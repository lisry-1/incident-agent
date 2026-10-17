import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  PrometheusMetricsAdapter,
  QUERIES,
  validateLabBase,
} from './prometheus-adapter.mjs';

const app = validateLabBase(
  process.env.INCIDENT_LAB_APP_URL || 'http://127.0.0.1:18080',
);
const prom = validateLabBase(
  process.env.INCIDENT_LAB_PROMETHEUS_URL || 'http://127.0.0.1:19090',
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(url, options = {}) {
  return fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
}
async function waitReady() {
  let reason = 'startup';
  for (let i = 0; i < 30; i++) {
    try {
      const appResponse = await request(new URL('/health', app));
      if (!appResponse.ok)
        throw new Error('Checkout health endpoint is not ready.');
      await appResponse.body?.cancel();
      const ready = await request(new URL('/-/ready', prom));
      if (!ready.ok) throw new Error('Prometheus is starting.');
      await ready.body?.cancel();
      const target = new URL('/api/v1/query', prom);
      target.searchParams.set('query', QUERIES.target_up);
      const response = await request(target);
      const body = await response.json();
      if (
        !response.ok ||
        body.status !== 'success' ||
        body.data?.resultType !== 'vector' ||
        !body.data.result.some(
          (series) =>
            series.metric.service === 'checkout-api' &&
            series.metric.namespace === 'demo' &&
            series.value[1] === '1',
        )
      ) {
        throw new Error(
          'Prometheus has not successfully scraped checkout yet.',
        );
      }
      return {
        status: 'ready',
        data_mode: 'live_lab',
        checkout: 'healthy endpoint reachable',
        prometheus: 'ready',
        scrape_target_up: 1,
      };
    } catch (error) {
      reason = error.message;
    }
    await sleep(1000);
  }
  throw new Error(
    `Lab not ready: ${reason}. Check docker compose -f incident-observability-lab/compose.yaml logs --tail=30`,
  );
}
async function capture() {
  const end = Date.now();
  const scope = {
    service: 'checkout-api',
    namespace: 'demo',
    start: new Date(end - 120000).toISOString(),
    end: new Date(end).toISOString(),
  };
  const adapter = new PrometheusMetricsAdapter({ scope, baseUrl: prom.origin });
  return adapter.query(scope);
}
async function setMode(mode) {
  const response = await request(new URL('/control/mode', app), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error('Could not change local lab fault mode.');
  await response.body?.cancel();
}
async function traffic(mode) {
  await setMode(mode);
  const end = Date.now() + 45000;
  let count = 0;
  while (Date.now() < end) {
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => request(new URL('/checkout', app))),
    );
    for (const response of responses) {
      await response.body?.cancel();
      if (response.status !== (mode === 'healthy' ? 200 : 503))
        throw new Error(
          'Unexpected checkout status during controlled experiment.',
        );
      count++;
    }
    await sleep(1000);
  }
  return { mode, requests: count, observation: await capture() };
}
async function exercise() {
  await waitReady();
  const runId = randomUUID();
  let healthy, fault;
  try {
    console.error('Healthy phase: generating requests for about 45 seconds...');
    healthy = await traffic('healthy');
    console.error(
      'Fault phase: injecting HTTP 503 and generating requests for about 45 seconds...',
    );
    fault = await traffic('fault');
  } finally {
    await setMode('healthy');
  }
  const healthyLatest = healthy.observation.evidence.at(-1);
  const faultLatest = fault.observation.evidence.at(-1);
  const passed =
    healthyLatest?.target_up === 1 &&
    faultLatest?.target_up === 1 &&
    healthyLatest?.http_5xx_ratio <= 0.01 &&
    faultLatest?.http_5xx_ratio >= 0.1 &&
    healthyLatest?.request_rate > 0 &&
    faultLatest?.request_rate > 0;
  const directory = fileURLToPath(new URL('./runs/', import.meta.url));
  mkdirSync(directory, { recursive: true });
  const auditFile = path.join(directory, `${runId}.json`);
  writeFileSync(
    auditFile,
    JSON.stringify(
      {
        schema_version: 1,
        run_id: runId,
        recorded_at: new Date().toISOString(),
        mode: 'prometheus_lab_integration',
        llm_called: false,
        data_mode: 'live_lab',
        passed,
        restored_healthy: true,
        healthy,
        fault,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      {
        run_id: runId,
        passed,
        llm_called: false,
        data_mode: 'live_lab',
        healthy_5xx_ratio: healthyLatest?.http_5xx_ratio ?? null,
        fault_5xx_ratio: faultLatest?.http_5xx_ratio ?? null,
        requests_generated: healthy.requests + fault.requests,
        restored_healthy: true,
        audit_file: auditFile,
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
}
async function main() {
  if (process.argv.length !== 3)
    throw new Error(
      'Usage: node incident-observability-lab/lab-cli.mjs check|capture|exercise',
    );
  const command = process.argv[2];
  if (command === 'check')
    console.log(JSON.stringify(await waitReady(), null, 2));
  else if (command === 'capture')
    console.log(JSON.stringify(await capture(), null, 2));
  else if (command === 'exercise') await exercise();
  else throw new Error('Unknown command. Use check, capture or exercise.');
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'error', message: error.message }));
    process.exitCode = 1;
  });
}
