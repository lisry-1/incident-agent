import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fail } from './store.mjs';
// Shared fixed Docker boundary for restart and release rollback diagnosis.
export async function runIsolatedWorker(root, gateway, session) {
  const directory = path.join(root, 'data/incident-approval');
  const config = path.join(directory, 'ipc/session.json');
  if (existsSync(config)) chmodSync(config, 0o600);
  writeFileSync(config, JSON.stringify(session), { mode: 0o444 });
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
    let worker;
    try {
      worker = JSON.parse(stdout.trim().split('\n').at(-1));
    } catch {
      worker = { error: 'Worker did not return a JSON report.' };
    }
    const reportFile = path.join(directory, 'last-worker-report.json');
    writeFileSync(
      reportFile,
      JSON.stringify(
        {
          recorded_at: new Date().toISOString(),
          llm_called: session.model === true,
          exit_code: code,
          isolation,
          worker,
          stderr,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    if (code !== 0)
      fail(
        'DIAGNOSIS_FAILED',
        `Isolated worker failed: ${stderr.slice(-1500)}`,
      );
    if (
      !isolation.network_none ||
      !isolation.root_read_only ||
      !isolation.no_privileged ||
      isolation.user !== '65532:65532' ||
      isolation.mounts.length !== 2 ||
      !isolation.mounts.every((m) => m.read_only) ||
      !worker.boundary ||
      !Object.values(worker.boundary).every((v) => v === true)
    )
      fail(
        'ISOLATION_FAILED',
        'Worker or Docker inspection did not match required isolation.',
      );
    return { worker, isolation, reportFile };
  } finally {
    try {
      execFileSync('docker', ['rm', '-f', name], {
        stdio: 'ignore',
        timeout: 15000,
      });
    } catch {}
  }
}
