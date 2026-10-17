import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { JaegerTracesAdapter } from '../jaeger-adapter.mjs';
import { scope, log, payload } from './trace-fixtures.mjs';
const startNs = BigInt(Date.parse(scope.start)) * 1000000n;
async function setup(t, reply) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(req.url);
    reply(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  const adapter = new JaegerTracesAdapter({
    scope,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    timeoutMs: 200,
  });
  return { adapter, calls };
}
test('v3 exact lookup preserves two measured spans and explicit shared trace association', async (t) => {
  const { adapter, calls } = await setup(t, (_, res) =>
    res.end(JSON.stringify(payload())),
  );
  const logs = { status: 'ok', evidence: [log()] };
  adapter.observeLogs(logs);
  logs.evidence[0].trace_id = 'f'.repeat(32);
  const result = await adapter.query(scope);
  assert.equal(result.status, 'ok');
  assert.equal(result.evidence.length, 2);
  assert.equal(result.partial, false);
  const url = new URL(calls[0], 'http://localhost');
  assert.equal(url.pathname, `/api/v3/traces/${log().trace_id}`);
  assert.equal(url.searchParams.get('rawTraces'), 'true');
  assert.equal(url.searchParams.get('startTime'), scope.start);
  assert.equal(result.evidence[1].parent_span_id, log().span_id);
});
test('no observed context, arbitrary ID and expanded scope cannot cause HTTP', async (t) => {
  const { adapter, calls } = await setup(t, (_, res) => res.end('{}'));
  assert.equal(
    (await adapter.query(scope)).error.code,
    'TRACE_CONTEXT_MISSING',
  );
  await assert.rejects(
    () => adapter.query({ ...scope, trace_id: log().trace_id }),
    { code: 'INVALID_ARGUMENTS' },
  );
  await assert.rejects(
    () => adapter.query({ ...scope, namespace: 'production' }),
    { code: 'SCOPE_DENIED' },
  );
  assert.equal(calls.length, 0);
});
test('lookup budget is eight distinct traces; sampling and one missing trace are explicit', async (t) => {
  const { adapter, calls } = await setup(t, (req, res) => {
    const i = parseInt(
      new URL(req.url, 'http://x').pathname.split('/').at(-1),
      16,
    );
    if (i === 3) {
      res.writeHead(404);
      res.end('{}');
    } else res.end(JSON.stringify(payload(log(i))));
  });
  adapter.observeLogs({
    status: 'ok',
    evidence: Array.from({ length: 12 }, (_, i) => log(i + 1)),
  });
  const r = await adapter.query(scope);
  assert.equal(calls.length, 8);
  assert.equal(r.evidence.length, 14);
  assert.equal(r.partial, true);
  assert.equal(r.query_coverage.traces.candidate_traces, 12);
  assert.equal(r.query_coverage.traces.failures.length, 1);
});
test('wrong service, namespace, trace, request, times and incomplete parent structure fail without leaking evidence', async (t) => {
  let current;
  const { adapter } = await setup(t, (_, res) =>
    res.end(JSON.stringify(current)),
  );
  adapter.observeLogs({ status: 'ok', evidence: [log()] });
  const changes = [
    (b) =>
      (b.result.resourceSpans[0].resource.attributes[0].value.stringValue =
        'other'),
    (b) =>
      (b.result.resourceSpans[0].resource.attributes[1].value.stringValue =
        'production'),
    (b) =>
      (b.result.resourceSpans[0].scopeSpans[0].spans[0].traceId = 'f'.repeat(
        32,
      )),
    (b) =>
      (b.result.resourceSpans[0].scopeSpans[0].spans[0].attributes[0].value.stringValue =
        'f'.repeat(32)),
    (b) =>
      (b.result.resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano =
        String(startNs - 1n)),
    (b) =>
      (b.result.resourceSpans[0].scopeSpans[0].spans[0].endTimeUnixNano =
        String(startNs + 120000000001n)),
    (b) => b.result.resourceSpans[0].scopeSpans[0].spans.pop(),
    (b) =>
      (b.result.resourceSpans[0].scopeSpans[0].spans[1].parentSpanId =
        'c'.repeat(16)),
  ];
  for (const change of changes) {
    current = payload();
    change(current);
    const r = await adapter.query(scope);
    assert.equal(r.status, 'unavailable');
    assert.deepEqual(r.evidence, []);
  }
});
test('redirect, timeout, oversized response and malformed JSON remain bounded failures', async (t) => {
  let mode = 'redirect';
  const { adapter, calls } = await setup(t, (_, res) => {
    if (mode === 'redirect') {
      res.writeHead(302, { Location: '/unexpected' });
      res.end();
    } else if (mode === 'large') res.end('x'.repeat(2 * 1024 * 1024 + 1));
    else if (mode === 'json') res.end('{');
  });
  adapter.observeLogs({ status: 'ok', evidence: [log()] });
  for (mode of ['redirect', 'large', 'json', 'timeout'])
    assert.equal((await adapter.query(scope)).status, 'unavailable');
  assert.equal(calls.length, 4);
});
test('a new adapter cannot inherit trace IDs and unavailable logs clear old context', async (t) => {
  const { adapter, calls } = await setup(t, (_, res) =>
    res.end(JSON.stringify(payload())),
  );
  adapter.observeLogs({ status: 'ok', evidence: [log()] });
  adapter.observeLogs({ status: 'unavailable', evidence: [] });
  assert.equal(
    (await adapter.query(scope)).error.code,
    'TRACE_CONTEXT_MISSING',
  );
  assert.equal(calls.length, 0);
});
