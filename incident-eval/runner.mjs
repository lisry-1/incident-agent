import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { Agent } from '../container/agent-runner/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js';
import { IncidentHarness } from '../incident-diagnosis-demo/scripts/incident-harness.mjs';
import { listCases } from '../incident-diagnosis-demo/scripts/incident-cli.mjs';
import { nextToolContext } from '../incident-observability-lab/approval/worker/model-state.mjs';
import { cases, reportContract, SYSTEM, PROMPT_REVISION } from './cases.mjs';
import { grade, hash, parseReport, summarize } from './grade.mjs';
import { MODEL, providerRequest, transportStream } from './transport.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function sourceHashes() {
  const paths = [
    'incident-eval/cases.mjs',
    'incident-eval/grade.mjs',
    'incident-eval/runner.mjs',
    'incident-eval/transport.mjs',
    'incident-diagnosis-demo/scripts/incident-harness.mjs',
    'incident-diagnosis-demo/scripts/incident-cli.mjs',
    'incident-diagnosis-demo/scripts/incident-timeline.mjs',
    'incident-observability-lab/approval/worker/model-state.mjs',
    'container/agent-runner/package-lock.json',
    ...['release-regression', 'upstream-timeout', 'insufficient-evidence'].map(
      (id) => `incident-diagnosis-demo/fixtures/${id}.json`,
    ),
  ];
  return Object.fromEntries(
    paths.map((p) => [p, hash(readFileSync(path.join(root, p), 'utf8'))]),
  );
}
export function inputFor(c) {
  const fixture = c.fixture
    ? listCases().find((f) => f.case_id === c.fixture)
    : null;
  return {
    task: c.prompt,
    data_mode: 'synthetic_fixture',
    report_contract: {
      ...reportContract,
      facts: Object.fromEntries(
        Object.entries(c.fields).map(([field, type]) => [
          field,
          {
            value: type,
            evidence_ids: ['supporting observed evidence IDs'],
          },
        ]),
      ),
    },
    fact_fields: c.fields,
    output_rules: [
      'Final response: one raw JSON object only. Put every explanation in summary; no text before or after the object.',
      'Use exactly the report_contract top-level keys, with no duplicates.',
      Object.keys(c.fields).length === 0
        ? 'This case requests NO structured fact fields: facts MUST be {}. Describe observations in summary and cite evidence_ids.'
        : 'facts must contain exactly the fact_fields keys. Each entry has value and evidence_ids only.',
    ],
    ...(fixture
      ? { alert: fixture.alert, pinned_scope: fixture.scope }
      : { evidence: c.evidence }),
  };
}

export async function runCase(c, { directory, request, modelCalled = false }) {
  const started = Date.now();
  const input = inputFor(c);
  const harness =
    c.kind === 'agent_fixture'
      ? new IncidentHarness({
          caseId: c.fixture,
          staged: true,
          maxAttempts: 12,
          auditDirectory: path.join(directory, c.id),
        })
      : null;
  const toolCalls = [],
    toolErrors = [],
    outputs = [],
    visibleTools = [];
  let agent,
    modelRequests = 0,
    turns = 0,
    runError = null;
  const schema = {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        enum: ['metrics', 'logs', 'deployments', 'pod_events', 'traces'],
      },
      namespace: {
        type: 'string',
        description: 'Optional namespace; only pinned demo is authorized.',
      },
    },
    required: ['source'],
    additionalProperties: false,
  };
  const tools = [
    'incident_probe',
    'incident_investigate',
    'incident_timeline',
  ].map((name) => ({
    name,
    label: name,
    executionMode: 'sequential',
    description:
      name === 'incident_probe'
        ? 'Probe metrics in the pinned scope; only metrics allowed.'
        : name === 'incident_timeline'
          ? 'Build timeline from observations already returned in this run.'
          : 'After abnormal probe, query logs, deployments, pod_events or traces in the pinned scope.',
    parameters:
      name === 'incident_timeline'
        ? { type: 'object', properties: {}, additionalProperties: false }
        : schema,
    execute: async (_id, args) => {
      const value = harness.dispatch({
        tool: name.replace('incident_', 'incident.'),
        arguments:
          name === 'incident_timeline'
            ? {}
            : {
                case: c.fixture,
                ...input.pinned_scope,
                source: args.source,
                ...(args.namespace ? { namespace: args.namespace } : {}),
              },
      });
      agent.state.tools = tools.filter((t) =>
        harness.availableTools.includes(
          t.name.replace('incident_', 'incident.'),
        ),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        details: {},
      };
    },
  }));
  agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM,
      tools: harness ? [tools[0]] : [],
      model: { id: MODEL, provider: 'anthropic', api: 'anthropic-messages' },
      thinkingLevel: 'off',
    },
    streamFn: transportStream(
      async (body, options) => {
        visibleTools.push((body.tools ?? []).map((t) => t.name));
        return request(body, options);
      },
      () => {
        if (++modelRequests > 8) throw new Error('MODEL_REQUEST_BUDGET');
      },
    ),
    toolExecution: 'sequential',
    prepareNextTurnWithContext: nextToolContext(() => agent.state.tools),
    shouldStopAfterTurn: () => ++turns >= 8,
  });
  agent.subscribe((e) => {
    if (e.type === 'message_end' && e.message.role === 'assistant') {
      outputs.push({
        stop_reason: e.message.stopReason,
        content: e.message.content,
        usage: {
          input_tokens: e.message.usage?.input,
          output_tokens: e.message.usage?.output,
        },
      });
      toolCalls.push(...e.message.content.filter((b) => b.type === 'toolCall'));
    }
    if (e.type === 'tool_execution_end' && e.isError)
      toolErrors.push({ tool: e.toolName, tool_call_id: e.toolCallId });
  });
  const deadline = setTimeout(() => agent.abort(), 180000);
  try {
    await agent.prompt(JSON.stringify(input));
    if (agent.state.errorMessage) runError = 'AGENT_OR_PROVIDER_ERROR';
  } catch (e) {
    // No provider response bodies, headers, credentials or full error stacks are persisted.
    runError = /^(MODEL_|REQUEST_|UNSUPPORTED_)/.test(e.message)
      ? e.message
      : 'AGENT_OR_PROVIDER_ERROR';
  } finally {
    clearTimeout(deadline);
    harness?.close();
  }
  const audit = harness
    ? readFileSync(harness.auditFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse)
    : [];
  const evidence = harness
    ? audit
        .filter((e) => e.type === 'tool_result')
        .flatMap((e) => e.result.evidence ?? e.result.events ?? [])
    : c.evidence;
  const last = outputs.at(-1);
  const text =
    last?.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n') ?? '';
  const report = parseReport(text);
  const record = {
    case_id: c.id,
    kind: c.kind,
    llm_called: modelCalled && modelRequests > 0,
    input,
    input_sha256: hash({ system: SYSTEM, input }),
    model_requests: modelRequests,
    duration_ms: Date.now() - started,
    run_error: runError,
    final_stop: last?.stop_reason ?? null,
    visible_tools_by_request: visibleTools,
    assistant_outputs: outputs,
    tool_calls: toolCalls,
    tool_errors: toolErrors,
    audit,
    report,
    grade: grade(c, {
      report,
      evidence,
      audit,
      toolCalls,
      toolErrors,
      runError,
      finalStop: last?.stop_reason,
    }),
  };
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, `${c.id}.json`),
    JSON.stringify(record, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  return record;
}

