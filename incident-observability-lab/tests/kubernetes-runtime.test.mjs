import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIncidentTools } from '../../container/agent-runner/dist/incident-tools.js';
import { adaptClaudeMcpToolsToPi } from '../../container/agent-runner/dist/runtime/pi/pi-tools.js';
import { fixture, kubeScope, pod, event, podUid } from './kube-fixtures.mjs';
import { payload, log } from './trace-fixtures.mjs';

test('real Pi adapter joins four same-Pod sources and never audits credentials or current snapshot as history', async (t) => {
  const f = await fixture(t, (req, res) =>
    res.end(
      JSON.stringify(
        req.url.includes('/events')
          ? { kind: 'EventList', items: [event()] }
          : pod(),
      ),
    ),
  );
  const reader = fileURLToPath(
    new URL('../../data/incident-k8s/reader.json', import.meta.url),
  );
  const previous = existsSync(reader) ? readFileSync(reader) : undefined;
  mkdirSync(path.dirname(reader), { recursive: true });
  writeFileSync(reader, JSON.stringify(f.config), { mode: 0o600 });
  chmodSync(reader, 0o600);
  const workspace = mkdtempSync(path.join(tmpdir(), 'kube-pi-'));
  const oldFetch = globalThis.fetch;
  let bundle;
  t.after(() => {
    bundle?.close();
    globalThis.fetch = oldFetch;
    rmSync(workspace, { recursive: true, force: true });
    if (previous) writeFileSync(reader, previous);
    else rmSync(reader, { force: true });
  });
  const record = {
    ...log(),
    cluster: 'incident-lab',
    pod: 'checkout-k8s',
    pod_uid: podUid,
    source: 'loki:checkout-k8s-lab:logs',
    status: 503,
    level: 'ERROR',
    duration_ms: 120,
    fault_injected: true,
    message: 'Local injected failure',
  };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.startsWith('/api/v3/traces/')) {
      const body = payload();
      body.result.resourceSpans[0].resource.attributes.push(
        ...[
          ['k8s.pod.name', 'checkout-k8s'],
          ['k8s.pod.uid', podUid],
          ['k8s.cluster.name', 'incident-lab'],
        ].map(([key, value]) => ({ key, value: { stringValue: value } })),
      );
      return new Response(JSON.stringify(body));
    }
    if (url.pathname === '/loki/api/v1/query_range') {
      assert.match(url.searchParams.get('query'), /job="checkout-k8s-lab"/);
      return new Response(
        JSON.stringify({
          status: 'success',
          data: {
            resultType: 'streams',
            result: [
              {
                stream: {
                  job: 'checkout-k8s-lab',
                  service: 'checkout-api',
                  namespace: 'demo',
                  status: '503',
                },
                values: [[record.timestamp_ns, JSON.stringify(record)]],
              },
            ],
          },
        }),
      );
    }
    const q = url.searchParams.get('query');
    assert.match(q, /job="checkout-k8s-lab"/);
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
    path.join(workspace, 'incident-demo.config.json'),
    JSON.stringify({
      case_id: 'prometheus-lab',
      workflow: 'staged',
      window_seconds: 120,
      end: kubeScope.end,
      logs: true,
      traces: true,
      kubernetes: true,
    }),
  );
  bundle = await createIncidentTools(workspace, true);
  const tools = adaptClaudeMcpToolsToPi(bundle.tools, {
    namespace: 'mcp__miniclaw',
  });
  async function call(name, args) {
    const tool = tools.find((t) => t.name.endsWith(name));
    const r = await tool.execute(
      'kube-test',
      await tool.prepareArguments(args),
      new AbortController().signal,
    );
    return JSON.parse(r.content.find((x) => x.type === 'text').text);
  }
  const args = { case: 'prometheus-lab', source: 'pod_events', ...kubeScope };
  assert.equal((await call('incident_investigate', args)).code, 'STAGE_DENIED');
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await call('incident_probe', { ...args, source: 'metrics' })).stage,
    'deep',
  );
  const logs = await call('incident_investigate', { ...args, source: 'logs' });
  assert.equal(logs.result.evidence[0].pod_uid, podUid);
  const traces = await call('incident_investigate', {
    ...args,
    source: 'traces',
  });
  assert.equal(traces.result.status, 'ok');
  assert.equal(traces.result.evidence[0].pod_uid, podUid);
  const kube = await call('incident_investigate', args);
  assert.equal(kube.result.status, 'ok');
  assert.equal(kube.result.current_snapshot.ready, 'True');
  assert.equal(
    (await call('incident_investigate', { ...args, namespace: 'production' }))
      .code,
    'SCOPE_DENIED',
  );
  assert.equal(f.calls.length, 2);
  const timeline = (await call('incident_timeline', {})).result;
  assert.equal(timeline.events.length, 5);
  assert.ok(
    timeline.correlations.some(
      (x) =>
        x.field === 'pod_uid' && x.value === podUid && x.evidence.length === 4,
    ),
  );
  assert.ok(!timeline.events.some((x) => x.observed_at));
  const audit = readFileSync(
    path.join(workspace, 'incident-audit', kube.run_id + '.jsonl'),
    'utf8',
  );
  assert.ok(!audit.includes(f.config.token));
  assert.ok(!audit.includes('certificate_authority_data'));
  assert.ok(!bundle.prompt.includes(f.config.token));
});
