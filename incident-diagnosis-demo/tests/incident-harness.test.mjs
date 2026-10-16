import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IncidentHarness, guardDemo } from '../scripts/incident-harness.mjs';
import { query } from '../scripts/incident-cli.mjs';

const input = { case: 'insufficient-evidence', source: 'metrics',
  service: 'checkout-api', namespace: 'demo',
  start: '2026-10-15T10:00:00Z', end: '2026-10-15T10:15:00Z' };
const request = (args = input) => ({ tool: 'incident.query', arguments: args });

function setup(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'incident-guard-'));
  let calls = 0;
  const harness = new IncidentHarness({ caseId: input.case, auditDirectory: dir,
    executeQuery: (args) => { calls++; return query(args); }, ...options });
  t.after(() => { harness.close(); rmSync(dir, { recursive: true, force: true }); });
  return { harness, calls: () => calls, dir };
}

test('permission is written before successful result, with evidence and ordered events', (t) => {
  const { harness, calls } = setup(t);
  assert.equal(harness.dispatch(request()).result.status, 'ok');
  assert.equal(calls(), 1);
  const records = readFileSync(harness.auditFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map((r) => r.type), ['permission', 'tool_result']);
  assert.equal(records[0].decision, 'allow');
  assert.equal(records[1].result.evidence[0].evidence_id, 'GAP-M1');
  assert.deepEqual(records.map((r) => r.sequence), [1, 2]);
  assert.ok(records.every((r) => r.run_id === harness.runId));
});

test('restart, rollback and shell requests never reach execution', (t) => {
  const { harness, calls } = setup(t);
  for (const tool of ['incident.restart', 'bash', 'incident.rollback']) {
    const event = harness.dispatch({ tool, arguments: input });
    assert.equal(event.code, 'TOOL_NOT_ALLOWED');
    assert.equal(event.tool_executed, false);
  }
  assert.equal(calls(), 0);
});

test('caller cannot expand pinned case, service, namespace or time scope', (t) => {
  const { harness, calls } = setup(t);
  for (const change of [{ case: 'release-regression' }, { namespace: 'production' },
    { service: 'billing-api' }, { start: '2026-10-15T09:59:00Z' },
    { end: '2026-10-15T10:16:00Z' }]) {
    assert.equal(harness.dispatch(request({ ...input, ...change })).code, 'SCOPE_DENIED');
  }
  assert.equal(calls(), 0);
});

test('malformed and extra arguments are denied before execution', (t) => {
  const { harness, calls } = setup(t);
  for (const args of [null, [], {}, { ...input, command: 'restart production' },
    { ...input, source: 42 }]) {
    assert.equal(harness.dispatch(request(args)).code, 'INVALID_ARGUMENTS');
  }
  assert.equal(harness.dispatch({ ...request(), command: 'restart' }).code, 'INVALID_REQUEST');
  assert.equal(harness.dispatch(request({ ...input, start: 'yesterday' })).code, 'INVALID_TIME');
  assert.equal(calls(), 0);
});

test('third identical unavailable query is blocked despite reordered fields', (t) => {
  const { harness, calls } = setup(t);
  const missing = { ...input, source: 'logs' };
  for (let i = 0; i < 2; i++) {
    assert.equal(harness.dispatch(request(missing)).result.status, 'unavailable');
  }
  const reordered = Object.fromEntries(Object.entries(missing).reverse());
  assert.equal(harness.dispatch(request(reordered)).code, 'CIRCUIT_OPEN');
  assert.equal(calls(), 2);
  assert.equal(harness.dispatch(request()).result.status, 'ok');
  assert.equal(calls(), 3);
});

test('tool exceptions count toward the failure threshold', (t) => {
  let executions = 0;
  const { harness } = setup(t, { executeQuery: () => { executions++; throw new Error('source down'); } });
  assert.equal(harness.dispatch(request()).result.error.code, 'TOOL_ERROR');
  assert.equal(harness.dispatch(request()).result.status, 'error');
  assert.equal(harness.dispatch(request()).code, 'CIRCUIT_OPEN');
  assert.equal(executions, 2);
});

test('empty results do not count as execution failures', (t) => {
  const { harness, calls } = setup(t, { caseId: 'upstream-timeout' });
  const args = { ...input, case: 'upstream-timeout', source: 'deployments' };
  for (let i = 0; i < 3; i++) {
    assert.equal(harness.dispatch(request(args)).result.status, 'empty');
  }
  assert.equal(calls(), 3);
});

test('denied attempts also consume the global request budget', (t) => {
  const { harness, calls } = setup(t, { maxAttempts: 2 });
  harness.dispatch({ tool: 'bash', arguments: input });
  harness.dispatch(request({ ...input, namespace: 'production' }));
  assert.equal(harness.dispatch(request()).code, 'BUDGET_EXHAUSTED');
  assert.equal(calls(), 0);
});

test('failure counters are isolated between runs', (t) => {
  const first = setup(t);
  const second = setup(t);
  const args = { ...input, source: 'logs' };
  first.harness.dispatch(request(args));
  first.harness.dispatch(request(args));
  assert.equal(first.harness.dispatch(request(args)).code, 'CIRCUIT_OPEN');
  assert.equal(second.harness.dispatch(request(args)).result.status, 'unavailable');
  assert.notEqual(first.harness.runId, second.harness.runId);
});

test('closed harness cannot execute another query', (t) => {
  const { harness, calls } = setup(t);
  harness.close();
  assert.throws(() => harness.dispatch(request()), /closed/);
  assert.equal(calls(), 0);
});

test('demo records actual execution counts and parseable JSONL', (t) => {
  const { dir } = setup(t);
  const result = guardDemo({ auditDirectory: dir });
  assert.equal(result.llm_called, false);
  assert.deepEqual(result.steps.map((s) => s.outcome),
    ['ok', 'SCOPE_DENIED', 'TOOL_NOT_ALLOWED', 'unavailable', 'unavailable', 'CIRCUIT_OPEN', 'ok']);
  assert.deepEqual(result.steps.map((s) => s.tool_executed), [true, false, false, true, true, false, true]);
  const records = readFileSync(result.audit_file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 11);
  assert.equal(records.filter((r) => r.type === 'tool_result').length, 4);
});
