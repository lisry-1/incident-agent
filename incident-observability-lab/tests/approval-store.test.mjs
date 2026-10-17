import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApprovalStore, digest } from '../approval/store.mjs';
import {
  executeRestart,
  restartArguments,
  RESTART_CODE,
} from '../approval/executor.mjs';
const target = {
  cluster: 'incident-lab',
  namespace: 'demo',
  pod: 'checkout-k8s',
  pod_uid: '11111111-1111-4111-8111-111111111111',
  container: 'checkout',
  instance_id: 'a'.repeat(32),
  restart_count: 1,
};
function context(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'approval-'));
  let now = 1000000;
  const store = new ApprovalStore(dir, { clock: () => now });
  store.initialize();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const create = () =>
    store.create({
      action: 'restart_container',
      target: structuredClone(target),
      evidence_digest: 'b'.repeat(64),
      evidence_run_id: '22222222-2222-4222-8222-222222222222',
      scope: {
        service: 'checkout-api',
        namespace: 'demo',
        start: '2026-10-17T10:00:00Z',
        end: '2026-10-17T10:02:00Z',
      },
      reason: 'Observed local fault.',
    });
  return { store, dir, create, advance: (ms) => (now += ms) };
}
test('pending proposal cannot execute without a distinct human signature', async (t) => {
  const { store, create } = context(t),
    p = create();
  let calls = 0;
  await assert.rejects(
    () => store.execute(p.proposal.proposal_id, async () => calls++),
    { code: 'APPROVAL_REQUIRED' },
  );
  assert.equal(calls, 0);
  const keys = store.initialize();
  assert.notEqual(keys.proposer_key_id, keys.approver_key_id);
});
test('valid approval binds one proposal and is consumed before executor starts', async (t) => {
  const { store, dir, create } = context(t),
    p = create(),
    id = p.proposal.proposal_id;
  store.approve(id);
  const receipt = await store.execute(id, async (proposal) => {
    assert.ok(existsSync(path.join(dir, 'consumed', id + '.json')));
    assert.match(
      readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'),
      /execution_reserved/,
    );
    assert.equal(digest(proposal), p.proposal_digest);
    return { ready: true };
  });
  assert.equal(receipt.status, 'verified');
  await assert.rejects(() => store.execute(id, async () => {}), {
    code: 'REPLAY_DENIED',
  });
});
test('proposal target or parameters cannot be altered after issuance', (t) => {
  const { store, dir, create } = context(t);
  for (const change of [
    (p) => (p.target.namespace = 'production'),
    (p) => (p.target.instance_id = 'c'.repeat(32)),
    (p) => (p.parameters.pid = 2),
    (p) => (p.scope.end = '2026-10-18T00:00:00Z'),
  ]) {
    const p = create(),
      file = path.join(dir, 'proposals', p.proposal.proposal_id + '.json'),
      e = JSON.parse(readFileSync(file, 'utf8'));
    change(e.proposal);
    writeFileSync(file, JSON.stringify(e));
    assert.throws(() => store.read(p.proposal.proposal_id), {
      code: 'PROPOSAL_TAMPERED',
    });
  }
});
test('fabricated approval booleans and signed-message edits cannot authorize', (t) => {
  const { store, dir, create } = context(t),
    p = create(),
    id = p.proposal.proposal_id;
  writeFileSync(
    path.join(dir, 'approvals', id + '.json'),
    JSON.stringify({ approved: true }),
  );
  assert.throws(() => store.authorize(id));
  rmSync(path.join(dir, 'approvals', id + '.json'));
  store.approve(id);
  const file = path.join(dir, 'approvals', id + '.json'),
    a = JSON.parse(readFileSync(file, 'utf8'));
  a.approval.proposal_digest = 'f'.repeat(64);
  writeFileSync(file, JSON.stringify(a));
  assert.throws(() => store.authorize(id), { code: 'APPROVAL_TAMPERED' });
});
test('approval cannot be copied to another valid proposal', (t) => {
  const { store, dir, create } = context(t),
    one = create(),
    two = create();
  store.approve(one.proposal.proposal_id);
  writeFileSync(
    path.join(dir, 'approvals', two.proposal.proposal_id + '.json'),
    readFileSync(
      path.join(dir, 'approvals', one.proposal.proposal_id + '.json'),
    ),
  );
  assert.throws(() => store.authorize(two.proposal.proposal_id), {
    code: 'APPROVAL_TAMPERED',
  });
});
test('proposal and approval lifetimes expire independently', (t) => {
  const a = context(t),
    p = a.create();
  a.advance(600001);
  assert.throws(() => a.store.read(p.proposal.proposal_id), {
    code: 'PROPOSAL_EXPIRED',
  });
  const b = context(t),
    q = b.create();
  b.store.approve(q.proposal.proposal_id);
  b.advance(120001);
  assert.throws(() => b.store.authorize(q.proposal.proposal_id), {
    code: 'APPROVAL_EXPIRED',
  });
});
test('unknown action, scope and arbitrary parameters are rejected at issuance', (t) => {
  const { store } = context(t);
  for (const t of [
    { ...target, namespace: 'production' },
    { ...target, pod: 'other' },
    { ...target, command: 'sh' },
    { ...target, restart_count: -1 },
  ])
    assert.throws(() =>
      store.create({ action: 'restart_container', target: t }),
    );
  assert.throws(() => store.create({ action: 'rollback', target }), {
    code: 'ACTION_DENIED',
  });
});
test('concurrent execution attempts result in one executor call', async (t) => {
  const { store, create } = context(t),
    p = create(),
    id = p.proposal.proposal_id;
  store.approve(id);
  let calls = 0;
  const result = await Promise.allSettled([
    store.execute(id, async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return {};
    }),
    store.execute(id, async () => {
      calls++;
      return {};
    }),
  ]);
  assert.equal(calls, 1);
  assert.equal(
    result.filter(
      (r) => r.status === 'rejected' && r.reason.code === 'REPLAY_DENIED',
    ).length,
    1,
  );
});
test('uncertain execution or process restart never re-arms consumed approval', async (t) => {
  const { store, dir, create } = context(t),
    p = create(),
    id = p.proposal.proposal_id;
  store.approve(id);
  const receipt = await store.execute(id, async () => {
    throw new Error('Lost connection after possible mutation');
  });
  assert.equal(receipt.status, 'execution_unknown_or_failed');
  const restored = new ApprovalStore(dir, { clock: () => 1000000 });
  await assert.rejects(() => restored.execute(id, async () => {}), {
    code: 'REPLAY_DENIED',
  });
});
test('fixed restart argv has no shell and carries UID and instance as separate arguments', () => {
  const args = restartArguments(target);
  assert.equal(args.includes('sh'), false);
  assert.equal(args.at(-2), target.pod_uid);
  assert.equal(args.at(-1), target.instance_id);
  assert.ok(args.includes(RESTART_CODE));
});
function backend() {
  let restarted = false;
  return {
    calls: 0,
    async snapshot() {
      return {
        pod_uid: target.pod_uid,
        restart_count: target.restart_count + (restarted ? 1 : 0),
        ready: restarted ? 'True' : 'False',
      };
    },
    async health() {
      return {
        pod_uid: target.pod_uid,
        instance_id: restarted ? 'c'.repeat(32) : target.instance_id,
        mode: restarted ? 'healthy' : 'fault',
      };
    },
    async restart() {
      this.calls++;
      restarted = true;
      throw new Error('exec disconnected after SIGTERM');
    },
    async delay() {},
  };
}
test('restart verifies actual changed instance, restart count and Ready after lost exec response', async () => {
  const b = backend(),
    result = await executeRestart({ target }, b);
  assert.equal(b.calls, 1);
  assert.equal(result.command_reported_error, true);
  assert.equal(result.restart_count_after, 2);
});
test('stale instance and changed Pod block before any exec', async () => {
  for (const change of [
    (b) =>
      (b.health = async () => ({
        pod_uid: target.pod_uid,
        instance_id: 'f'.repeat(32),
        mode: 'fault',
      })),
    (b) => (b.snapshot = async () => ({ pod_uid: 'other', restart_count: 1 })),
  ]) {
    const b = backend();
    change(b);
    await assert.rejects(() => executeRestart({ target }, b), {
      code: 'PRECONDITION_FAILED',
    });
    assert.equal(b.calls, 0);
  }
});
test('successful command status alone cannot establish recovery or trigger retry', async () => {
  const b = backend();
  b.restart = async () => {
    b.calls++;
  };
  await assert.rejects(() => executeRestart({ target }, b), {
    code: 'VERIFICATION_TIMEOUT',
  });
  assert.equal(b.calls, 1);
});

test('executor credential validator rejects exec plugins, foreign API, wrong identity and broad contexts', async () => {
  const { validateExecutorConfig } = await import('../approval/executor.mjs');
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'system:serviceaccount:demo:incident-executor', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.dGVzdA`;
  const cfg = {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [
      {
        name: 'incident-lab',
        cluster: {
          server: 'https://127.0.0.1:6443',
          'certificate-authority-data': 'test',
        },
      },
    ],
    users: [{ name: 'incident-executor', user: { token } }],
    contexts: [
      {
        name: 'incident-executor',
        context: {
          cluster: 'incident-lab',
          user: 'incident-executor',
          namespace: 'demo',
        },
      },
    ],
    'current-context': 'incident-executor',
  };
  assert.doesNotThrow(() => validateExecutorConfig(cfg));
  for (const change of [
    (c) => (c.users[0].user.exec = { command: 'sh' }),
    (c) => (c.clusters[0].cluster.server = 'https://example.com:6443'),
    (c) => (c.contexts[0].context.namespace = 'production'),
    (c) => c.users.push({ name: 'other', user: { exec: { command: 'sh' } } }),
  ]) {
    const bad = structuredClone(cfg);
    change(bad);
    assert.throws(() => validateExecutorConfig(bad));
  }
});
