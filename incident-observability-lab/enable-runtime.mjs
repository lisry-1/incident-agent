import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PrometheusMetricsAdapter } from './prometheus-adapter.mjs';
try {
  if (process.argv.length !== 4)
    throw new Error(
      'Usage: node incident-observability-lab/enable-runtime.mjs <workspace-directory> <exercise-audit.json>',
    );
  const workspace = path.resolve(process.argv[2]);
  if (!existsSync(workspace)) throw new Error('Workspace must already exist.');
  const audit = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  if (
    audit.mode !== 'prometheus_lab_integration' ||
    audit.data_mode !== 'live_lab' ||
    audit.passed !== true
  )
    throw new Error('Use a passed live lab exercise audit.');
  const scope = audit.fault?.observation?.scope;
  new PrometheusMetricsAdapter({ scope });
  const windowSeconds =
    (Date.parse(scope.end) - Date.parse(scope.start)) / 1000;
  if (!Number.isInteger(windowSeconds))
    throw new Error('Exercise window must use whole seconds.');
  const config = {
    case_id: 'prometheus-lab',
    workflow: 'staged',
    window_seconds: windowSeconds,
    end: scope.end,
  };
  const file = path.join(workspace, 'incident-demo.config.json');
  if (existsSync(file)) copyFileSync(file, `${file}.backup-${Date.now()}`);
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        status: 'configured',
        config,
        scope,
        note: 'Pins the historical experiment window. Runtime queries Prometheus again; it does not read evidence from this audit. Restart Miniclaw before the model test. Prometheus retention is 6 hours.',
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
