import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { checkTarget, fail } from './store.mjs';
const exec = promisify(execFile);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// All code and endpoints are constant policy. UUID/instance ID are passed as argv,
// never interpolated into a shell. Checks happen inside the exact target container.
export const RESTART_CODE =
  "import json,os,signal,sys,urllib.request; assert os.environ.get('POD_UID') == sys.argv[1]; h=json.load(urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=2)); assert h.get('instance_id') == sys.argv[2] and h.get('mode') == 'fault'; os.kill(1,signal.SIGTERM)";
export function restartArguments(target) {
  checkTarget(target);
  return [
    'exec',
    '-n',
    'demo',
    'checkout-k8s',
    '-c',
    'checkout',
    '--',
    'python',
    '-c',
    RESTART_CODE,
    target.pod_uid,
    target.instance_id,
  ];
}
export async function appHealth() {
  const response = await fetch('http://127.0.0.1:18081/health', {
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok)
    fail('PRECONDITION_FAILED', 'Local app health is unavailable.');
  const body = await response.json();
  if (
    body.data_mode !== 'live_lab' ||
    !/^[a-f0-9]{32}$/.test(body.instance_id ?? '')
  )
    fail(
      'PRECONDITION_FAILED',
      'Upgrade the local Kubernetes app before using approvals.',
    );
  return body;
}

export function validateExecutorConfig(cfg) {
  const exact = (obj, names) =>
    obj && Object.keys(obj).sort().join(',') === [...names].sort().join(',');
  if (
    !exact(cfg, [
      'apiVersion',
      'kind',
      'clusters',
      'users',
      'contexts',
      'current-context',
    ]) ||
    cfg.apiVersion !== 'v1' ||
    cfg.kind !== 'Config' ||
    cfg['current-context'] !== 'incident-executor' ||
    cfg.clusters?.length !== 1 ||
    cfg.users?.length !== 1 ||
    cfg.contexts?.length !== 1
  )
    fail('INVALID_CREDENTIALS', 'Unexpected executor kubeconfig shape.');
  const cluster = cfg.clusters[0],
    user = cfg.users[0],
    context = cfg.contexts[0];
  if (
    cluster.name !== 'incident-lab' ||
    user.name !== 'incident-executor' ||
    context.name !== 'incident-executor' ||
    !exact(cluster.cluster, ['server', 'certificate-authority-data']) ||
    !exact(user.user, ['token']) ||
    !exact(context.context, ['cluster', 'user', 'namespace']) ||
    context.context.cluster !== 'incident-lab' ||
    context.context.user !== 'incident-executor' ||
    context.context.namespace !== 'demo'
  )
    fail(
      'INVALID_CREDENTIALS',
      'Only the generated executor identity is accepted.',
    );
  const url = new URL(cluster.cluster.server);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail(
      'INVALID_CREDENTIALS',
      'Executor API must be pinned to HTTPS loopback.',
    );
  if (
    typeof user.user.token !== 'string' ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(user.user.token)
  )
    fail('INVALID_CREDENTIALS', 'Expected a ServiceAccount token.');
  let claims;
  try {
    claims = JSON.parse(
      Buffer.from(user.user.token.split('.')[1], 'base64url').toString(),
    );
  } catch {
    fail('INVALID_CREDENTIALS', 'Invalid token claims.');
  }
  if (
    claims.sub !== 'system:serviceaccount:demo:incident-executor' ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp * 1000 <= Date.now()
  )
    fail('TOKEN_EXPIRED', 'Renew executor credentials using approval setup.');
}

export function executorBackend(root) {
  const kubectl = path.join(root, 'data/incident-k8s/bin/kubectl');
  const credentialFile = path.join(
    root,
    'data/incident-approval/executor.json',
  );
  async function call(args) {
    const stat = statSync(credentialFile);
    if (stat.mode & 0o077)
      fail('INVALID_CREDENTIALS', 'Executor kubeconfig must have mode 600.');
    const cfg = JSON.parse(readFileSync(credentialFile, 'utf8'));
    validateExecutorConfig(cfg);
    // Do not surface kubectl stderr: it may contain connection/config details.
    try {
      return await exec(
        kubectl,
        [
          '--cache-dir',
          path.join(root, 'data/incident-approval/kube-cache'),
          '--kubeconfig',
          credentialFile,
          '--context',
          'incident-executor',
          '--request-timeout=5s',
          ...args,
        ],
        {
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          env: { PATH: process.env.PATH },
        },
      );
    } catch {
      fail(
        'EXECUTOR_COMMAND_FAILED',
        'The fixed executor request did not complete successfully.',
      );
    }
  }
  return {
    async snapshot() {
      const { stdout } = await call([
        'get',
        'pod',
        'checkout-k8s',
        '-n',
        'demo',
        '-o',
        'json',
      ]);
      const pod = JSON.parse(stdout);
      if (
        pod.metadata?.namespace !== 'demo' ||
        pod.metadata.name !== 'checkout-k8s' ||
        pod.metadata.labels?.app !== 'checkout-api'
      )
        fail('PRECONDITION_FAILED', 'Unexpected Pod.');
      const container = pod.status?.containerStatuses?.find(
        (c) => c.name === 'checkout',
      );
      return {
        pod_uid: pod.metadata.uid,
        restart_count: container?.restartCount,
        ready: pod.status?.conditions?.find((c) => c.type === 'Ready')?.status,
      };
    },
    health: appHealth,
    async restart(target) {
      return call(restartArguments(target));
    },
    delay,
  };
}
export async function executeRestart(proposal, backend) {
  checkTarget(proposal.target);
  const t = proposal.target;
  const before = await backend.snapshot(),
    health = await backend.health();
  if (
    before.pod_uid !== t.pod_uid ||
    before.restart_count !== t.restart_count ||
    health.pod_uid !== t.pod_uid ||
    health.instance_id !== t.instance_id ||
    health.mode !== 'fault'
  )
    fail(
      'PRECONDITION_FAILED',
      'Target UID, instance, restart count or mode changed after proposal.',
    );
  let commandReportedError = false;
  try {
    await backend.restart(t);
  } catch {
    commandReportedError = true;
  }
  // Killing PID 1 can close exec before a clean exit response. Verify state instead
  // of treating transport success as proof, and never send a second restart.
  const deadline = Date.now() + 90000;
  for (let i = 0; i < 60 && Date.now() < deadline; i++) {
    await backend.delay(1000);
    try {
      const after = await backend.snapshot(),
        h = await backend.health();
      if (after.pod_uid !== t.pod_uid)
        fail('TARGET_REPLACED', 'Pod identity changed during execution.');
      if (
        after.restart_count === t.restart_count + 1 &&
        after.ready === 'True' &&
        h.pod_uid === t.pod_uid &&
        h.instance_id !== t.instance_id &&
        h.mode === 'healthy'
      )
        return {
          action: 'restart_container',
          pod_uid: t.pod_uid,
          restart_count_before: t.restart_count,
          restart_count_after: after.restart_count,
          instance_before: t.instance_id,
          instance_after: h.instance_id,
          ready: after.ready,
          mode: h.mode,
          command_reported_error: commandReportedError,
          verification:
            'One container restart observed; new instance is healthy and Ready. No service-wide or production recovery claim.',
        };
      if (after.restart_count > t.restart_count + 1)
        fail('EXCESS_RESTARTS', 'More than one restart observed.');
    } catch (e) {
      if (['TARGET_REPLACED', 'EXCESS_RESTARTS'].includes(e.code)) throw e;
    }
  }
  fail(
    'VERIFICATION_TIMEOUT',
    'Restart outcome did not verify; do not automatically retry.',
  );
}
