import https from 'node:https';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { digest, canonical, checkRollbackTarget, fail } from './store.mjs';
import { validateExecutorConfig } from './executor.mjs';

export const RELEASE_IMAGE = 'incident-checkout:k8s-v11';
export const RELEASE_SELECTOR = 'app=incident-checkout-release';
const DEPLOYMENT = '/apis/apps/v1/namespaces/demo/deployments/checkout-release';
const SERVICE = '/api/v1/namespaces/demo/services/checkout-release/proxy';
const revision = (object) =>
  Number(object.metadata?.annotations?.['deployment.kubernetes.io/revision']);
const owner = (object, uid, kind) =>
  object.metadata?.ownerReferences?.some(
    (o) => o.uid === uid && o.kind === kind && o.controller === true,
  );
export function template(value) {
  const copy = structuredClone(value);
  if (!copy?.metadata || !copy.spec)
    fail('PRECONDITION_FAILED', 'Missing Pod template.');
  delete copy.metadata.labels?.['pod-template-hash'];
  delete copy.metadata.creationTimestamp;
  return copy;
}
export const templateDigest = (value) => digest(template(value));
export function checkReleaseTemplate(value, mode) {
  const t = template(value),
    c = t.spec.containers;
  if (
    c?.length !== 1 ||
    c[0].name !== 'checkout' ||
    c[0].image !== RELEASE_IMAGE ||
    t.metadata.labels?.app !== 'incident-checkout-release' ||
    c[0].env?.find((e) => e.name === 'LAB_INITIAL_MODE')?.value !== mode ||
    c[0].env?.find((e) => e.name === 'LAB_RELEASE')?.value !==
      (mode === 'healthy' ? 'stable-v1' : 'regression-v2')
  )
    fail('PRECONDITION_FAILED', 'Unexpected release template.');
  return t;
}
function deploymentCheck(d) {
  if (
    d.metadata?.name !== 'checkout-release' ||
    d.metadata.namespace !== 'demo' ||
    !d.metadata.uid ||
    d.spec?.replicas !== 1 ||
    d.spec.strategy?.type !== 'Recreate' ||
    d.spec.paused
  )
    fail(
      'PRECONDITION_FAILED',
      'Expected one unpaused local Recreate Deployment.',
    );
}
export function bindRollback(observed, stableProof) {
  const { deployment: d, replicasets, pods, health, responses } = observed;
  deploymentCheck(d);
  checkReleaseTemplate(d.spec.template, 'fault');
  if (
    stableProof?.deployment_uid !== d.metadata.uid ||
    stableProof.http_status !== 200 ||
    stableProof.release !== 'stable-v1' ||
    !stableProof.template_digest
  )
    fail(
      'EVIDENCE_REQUIRED',
      'A measured healthy baseline for this Deployment is required.',
    );
  const owned = replicasets.filter((r) =>
    owner(r, d.metadata.uid, 'Deployment'),
  );
  const stable = owned.find(
    (r) => templateDigest(r.spec.template) === stableProof.template_digest,
  );
  const current = owned.find(
    (r) => templateDigest(r.spec.template) === templateDigest(d.spec.template),
  );
  if (!stable || !current || stable.metadata.uid === current.metadata.uid)
    fail(
      'EVIDENCE_REQUIRED',
      'Healthy history and current ReplicaSet must both exist.',
    );
  checkReleaseTemplate(stable.spec.template, 'healthy');
  if (revision(current) !== revision(d))
    fail('PRECONDITION_FAILED', 'Deployment revision has not settled.');
  const active = pods.filter(
    (p) =>
      owner(p, current.metadata.uid, 'ReplicaSet') &&
      !p.metadata.deletionTimestamp,
  );
  if (
    active.length !== 1 ||
    active[0].metadata.uid !== health?.pod_uid ||
    health.mode !== 'fault' ||
    health.release !== 'regression-v2' ||
    active[0].status?.conditions?.find((c) => c.type === 'Ready')?.status !==
      'False' ||
    responses?.length !== 3 ||
    !responses.every(
      (r) => r.status === 503 && r.body?.data_mode === 'live_lab',
    )
  )
    fail(
      'EVIDENCE_REQUIRED',
      'Three measured 503 responses and the same unready release Pod are required.',
    );
  const target = {
    cluster: 'incident-lab',
    namespace: 'demo',
    deployment: 'checkout-release',
    deployment_uid: d.metadata.uid,
    generation: d.metadata.generation,
    current_revision: revision(d),
    current_template_digest: templateDigest(d.spec.template),
    stable_replicaset: stable.metadata.name,
    stable_replicaset_uid: stable.metadata.uid,
    stable_revision: revision(stable),
    stable_template_digest: templateDigest(stable.spec.template),
  };
  checkRollbackTarget(target);
  return target;
}
export function rollbackPatch(proposal, d, replicasets) {
  if (proposal.action !== 'rollback_deployment')
    fail('ACTION_DENIED', 'Expected rollback_deployment.');
  checkRollbackTarget(proposal.target);
  const t = proposal.target;
  if (
    canonical(proposal.parameters) !==
    canonical({
      strategy: 'restore_pod_template',
      template_digest: t.stable_template_digest,
    })
  )
    fail('PRECONDITION_FAILED', 'Rollback parameters changed.');
  deploymentCheck(d);
  const stable = replicasets.find(
    (r) =>
      r.metadata.name === t.stable_replicaset &&
      r.metadata.uid === t.stable_replicaset_uid,
  );
  if (
    d.metadata.uid !== t.deployment_uid ||
    d.metadata.generation !== t.generation ||
    revision(d) !== t.current_revision ||
    templateDigest(d.spec.template) !== t.current_template_digest ||
    !stable ||
    !owner(stable, t.deployment_uid, 'Deployment') ||
    revision(stable) !== t.stable_revision ||
    templateDigest(stable.spec.template) !== t.stable_template_digest
  )
    fail(
      'PRECONDITION_FAILED',
      'Deployment or approved history changed after the proposal.',
    );
  checkReleaseTemplate(d.spec.template, 'fault');
  checkReleaseTemplate(stable.spec.template, 'healthy');
  return [
    { op: 'test', path: '/metadata/uid', value: t.deployment_uid },
    {
      op: 'test',
      path: '/metadata/resourceVersion',
      value: d.metadata.resourceVersion,
    },
    { op: 'test', path: '/metadata/generation', value: t.generation },
    { op: 'test', path: '/spec/replicas', value: 1 },
    { op: 'test', path: '/spec/template', value: d.spec.template },
    {
      op: 'replace',
      path: '/spec/template',
      value: template(stable.spec.template),
    },
  ];
}

