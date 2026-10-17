import { createServer } from 'node:https';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const tls = JSON.parse(
  readFileSync(new URL('./kube-test-tls.json', import.meta.url), 'utf8'),
);
export const kubeScope = {
  service: 'checkout-api',
  namespace: 'demo',
  start: '2026-10-17T10:00:00.000Z',
  end: '2026-10-17T10:02:00.000Z',
};
export const podUid = '11111111-1111-4111-8111-111111111111';
export function pod() {
  return {
    kind: 'Pod',
    metadata: {
      name: 'checkout-k8s',
      namespace: 'demo',
      uid: podUid,
      labels: { app: 'checkout-api', 'incident-lab/cluster': 'incident-lab' },
    },
    spec: {
      containers: [
        { env: [{ name: 'DO_NOT_EXPOSE', value: 'not-real-but-sensitive' }] },
      ],
    },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [{ restartCount: 0 }],
    },
  };
}
export function event(last = '2026-10-17T10:01:00.123456Z') {
  return {
    metadata: {
      uid: '22222222-2222-4222-8222-222222222222',
      namespace: 'demo',
      resourceVersion: '20',
    },
    involvedObject: {
      kind: 'Pod',
      name: 'checkout-k8s',
      namespace: 'demo',
      uid: podUid,
    },
    type: 'Warning',
    reason: 'Unhealthy',
    message: 'Readiness probe failed: HTTP probe failed with statuscode: 503',
    firstTimestamp: '2026-10-17T10:00:55Z',
    series: { lastObservedTime: last, count: 3 },
  };
}
export async function fixture(t, reply) {
  const calls = [];
  const server = createServer(tls, (req, res) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers });
    reply(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(path.join(tmpdir(), 'incident-kube-'));
  const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'system:serviceaccount:demo:incident-reader', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.dGVzdA`;
  const config = {
    cluster: 'incident-lab',
    namespace: 'demo',
    pod_name: 'checkout-k8s',
    pod_uid: podUid,
    server: `https://127.0.0.1:${server.address().port}`,
    certificate_authority_data: Buffer.from(tls.cert).toString('base64'),
    token,
  };
  const file = path.join(dir, 'reader.json');
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          r();
        });
      }),
  );
  return { calls, config, file };
}
