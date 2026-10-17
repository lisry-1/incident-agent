import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IncidentHarness } from '../../incident-diagnosis-demo/scripts/incident-harness.mjs';
import { createIncidentTools } from '../../container/agent-runner/dist/incident-tools.js';
import { adaptClaudeMcpToolsToPi } from '../../container/agent-runner/dist/runtime/pi/pi-tools.js';
const scope = {
  service: 'checkout-api',
  namespace: 'demo',
  start: '2026-10-15T10:00:00.000Z',
  end: '2026-10-15T10:02:00.000Z',
};
const args = { case: 'prometheus-lab', source: 'metrics', ...scope };
const probe = { tool: 'incident.probe', arguments: args };
function harness(t, executeQuery, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'live-guard-'));
  const h = new IncidentHarness({
    caseId: 'prometheus-lab',
    liveScope: scope,
    staged: true,
    auditDirectory: dir,
    executeQuery,
    ...options,
  });
  t.after(() => {
    h.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return h;
}
test('async failure serialization enforces breaker and ordered durable audit', async (t) => {
  let calls = 0;
  const h = harness(t, async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return { status: 'unavailable', evidence: [] };
  });
  const results = await Promise.all([
    h.dispatchAsync(probe),
    h.dispatchAsync(probe),
    h.dispatchAsync(probe),
  ]);
  assert.equal(calls, 2);
  assert.equal(results[2].code, 'CIRCUIT_OPEN');
  const audit = readFileSync(h.auditFile, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(
    audit.map((x) => x.type),
    ['permission', 'tool_result', 'permission', 'tool_result', 'permission'],
  );
  assert.ok(audit.every((x) => x.data_mode === 'live_lab'));
});
test('live scope and request budget deny before network', async (t) => {
  let calls = 0;
  const h = harness(
    t,
    async () => {
      calls++;
      return { status: 'empty', evidence: [] };
    },
    { maxAttempts: 2 },
  );
  assert.equal(
    (
      await h.dispatchAsync({
        tool: 'incident.probe',
        arguments: { ...args, namespace: 'production' },
      })
    ).code,
    'SCOPE_DENIED',
  );
  assert.equal(
    (
      await h.dispatchAsync({
        tool: 'incident.probe',
        arguments: { ...args, end: '2026-10-15T10:03:00Z' },
      })
    ).code,
    'SCOPE_DENIED',
  );
  assert.equal((await h.dispatchAsync(probe)).code, 'BUDGET_EXHAUSTED');
  assert.equal(calls, 0);
});
test('partial and empty observations cannot finish probe as healthy', async (t) => {
  for (const result of [
    { status: 'empty', evidence: [] },
    { status: 'ok', partial: true, evidence: [{ http_5xx_ratio: 0 }] },
  ]) {
    const h = harness(t, async () => result);
    assert.equal((await h.dispatchAsync(probe)).stage, 'probe');
  }
});
test('queued calls snapshot inputs and closed harness prevents execution', async (t) => {
  let calls = 0;
  const h = harness(t, async () => {
    calls++;
    return { status: 'unavailable', evidence: [] };
  });
  const input = structuredClone(probe);
  const pending = h.dispatchAsync(input);
  input.arguments.namespace = 'production';
  assert.equal((await pending).result.status, 'unavailable');
  h.close();
  await assert.rejects(h.dispatchAsync(probe), /closed/);
  assert.equal(calls, 1);
});
test('Pi adapted live tools query Prometheus, switch stage, never fall back to fixtures', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'live-pi-'));
  const oldFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests++;
    const u = new URL(url);
    assert.equal(u.origin, 'http://127.0.0.1:19090');
    assert.equal(u.pathname, '/api/v1/query_range');
    const q = u.searchParams.get('query');
    const value = q.includes('histogram_quantile')
      ? '200'
      : q.includes('status=~')
        ? '0.5'
        : q.startsWith('min')
          ? '1'
          : '4';
    return new Response(
      JSON.stringify({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { service: 'checkout-api', namespace: 'demo' },
              values: [[Number(u.searchParams.get('start')), value]],
            },
          ],
        },
      }),
    );
  };
  let bundle;
  t.after(() => {
    bundle?.close();
    globalThis.fetch = oldFetch;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(
    path.join(dir, 'incident-demo.config.json'),
    JSON.stringify({
      case_id: 'prometheus-lab',
      workflow: 'staged',
      window_seconds: 120,
      end: scope.end,
    }),
  );
  bundle = await createIncidentTools(dir, true);
  const tools = adaptClaudeMcpToolsToPi(bundle.tools, {
    namespace: 'mcp__miniclaw',
  });
  let active = ['bash', ...tools.map((t) => t.name)];
  bundle.configureTools({
    getActiveToolNames: () => active,
    setActiveToolsByName: (n) => {
      active = n;
    },
  });
  const call = async (name, args) => {
    const tool = tools.find((t) => t.name.endsWith(name));
    const result = await tool.execute(
      'test',
      await tool.prepareArguments(args),
      new AbortController().signal,
    );
    return JSON.parse(result.content.find((x) => x.type === 'text').text);
  };
  assert.deepEqual(active, ['bash', 'mcp__miniclaw__incident_probe']);
  assert.equal(
    (await call('incident_probe', { ...args, namespace: 'production' })).code,
    'SCOPE_DENIED',
  );
  assert.equal(requests, 0);
  const result = await call('incident_probe', args);
  assert.equal(result.stage, 'deep');
  assert.equal(requests, 4);
  assert.ok(active.includes('mcp__miniclaw__incident_timeline'));
  assert.ok(active.includes('bash'));
  assert.ok(!active.includes('mcp__miniclaw__incident_probe'));
  const unavailable = await call('incident_investigate', {
    ...args,
    source: 'logs',
  });
  assert.equal(unavailable.result.error.code, 'SOURCE_NOT_CONFIGURED');
  assert.equal(requests, 4);
  const timeline = (await call('incident_timeline', {})).result;
  assert.equal(timeline.data_mode, 'live_lab');
  assert.equal(timeline.events.length, 1);
  assert.match(timeline.events[0].evidence_id, /^PROM-/);
  assert.equal(timeline.source_coverage.logs[0].status, 'unavailable');
  const audit = readFileSync(
    path.join(
      dir,
      'incident-audit',
      readdirSync(path.join(dir, 'incident-audit'))[0],
    ),
    'utf8',
  );
  assert.ok(!audit.includes('synthetic_fixture'));
  assert.ok(!audit.includes('REL-'));
});

