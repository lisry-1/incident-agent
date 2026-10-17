import { releaseWorkload } from '../approval/release-workload.mjs';
import { templateDigest, bindRollback } from '../approval/rollback.mjs';
export const deploymentUid = '11111111-1111-4111-8111-111111111111';
export const stableUid = '22222222-2222-4222-8222-222222222222';
export const badUid = '33333333-3333-4333-8333-333333333333';
export const oldPod = '44444444-4444-4444-8444-444444444444';
export const newPod = '55555555-5555-4555-8555-555555555555';
const owner = (uid, kind) => [{ uid, kind, controller: true }];
export function fixture() {
  const deployment = releaseWorkload('fault');
  Object.assign(deployment.metadata, {
    uid: deploymentUid,
    generation: 2,
    resourceVersion: '100',
    annotations: { 'deployment.kubernetes.io/revision': '2' },
  });
  const stable = {
    metadata: {
      name: 'checkout-release-abc123',
      uid: stableUid,
      annotations: { 'deployment.kubernetes.io/revision': '1' },
      ownerReferences: owner(deploymentUid, 'Deployment'),
    },
    spec: { template: releaseWorkload('healthy').spec.template },
  };
  stable.spec.template.metadata.labels['pod-template-hash'] = 'abc123';
  const bad = {
    metadata: {
      name: 'checkout-release-def456',
      uid: badUid,
      annotations: { 'deployment.kubernetes.io/revision': '2' },
      ownerReferences: owner(deploymentUid, 'Deployment'),
    },
    spec: { template: structuredClone(deployment.spec.template) },
  };
  const pod = {
    metadata: {
      name: 'checkout-release-def456-pod',
      uid: oldPod,
      ownerReferences: owner(badUid, 'ReplicaSet'),
    },
    status: { conditions: [{ type: 'Ready', status: 'False' }] },
  };
  const observed = {
    deployment,
    replicasets: [stable, bad],
    pods: [pod],
    health: {
      mode: 'fault',
      release: 'regression-v2',
      pod_uid: oldPod,
      instance_id: 'a'.repeat(32),
    },
    responses: Array.from({ length: 3 }, () => ({
      status: 503,
      body: { data_mode: 'live_lab' },
    })),
  };
  const proof = {
    checked_at: new Date(Date.now() - 60000).toISOString(),
    deployment_uid: deploymentUid,
    template_digest: templateDigest(stable.spec.template),
    http_status: 200,
    release: 'stable-v1',
  };
  const target = bindRollback(observed, proof);
  const proposal = {
    action: 'rollback_deployment',
    target,
    parameters: {
      strategy: 'restore_pod_template',
      template_digest: target.stable_template_digest,
    },
  };
  const after = structuredClone(observed);
  after.deployment.spec.template = releaseWorkload('healthy').spec.template;
  Object.assign(after.deployment.metadata, {
    generation: 3,
    resourceVersion: '101',
    annotations: { 'deployment.kubernetes.io/revision': '3' },
  });
  after.deployment.status = {
    observedGeneration: 3,
    replicas: 1,
    updatedReplicas: 1,
    readyReplicas: 1,
    availableReplicas: 1,
  };
  after.replicasets[0].metadata.annotations[
    'deployment.kubernetes.io/revision'
  ] = '3';
  after.pods = [
    {
      metadata: {
        uid: newPod,
        ownerReferences: owner(stableUid, 'ReplicaSet'),
      },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    },
  ];
  after.health = {
    mode: 'healthy',
    release: 'stable-v1',
    pod_uid: newPod,
    instance_id: 'b'.repeat(32),
  };
  return { observed, proof, target, proposal, after };
}
export function backendFixture(
  f,
  { lostResponse = false, conflict = false } = {},
) {
  let state = f.observed;
  const writes = [];
  return {
    writes,
    deployment: async () => structuredClone(state.deployment),
    replicasets: async () => structuredClone(state.replicasets),
    pods: async () => structuredClone(state.pods),
    health: async () => structuredClone(state.health),
    checkout: async () => ({
      status: state === f.observed ? 503 : 200,
      body: { data_mode: 'live_lab' },
    }),
    patch: async (operations) => {
      writes.push(operations);
      if (conflict)
        throw Object.assign(new Error('Conflict'), {
          code: 'PRECONDITION_FAILED',
        });
      state = f.after;
      if (lostResponse) throw new Error('Response lost');
    },
    delay: async () => {},
  };
}
