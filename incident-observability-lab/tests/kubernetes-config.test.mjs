import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { kubeScope } from './kube-fixtures.mjs';

test('passed four-source audit pins Kubernetes capability; old tracing audit remains compatible', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kube-enable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const mode of [
    'kubernetes_lab_integration',
    'tracing_lab_integration',
  ]) {
    const audit = {
      mode,
      passed: true,
      data_mode: 'live_lab',
      fault: { observation: { scope: kubeScope } },
      logs: { status: 'ok', evidence: [{}] },
      traces: {
        status: 'ok',
        evidence: [{}],
        query_coverage: { traces: { failures: [] } },
      },
      pod_events: { status: 'ok' },
      rbac: { passed: true },
      workload: { pod_uid: 'test' },
    };
    const file = path.join(dir, 'audit.json');
    writeFileSync(file, JSON.stringify(audit));
    execFileSync(process.execPath, [
      'incident-observability-lab/enable-runtime.mjs',
      dir,
      file,
    ]);
    const config = JSON.parse(
      readFileSync(path.join(dir, 'incident-demo.config.json'), 'utf8'),
    );
    assert.equal(config.logs, true);
    assert.equal(config.traces, true);
    assert.equal(
      config.kubernetes,
      mode === 'kubernetes_lab_integration' ? true : undefined,
    );
  }
});
test('failed or missing RBAC evidence cannot enable Kubernetes runtime', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kube-enable-deny-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'audit.json');
  writeFileSync(
    file,
    JSON.stringify({
      mode: 'kubernetes_lab_integration',
      passed: true,
      data_mode: 'live_lab',
      fault: { observation: { scope: kubeScope } },
      logs: { status: 'ok', evidence: [{}] },
      traces: {
        status: 'ok',
        evidence: [{}],
        query_coverage: { traces: { failures: [] } },
      },
      pod_events: { status: 'ok' },
      rbac: { passed: false },
    }),
  );
  assert.throws(() =>
    execFileSync(
      process.execPath,
      ['incident-observability-lab/enable-runtime.mjs', dir, file],
      { stdio: 'pipe' },
    ),
  );
});