test('Pi live logs option joins actual query results into timeline and shares the failure breaker', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'live-pi-logs-'));
  const oldFetch = globalThis.fetch;
  let bundle,
    logCalls = 0,
    logFailure = false;
  const ns = String(
    BigInt(Date.parse(scope.start) + 60000) * 1000000n + 987654n,
  );
  const value = {
    timestamp: '2026-10-15T10:01:00.000Z',
    service: 'checkout-api',
    namespace: 'demo',
    status: 503,
    level: 'ERROR',
    duration_ms: 121,
    request_id: 'b'.repeat(32),
    fault_injected: true,
    data_mode: 'live_lab',
    message: 'Injected HTTP 503 in local experiment',
  };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/loki/api/v1/query_range') {
      logCalls++;
      assert.equal(url.origin, 'http://127.0.0.1:13100');
      if (logFailure) throw new Error('Unreachable test Loki');
      return new Response(
        JSON.stringify({
          status: 'success',
          data: {
            resultType: 'streams',
            result: [
              {
                stream: {
                  job: 'checkout-lab',
                  service: 'checkout-api',
                  namespace: 'demo',
                  status: '503',
                },
                values: [[ns, JSON.stringify(value)]],
              },
            ],
          },
        }),
      );
    }
    assert.equal(url.origin, 'http://127.0.0.1:19090');
    const q = url.searchParams.get('query');
    const sample = q.includes('histogram_quantile')
      ? '200'
      : q.includes('status=~')
        ? '0.5'
        : q.startsWith('min')
          ? '1'
          : '4';
    return new Response(
      JSON.stringify({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { service: 'checkout-api', namespace: 'demo' },
              values: [[Number(url.searchParams.get('start')), sample]],
            },
          ],
        },
      }),
    );
  };
  t.after(() => {
    bundle?.close();
    globalThis.fetch = oldFetch;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(
    path.join(dir, 'incident-demo.config.json'),
    JSON.stringify({
      case_id: 'prometheus-lab',
      workflow: 'staged',
      window_seconds: 120,
      end: scope.end,
      logs: true,
    }),
  );
  bundle = await createIncidentTools(dir, true);
  const tools = adaptClaudeMcpToolsToPi(bundle.tools, {
    namespace: 'mcp__miniclaw',
  });
  const call = async (name, args) => {
    const tool = tools.find((t) => t.name.endsWith(name));
    const r = await tool.execute(
      'logs-test',
      await tool.prepareArguments(args),
      new AbortController().signal,
    );
    return JSON.parse(r.content.find((x) => x.type === 'text').text);
  };
  assert.equal(
    (await call('incident_investigate', { ...args, source: 'logs' })).code,
    'STAGE_DENIED',
  );
  assert.equal(logCalls, 0);
  assert.equal((await call('incident_probe', args)).stage, 'deep');
  const logResult = await call('incident_investigate', {
    ...args,
    source: 'logs',
  });
  assert.equal(logResult.result.status, 'ok');
  assert.match(logResult.result.evidence[0].evidence_id, /^LOKI-/);
  const timeline = (await call('incident_timeline', {})).result;
  assert.equal(timeline.events.length, 2);
  assert.equal(timeline.source_coverage.logs[0].partial, false);
  assert.equal(
    timeline.events.filter((e) => e.source_kind === 'logs')[0].timestamp_ns,
    ns,
  );
  assert.equal(timeline.data_mode, 'live_lab');
  logFailure = true;
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      call('incident_investigate', { ...args, source: 'logs' }),
    ),
  );
  assert.equal(results[0].result.status, 'unavailable');
  assert.equal(results[1].result.status, 'unavailable');
  assert.equal(results[2].code, 'CIRCUIT_OPEN');
  assert.equal(logCalls, 3);
  assert.match(
    bundle.prompt,
    /first nonzero evaluation is NOT the precise failure onset/,
  );
});
