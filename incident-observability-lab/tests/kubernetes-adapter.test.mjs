import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync } from 'node:fs';
import {
  KubernetesPodEventsAdapter,
  readerClient,
  checkReaderPermissions,
} from '../kubernetes-adapter.mjs';
import { fixture, kubeScope, pod, event } from './kube-fixtures.mjs';

test('real TLS uses pinned CA and reader token; preserves event aggregation and separates current snapshot', async (t) => {
  const f = await fixture(t, (req, res) =>
    res.end(
      JSON.stringify(
        req.url.includes('/events')
          ? { kind: 'EventList', metadata: {}, items: [event()] }
          : pod(),
      ),
    ),
  );
  const a = new KubernetesPodEventsAdapter({
    scope: kubeScope,
    credentialFile: f.file,
  });
  const r = await a.query(kubeScope);
  assert.equal(r.status, 'ok');
  assert.equal(r.evidence.length, 1);
  assert.equal(r.evidence[0].count, 3);
  assert.equal(r.evidence[0].aggregated, true);
  assert.equal(r.evidence[0].timestamp, '2026-10-17T10:01:00.123Z');
  assert.match(r.evidence[0].timestamp_ns, /123456000$/);
  assert.equal(r.current_snapshot.ready, 'True');
  assert.equal(f.calls.length, 2);
  assert.ok(
    f.calls.every(
      (c) =>
        c.method === 'GET' &&
        c.headers.authorization === `Bearer ${f.config.token}`,
    ),
  );
  const url = new URL(f.calls[1].url, 'https://localhost');
  assert.equal(url.searchParams.get('limit'), '101');
  assert.match(url.searchParams.get('fieldSelector'), /involvedObject.uid=/);
  assert.ok(!JSON.stringify(r).includes(f.config.token));
  assert.ok(!JSON.stringify(r).includes('DO_NOT_EXPOSE'));
  assert.ok(!r.evidence.some((e) => e.observed_at));
});
test('scope expansion and arbitrary API paths are rejected before TLS request', async (t) => {
  const f = await fixture(t, (_, res) => res.end('{}'));
  const a = new KubernetesPodEventsAdapter({
    scope: kubeScope,
    credentialFile: f.file,
  });
  await assert.rejects(
    () => a.query({ ...kubeScope, namespace: 'production' }),
    { code: 'SCOPE_DENIED' },
  );
  await assert.rejects(
    () => a.query({ ...kubeScope, path: '/api/v1/secrets' }),
    { code: 'INVALID_ARGUMENTS' },
  );
  await assert.rejects(
    () => a.query({ ...kubeScope, start: '2026-10-17T09:59:59Z' }),
    { code: 'SCOPE_DENIED' },
  );
  assert.equal(f.calls.length, 0);
});
test('foreign Pod, namespace, UID and malformed aggregation never leak evidence', async (t) => {
  let podBody = pod(),
    events = [event()];
  const f = await fixture(t, (req, res) =>
    res.end(
      JSON.stringify(
        req.url.includes('/events')
          ? { kind: 'EventList', items: events }
          : podBody,
      ),
    ),
  );
  const a = new KubernetesPodEventsAdapter({
    scope: kubeScope,
    credentialFile: f.file,
  });
  for (const mutate of [
    () => (podBody.metadata.namespace = 'production'),
    () => (podBody.metadata.uid = '33333333-3333-4333-8333-333333333333'),
    () =>
      (events[0].involvedObject.uid = '33333333-3333-4333-8333-333333333333'),
    () => (events[0].metadata.namespace = 'production'),
    () => (events[0].series.count = -1),
    () => (events[0].series.lastObservedTime = '2026-02-30T10:00:00.000001Z'),
  ]) {
    podBody = pod();
    events = [event()];
    mutate();
    const r = await a.query(kubeScope);
    assert.equal(r.status, 'unavailable');
    assert.deepEqual(r.evidence, []);
  }
});
test('aggregated events respect half-open windows and explicit API pagination', async (t) => {
  let last = kubeScope.end,
    continued = false;
  const f = await fixture(t, (req, res) =>
    res.end(
      JSON.stringify(
        req.url.includes('/events')
          ? {
              kind: 'EventList',
              metadata: { continue: continued ? 'next' : '' },
              items: [event(last)],
            }
          : pod(),
      ),
    ),
  );
  const a = new KubernetesPodEventsAdapter({
    scope: kubeScope,
    credentialFile: f.file,
  });
  let r = await a.query(kubeScope);
  assert.equal(r.status, 'empty');
  assert.equal(r.query_coverage.pod_events.excluded_outside_window, 1);
  last = '2026-10-17T10:01:59.999999999Z';
  continued = true;
  r = await a.query(kubeScope);
  assert.equal(r.status, 'ok');
  assert.equal(r.partial, true);
});
test('403, redirects, timeouts and oversized responses return sanitized bounded failures', async (t) => {
  let mode = '403';
  const f = await fixture(t, (_, res) => {
    if (mode === '403') {
      res.writeHead(403);
      res.end('server-secret-must-not-leak');
    }
    if (mode === 'redirect') {
      res.writeHead(302, { Location: 'https://example.com' });
      res.end();
    }
    if (mode === 'large') res.end('x'.repeat(2 * 1024 * 1024 + 1));
  });
  const a = new KubernetesPodEventsAdapter({
    scope: kubeScope,
    credentialFile: f.file,
    timeoutMs: 100,
  });
  for (mode of ['403', 'redirect', 'large', 'timeout']) {
    const r = await a.query(kubeScope);
    assert.equal(r.status, 'unavailable');
    assert.ok(!JSON.stringify(r).includes('server-secret'));
    assert.ok(!JSON.stringify(r).includes(f.config.token));
  }
  assert.equal(f.calls.length, 4);
});
test('credentials reject external endpoints, ambient exec config, expired tokens and broad file permissions', async (t) => {
  const f = await fixture(t, (_, res) => res.end('{}'));
  for (const change of [
    (c) => (c.server = 'https://example.com:6443'),
    (c) => (c.exec = { command: 'sh' }),
    (c) => (c.token = 'bad'),
    (c) =>
      (c.token = `e30.${Buffer.from(JSON.stringify({ sub: 'system:serviceaccount:demo:incident-reader', exp: 1 })).toString('base64url')}.dA`),
  ]) {
    const config = structuredClone(f.config);
    change(config);
    writeFileSync(f.file, JSON.stringify(config));
    assert.throws(() => readerClient(f.file));
  }
  writeFileSync(f.file, 'invalid-private-data');
  assert.throws(() => readerClient(f.file), { code: 'INVALID_CREDENTIALS' });
  writeFileSync(f.file, JSON.stringify(f.config));
  chmodSync(f.file, 0o644);
  assert.throws(() => readerClient(f.file), { code: 'INVALID_CREDENTIALS' });
  assert.equal(f.calls.length, 0);
});
test('RBAC verification uses only self access reviews and checks exec, mutations, secrets and foreign scope', async (t) => {
  const f = await fixture(t, (req, res) => {
    let raw = '';
    req.on('data', (b) => (raw += b));
    req.on('end', () => {
      const a = JSON.parse(raw).spec.resourceAttributes;
      const allowed =
        a.namespace === 'demo' &&
        ((a.verb === 'get' &&
          a.resource === 'pods' &&
          a.name === 'checkout-k8s') ||
          (a.verb === 'list' && a.resource === 'events'));
      res.end(JSON.stringify({ status: { allowed } }));
    });
  });
  const r = await checkReaderPermissions(f.file);
  assert.equal(r.passed, true);
  assert.equal(r.checks.length, 9);
  assert.ok(
    f.calls.every(
      (c) =>
        c.method === 'POST' &&
        c.url === '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
    ),
  );
});