export function releaseBackend(root, role = 'reader') {
  if (!['reader', 'executor'].includes(role))
    fail('INVALID_CREDENTIALS', 'Unknown release role.');
  const file = path.join(root, 'data/incident-rollback', role + '.json');
  const identity = 'incident-release-' + role;
  async function request(endpoint, { method = 'GET', value } = {}) {
    if (statSync(file).mode & 0o077)
      fail('INVALID_CREDENTIALS', 'Release credentials must have mode 600.');
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    validateExecutorConfig(cfg, identity);
    const url = new URL(endpoint, cfg.clusters[0].cluster.server);
    const body = value ? JSON.stringify(value) : undefined;
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method,
          ca: Buffer.from(
            cfg.clusters[0].cluster['certificate-authority-data'],
            'base64',
          ),
          headers: {
            Authorization: 'Bearer ' + cfg.users[0].user.token,
            ...(body
              ? {
                  'Content-Type': 'application/json-patch+json',
                  'Content-Length': Buffer.byteLength(body),
                }
              : {}),
          },
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('error', () =>
            reject(
              Object.assign(new Error('Release API response interrupted.'), {
                code: 'RELEASE_API_FAILED',
              }),
            ),
          );
          res.on('data', (b) => {
            size += b.length;
            if (size > 4 * 1024 * 1024)
              req.destroy(new Error('Response limit'));
            else chunks.push(b);
          });
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              });
            } catch {
              reject(
                Object.assign(new Error('Invalid API response.'), {
                  code: 'RELEASE_API_FAILED',
                }),
              );
            }
          });
        },
      );
      req.setTimeout(5000, () => req.destroy(new Error('Request deadline')));
      req.on('error', () =>
        reject(
          Object.assign(new Error('Fixed release API request failed.'), {
            code: 'RELEASE_API_FAILED',
          }),
        ),
      );
      req.end(body);
    });
  }
  async function json(endpoint) {
    const r = await request(endpoint);
    if (r.status !== 200)
      fail(
        'RELEASE_API_FAILED',
        `Fixed release read returned HTTP ${r.status}.`,
      );
    return r.body;
  }
  return {
    deployment: () => json(DEPLOYMENT),
    replicasets: async () =>
      (
        await json(
          '/apis/apps/v1/namespaces/demo/replicasets?labelSelector=' +
            encodeURIComponent(RELEASE_SELECTOR),
        )
      ).items,
    pods: async () =>
      (
        await json(
          '/api/v1/namespaces/demo/pods?labelSelector=' +
            encodeURIComponent(RELEASE_SELECTOR),
        )
      ).items,
    health: () => json(SERVICE + '/health'),
    checkout: () => request(SERVICE + '/checkout'),
    async patch(operations) {
      if (role !== 'executor')
        fail('ACTION_DENIED', 'Reader cannot submit a rollback.');
      const r = await request(DEPLOYMENT, {
        method: 'PATCH',
        value: operations,
      });
      if (r.status === 409 || r.status === 422)
        fail(
          'PRECONDITION_FAILED',
          'Atomic rollback precondition failed. No automatic retry.',
        );
      if (r.status !== 200)
        fail('RELEASE_API_FAILED', `Rollback API returned HTTP ${r.status}.`);
      return r.body;
    },
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export async function observeRelease(backend) {
  const [deployment, replicasets, pods, health] = await Promise.all([
    backend.deployment(),
    backend.replicasets(),
    backend.pods(),
    backend.health(),
  ]);
  const responses = [];
  for (let i = 0; i < 3; i++) responses.push(await backend.checkout());
  return {
    observed_at: new Date().toISOString(),
    deployment,
    replicasets,
    pods,
    health,
    responses,
  };
}

export async function executeRollback(proposal, backend) {
  const [d, sets, before] = await Promise.all([
    backend.deployment(),
    backend.replicasets(),
    backend.health(),
  ]);
  const operations = rollbackPatch(proposal, d, sets);
  if (before.mode !== 'fault' || before.release !== 'regression-v2')
    fail('PRECONDITION_FAILED', 'The approved release is no longer faulty.');
  let commandReportedError = false;
  try {
    await backend.patch(operations);
  } catch (e) {
    if (e.code === 'PRECONDITION_FAILED') throw e;
    commandReportedError = true;
  }
  const deadline = Date.now() + 100000,
    t = proposal.target;
  for (let i = 0; i < 90 && Date.now() < deadline; i++) {
    await backend.delay(1000);
    try {
      const [after, replicasets, pods, h] = await Promise.all([
        backend.deployment(),
        backend.replicasets(),
        backend.pods(),
        backend.health(),
      ]);
      if (after.metadata.uid !== t.deployment_uid)
        fail('TARGET_REPLACED', 'Deployment identity changed.');
      if (after.metadata.generation > t.generation + 1)
        fail('CONCURRENT_ROLLOUT', 'Another Deployment change occurred.');
      if (
        after.metadata.generation === t.generation + 1 &&
        templateDigest(after.spec.template) !== t.stable_template_digest
      )
        fail('CONCURRENT_ROLLOUT', 'Unexpected template after rollback.');
      const stable = replicasets.find(
        (r) =>
          r.metadata.uid === t.stable_replicaset_uid &&
          owner(r, t.deployment_uid, 'Deployment'),
      );
      const active =
        stable &&
        pods.filter(
          (p) =>
            owner(p, stable.metadata.uid, 'ReplicaSet') &&
            !p.metadata.deletionTimestamp,
        );
      const ready =
        active?.length === 1 &&
        active[0].metadata.uid === h.pod_uid &&
        active[0].status?.conditions?.find((c) => c.type === 'Ready')
          ?.status === 'True';
      if (
        after.metadata.generation === t.generation + 1 &&
        templateDigest(after.spec.template) === t.stable_template_digest &&
        after.status?.observedGeneration >= after.metadata.generation &&
        after.status?.updatedReplicas === 1 &&
        after.status?.readyReplicas === 1 &&
        after.status?.availableReplicas === 1 &&
        after.status?.replicas === 1 &&
        revision(after) > t.current_revision &&
        stable &&
        templateDigest(stable.spec.template) === t.stable_template_digest &&
        ready &&
        h.mode === 'healthy' &&
        h.release === 'stable-v1' &&
        h.pod_uid !== before.pod_uid &&
        h.instance_id !== before.instance_id
      ) {
        const checks = [];
        for (let n = 0; n < 3; n++) checks.push(await backend.checkout());
        if (
          !checks.every(
            (r) => r.status === 200 && r.body?.data_mode === 'live_lab',
          )
        )
          continue;
        return {
          action: 'rollback_deployment',
          deployment_uid: t.deployment_uid,
          generation_before: t.generation,
          generation_after: after.metadata.generation,
          revision_before: t.current_revision,
          revision_after: revision(after),
          restored_template_digest: t.stable_template_digest,
          stable_replicaset_uid: stable.metadata.uid,
          pod_before: before.pod_uid,
          pod_after: h.pod_uid,
          release: h.release,
          mode: h.mode,
          ready: true,
          http_statuses: checks.map((c) => c.status),
          command_reported_error: commandReportedError,
          verification:
            'Previous measured healthy Pod template restored by one atomic patch; new Pod Ready and three HTTP 200 responses. Local experiment only.',
        };
      }
    } catch (e) {
      if (['TARGET_REPLACED', 'CONCURRENT_ROLLOUT'].includes(e.code)) throw e;
    }
  }
  fail(
    'VERIFICATION_TIMEOUT',
    'Rollback did not verify. Approval stays consumed; no automatic retry.',
  );
}
