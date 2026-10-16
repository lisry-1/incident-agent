import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listCases, query, validateQuery } from './incident-cli.mjs';

const argumentKeys = ['case', 'source', 'service', 'namespace', 'start', 'end'];
const defaultAuditDirectory = fileURLToPath(new URL('../runs/', import.meta.url));

function plainObject(value) {
  return value !== null && typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// A local tool broker, NOT a sandbox for the host Agent's other tools.
// Model integration must route every incident tool call through dispatch().
export class IncidentHarness {
  #scope;
  #caseId;
  #execute;
  #failures = new Map();
  #attempts = 0;
  #sequence = 0;
  #maxAttempts;
  #failureLimit;
  #fd;
  #runId = randomUUID();
  #auditFile;

  constructor({ caseId, auditDirectory = defaultAuditDirectory, maxAttempts = 12,
    failureLimit = 2, executeQuery = query } = {}) {
    const selected = listCases().find((entry) => entry.case_id === caseId);
    if (!selected) throw new Error('Unknown case: select a fixed fixture case.');
    if (![maxAttempts, failureLimit].every((n) => Number.isInteger(n) && n > 0)) {
      throw new Error('Attempt and failure limits must be positive integers.');
    }
    this.#caseId = caseId;
    this.#scope = Object.freeze({ ...selected.scope });
    this.#execute = executeQuery;
    this.#maxAttempts = maxAttempts;
    this.#failureLimit = failureLimit;
    mkdirSync(auditDirectory, { recursive: true });
    this.#auditFile = path.resolve(auditDirectory, `${this.#runId}.jsonl`);
    this.#fd = openSync(this.#auditFile, 'wx', 0o600);
  }

  get auditFile() { return this.#auditFile; }
  get runId() { return this.#runId; }

  #record(value) {
    if (this.#fd === undefined) throw new Error('Harness is closed.');
    const record = { schema_version: 1, run_id: this.#runId,
      sequence: ++this.#sequence, recorded_at: new Date().toISOString(),
      data_mode: 'synthetic_fixture', ...value };
    appendFileSync(this.#fd, `${JSON.stringify(record)}\n`);
    fsyncSync(this.#fd);
    return record;
  }

  dispatch(request) {
    if (this.#fd === undefined) throw new Error('Harness is closed.');
    const attempt = ++this.#attempts;
    const deny = (code, message) => this.#record({ type: 'permission', attempt,
      decision: 'deny', tool_executed: false, code, message });
    // Count all requests, including invalid or denied ones, toward the run budget.
    if (attempt > this.#maxAttempts) return deny('BUDGET_EXHAUSTED', 'Run request budget reached.');
    if (!plainObject(request) || Object.keys(request).some((k) => !['tool', 'arguments'].includes(k))) {
      return deny('INVALID_REQUEST', 'Use exactly tool and arguments.');
    }
    if (request.tool !== 'incident.query') return deny('TOOL_NOT_ALLOWED', 'Only incident.query is registered.');
    const args = request.arguments;
    if (!plainObject(args) || Object.keys(args).length !== argumentKeys.length ||
        argumentKeys.some((k) => typeof args[k] !== 'string') ||
        Object.keys(args).some((k) => !argumentKeys.includes(k))) {
      return deny('INVALID_ARGUMENTS', 'Supply only the six string query fields.');
    }
    // Snapshot values in a fixed order; field ordering cannot evade failure tracking.
    const input = Object.freeze(Object.fromEntries(argumentKeys.map((k) => [k, args[k]])));
    if (input.case !== this.#caseId || input.service !== this.#scope.service ||
        input.namespace !== this.#scope.namespace) {
      return deny('SCOPE_DENIED', 'Case, service and namespace are pinned for this run.');
    }
    try {
      const { start, end } = validateQuery(input);
      if (start < Date.parse(this.#scope.start) || end > Date.parse(this.#scope.end)) {
        return deny('SCOPE_DENIED', 'Requested interval exceeds this run scope.');
      }
    } catch (error) {
      return deny(error.code || 'INVALID_ARGUMENTS', error.message);
    }
    const fingerprint = JSON.stringify(input);
    if ((this.#failures.get(fingerprint) || 0) >= this.#failureLimit) {
      return deny('CIRCUIT_OPEN', `This exact query failed ${this.#failureLimit} times; change the query or report missing evidence.`);
    }
    // Persist the permission decision before invoking the registered read-only function.
    // If writing the audit fails, execution does not proceed.
    this.#record({ type: 'permission', attempt, decision: 'allow',
      tool: request.tool, input });
    let result;
    try {
      result = this.#execute(input);
      if (!result || !['ok', 'empty', 'unavailable', 'error'].includes(result.status)) {
        throw new Error('Query returned an invalid result status.');
      }
    } catch (error) {
      result = { status: 'error', evidence: [],
        error: { code: error.code || 'TOOL_ERROR', message: error.message } };
    }
    const failed = ['error', 'unavailable'].includes(result.status);
    this.#failures.set(fingerprint, failed ? (this.#failures.get(fingerprint) || 0) + 1 : 0);
    return this.#record({ type: 'tool_result', attempt, tool: request.tool,
      input, result, tool_executed: true });
  }

  close() {
    if (this.#fd !== undefined) {
      closeSync(this.#fd);
      this.#fd = undefined;
    }
  }
}

export function guardDemo({ auditDirectory } = {}) {
  const caseId = 'insufficient-evidence';
  const { scope } = listCases().find((entry) => entry.case_id === caseId);
  const harness = new IncidentHarness({ caseId, auditDirectory });
  const input = { case: caseId, source: 'metrics', ...scope };
  const call = (args) => ({ tool: 'incident.query', arguments: args });
  const requests = [
    ['正常指标查询', call(input)],
    ['越界查询 production', call({ ...input, namespace: 'production' })],
    ['请求重启服务', { tool: 'incident.restart', arguments: input }],
    ['缺失日志：第 1 次', call({ ...input, source: 'logs' })],
    ['缺失日志：第 2 次', call({ ...input, source: 'logs' })],
    ['缺失日志：第 3 次', call({ ...input, source: 'logs' })],
    ['再次查询可用指标', call(input)],
  ];
  try {
    const steps = requests.map(([label, request]) => {
      const event = harness.dispatch(request);
      return { label, outcome: event.code || event.result.status,
        tool_executed: event.tool_executed };
    });
    return { mode: 'guard_smoke_test', llm_called: false,
      data_mode: 'synthetic_fixture', run_id: harness.runId,
      audit_file: harness.auditFile, steps,
      note: 'Local broker demonstration only; not wired into Miniclaw Runtime or a live LLM.' };
  } finally { harness.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== 'demo') {
      throw new Error('Usage: node incident-harness.mjs demo');
    }
    console.log(JSON.stringify(guardDemo(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'error', message: error.message }));
    process.exitCode = 1;
  }
}
