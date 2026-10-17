import { execFileSync, spawn } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ApprovalStore, digest, fail } from './store.mjs';
import { startGateway } from './gateway.mjs';
import { appHealth, executorBackend, executeRestart } from './executor.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = path.join(root, 'data/incident-approval');
const store = new ApprovalStore(directory);
const kubectl = path.join(root, 'data/incident-k8s/bin/kubectl');
const admin = path.join(root, 'data/incident-k8s/admin.yaml');
const execCfg = path.join(directory, 'executor.json');
const adminArgs = ['--kubeconfig', admin, '--context', 'kind-incident-lab'];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const k = (args) =>
  execFileSync(kubectl, [...adminArgs, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
async function mode(value) {
  const r = await fetch('http://127.0.0.1:18081/control/mode', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: value }),
  });
  if (!r.ok) fail('LAB_CONTROL_FAILED', 'Local mode control failed.');
  await r.body?.cancel();
}
function setup() {
  if (!existsSync(admin))
    fail('SETUP_REQUIRED', 'Complete Kubernetes setup first.');
  store.initialize();
  execFileSync(
    kubectl,
    [
      ...adminArgs,
      'apply',
      '-f',
      path.join(root, 'incident-observability-lab/approval/executor-rbac.yaml'),
    ],
    { cwd: root, stdio: 'inherit', timeout: 15000 },
  );
  const cfg = JSON.parse(
    k(['config', 'view', '--raw', '--minify', '-o', 'json']),
  );
  const token = k([
    'create',
    'token',
    'incident-executor',
    '-n',
    'demo',
    '--duration=8h',
  ]);
  const config = {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name: 'incident-lab', cluster: cfg.clusters[0].cluster }],
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
  writeFileSync(execCfg, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
  chmodSync(execCfg, 0o600);
  const expectedPermissions = [
    {
      verb: 'get',
      resource: 'pods',
      name: 'checkout-k8s',
      namespace: 'demo',
      expected: true,
    },
    {
      verb: 'create',
      resource: 'pods',
      subresource: 'exec',
      name: 'checkout-k8s',
      namespace: 'demo',
      expected: true,
    },
    {
      verb: 'create',
      resource: 'pods',
      subresource: 'exec',
      name: 'another-pod',
      namespace: 'demo',
      expected: false,
    },
    {
      verb: 'create',
      resource: 'pods',
      subresource: 'exec',
      name: 'checkout-k8s',
      namespace: 'production',
      expected: false,
    },
    { verb: 'get', resource: 'secrets', namespace: 'demo', expected: false },
    {
      verb: 'patch',
      resource: 'pods',
      name: 'checkout-k8s',
      namespace: 'demo',
      expected: false,
    },
    {
      verb: 'delete',
      resource: 'pods',
      name: 'checkout-k8s',
      namespace: 'demo',
      expected: false,
    },
  ];
  const rbac = [];
  for (const { expected, ...attributes } of expectedPermissions) {
    const review = {
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SelfSubjectAccessReview',
      spec: { resourceAttributes: { group: '', ...attributes } },
    };
    const response = JSON.parse(
      execFileSync(
        kubectl,
        [
          '--kubeconfig',
          execCfg,
          '--context',
          'incident-executor',
          '--request-timeout=5s',
          'create',
          '--raw',
          '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
          '-f',
          '-',
        ],
        {
          cwd: root,
          input: JSON.stringify(review),
          encoding: 'utf8',
          timeout: 15000,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ),
    );
    rbac.push({
      ...attributes,
      expected,
      allowed: response.status?.allowed,
      passed: response.status?.allowed === expected,
    });
  }
  if (!rbac.every((check) => check.passed))
    fail(
      'EXECUTOR_RBAC_FAILED',
      'Executor permissions differ from the fixed policy. Do not proceed.',
    );
  writeFileSync(
    path.join(directory, 'executor-rbac-check.json'),
    JSON.stringify({ passed: true, checks: rbac }, null, 2) + '\n',
    { mode: 0o600 },
  );
  execFileSync(
    'docker',
    [
      'build',
      '-t',
      'incident-diagnosis:v10',
      path.join(root, 'incident-observability-lab/approval/worker'),
    ],
    { cwd: root, stdio: 'inherit', timeout: 240000 },
  );
  console.log(
    JSON.stringify(
      {
        status: 'configured',
        executor_rbac_passed: true,
        ...store.initialize(),
        note: 'Approval keys and executor credentials remain outside the diagnosis container. No restart executed.',
      },
      null,
      2,
    ),
  );
}
async function diagnose(model) {
  store.initialize();
  if (model && !process.env.INCIDENT_APPROVAL_API_KEY)
    fail(
      'MODEL_KEY_REQUIRED',
      'Set INCIDENT_APPROVAL_API_KEY privately before --model. Never paste it into chat.',
    );
  const backend = executorBackend(root);
  let gateway,
    proposalCreated = false;
  try {
    const current = await backend.snapshot(),
      initial = await appHealth();
    if (initial.pod_uid !== current.pod_uid)
      fail('PRECONDITION_FAILED', 'App does not match the Pod.');
    await mode('fault');
    console.error(
      'Local fault injection: generating actual requests for about 35 seconds. The fault remains pending human approval after successful diagnosis.',
    );
    const until = Date.now() + 35000;
    while (Date.now() < until) {
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          const r = await fetch('http://127.0.0.1:18081/checkout', {
            redirect: 'error',
            signal: AbortSignal.timeout(3000),
          });
          if (r.status !== 503) throw new Error('Expected injected 503.');
          await r.body?.cancel();
        }),
      );
      await delay(1000);
    }
    const now = Date.now(),
      scope = {
        service: 'checkout-api',
        namespace: 'demo',
        start: new Date(now - 120000).toISOString(),
        end: new Date(now).toISOString(),
      };
    const state = await backend.snapshot(),
      h = await appHealth();
    const target = {
      cluster: 'incident-lab',
      namespace: 'demo',
      pod: 'checkout-k8s',
      pod_uid: state.pod_uid,
      container: 'checkout',
      instance_id: h.instance_id,
      restart_count: state.restart_count,
    };
    const key = model ? process.env.INCIDENT_APPROVAL_API_KEY : undefined;
    if (model && !key)
      fail(
        'MODEL_KEY_REQUIRED',
        'Set INCIDENT_APPROVAL_API_KEY privately before --model. Never paste it into chat.',
      );
    gateway = await startGateway({
      root,
      scope,
      store,
      targetSnapshot: target,
      modelKey: key,
    });
    const config = path.join(directory, 'ipc/session.json');
    if (existsSync(config)) chmodSync(config, 0o600);
    writeFileSync(config, JSON.stringify({ scope, model }), { mode: 0o444 });
    chmodSync(config, 0o444);
    const name = 'incident-diagnosis-' + Date.now();
    const args = [
      'run',
      '--name',
      name,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--user',
      '65532:65532',
      '--pids-limit',
      '64',
      '--memory',
      '256m',
      '--cpus',
      '0.5',
      '--mount',
      `type=bind,source=${gateway.socket},target=/ipc/gateway.sock,readonly`,
      '--mount',
      `type=bind,source=${config},target=/ipc/session.json,readonly`,
      'incident-diagnosis:v10',
    ];
    const child = spawn('docker', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b;
      if (stdout.length > 2 * 1024 * 1024) child.kill('SIGTERM');
    });
    child.stderr.on('data', (b) => {
      stderr += b;
      if (stderr.length > 65536) stderr = stderr.slice(-65536);
    });
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on('exit', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      const inspect = JSON.parse(
        execFileSync('docker', ['inspect', name], {
          encoding: 'utf8',
          timeout: 10000,
        }),
      )[0];
      const isolation = {
        network_none: inspect.HostConfig.NetworkMode === 'none',
        root_read_only: inspect.HostConfig.ReadonlyRootfs === true,
        no_privileged: inspect.HostConfig.Privileged === false,
        user: inspect.Config.User,
        mounts: inspect.Mounts.map((m) => ({
          destination: m.Destination,
          read_only: !m.RW,
        })),
      };
      if (code !== 0)
        fail(
          'DIAGNOSIS_FAILED',
          `Isolated worker failed: ${stderr.slice(-1500)}`,
        );
      if (!gateway.proposal)
        fail(
          'PROPOSAL_MISSING',
          'Worker did not create a pending proposal. No restart executed.',
        );
      const worker = JSON.parse(stdout.trim().split('\n').at(-1));
      if (
        !isolation.network_none ||
        !isolation.root_read_only ||
        !isolation.no_privileged ||
        isolation.user !== '65532:65532' ||
        isolation.mounts.length !== 2 ||
        !isolation.mounts.every((m) => m.read_only)
      )
        fail(
          'ISOLATION_FAILED',
          'Container inspection did not match required isolation.',
        );
      const result = {
        status: 'pending_human_approval',
        llm_called: model,
        proposal_id: gateway.proposal.proposal.proposal_id,
        proposal_digest: gateway.proposal.proposal_digest,
        proposal: gateway.proposal.proposal,
        isolation,
        worker,
        diagnosis_audit: gateway.guard.auditFile,
        note: 'Fault intentionally remains in this local lab. Review then approve and execute, or use restore to stop the experiment. No proposal-triggered restart has been executed.',
      };
      writeFileSync(
        path.join(directory, 'latest-diagnosis.json'),
        JSON.stringify(result, null, 2) + '\n',
        { mode: 0o600 },
      );
      proposalCreated = true;
      console.log(JSON.stringify(result, null, 2));
    } finally {
      try {
        execFileSync('docker', ['rm', '-f', name], {
          stdio: 'ignore',
          timeout: 15000,
        });
      } catch {}
    }
  } finally {
    await gateway?.close();
    if (!proposalCreated) await mode('healthy');
  }
}
function verifyEvidence(p) {
  const bundle = JSON.parse(
    readFileSync(
      path.join(directory, 'evidence-' + p.evidence_run_id + '.json'),
      'utf8',
    ),
  );
  if (
    bundle.run_id !== p.evidence_run_id ||
    digest(bundle.observations) !== p.evidence_digest
  )
    fail(
      'EVIDENCE_TAMPERED',
      'Stored evidence no longer matches the signed proposal.',
    );
}
async function approve(id) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    fail(
      'HUMAN_TTY_REQUIRED',
      'Approval requires an interactive operator terminal. Piped input is rejected.',
    );
  const p = store.read(id),
    hash = digest(p);
  verifyEvidence(p);
  console.log(
    JSON.stringify(
      {
        review: p,
        proposal_digest: hash,
        notice:
          'This approves exactly one local container restart, not arbitrary commands. Verify the target, evidence and parameters.',
      },
      null,
      2,
    ),
  );
  const expected = `APPROVE ${id} ${hash.slice(0, 12)}`;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Type exactly: ${expected}\n> `);
    if (answer !== expected) fail('APPROVAL_CANCELLED', 'No approval issued.');
  } finally {
    rl.close();
  }
  console.log(
    JSON.stringify(
      {
        status: 'approved',
        approval: store.approve(id),
        next: `node incident-observability-lab/approval/cli.mjs execute ${id}`,
      },
      null,
      2,
    ),
  );
}
function archiveVerified(receipt) {
  const id = receipt.proposal_id;
  const issued = JSON.parse(
    readFileSync(path.join(directory, 'proposals', id + '.json'), 'utf8'),
  );
  const approval = JSON.parse(
    readFileSync(path.join(directory, 'approvals', id + '.json'), 'utf8'),
  );
  const runId = issued.proposal.evidence_run_id;
  const evidence = JSON.parse(
    readFileSync(path.join(directory, 'evidence-' + runId + '.json'), 'utf8'),
  );
  const diagnosis = JSON.parse(
    readFileSync(path.join(directory, 'latest-diagnosis.json'), 'utf8'),
  );
  if (diagnosis.proposal_id !== id)
    fail(
      'ARCHIVE_MISMATCH',
      'Execution verified, but latest diagnosis differs. Preserve the receipt and archive the matching run manually.',
    );
  const public_keys = Object.fromEntries(
    ['proposer', 'approver'].map((role) => {
      const key = JSON.parse(
        readFileSync(path.join(directory, 'keys', role + '.json'), 'utf8'),
      );
      return [role, { key_id: key.key_id, public_key: key.public_key }];
    }),
  );
  const domain_audit = readFileSync(
    path.join(directory, 'diagnosis-audit', runId + '.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map(JSON.parse);
  const report = {
    schema_version: 1,
    mode: 'controlled_restart_integration',
    data_mode: 'live_lab',
    llm_called: diagnosis.llm_called,
    passed: true,
    issued,
    approval,
    receipt,
    public_keys,
    executor_rbac: JSON.parse(
      readFileSync(path.join(directory, 'executor-rbac-check.json'), 'utf8'),
    ),
    diagnosis,
    evidence,
    domain_audit,
  };
  const destination = path.join(
    root,
    'docs/evidence/approval-restart-run.json',
  );
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  return destination;
}

async function main() {
  const command = process.argv[2],
    id = process.argv[3];
  if (command === 'setup' && process.argv.length === 3) setup();
  else if (
    command === 'diagnose' &&
    (process.argv.length === 3 ||
      (process.argv.length === 4 && id === '--model'))
  )
    await diagnose(id === '--model');
  else if (command === 'review' && process.argv.length === 4)
    console.log(JSON.stringify(store.read(id), null, 2));
  else if (command === 'approve' && process.argv.length === 4)
    await approve(id);
  else if (command === 'execute' && process.argv.length === 4) {
    verifyEvidence(store.read(id));
    const receipt = await store.execute(id, (p) =>
      executeRestart(p, executorBackend(root)),
    );
    const archive =
      receipt.status === 'verified' ? archiveVerified(receipt) : undefined;
    console.log(
      JSON.stringify(
        { ...receipt, ...(archive ? { saved_to: archive } : {}) },
        null,
        2,
      ),
    );
    if (receipt.status !== 'verified') process.exitCode = 1;
  } else if (command === 'restore' && process.argv.length === 3) {
    await mode('healthy');
    console.log(
      JSON.stringify({
        status: 'restored_healthy_mode',
        note: 'Operator ended local injection; no approved restart was executed.',
      }),
    );
  } else
    fail(
      'USAGE',
      'Use setup | diagnose [--model] | review <id> | approve <id> | execute <id> | restore.',
    );
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      status: 'error',
      code: e.code ?? 'COMMAND_FAILED',
      message:
        e.status !== undefined
          ? 'A setup command failed; private credentials were not printed.'
          : e.message,
    }),
  );
  process.exitCode = 1;
});