export async function runSuite({
  request,
  modelCalled,
  directory,
  selected = cases,
  progress = () => {},
}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sources = sourceHashes();
  const results = [];
  for (const c of selected) {
    progress(`Running ${c.id} (${c.kind})...`);
    const result = await runCase(c, { directory, request, modelCalled });
    results.push(result);
    progress(
      `${c.id}: ${result.grade.automated_pass ? 'PASS' : 'FAIL'} ${result.grade.failed_checks.join(', ')}`,
    );
    // Keep both failures and successes. Never overwrite or silently retry a failed case.
    const snapshot = {
      schema_version: 1,
      suite: 'incident-regression-v1',
      prompt_revision: PROMPT_REVISION,
      data_mode: 'synthetic_fixture',
      llm_called: results.some((r) => r.llm_called),
      completed: results.length === selected.length,
      selected_case_ids: selected.map((c) => c.id),
      case_set_sha256: hash(cases),
      prompt_sha256: hash(SYSTEM),
      source_hashes: sources,
      model_identity_sha256: hash(MODEL),
      limits: {
        requests_per_case: 8,
        output_tokens_per_request: 2048,
        case_timeout_seconds: 180,
      },
      created_at: new Date().toISOString(),
      summary: summarize(results),
      results,
    };
    writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(snapshot, null, 2) + '\n',
      { mode: 0o600 },
    );
    // Provider outages/balance failures stop the suite; record remaining cases as unrun.
    if (result.run_error) break;
  }
  return JSON.parse(readFileSync(path.join(directory, 'report.json'), 'utf8'));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'list' && rest.length === 0) {
    console.log(
      JSON.stringify(
        {
          suite: 'incident-regression-v1',
          llm_called: false,
          cases: cases.map((c) => ({ id: c.id, kind: c.kind, task: c.prompt })),
          max_requests: 64,
          output_tokens_per_request: 2048,
          note: 'Eight public fixed cases, not a production benchmark.',
        },
        null,
        2,
      ),
    );
    return;
  }
  if (
    command !== 'run' ||
    rest.some((id) => !cases.some((c) => c.id === id)) ||
    new Set(rest).size !== rest.length
  )
    throw new Error(
      'Usage: node incident-eval/runner.mjs list | run [case-01 ... case-08]',
    );
  const apiKey = process.env.INCIDENT_EVAL_API_KEY;
  if (!apiKey)
    throw new Error('Set INCIDENT_EVAL_API_KEY in this terminal before run.');
  const directory = path.join(root, 'data', 'incident-eval', randomUUID());
  const report = await runSuite({
    directory,
    modelCalled: true,
    selected: rest.length ? cases.filter((c) => rest.includes(c.id)) : cases,
    request: (body, options) =>
      providerRequest(body, { apiKey, signal: options?.signal }),
    progress: (message) => console.log(message),
  });
  console.log(
    JSON.stringify(
      {
        completed: report.completed,
        llm_called: report.llm_called,
        ...report.summary,
        report_file: path.join(directory, 'report.json'),
        note: 'Automated structured checks; prose review pending. Failed cases retained. No live cluster or approval actions.',
      },
      null,
      2,
    ),
  );
  if (
    !report.completed ||
    report.summary.automated_passed !== report.summary.total
  )
    process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'error', message: error.message }));
    process.exitCode = 1;
  });
