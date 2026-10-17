import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  PrometheusMetricsAdapter,
  QUERIES,
  validateLabBase,
} from './prometheus-adapter.mjs';
import { LokiLogsAdapter } from './loki-adapter.mjs';
import { JaegerTracesAdapter } from './jaeger-adapter.mjs';
import {
  KubernetesPodEventsAdapter,
  checkReaderPermissions,
} from './kubernetes-adapter.mjs';
import { labJob } from './lab-target.mjs';

const kubernetes = ['check-kubernetes', 'exercise-kubernetes'].includes(
  process.argv[2],
);
const target = kubernetes ? 'kubernetes' : 'compose';
const credentialFile = fileURLToPath(
  new URL('../data/incident-k8s/reader.json', import.meta.url),
);
const app = validateLabBase(
  process.env.INCIDENT_LAB_APP_URL ||
    (kubernetes ? 'http://127.0.0.1:18081' : 'http://127.0.0.1:18080'),
);
const prom = validateLabBase(
  process.env.INCIDENT_LAB_PROMETHEUS_URL || 'http://127.0.0.1:19090',
);
const loki = validateLabBase(
  process.env.INCIDENT_LAB_LOKI_URL || 'http://127.0.0.1:13100',
);
const jaeger = validateLabBase(
  process.env.INCIDENT_LAB_JAEGER_URL || 'http://127.0.0.1:16686',
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(url, options = {}) {
  return fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
}
async function waitReady(withLogs = false, withTraces = false) {
  let reason = 'startup';
  for (let i = 0; i < 30; i++) {
    try {
      const appResponse = await request(new URL('/health', app));
      if (!appResponse.ok)
        throw new Error('Checkout health endpoint is not ready.');
      const appBody = await appResponse.json();
      if (withLogs) {
        if (!appBody.log_exporter?.enabled)
          throw new Error(
            'Checkout log exporter is not enabled. Rebuild the checkout image.',
          );
        const logReady = await request(new URL('/ready', loki));
        const ok = logReady.ok;
        await logReady.body?.cancel();
        if (!ok) throw new Error('Loki is starting.');
      }
      if (withTraces) {
        if (!appBody.trace_exporter?.enabled)
          throw new Error(
            'Checkout trace exporter is not enabled. Rebuild checkout.',
          );
        const ready = await request(new URL('/api/v3/services', jaeger));
        if (!ready.ok) throw new Error('Jaeger query API is not ready.');
        await ready.body?.cancel();
      }
      const ready = await request(new URL('/-/ready', prom));
      if (!ready.ok) throw new Error('Prometheus is starting.');
      await ready.body?.cancel();
      const target = new URL('/api/v1/query', prom);
      target.searchParams.set(
        'query',
        QUERIES.target_up.replace(
          'job="checkout-lab"',
          `job="${labJob(kubernetes ? 'kubernetes' : 'compose')}"`,
        ),
      );
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
        ...(withTraces ? { jaeger: 'ready', trace_exporter: 'enabled' } : {}),
        ...(withLogs ? { loki: 'ready', log_exporter: 'enabled' } : {}),
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
  const adapter = new PrometheusMetricsAdapter({
    scope,
    baseUrl: prom.origin,
    target,
  });
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
  const requestIds = [];
  while (Date.now() < end) {
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => request(new URL('/checkout', app))),
    );
    for (const response of responses) {
      const body = await response.json();
      if (
        typeof body.request_id !== 'string' ||
        !/^[a-f0-9]{32}$/.test(body.request_id)
      )
        throw new Error('Checkout returned invalid request ID.');
      requestIds.push(body.request_id);
      if (response.status !== (mode === 'healthy' ? 200 : 503))
        throw new Error(
          'Unexpected checkout status during controlled experiment.',
        );
      count++;
    }
    await sleep(1000);
  }
  let podSnapshot;
  if (kubernetes) {
    const endMs = Date.now();
    const scope = {
      service: 'checkout-api',
      namespace: 'demo',
      start: new Date(endMs - 120000).toISOString(),
      end: new Date(endMs).toISOString(),
    };
    const result = await new KubernetesPodEventsAdapter({
      scope,
      credentialFile,
    }).query(scope);
    podSnapshot = result.current_snapshot;
  }
  return {
    ...(kubernetes ? { pod_snapshot: podSnapshot } : {}),
    mode,
    requests: count,
    request_ids: requestIds,
    observation: await capture(),
  };
}
async function exercise(withLogs = false, withTraces = false) {
  await waitReady(withLogs, withTraces);
  const traceBefore = withTraces
    ? (await (await request(new URL('/health', app))).json()).trace_exporter
    : undefined;
  const exporterBefore = withLogs
    ? (await (await request(new URL('/health', app))).json()).log_exporter
    : undefined;
  const runId = randomUUID();
  let healthy, fault, restoredSnapshot;
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
  if (kubernetes) {
    for (let attempt = 0; attempt < 15; attempt++) {
      const endMs = Date.now();
      const scope = {
        service: 'checkout-api',
        namespace: 'demo',
        start: new Date(endMs - 120000).toISOString(),
        end: new Date(endMs).toISOString(),
      };
      const result = await new KubernetesPodEventsAdapter({
        scope,
        credentialFile,
      }).query(scope);
      restoredSnapshot = result.current_snapshot;
      if (restoredSnapshot?.ready === 'True') break;
      await sleep(1000);
    }
    // Include the observed recovery boundary so the last aggregate Event update
    // cannot fall just beyond the historical query window.
    fault.observation = await capture();
  }
  const healthyLatest = healthy.observation.evidence.at(-1);
  const faultLatest = fault.observation.evidence.at(-1);
  let passed =
    healthyLatest?.target_up === 1 &&
    faultLatest?.target_up === 1 &&
    healthyLatest?.http_5xx_ratio <= 0.01 &&
    faultLatest?.http_5xx_ratio >= 0.1 &&
    healthyLatest?.request_rate > 0 &&
    faultLatest?.request_rate > 0;
  let logs, exporterAfter;
  if (withLogs) {
    const scope = fault.observation.scope;
    const adapter = new LokiLogsAdapter({
      scope,
      baseUrl: loki.origin,
      target,
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      exporterAfter = (await (await request(new URL('/health', app))).json())
        .log_exporter;
      logs = await adapter.query(scope);
      const ids = new Set(logs.evidence.map((e) => e.request_id));
      if (
        logs.status === 'ok' &&
        fault.request_ids.every((id) => ids.has(id)) &&
        exporterAfter.pending === 0
      )
        break;
      await sleep(500);
    }
    const ids = new Set(logs.evidence.map((e) => e.request_id));
    passed =
      passed &&
      logs.status === 'ok' &&
      !logs.partial &&
      fault.request_ids.every((id) => ids.has(id)) &&
      exporterAfter.enabled &&
      exporterAfter.pending === 0 &&
      exporterAfter.dropped === exporterBefore.dropped;
  }
  let traces, traceAfter;
  if (withTraces) {
    const scope = fault.observation.scope;
    const adapter = new JaegerTracesAdapter({
      scope,
      baseUrl: jaeger.origin,
      target,
    });
    adapter.observeLogs(logs);
    for (let attempt = 0; attempt < 10; attempt++) {
      traces = await adapter.query(scope);
      traceAfter = (await (await request(new URL('/health', app))).json())
        .trace_exporter;
      if (
        traces.query_coverage?.traces.returned_traces === 8 &&
        traceAfter.pending === 0
      )
        break;
      await sleep(1000);
    }
    passed =
      passed &&
      traces.status === 'ok' &&
      traces.evidence.length === 16 &&
      traces.query_coverage.traces.returned_traces === 8 &&
      traces.query_coverage.traces.failures.length === 0 &&
      logs.evidence.every((e) => /^[a-f0-9]{32}$/.test(e.trace_id ?? '')) &&
      traceAfter.pending === 0 &&
      traceAfter.dropped === traceBefore.dropped;
  }
  let podEvents, rbac, healthySnapshot, faultSnapshot;
  if (kubernetes) {
    const scope = fault.observation.scope;
    const adapter = new KubernetesPodEventsAdapter({ scope, credentialFile });
    podEvents = await adapter.query(scope);
    rbac = await checkReaderPermissions(credentialFile);
    const uids = new Set(
      [...logs.evidence, ...traces.evidence].map((e) => e.pod_uid),
    );
    // This query occurs after restore; its snapshot cannot describe the fault window.
    const expectedUid = podEvents.current_snapshot?.pod_uid;
    passed =
      passed &&
      rbac.passed &&
      podEvents.status === 'ok' &&
      !podEvents.partial &&
      podEvents.evidence.some(
        (e) =>
          e.reason === 'Unhealthy' &&
          e.type === 'Warning' &&
          e.message.includes('503'),
      ) &&
      !!expectedUid &&
      uids.size === 1 &&
      uids.has(expectedUid);
    healthySnapshot = healthy.pod_snapshot;
    faultSnapshot = fault.pod_snapshot;
    passed =
      passed &&
      healthySnapshot?.ready === 'True' &&
      faultSnapshot?.ready === 'False' &&
      restoredSnapshot?.ready === 'True';
  }
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
        ...(withTraces
          ? {
              traces,
              trace_exporter_before: traceBefore,
              trace_exporter_after: traceAfter,
            }
          : {}),
        ...(kubernetes
          ? {
              pod_events: podEvents,
              rbac,
              workload: {
                cluster: 'incident-lab',
                pod: 'checkout-k8s',
                pod_uid: podEvents.current_snapshot?.pod_uid,
              },
              phase_snapshots: {
                healthy: healthySnapshot,
                fault: faultSnapshot,
                restored: restoredSnapshot,
              },
            }
          : {}),
        mode: kubernetes
          ? 'kubernetes_lab_integration'
          : withTraces
            ? 'tracing_lab_integration'
            : withLogs
              ? 'observability_lab_integration'
              : 'prometheus_lab_integration',
        llm_called: false,
        data_mode: 'live_lab',
        passed,
        restored_healthy: true,
        healthy,
        fault,
        ...(withLogs
          ? {
              logs,
              exporter_before: exporterBefore,
              exporter_after: exporterAfter,
            }
          : {}),
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
        ...(kubernetes
          ? {
              pod_events: podEvents.evidence.length,
              kubernetes_query_partial: podEvents.partial,
              rbac_passed: rbac.passed,
              same_pod_uid_across_sources:
                new Set(
                  [
                    ...logs.evidence,
                    ...traces.evidence,
                    ...podEvents.evidence,
                  ].map((e) => e.pod_uid),
                ).size === 1,
              healthy_pod_ready: healthySnapshot?.ready,
              fault_pod_ready: faultSnapshot?.ready,
              restored_pod_ready: restoredSnapshot?.ready,
            }
          : {}),
        ...(withTraces
          ? {
              jaeger_spans: traces.evidence.length,
              trace_coverage: traces.query_coverage?.traces,
              trace_exporter_dropped_delta:
                traceAfter.dropped - traceBefore.dropped,
            }
          : {}),
        ...(withLogs
          ? {
              loki_logs: logs.evidence.length,
              log_query_partial: logs.partial,
              all_fault_request_ids_found: fault.request_ids.every((id) =>
                logs.evidence.some((e) => e.request_id === id),
              ),
              log_exporter_dropped_delta:
                exporterAfter.dropped - exporterBefore.dropped,
            }
          : {}),
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
      'Usage: node incident-observability-lab/lab-cli.mjs check|capture|exercise|check-logs|exercise-logs|check-traces|exercise-traces|check-kubernetes|exercise-kubernetes',
    );
  const command = process.argv[2];
  if (command === 'check')
    console.log(JSON.stringify(await waitReady(), null, 2));
  else if (command === 'capture')
    console.log(JSON.stringify(await capture(), null, 2));
  else if (command === 'exercise') await exercise();
  else if (command === 'check-logs')
    console.log(JSON.stringify(await waitReady(true), null, 2));
  else if (command === 'check-traces')
    console.log(JSON.stringify(await waitReady(true, true), null, 2));
  else if (command === 'check-kubernetes') {
    const ready = await waitReady(true, true);
    const rbac = await checkReaderPermissions(credentialFile);
    if (!rbac.passed) throw new Error('Reader RBAC checks failed.');
    console.log(JSON.stringify({ ...ready, rbac }, null, 2));
  } else if (command === 'exercise-kubernetes') await exercise(true, true);
  else if (command === 'exercise-traces') await exercise(true, true);
  else if (command === 'exercise-logs') await exercise(true);
  else
    throw new Error(
      'Unknown command. Use check, capture, exercise, check-logs, exercise-logs, check-traces, exercise-traces, check-kubernetes or exercise-kubernetes.',
    );
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
