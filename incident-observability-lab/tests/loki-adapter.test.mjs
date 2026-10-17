import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { LokiLogsAdapter, LOG_QUERY } from '../loki-adapter.mjs';
const scope = {
  service: 'checkout-api',
  namespace: 'demo',
  start: '2026-10-17T06:00:00.000Z',
  end: '2026-10-17T06:02:00.000Z',
};
const ns = BigInt(Date.parse('2026-10-17T06:01:00.000Z')) * 1000000n + 123456n;
const record = (id = 'a'.repeat(32), stamp = ns) => ({
  timestamp: new Date(Number(stamp / 1000000n)).toISOString(),
  service: 'checkout-api',
  namespace: 'demo',
  data_mode: 'live_lab',
  status: 503,
  level: 'ERROR',
  message: 'Injected HTTP 503 in local experiment',
  request_id: id,
  duration_ms: 120,
  fault_injected: true,
});
const stream = (
  values = [[String(ns), JSON.stringify(record())]],
  labels = {
    job: 'checkout-lab',
    service: 'checkout-api',
    namespace: 'demo',
    status: '503',
  },
) => ({
  status: 'success',
  data: { resultType: 'streams', result: [{ stream: labels, values }] },
});
async function server(t, handle) {
  let calls = 0;
  const s = http.createServer((req, res) => {
    calls++;
    handle(req, res);
  });
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  t.after(() => {
    s.closeAllConnections();
    return new Promise((r) => s.close(r));
  });
  return { url: `http://127.0.0.1:${s.address().port}`, calls: () => calls };
}
const send = (res, body) => res.end(JSON.stringify(body));
test('Loki uses fixed GET filter and lossless half-open ns window; preserves millisecond evidence', async (t) => {
  const s = await server(t, (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(req.method, 'GET');
    assert.equal(url.pathname, '/loki/api/v1/query_range');
    assert.equal(url.searchParams.get('query'), LOG_QUERY);
    assert.equal(
      url.searchParams.get('end'),
      String(BigInt(Date.parse(scope.end)) * 1000000n),
    );
    assert.equal(url.searchParams.get('limit'), '201');
    assert.equal(url.searchParams.get('direction'), 'forward');
    send(res, stream());
  });
  const result = await new LokiLogsAdapter({ scope, baseUrl: s.url }).query(
    scope,
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.partial, false);
  assert.equal(result.evidence[0].timestamp_ns, String(ns));
  assert.equal(result.evidence[0].timestamp, '2026-10-17T06:01:00.000Z');
  assert.match(result.evidence[0].evidence_id, /^LOKI-/);
  assert.equal(result.evidence[0].trace_id, undefined);
});
test('scope expansion, raw LogQL, path and endpoint inputs are denied before HTTP', async (t) => {
  const s = await server(t, (_, res) => send(res, stream()));
  const adapter = new LokiLogsAdapter({ scope, baseUrl: s.url });
  for (const input of [
    { ...scope, namespace: 'production' },
    { ...scope, start: '2026-10-17T05:59:00Z' },
    { ...scope, query: '{namespace="production"}' },
    { ...scope, end: scope.start },
    { ...scope, start: 'bad' },
  ])
    await assert.rejects(adapter.query(input));
  assert.equal(s.calls(), 0);
  assert.throws(
    () => new LokiLogsAdapter({ scope, baseUrl: 'http://example.org' }),
  );
});
test('foreign stream, foreign log body, boundary time and malformed logs fail visibly', async (t) => {
  let payload = stream();
  const s = await server(t, (_, res) => send(res, payload));
  const adapter = new LokiLogsAdapter({ scope, baseUrl: s.url });
  for (const body of [
    stream(undefined, {
      job: 'other',
      service: 'checkout-api',
      namespace: 'demo',
      status: '503',
    }),
    stream([
      [String(ns), JSON.stringify({ ...record(), namespace: 'production' })],
    ]),
    stream([
      [
        String(BigInt(Date.parse(scope.end)) * 1000000n),
        JSON.stringify(record()),
      ],
    ]),
    stream([[String(ns), 'not-json']]),
    stream([[String(ns), JSON.stringify({ ...record(), duration_ms: -1 })]]),
  ]) {
    payload = body;
    const r = await adapter.query(scope);
    assert.equal(r.status, 'unavailable');
    assert.deepEqual(r.evidence, []);
  }
});
test('limit sentinel marks truncation instead of complete query coverage', async (t) => {
  const rows = [0, 1, 2].map((i) => {
    const stamp = ns + BigInt(i);
    return [String(stamp), JSON.stringify(record(String(i).repeat(32), stamp))];
  });
  const s = await server(t, (_, res) => send(res, stream(rows)));
  const r = await new LokiLogsAdapter({
    scope,
    baseUrl: s.url,
    limit: 2,
  }).query(scope);
  assert.equal(r.status, 'ok');
  assert.equal(r.evidence.length, 2);
  assert.equal(r.partial, true);
  assert.equal(r.truncated, true);
});
test('empty successful query remains empty; timeout and redirects cannot become evidence', async (t) => {
  let mode = 'empty';
  const s = await server(t, (req, res) => {
    if (mode === 'timeout') return;
    if (mode === 'redirect') {
      res.writeHead(302, { Location: '/unexpected' });
      return res.end();
    }
    send(res, {
      status: 'success',
      data: { resultType: 'streams', result: [] },
    });
  });
  const a = new LokiLogsAdapter({ scope, baseUrl: s.url, timeoutMs: 30 });
  assert.equal((await a.query(scope)).status, 'empty');
  mode = 'timeout';
  assert.equal((await a.query(scope)).error.code, 'QUERY_TIMEOUT');
  mode = 'redirect';
  const count = s.calls();
  assert.equal((await a.query(scope)).status, 'unavailable');
  assert.equal(s.calls(), count + 1);
});
test('unexpected matrix, oversized body and conflicting identities are rejected', async (t) => {
  let payload = {
    status: 'success',
    data: { resultType: 'matrix', result: [] },
  };
  const s = await server(t, (_, res) => send(res, payload));
  const a = new LokiLogsAdapter({ scope, baseUrl: s.url });
  assert.equal((await a.query(scope)).status, 'unavailable');
  payload = stream([
    [String(ns), JSON.stringify(record())],
    [String(ns), JSON.stringify({ ...record(), message: 'different' })],
  ]);
  assert.equal((await a.query(scope)).status, 'unavailable');
  payload = { padding: 'x'.repeat(2 * 1024 * 1024) };
  assert.equal((await a.query(scope)).error.code, 'RESPONSE_TOO_LARGE');
});
