import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ApprovalStore, fail } from './store.mjs';
import { releaseWorkload, releaseService } from './release-workload.mjs';
import { releaseBackend, observeRelease, templateDigest } from './rollback.mjs';
import { startReleaseGateway } from './release-gateway.mjs';
import { runIsolatedWorker } from './isolated-runner.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = path.join(root, 'data/incident-rollback');
const store = new ApprovalStore(path.join(root, 'data/incident-approval'));
const kubectl = path.join(root, 'data/incident-k8s/bin/kubectl');
const adminArgs = [
  '--kubeconfig',
  path.join(root, 'data/incident-k8s/admin.yaml'),
  '--context',
  'kind-incident-lab',
];
function admin(args, value) {
  return execFileSync(kubectl, [...adminArgs, ...args], {
    cwd: root,
    encoding: 'utf8',
    input: value ? JSON.stringify(value) : undefined,
    timeout: 20000,
    stdio: [value ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
}
function apply(mode) {
  admin(['apply', '-f', '-'], releaseWorkload(mode));
}
async function waitMode(mode) {
  const b = releaseBackend(root);
  const deadline = Date.now() + 120000;
  for (let i = 0; i < 90 && Date.now() < deadline; i++) {
    try {
      const o = await observeRelease(b);
      const d = o.deployment;
      const label = mode === 'healthy' ? 'stable-v1' : 'regression-v2';
      const current = d.spec.template.spec.containers[0].env.find(
        (e) => e.name === 'LAB_RELEASE',
      )?.value;
      if (
        current === label &&
        o.health.release === label &&
        o.health.mode === mode &&
        d.status?.observedGeneration >= d.metadata.generation &&
        o.responses.every(
          (r) => r.status === (mode === 'healthy' ? 200 : 503),
        ) &&
        (mode !== 'fault' ||
          o.pods.some(
            (p) =>
              p.metadata.uid === o.health.pod_uid &&
              p.status?.conditions?.some(
                (c) => c.type === 'Ready' && c.status === 'False',
              ),
          )) &&
        (mode !== 'healthy' ||
          (d.status.readyReplicas === 1 &&
            d.status.updatedReplicas === 1 &&
            d.status.replicas === 1))
      )
        return o;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(
    'RELEASE_TIMEOUT',
    'Release did not reach expected state. Inspect checkout-release; do not approve a stale proposal.',
  );
}
async function setup() {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  store.initialize();
  execFileSync(
    'docker',
    [
      'build',
      '-t',
      'incident-checkout:k8s-v11',
      path.join(root, 'incident-observability-lab'),
    ],
    { stdio: 'inherit', timeout: 240000 },
  );
  execFileSync(
    path.join(root, 'data/incident-k8s/bin/kind'),
    [
      'load',
      'docker-image',
      'incident-checkout:k8s-v11',
      '--name',
      'incident-lab',
    ],
    { stdio: 'inherit', timeout: 120000 },
  );
  admin([
    'apply',
    '-f',
    path.join(root, 'incident-observability-lab/approval/release-rbac.yaml'),
  ]);
  const cfg = JSON.parse(
    admin(['config', 'view', '--raw', '--minify', '-o', 'json']),
  );
  const checks = [];
  for (const role of ['reader', 'executor']) {
    const name = 'incident-release-' + role;
    const token = admin([
      'create',
      'token',
      name,
      '-n',
      'demo',
      '--duration=8h',
    ]);
    const file = path.join(directory, role + '.json');
    writeFileSync(
      file,
      JSON.stringify(
        {
          apiVersion: 'v1',
          kind: 'Config',
          clusters: [
            { name: 'incident-lab', cluster: cfg.clusters[0].cluster },
          ],
          users: [{ name, user: { token } }],
          contexts: [
            {
              name,
              context: {
                cluster: 'incident-lab',
                user: name,
                namespace: 'demo',
              },
            },
          ],
          'current-context': name,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    chmodSync(file, 0o600);
    for (const attributes of [
      {
        group: 'apps',
        resource: 'deployments',
        name: 'checkout-release',
        namespace: 'demo',
        verb: 'get',
        expected: true,
      },
      {
        group: 'apps',
        resource: 'deployments',
        name: 'checkout-release',
        namespace: 'demo',
        verb: 'patch',
        expected: role === 'executor',
      },
      {
        group: 'apps',
        resource: 'deployments',
        name: 'another-release',
        namespace: 'demo',
        verb: 'patch',
        expected: false,
      },
      {
        group: 'apps',
        resource: 'deployments',
        name: 'checkout-release',
        namespace: 'production',
        verb: 'patch',
        expected: false,
      },
      {
        group: '',
        resource: 'services',
        subresource: 'proxy',
        name: 'checkout-release',
        namespace: 'demo',
        verb: 'get',
        expected: true,
      },
      {
        group: '',
        resource: 'services',
        subresource: 'proxy',
        name: 'checkout-release',
        namespace: 'demo',
        verb: 'create',
        expected: false,
      },
      {
        group: '',
        resource: 'pods',
        subresource: 'exec',
        name: 'checkout-k8s',
        namespace: 'demo',
        verb: 'create',
        expected: false,
      },
      {
        group: '',
        resource: 'secrets',
        namespace: 'demo',
        verb: 'get',
        expected: false,
      },
    ]) {
      const { expected, ...a } = attributes;
      const response = JSON.parse(
        execFileSync(
          kubectl,
          [
            '--kubeconfig',
            file,
            '--context',
            name,
            '--request-timeout=5s',
            'create',
            '--raw',
            '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
            '-f',
            '-',
          ],
          {
            input: JSON.stringify({
              apiVersion: 'authorization.k8s.io/v1',
              kind: 'SelfSubjectAccessReview',
              spec: { resourceAttributes: a },
            }),
            encoding: 'utf8',
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ),
      );
      checks.push({
        role,
        ...a,
        expected,
        allowed: response.status?.allowed,
        passed: response.status?.allowed === expected,
      });
    }
  }
  if (!checks.every((c) => c.passed))
    fail(
      'RELEASE_RBAC_FAILED',
      'Release reader/executor permissions did not match policy.',
    );
  writeFileSync(
    path.join(directory, 'rbac-check.json'),
    JSON.stringify({ passed: true, checks }, null, 2) + '\n',
    { mode: 0o600 },
  );
  admin(['apply', '-f', '-'], releaseService);
  apply('healthy');
  const initial = await waitMode('healthy');
  execFileSync(
    'docker',
    [
      'build',
      '-t',
      'incident-diagnosis:v10',
      path.join(root, 'incident-observability-lab/approval/worker'),
    ],
    { stdio: 'inherit', timeout: 240000 },
  );
  console.log(
    JSON.stringify(
      {
        status: 'configured',
        release_rbac_passed: true,
        deployment: 'checkout-release',
        deployment_uid: initial.deployment.metadata.uid,
        release: initial.health.release,
        http_statuses: initial.responses.map((r) => r.status),
        note: 'Operator setup deployed a healthy local release. No approved rollback executed.',
      },
      null,
      2,
    ),
  );
}
async function exercise() {
  let gateway,
    pending = false;
  try {
    apply('healthy');
    const healthy = await waitMode('healthy');
    const proof = {
      checked_at: healthy.observed_at,
      deployment_uid: healthy.deployment.metadata.uid,
      template_digest: templateDigest(healthy.deployment.spec.template),
      http_status: 200,
      release: healthy.health.release,
      pod_uid: healthy.health.pod_uid,
      instance_id: healthy.health.instance_id,
      http_statuses: healthy.responses.map((r) => r.status),
    };
    console.error(
      'Healthy baseline measured. Operator deploying local regression-v2; rollback will require human approval.',
    );
    apply('fault');
    await waitMode('fault');
    gateway = await startReleaseGateway({
      root,
      store,
      backend: releaseBackend(root),
      stableProof: proof,
    });
    const { worker, isolation } = await runIsolatedWorker(root, gateway, {
      workflow: 'rollback',
      model: false,
    });
    if (!gateway.proposal)
      fail('PROPOSAL_MISSING', 'No rollback proposal was created.');
    const result = {
      status: 'pending_human_approval',
      llm_called: false,
      proposal_id: gateway.proposal.proposal.proposal_id,
      proposal_digest: gateway.proposal.proposal_digest,
      proposal: gateway.proposal.proposal,
      isolation,
      worker,
      diagnosis_audit: gateway.auditFile,
      note: 'Local regression remains pending human review. Reuses the signed approval mechanism; this is a deterministic release API/HTTP experiment, not a model four-source diagnosis.',
    };
    writeFileSync(
      path.join(root, 'data/incident-approval/latest-release-diagnosis.json'),
      JSON.stringify(result, null, 2) + '\n',
      { mode: 0o600 },
    );
    pending = true;
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await gateway?.close();
    if (!pending) {
      try {
        apply('healthy');
      } catch {}
    }
  }
}
async function main() {
  if (process.argv.length !== 3)
    fail('USAGE', 'Use release-cli.mjs setup | exercise | restore.');
  if (process.argv[2] === 'setup') await setup();
  else if (process.argv[2] === 'exercise') await exercise();
  else if (process.argv[2] === 'restore') {
    apply('healthy');
    const state = await waitMode('healthy');
    console.log(
      JSON.stringify({
        status: 'operator_restored_healthy',
        release: state.health.release,
        note: 'Operator ended the experiment. This is not an approved executor rollback receipt.',
      }),
    );
  } else fail('USAGE', 'Use release-cli.mjs setup | exercise | restore.');
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      status: 'error',
      code: e.code ?? 'RELEASE_COMMAND_FAILED',
      message:
        e.status !== undefined
          ? 'A fixed setup request failed; credentials were not printed.'
          : e.message,
    }),
  );
  process.exitCode = 1;
});
