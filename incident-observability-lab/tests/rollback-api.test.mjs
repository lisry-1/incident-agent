import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fixture as tlsFixture } from './kube-fixtures.mjs';
import { fixture } from './rollback-fixtures.mjs';
import {
  releaseBackend,
  observeRelease,
  executeRollback,
} from '../approval/rollback.mjs';

async function apiFixture(t, { conflict = false } = {}) {
  const f = fixture();
  let state = f.observed;
  const writes = [];
  const api = await tlsFixture(t, (req, res) => {
    if (req.method === 'PATCH') {
      assert.equal(
        req.url,
        '/apis/apps/v1/namespaces/demo/deployments/checkout-release',
      );
      assert.equal(req.headers['content-type'], 'application/json-patch+json');
      let raw = '';
      req.on('data', (b) => {
        raw += b;
      });
      req.on('end', () => {
        writes.push(JSON.parse(raw));
        if (conflict) {
          res.writeHead(422);
          res.end(JSON.stringify({ reason: 'Invalid' }));
        } else {
          state = f.after;
          res.end(JSON.stringify(state.deployment));
        }
      });
      return;
    }
    assert.equal(req.method, 'GET');
    let body;
    if (
      req.url === '/apis/apps/v1/namespaces/demo/deployments/checkout-release'
    )
      body = state.deployment;
    else if (req.url.startsWith('/apis/apps/v1/namespaces/demo/replicasets?'))
      body = { items: state.replicasets };
    else if (req.url.startsWith('/api/v1/namespaces/demo/pods?'))
      body = { items: state.pods };
    else if (req.url.endsWith('/proxy/health')) body = state.health;
    else if (req.url.endsWith('/proxy/checkout')) {
      res.statusCode = state === f.observed ? 503 : 200;
      body = { data_mode: 'live_lab' };
    } else {
      assert.fail('Unexpected endpoint: ' + req.url);
    }
    res.end(JSON.stringify(body));
  });
  const root = path.dirname(api.file),
    directory = path.join(root, 'data/incident-rollback');
  mkdirSync(directory, { recursive: true });
  for (const role of ['reader', 'executor']) {
    const name = 'incident-release-' + role;
    const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'system:serviceaccount:demo:' + name, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.dGVzdA`;
    writeFileSync(
      path.join(directory, role + '.json'),
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'Config',
        clusters: [
          {
            name: 'incident-lab',
            cluster: {
              server: api.config.server,
              'certificate-authority-data':
                api.config.certificate_authority_data,
            },
          },
        ],
        users: [{ name, user: { token } }],
        contexts: [
          {
            name,
            context: { cluster: 'incident-lab', user: name, namespace: 'demo' },
          },
        ],
        'current-context': name,
      }),
      { mode: 0o600 },
    );
  }
  return { root, f, api, writes };
}
test('TLS release backend preserves measured 503 and verifies real fixed HTTP/API request flow after one JSON patch', async (t) => {
  const { root, f, api, writes } = await apiFixture(t);
  const read = releaseBackend(root);
  const observation = await observeRelease(read);
  assert.deepEqual(
    observation.responses.map((r) => r.status),
    [503, 503, 503],
  );
  const executor = releaseBackend(root, 'executor');
  executor.delay = async () => {};
  const result = await executeRollback(f.proposal, executor);
  assert.equal(result.ready, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(result.http_statuses, [200, 200, 200]);
  assert.ok(
    api.calls.every((c) => c.headers.authorization.startsWith('Bearer ')),
  );
});
test('API JSON Patch precondition failure returns PRECONDITION_FAILED with only one request', async (t) => {
  const { root, f, writes } = await apiFixture(t, { conflict: true });
  const executor = releaseBackend(root, 'executor');
  executor.delay = async () => {};
  await assert.rejects(executeRollback(f.proposal, executor), {
    code: 'PRECONDITION_FAILED',
  });
  assert.equal(writes.length, 1);
});
