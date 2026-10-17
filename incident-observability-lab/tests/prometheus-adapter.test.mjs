import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { PrometheusMetricsAdapter, QUERIES } from '../prometheus-adapter.mjs';
const scope = {
  service: 'checkout-api',
  namespace: 'demo',
  start: '2026-10-17T06:00:00Z',
  end: '2026-10-17T06:02:00Z',
};
const timestamp = Date.parse('2026-10-17T06:01:00Z') / 1000;
const labels = { service: scope.service, namespace: scope.namespace };
const matrix = (value = '0.2', metric = labels, time = timestamp) => ({
  status: 'success',
  data: { resultType: 'matrix', result: [{ metric, values: [[time, value]] }] },
});
async function server(t, handler) {
  let calls = 0;
  const s = http.createServer((req, res) => {
    calls++;
    handler(req, res);
  });
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  t.after(() => {
    s.closeAllConnections();
    return new Promise((resolve) => s.close(resolve));
  });
  return { url: `http://127.0.0.1:${s.address().port}`, calls: () => calls };
}
const send = (res, body) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};
test('fixed GET templates, bounded lookback and exclusive end generate sourced live evidence', async (t) => {
  const urls = [];
  const s = await server(t, (req, res) => {
    assert.equal(req.method, 'GET');
    urls.push(new URL(req.url, 'http://localhost'));
    send(res, matrix());
  });
  const result = await new PrometheusMetricsAdapter({
    scope,
    baseUrl: s.url,
  }).query(scope);
  assert.equal(result.data_mode, 'live_lab');
  assert.equal(result.status, 'ok');
  assert.equal(result.partial, false);
  assert.equal(result.evidence.length, 1);
  assert.match(result.evidence[0].evidence_id, /^PROM-/);
  assert.equal(result.evidence[0].http_5xx_ratio, 0.2);
  assert.equal(urls.length, 4);
  for (const u of urls) {
    assert.equal(u.pathname, '/api/v1/query_range');
    assert.ok(Object.values(QUERIES).includes(u.searchParams.get('query')));
    assert.equal(
      Number(u.searchParams.get('start')),
      Date.parse(scope.start) / 1000 + 30,
    );
    assert.equal(
      Number(u.searchParams.get('end')),
      (Date.parse(scope.end) - 1) / 1000,
    );
  }
});
test('scope expansion, raw query injection and invalid time never reach HTTP', async (t) => {
  const s = await server(t, (_, res) => send(res, matrix()));
  const a = new PrometheusMetricsAdapter({ scope, baseUrl: s.url });
  for (const input of [
    { ...scope, namespace: 'production' },
    { ...scope, service: 'other' },
    { ...scope, start: '2026-10-17T05:00:00Z' },
    { ...scope, end: '2026-10-17T06:03:00Z' },
    { ...scope, query: 'up' },
    { ...scope, start: '2026-02-30T00:00:00Z' },
  ])
    await assert.rejects(() => a.query(input));
  assert.equal(s.calls(), 0);
});
test('reject arbitrary remote origins and credential-bearing endpoints', () => {
  for (const baseUrl of [
    'http://example.com',
    'http://u:p@localhost:19090',
    'http://localhost:19090/api',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => new PrometheusMetricsAdapter({ scope, baseUrl }));
  }
});
test('redirects are rejected instead of following another endpoint', async (t) => {
  let destinationCalls = 0;
  const s = await server(t, (req, res) => {
    if (req.url === '/other') destinationCalls++;
    res.writeHead(302, { Location: '/other' });
    res.end();
  });
  const result = await new PrometheusMetricsAdapter({
    scope,
    baseUrl: s.url,
  }).query(scope);
  assert.equal(result.status, 'unavailable');
  assert.equal(destinationCalls, 0);
});
test('wrong-scope responses cannot become evidence', async (t) => {
  const s = await server(t, (_, res) =>
    send(res, matrix('0.2', { ...labels, namespace: 'production' })),
  );
  const result = await new PrometheusMetricsAdapter({
    scope,
    baseUrl: s.url,
  }).query(scope);
  assert.equal(result.evidence.length, 0);
  assert.equal(
    result.query_coverage.http_5xx_ratio.error.code,
    'RESPONSE_SCOPE_MISMATCH',
  );
});
test('outside-window samples are rejected, including inclusive API end', async (t) => {
  const s = await server(t, (_, res) =>
    send(res, matrix('0.2', labels, Date.parse(scope.end) / 1000)),
  );
  const result = await new PrometheusMetricsAdapter({
    scope,
    baseUrl: s.url,
  }).query(scope);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.evidence.length, 0);
});
test('NaN and missing samples stay missing rather than becoming zero/healthy', async (t) => {
  const s = await server(t, (_, res) => send(res, matrix('NaN')));
  const result = await new PrometheusMetricsAdapter({
    scope,
    baseUrl: s.url,
  }).query(scope);
  assert.equal(result.status, 'empty');
  assert.equal(result.partial, true);
  assert.equal(result.evidence.length, 0);
  assert.equal(
    result.query_coverage.http_5xx_ratio.omitted_non_finite_samples,
    1,
  );
});
test('a failed metric query preserves other evidence and marks partial coverage', async (t) => {
  const s = await server(t, (req, res) => {
    if (
      new URL(req.url, 'http://localhost').searchParams.get('query') ===
      QUERIES.http_5xx_ratio
    ) {
      res.writeHead(503);
      res.end();
    } else send(res, matrix());
  });
  const result = await new PrometheusMetricsAdapter({
    scope,
    baseUrl: s.url,
  }).query(scope);
  assert.equal(result.status, 'ok');
  assert.equal(result.partial, true);
  assert.ok(result.evidence[0].missing_metrics.includes('http_5xx_ratio'));
  assert.equal(result.evidence[0].http_5xx_ratio, undefined);
});
test('query timeout is bounded and reported as unavailable', async (t) => {
  const s = await server(t, () => {});
  const result = await new PrometheusMetricsAdapter({
    scope,
    baseUrl: s.url,
    timeoutMs: 30,
  }).query(scope);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.query_coverage.target_up.error.code, 'QUERY_TIMEOUT');
});
test('API errors and unexpected response shapes do not masquerade as success', async (t) => {
  const s = await server(t, (_, res) =>
    send(res, { status: 'error', errorType: 'execution' }),
  );
  const result = await new PrometheusMetricsAdapter({
    scope,
    baseUrl: s.url,
  }).query(scope);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.query_coverage.target_up.error.code, 'INVALID_RESPONSE');
});
