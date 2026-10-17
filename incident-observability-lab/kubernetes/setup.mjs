import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkReaderPermissions } from '../kubernetes-adapter.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = path.join(root, 'data/incident-k8s');
const local = path.join(directory, 'bin');
const admin = path.join(directory, 'admin.yaml');
const kind = path.join(local, 'kind'),
  kubectl = path.join(local, 'kubectl');
const compose = [
  'compose',
  '-f',
  path.join(root, 'incident-observability-lab/compose.yaml'),
];
const adminArgs = ['--kubeconfig', admin, '--context', 'kind-incident-lab'];
const output = (bin, args) =>
  execFileSync(bin, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const run = (bin, args, timeout = 180000) =>
  execFileSync(bin, args, { cwd: root, timeout, stdio: 'inherit' });
const k = (args) => output(kubectl, [...adminArgs, ...args]);
try {
  if (process.argv.length !== 2)
    throw new Error(
      'Usage: node incident-observability-lab/kubernetes/setup.mjs',
    );
  if (!existsSync(kind) || !existsSync(kubectl))
    throw new Error(
      'Install private lab tools first: bash incident-observability-lab/kubernetes/install-tools.sh',
    );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  output('docker', ['info', '--format', '{{.ServerVersion}}']);
  for (const service of ['loki', 'jaeger', 'prometheus']) {
    if (!output('docker', [...compose, 'ps', '-q', service]))
      throw new Error(`Start Compose ${service} before Kubernetes setup.`);
  }
  const clusters = output(kind, ['get', 'clusters']).split('\n');
  if (!clusters.includes('incident-lab'))
    run(
      kind,
      [
        'create',
        'cluster',
        '--name',
        'incident-lab',
        '--config',
        path.join(root, 'incident-observability-lab/kubernetes/kind.yaml'),
        '--kubeconfig',
        admin,
        '--wait',
        '120s',
      ],
      240000,
    );
  else if (!existsSync(admin))
    writeFileSync(
      admin,
      output(kind, ['get', 'kubeconfig', '--name', 'incident-lab']) + '\n',
      { mode: 0o600 },
    );
  chmodSync(admin, 0o600);
  const node = 'incident-lab-control-plane',
    network = 'incident-observability-lab_lab';
  const info = JSON.parse(output('docker', ['inspect', node]))[0];
  if (!info.NetworkSettings.Networks[network])
    run('docker', ['network', 'connect', network, node]);
  function serviceIp(service) {
    const cid = output('docker', [...compose, 'ps', '-q', service]);
    const address = JSON.parse(output('docker', ['inspect', cid]))[0]
      .NetworkSettings.Networks[network]?.IPAddress;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(address ?? ''))
      throw new Error('Could not resolve lab service IP.');
    return address;
  }
  run('docker', [
    'build',
    '-t',
    'incident-checkout:k8s-v10',
    path.join(root, 'incident-observability-lab'),
  ]);
  run(kind, [
    'load',
    'docker-image',
    'incident-checkout:k8s-v10',
    '--name',
    'incident-lab',
  ]);
  run(kubectl, [
    ...adminArgs,
    'apply',
    '-f',
    path.join(root, 'incident-observability-lab/kubernetes/rbac.yaml'),
  ]);
  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: 'checkout-k8s',
      namespace: 'demo',
      labels: { app: 'checkout-api', 'incident-lab/cluster': 'incident-lab' },
    },
    spec: {
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 10001,
        runAsGroup: 10001,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      hostAliases: [
        { ip: serviceIp('loki'), hostnames: ['loki'] },
        { ip: serviceIp('jaeger'), hostnames: ['jaeger'] },
      ],
      containers: [
        {
          name: 'checkout',
          image: 'incident-checkout:k8s-v10',
          imagePullPolicy: 'Never',
          ports: [{ containerPort: 8080 }],
          env: [
            { name: 'LAB_JOB', value: 'checkout-k8s-lab' },
            {
              name: 'LOKI_PUSH_URL',
              value: 'http://loki:3100/loki/api/v1/push',
            },
            { name: 'OTLP_TRACES_URL', value: 'http://jaeger:4318/v1/traces' },
            {
              name: 'POD_NAME',
              valueFrom: { fieldRef: { fieldPath: 'metadata.name' } },
            },
            {
              name: 'POD_UID',
              valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } },
            },
          ],
          readinessProbe: {
            httpGet: { path: '/ready', port: 8080 },
            initialDelaySeconds: 2,
            periodSeconds: 2,
            timeoutSeconds: 1,
            failureThreshold: 1,
            successThreshold: 1,
          },
          resources: {
            requests: { cpu: '50m', memory: '32Mi' },
            limits: { cpu: '500m', memory: '128Mi' },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
        },
      ],
    },
  };
  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'checkout-k8s', namespace: 'demo' },
    spec: {
      type: 'NodePort',
      publishNotReadyAddresses: true,
      selector: { app: 'checkout-api' },
      ports: [{ port: 8080, targetPort: 8080, nodePort: 30080 }],
    },
  };
  const manifest = path.join(directory, 'workload.json');
  writeFileSync(
    manifest,
    JSON.stringify(
      { apiVersion: 'v1', kind: 'List', items: [pod, service] },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  run(kubectl, [...adminArgs, 'apply', '-f', manifest]);
  run(
    kubectl,
    [
      ...adminArgs,
      'wait',
      '--for=condition=Ready',
      'pod/checkout-k8s',
      '-n',
      'demo',
      '--timeout=90s',
    ],
    100000,
  );
  let livePod;
  for (let attempt = 0; attempt < 90; attempt++) {
    livePod = JSON.parse(
      k([
        'get',
        'pod',
        'checkout-k8s',
        '-n',
        'demo',
        '-o',
        'json',
        '--request-timeout=5s',
      ]),
    );
    const container = livePod.status?.containerStatuses?.find(
      (c) => c.name === 'checkout',
    );
    if (container?.ready && container.image?.endsWith(':k8s-v10')) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const active = livePod.status?.containerStatuses?.find(
    (c) => c.name === 'checkout',
  );
  if (!active?.ready || !active.image?.endsWith(':k8s-v10'))
    throw new Error(
      'The v10 checkout container did not become ready; inspect the Pod before approval setup.',
    );
  const adminConfig = JSON.parse(
    k(['config', 'view', '--raw', '--minify', '-o', 'json']),
  );
  const cluster = adminConfig.clusters[0].cluster;
  const token = k([
    'create',
    'token',
    'incident-reader',
    '-n',
    'demo',
    '--duration=8h',
  ]);
  const credential = path.join(directory, 'reader.json');
  writeFileSync(
    credential,
    JSON.stringify(
      {
        cluster: 'incident-lab',
        namespace: 'demo',
        pod_name: 'checkout-k8s',
        pod_uid: livePod.metadata.uid,
        server: cluster.server,
        certificate_authority_data: cluster['certificate-authority-data'],
        token,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  chmodSync(credential, 0o600);
  const permissions = await checkReaderPermissions(credential);
  if (!permissions.passed)
    throw new Error('Reader RBAC verification failed; do not enable runtime.');
  // Reload Prometheus to pick up the isolated Kubernetes job from the mounted file.
  const reload = [...compose, 'up', '-d', '--force-recreate', '--no-deps'];
  run('docker', [...reload, 'prometheus']);
  console.log(
    JSON.stringify(
      {
        status: 'ready',
        cluster: 'incident-lab',
        namespace: 'demo',
        pod: 'checkout-k8s',
        pod_uid: livePod.metadata.uid,
        app_url: 'http://127.0.0.1:18081',
        rbac: permissions,
        note: 'Reader token stored privately, never printed. Renew with this command when expired. This setup creates a local experimental workload.',
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'error',
      message:
        error.status === undefined
          ? error.message
          : 'Setup command failed. Inspect the preceding command output; credentials were not printed.',
    }),
  );
  process.exitCode = 1;
}
