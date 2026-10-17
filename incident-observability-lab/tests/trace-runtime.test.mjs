import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIncidentTools } from '../../container/agent-runner/dist/incident-tools.js';
import { adaptClaudeMcpToolsToPi } from '../../container/agent-runner/dist/runtime/pi/pi-tools.js';
import { scope, log, payload } from './trace-fixtures.mjs';
test('Pi runtime enforces probe, protected logs, trace lookup, scope and aligned shared identity', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trace-runtime-'));
  const oldFetch = globalThis.fetch;
  let bundle,
    traceCalls = 0;
  t.after(() => {
    bundle?.close();
    globalThis.fetch = oldFetch;
    rmSync(dir, { recursive: true, force: true });
  });
  const value = {
    ...log(),
    status: 503,
    level: 'ERROR',
    duration_ms: 120,
    fault_injected: true,
    message: 'Injected HTTP 503 in local experiment',
  };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.startsWith('/api/v3/traces/')) {
      traceCalls++;
      assert.equal(url.origin, 'http://127.0.0.1:16686');
      return new Response(JSON.stringify(payload()));
    }
    if (url.pathname === '/loki/api/v1/query_range')
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
                values: [[value.timestamp_ns, JSON.stringify(value)]],
              },
            ],
          },
        }),
      );
    assert.equal(url.origin, 'http://127.0.0.1:19090');
    const q = url.searchParams.get('query');
    return new Response(
      JSON.stringify({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { service: 'checkout-api', namespace: 'demo' },
              values: [
                [
                  Number(url.searchParams.get('start')),
                  q.includes('status=~')
                    ? '0.5'
                    : q.startsWith('min')
                      ? '1'
                      : '4',
                ],
              ],
            },
          ],
        },
      }),
    );
  };
  writeFileSync(
    path.join(dir, 'incident-demo.config.json'),
    JSON.stringify({
      case_id: 'prometheus-lab',
      workflow: 'staged',
      window_seconds: 120,
      end: scope.end,
      logs: true,
      traces: true,
    }),
  );
  bundle = await createIncidentTools(dir, true);
  const tools = adaptClaudeMcpToolsToPi(bundle.tools, {
    namespace: 'mcp__miniclaw',
  });
  async function call(name, args) {
    const tool = tools.find((t) => t.name.endsWith(name));
    const r = await tool.execute(
      'trace-test',
      await tool.prepareArguments(args),
      new AbortController().signal,
    );
    return JSON.parse(r.content.find((x) => x.type === 'text').text);
  }
  const args = { case: 'prometheus-lab', source: 'traces', ...scope };
  assert.equal((await call('incident_investigate', args)).code, 'STAGE_DENIED');
  assert.equal(
    (await call('incident_probe', { ...args, source: 'metrics' })).stage,
    'deep',
  );
  assert.equal(
    (await call('incident_investigate', args)).result.error.code,
    'TRACE_CONTEXT_MISSING',
  );
  assert.equal(traceCalls, 0);
  const logs = await call('incident_investigate', { ...args, source: 'logs' });
  assert.equal(logs.result.evidence[0].trace_id, log().trace_id);
  logs.result.evidence[0].trace_id = 'f'.repeat(32);
  const traces = await call('incident_investigate', args);
  assert.equal(traces.result.status, 'ok');
  assert.equal(traceCalls, 1);
  assert.equal(
    (await call('incident_investigate', { ...args, namespace: 'production' }))
      .code,
    'SCOPE_DENIED',
  );
  assert.equal(traceCalls, 1);
  const timeline = (await call('incident_timeline', {})).result;
  assert.equal(timeline.events.length, 4);
  assert.equal(
    timeline.source_coverage.traces[1]?.partial ??
      timeline.source_coverage.traces[0]?.partial,
    false,
  );
  assert.ok(
    timeline.correlations.some((c) =>
      JSON.stringify(c).includes(log().trace_id),
    ),
  );
  const records = readFileSync(
    path.join(
      dir,
      'incident-audit',
      readdirSync(path.join(dir, 'incident-audit'))[0],
    ),
    'utf8',
  )
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.ok(
    records.some((e) => e.type === 'stage_transition' && e.to === 'deep'),
  );
  assert.equal(
    records.filter(
      (e) =>
        e.type === 'tool_result' &&
        e.tool === 'incident.investigate' &&
        e.result.evidence?.some(
          (x) => x.source === 'jaeger:checkout-lab:traces',
        ),
    ).length,
    1,
  );
});
test('trace capability requires logs and is rejected for fixture cases', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'trace-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const config of [
    { case_id: 'prometheus-lab', workflow: 'staged', traces: true },
    {
      case_id: 'release-regression',
      workflow: 'staged',
      logs: true,
      traces: true,
    },
  ]) {
    writeFileSync(
      path.join(dir, 'incident-demo.config.json'),
      JSON.stringify(config),
    );
    await assert.rejects(() => createIncidentTools(dir, true));
  }
});
