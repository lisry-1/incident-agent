import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApprovalStore } from '../approval/store.mjs';
import { startGateway, gatewayRequest } from '../approval/gateway.mjs';
const scope = {
  service: 'checkout-api',
  namespace: 'demo',
  start: '2026-10-17T10:00:00Z',
  end: '2026-10-17T10:02:00Z',
};
const uid = '11111111-1111-4111-8111-111111111111';
const target = {
  cluster: 'incident-lab',
  namespace: 'demo',
  pod: 'checkout-k8s',
  pod_uid: uid,
  container: 'checkout',
  instance_id: 'a'.repeat(32),
  restart_count: 0,
};
async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'approval-gateway-'));
  const store = new ApprovalStore(path.join(root, 'data/incident-approval'));
  store.initialize();
  const evidence = (source) => [
    {
      evidence_id: source,
      source: 'test:' + source,
      data_mode: 'live_lab',
      service: 'checkout-api',
      namespace: 'demo',
      timestamp: '2026-10-17T10:01:00Z',
      pod_uid: uid,
      ...(source === 'metrics' ? { http_5xx_ratio: 1 } : {}),
      ...(source === 'pod_events' ? { reason: 'Unhealthy' } : {}),
    },
  ];
  const adapter = (source) => ({
    async query() {
      return {
        status: 'ok',
        data_mode: 'live_lab',
        evidence: evidence(source),
      };
    },
    observeLogs() {},
  });
  const gateway = await startGateway({
    root,
    scope,
    store,
    targetSnapshot: target,
    httpTestOnly: true,
    health: async () => ({
      pod_uid: uid,
      instance_id: target.instance_id,
      mode: 'fault',
    }),
    adapters: {
      metrics: adapter('metrics'),
      logs: adapter('logs'),
      traces: adapter('traces'),
      kube: adapter('pod_events'),
    },
  });
  t.after(async () => {
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = (route, input) =>
    gatewayRequest(gateway.testAddress, route, input);
  const query = (source) =>
    call('/incident/dispatch', {
      tool: source === 'metrics' ? 'incident.probe' : 'incident.investigate',
      arguments: { case: 'prometheus-lab', ...scope, source },
    });
  return { root, store, gateway, call, query };
}
test('gateway denies approval, execution, arbitrary fetch and mutation routes', async (t) => {
  const { call } = await fixture(t);
  for (const route of [
    '/incident/approve',
    '/incident/execute',
    '/fetch',
    '/shell',
  ])
    assert.equal((await call(route, { approved: true })).code, 'ROUTE_DENIED');
  assert.equal(
    (
      await call('/incident/dispatch', {
        tool: 'incident.restart',
        arguments: {},
      })
    ).code,
    'ROUTE_DENIED',
  );
});
test('read scope and stage are enforced and caller cannot propose without observed evidence', async (t) => {
  const { call, query } = await fixture(t);
  assert.equal((await query('logs')).event.code, 'STAGE_DENIED');
  assert.equal(
    (
      await call('/incident/propose', {
        action: 'restart_container',
        reason: 'x',
      })
    ).code,
    'EVIDENCE_REQUIRED',
  );
  const denied = await call('/incident/dispatch', {
    tool: 'incident.probe',
    arguments: {
      case: 'prometheus-lab',
      ...scope,
      namespace: 'production',
      source: 'metrics',
    },
  });
  assert.equal(denied.event.code, 'SCOPE_DENIED');
});
test('gateway seals evidence-bound pending proposal only after four sources and timeline', async (t) => {
  const { call, query, gateway, root, store } = await fixture(t);
  for (const source of ['metrics', 'logs', 'traces', 'pod_events'])
    assert.equal((await query(source)).event.result.status, 'ok');
  assert.equal(
    (
      await call('/incident/propose', {
        action: 'restart_container',
        reason: 'x',
      })
    ).code,
    'EVIDENCE_REQUIRED',
  );
  assert.equal(
    (
      await call('/incident/dispatch', {
        tool: 'incident.timeline',
        arguments: {},
      })
    ).event.result.status,
    'ok',
  );
  const p = await call('/incident/propose', {
    action: 'restart_container',
    reason: 'Evidence suggests a local restart for this injected fault.',
  });
  assert.equal(p.status, 'pending_human_approval');
  assert.equal(p.proposal.target.pod_uid, uid);
  assert.equal(p.proposal.evidence_run_id, gateway.guard.runId);
  assert.equal(
    store.read(p.proposal.proposal_id).evidence_digest,
    p.proposal.evidence_digest,
  );
  const bundle = JSON.parse(
    readFileSync(
      path.join(
        root,
        'data/incident-approval/evidence-' + gateway.guard.runId + '.json',
      ),
      'utf8',
    ),
  );
  assert.equal(bundle.observations.length, 4);
  assert.equal(
    (
      await call('/incident/propose', {
        action: 'restart_container',
        reason: 'again',
      })
    ).code,
    'PROPOSAL_LIMIT',
  );
  assert.equal(
    (await call('/incident/propose', { action: 'rollback', reason: 'x' })).code,
    'PROPOSAL_LIMIT',
  );
});
test('model requests are disabled by default and cannot choose arbitrary provider endpoint', async (t) => {
  const { call } = await fixture(t);
  assert.equal(
    (await call('/model/v1/messages', { url: 'http://example.com' })).code,
    'MODEL_DISABLED',
  );
});
