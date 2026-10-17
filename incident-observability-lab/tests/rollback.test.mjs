import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApprovalStore, digest } from '../approval/store.mjs';
import {
  templateDigest,
  bindRollback,
  rollbackPatch,
  executeRollback,
  releaseBackend,
} from '../approval/rollback.mjs';
import { startReleaseGateway } from '../approval/release-gateway.mjs';
import { gatewayRequest } from '../approval/gateway.mjs';
import { fixture, backendFixture, newPod } from './rollback-fixtures.mjs';
function storeFor(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ApprovalStore(path.join(root, 'data/incident-approval'));
  store.initialize();
  return { root, store };
}
function issue(store, target) {
  return store.create({
    action: 'rollback_deployment',
    target,
    evidence_digest: digest({ measured: true }),
    evidence_run_id: randomUUID(),
    scope: {
      service: 'checkout-api',
      namespace: 'demo',
      start: '2026-10-18T00:00:00Z',
      end: '2026-10-18T00:01:00Z',
    },
    reason: 'Measured healthy baseline and current local release regression.',
  });
}

test('rollback binds actual healthy history, faulty current revision, same unready Pod and measured HTTP responses', () => {
  const f = fixture();
  assert.equal(f.target.current_revision, 2);
  assert.equal(f.target.stable_revision, 1);
  assert.notEqual(
    f.target.current_template_digest,
    f.target.stable_template_digest,
  );
  assert.equal(
    f.target.stable_template_digest,
    templateDigest(f.observed.replicasets[0].spec.template),
  );
});
test('missing healthy proof, wrong owner, ready Pod, mixed HTTP data or another Pod cannot create rollback', () => {
  for (const alter of [
    (f) => {
      f.proof.deployment_uid = randomUUID();
    },
    (f) => {
      f.observed.replicasets[0].metadata.ownerReferences[0].uid = randomUUID();
    },
    (f) => {
      f.observed.pods[0].status.conditions[0].status = 'True';
    },
    (f) => {
      f.observed.responses[0].status = 200;
    },
    (f) => {
      f.observed.health.pod_uid = randomUUID();
    },
  ]) {
    const f = fixture();
    alter(f);
    assert.throws(() => bindRollback(f.observed, f.proof));
  }
});
test('unknown targets, namespaces and equal or future revisions are rejected by signed proposal policy', (t) => {
  const { store } = storeFor(t);
  for (const changed of [
    { deployment: 'another' },
    { namespace: 'production' },
    { stable_revision: 2 },
    { stable_revision: 3 },
    { stable_replicaset: '../../outside' },
  ])
    assert.throws(() => issue(store, { ...fixture().target, ...changed }), {
      code: 'SCOPE_DENIED',
    });
});
test('rollback proposal requires separate approval and is consumed once across process reloads', async (t) => {
  const { root, store } = storeFor(t),
    f = fixture();
  const p = issue(store, f.target),
    id = p.proposal.proposal_id;
  await assert.rejects(store.execute(id, async () => {}));
  store.approve(id);
  const b = backendFixture(f);
  const result = await store.execute(id, (proposal) =>
    executeRollback(proposal, b),
  );
  assert.equal(result.status, 'verified');
  assert.equal(b.writes.length, 1);
  const reloaded = new ApprovalStore(path.join(root, 'data/incident-approval'));
  await assert.rejects(
    reloaded.execute(id, async () => assert.fail('must not execute twice')),
    { code: 'REPLAY_DENIED' },
  );
});
test('atomic patch tests UID, resourceVersion, generation, replicas and full current template before one replacement', () => {
  const f = fixture(),
    operations = rollbackPatch(
      f.proposal,
      f.observed.deployment,
      f.observed.replicasets,
    );
  assert.deepEqual(
    operations.slice(0, -1).map((x) => x.path),
    [
      '/metadata/uid',
      '/metadata/resourceVersion',
      '/metadata/generation',
      '/spec/replicas',
      '/spec/template',
    ],
  );
  assert.equal(operations.at(-1).op, 'replace');
  assert.equal(operations.at(-1).path, '/spec/template');
  assert.equal(
    templateDigest(operations.at(-1).value),
    f.target.stable_template_digest,
  );
  assert.equal(
    operations.at(-1).value.metadata.labels['pod-template-hash'],
    undefined,
  );
});
test('changed generation, target UID, current template or historical template blocks before patch', async () => {
  for (const change of [
    (f) => {
      f.observed.deployment.metadata.generation++;
    },
    (f) => {
      f.observed.deployment.metadata.uid = randomUUID();
    },
    (f) => {
      f.observed.deployment.spec.template.spec.containers[0].image =
        'different';
    },
    (f) => {
      f.observed.replicasets[0].spec.template.spec.containers[0].image =
        'different';
    },
  ]) {
    const f = fixture();
    change(f);
    const b = backendFixture(f);
    await assert.rejects(executeRollback(f.proposal, b), {
      code: 'PRECONDITION_FAILED',
    });
    assert.equal(b.writes.length, 0);
  }
});
test('restored template, new owned Pod Ready and three HTTP 200 responses verify actual recovery', async () => {
  const f = fixture(),
    b = backendFixture(f),
    r = await executeRollback(f.proposal, b);
  assert.equal(r.pod_after, newPod);
  assert.equal(r.release, 'stable-v1');
  assert.deepEqual(r.http_statuses, [200, 200, 200]);
  assert.equal(r.generation_after, 3);
  assert.equal(r.revision_after, 3);
  assert.equal(b.writes.length, 1);
});
test('lost patch response is verified through state, never followed by a second write', async () => {
  const f = fixture(),
    b = backendFixture(f, { lostResponse: true });
  const r = await executeRollback(f.proposal, b);
  assert.equal(r.command_reported_error, true);
  assert.equal(b.writes.length, 1);
});
test('atomic conflict consumes approval and does not retry or treat unchanged state as recovery', async (t) => {
  const { store } = storeFor(t),
    f = fixture(),
    p = issue(store, f.target),
    id = p.proposal.proposal_id;
  store.approve(id);
  const b = backendFixture(f, { conflict: true });
  assert.equal(
    (await store.execute(id, (p) => executeRollback(p, b))).status,
    'precondition_failed',
  );
  assert.equal(b.writes.length, 1);
  await assert.rejects(
    store.execute(id, async () => {}),
    { code: 'REPLAY_DENIED' },
  );
});
test('concurrent rollout after patch fails visibly and never reissues rollback', async () => {
  const f = fixture();
  f.after.deployment.metadata.generation = 4;
  const b = backendFixture(f);
  await assert.rejects(executeRollback(f.proposal, b), {
    code: 'CONCURRENT_ROLLOUT',
  });
  assert.equal(b.writes.length, 1);
});
test('successful patch without measured HTTP recovery cannot count as verified', async () => {
  const f = fixture(),
    b = backendFixture(f);
  b.checkout = async () => ({ status: 503 });
  await assert.rejects(executeRollback(f.proposal, b), {
    code: 'VERIFICATION_TIMEOUT',
  });
  assert.equal(b.writes.length, 1);
});
test('release reader rejects mutation before loading any credentials', async () => {
  const b = releaseBackend('/missing-root', 'reader');
  await assert.rejects(b.patch([]), { code: 'ACTION_DENIED' });
});
test('release broker rejects fake approval, arbitrary APIs, scope edits and proposal before evidence', async (t) => {
  const { root, store } = storeFor(t),
    f = fixture();
  const g = await startReleaseGateway({
    root,
    store,
    backend: backendFixture(f),
    stableProof: f.proof,
    httpTestOnly: true,
  });
  t.after(() => g.close());
  for (const route of [
    '/incident/approve',
    '/incident/execute',
    '/fetch',
    '/shell',
  ])
    assert.equal(
      (await gatewayRequest(g.testAddress, route, {})).code,
      'ROUTE_DENIED',
    );
  assert.equal(
    (
      await gatewayRequest(g.testAddress, '/release/observe', {
        namespace: 'production',
      })
    ).code,
    'SCOPE_DENIED',
  );
  assert.equal(
    (
      await gatewayRequest(g.testAddress, '/release/propose', {
        action: 'rollback_deployment',
        reason: 'premature',
      })
    ).code,
    'EVIDENCE_REQUIRED',
  );
});
test('isolated release broker seals observed evidence and one pending rollback with no execution route', async (t) => {
  const { root, store } = storeFor(t),
    f = fixture(),
    b = backendFixture(f);
  const g = await startReleaseGateway({
    root,
    store,
    backend: b,
    stableProof: f.proof,
    httpTestOnly: true,
  });
  t.after(() => g.close());
  assert.equal(
    (await gatewayRequest(g.testAddress, '/release/observe', {})).status,
    'observed',
  );
  const p = await gatewayRequest(g.testAddress, '/release/propose', {
    action: 'rollback_deployment',
    reason: 'Restore the measured healthy release.',
  });
  assert.equal(p.status, 'pending_human_approval');
  assert.equal(p.requires_human_approval, true);
  assert.equal(store.read(p.proposal.proposal_id).target.current_revision, 2);
  assert.equal(
    (
      await gatewayRequest(g.testAddress, '/release/propose', {
        action: 'rollback_deployment',
        reason: 'again',
      })
    ).code,
    'PROPOSAL_LIMIT',
  );
  assert.equal(b.writes.length, 0);
});
