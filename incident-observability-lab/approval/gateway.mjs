import { createServer, request as httpRequest } from 'node:http';
import {
  mkdirSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
  existsSync,
  appendFileSync,
} from 'node:fs';
import path from 'node:path';
import { IncidentHarness } from '../../incident-diagnosis-demo/scripts/incident-harness.mjs';
import { PrometheusMetricsAdapter } from '../prometheus-adapter.mjs';
import { LokiLogsAdapter } from '../loki-adapter.mjs';
import { JaegerTracesAdapter } from '../jaeger-adapter.mjs';
import { KubernetesPodEventsAdapter } from '../kubernetes-adapter.mjs';
import { digest, fail } from './store.mjs';
import { appHealth } from './executor.mjs';
async function body(req) {
  let count = 0;
  const chunks = [];
  for await (const c of req) {
    count += c.length;
    if (count > 262144) fail('REQUEST_TOO_LARGE', 'Request exceeds 256 KiB.');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
export async function startGateway({
  root,
  scope,
  store,
  targetSnapshot,
  modelKey,
  adapters,
  health = appHealth,
  httpTestOnly = false,
}) {
  const directory = path.join(root, 'data/incident-approval/ipc');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const socket = path.join(directory, 'gateway.sock');
  if (existsSync(socket))
    fail(
      'GATEWAY_EXISTS',
      'A gateway socket already exists; inspect the previous process before removing it.',
    );
  const credentialFile = path.join(root, 'data/incident-k8s/reader.json');
  const metrics =
    adapters?.metrics ??
    new PrometheusMetricsAdapter({ scope, target: 'kubernetes' });
  const logs =
    adapters?.logs ?? new LokiLogsAdapter({ scope, target: 'kubernetes' });
  const traces =
    adapters?.traces ??
    new JaegerTracesAdapter({ scope, target: 'kubernetes' });
  const kube =
    adapters?.kube ?? new KubernetesPodEventsAdapter({ scope, credentialFile });
  const observations = [];
  const guard = new IncidentHarness({
    caseId: 'prometheus-lab',
    staged: true,
    liveScope: scope,
    auditDirectory: path.join(root, 'data/incident-approval/diagnosis-audit'),
    executeQuery: async (input) => {
      const q = {
        service: input.service,
        namespace: input.namespace,
        start: input.start,
        end: input.end,
      };
      let result;
      if (input.source === 'metrics') result = await metrics.query(q);
      else if (input.source === 'logs') {
        result = await logs.query(q);
        traces.observeLogs(result);
      } else if (input.source === 'traces') result = await traces.query(q);
      else if (input.source === 'pod_events') result = await kube.query(q);
      else
        result = {
          status: 'unavailable',
          data_mode: 'live_lab',
          evidence: [],
          error: { code: 'SOURCE_NOT_CONFIGURED', message: 'No fallback.' },
        };
      observations.push({
        input: structuredClone(input),
        result: structuredClone(result),
      });
      return result;
    },
  });
  let proposal,
    proposalStarted = false,
    timelineSeen = false,
    modelCalls = 0,
    attempts = 0;
  const auditFile = path.join(
    root,
    'data/incident-approval/gateway-audit.jsonl',
  );
  const audit = (type, fields = {}) => {
    /* no secrets or request bodies */
    const line =
      JSON.stringify({
        type,
        recorded_at: new Date().toISOString(),
        ...fields,
      }) + '\n';
    // Main authorization journal is fsynced by the store. Gateway audit is diagnostic.
    append(line);
  };
  const append = (line) => appendFileSync(auditFile, line, { mode: 0o600 });
  const server = createServer(async (req, res) => {
    try {
      attempts++;
      if (attempts > 32)
        fail('REQUEST_BUDGET_EXCEEDED', 'Gateway budget exhausted.');
      if (req.method === 'POST' && req.url === '/model/v1/messages') {
        if (!modelKey) fail('MODEL_DISABLED', 'Model inference is opt-in.');
        if (++modelCalls > 8)
          fail('MODEL_BUDGET_EXCEEDED', 'At most 8 model calls.');
        const payload = await body(req);
        if (
          payload.model !== 'deepseek-flash' ||
          payload.stream !== true ||
          !Number.isInteger(payload.max_tokens) ||
          payload.max_tokens < 1 ||
          payload.max_tokens > 4096 ||
          !Array.isArray(payload.messages)
        )
          fail(
            'INVALID_MODEL_REQUEST',
            'Fixed model, streaming and token limit required.',
          );
        // No caller-controlled upstream URL or headers; credentials stay here.
        audit('model_request', { call: modelCalls });
        const upstream = await fetch(
          'https://api.deepseek.com/anthropic/v1/messages',
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(90000),
            headers: {
              'x-api-key': modelKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              ...payload,
              thinking: { type: 'disabled' },
            }),
          },
        );
        if (!upstream.ok) {
          await upstream.body?.cancel();
          fail('MODEL_UPSTREAM_ERROR', `Model HTTP ${upstream.status}.`);
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        let bytes = 0;
        for await (const chunk of upstream.body) {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024)
            throw new Error('Model response too large.');
          res.write(chunk);
        }
        res.end();
        return;
      }
      if (req.method !== 'POST')
        fail('ROUTE_DENIED', 'Only fixed POST domain routes are supported.');
      const input = await body(req);
      if (req.url === '/incident/dispatch') {
        if (
          ![
            'incident.probe',
            'incident.investigate',
            'incident.timeline',
          ].includes(input.tool) ||
          Object.keys(input).sort().join(',') !== 'arguments,tool'
        )
          fail('ROUTE_DENIED', 'Only read-only diagnosis tools are supported.');
        const result = await guard.dispatchAsync(input);
        if (
          input.tool === 'incident.timeline' &&
          result.result?.status === 'ok'
        )
          timelineSeen = true;
        audit('domain_call', { tool: input.tool });
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            event: result,
            available_tools: guard.availableTools,
          }),
        );
        return;
      }
      if (req.url === '/incident/propose') {
        if (proposalStarted)
          fail('PROPOSAL_LIMIT', 'At most one proposal per diagnosis.');
        if (
          Object.keys(input).sort().join(',') !== 'action,reason' ||
          input.action !== 'restart_container'
        )
          fail('ACTION_DENIED', 'Only restart_container can be proposed.');
        if (!timelineSeen)
          fail(
            'EVIDENCE_REQUIRED',
            'Generate the observed timeline before proposing.',
          );
        const required = ['metrics', 'logs', 'traces', 'pod_events'];
        if (
          !required.every((source) =>
            observations.some(
              (o) =>
                o.input.source === source &&
                o.result.status === 'ok' &&
                o.result.evidence?.length,
            ),
          )
        )
          fail(
            'EVIDENCE_REQUIRED',
            'Observe all four configured sources before proposing.',
          );
        const records = observations.flatMap((o) => o.result.evidence ?? []);
        if (
          !records.some(
            (e) =>
              typeof e.http_5xx_ratio === 'number' && e.http_5xx_ratio > 0.1,
          ) ||
          !records.some((e) => e.reason === 'Unhealthy')
        )
          fail(
            'EVIDENCE_REQUIRED',
            'Observed error metrics and an Unhealthy event are required.',
          );
        if (
          records.some((e) => e.pod_uid && e.pod_uid !== targetSnapshot.pod_uid)
        )
          fail('TARGET_CHANGED', 'Observed evidence belongs to another Pod.');
        proposalStarted = true;
        const current = await health();
        if (
          current.pod_uid !== targetSnapshot.pod_uid ||
          current.instance_id !== targetSnapshot.instance_id ||
          current.mode !== 'fault'
        )
          fail(
            'PRECONDITION_FAILED',
            'Target changed or is no longer in injected fault mode.',
          );
        const evidenceDigest = digest(observations);
        const runId = guard.runId;
        const evidencePath = path.join(
          root,
          'data/incident-approval/evidence-' + runId + '.json',
        );
        writeFileSync(
          evidencePath,
          JSON.stringify(
            {
              run_id: runId,
              scope,
              observations,
              evidence_digest: evidenceDigest,
            },
            null,
            2,
          ) + '\n',
          { mode: 0o600 },
        );
        proposal = store.create({
          action: input.action,
          target: targetSnapshot,
          evidence_digest: evidenceDigest,
          evidence_run_id: runId,
          scope,
          reason: input.reason,
        });
        audit('proposal_created', {
          proposal_id: proposal.proposal.proposal_id,
        });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(proposal));
        return;
      }
      fail(
        'ROUTE_DENIED',
        'Approval, execution, arbitrary fetch, shell and filesystem routes are unavailable.',
      );
    } catch (e) {
      audit('request_denied', {
        route: req.url,
        code: e.code ?? 'GATEWAY_ERROR',
      });
      if (!res.headersSent)
        res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'denied',
          code: e.code ?? 'GATEWAY_ERROR',
          message: e.code ? e.message : 'Gateway request failed.',
        }),
      );
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    if (httpTestOnly) server.listen(0, '127.0.0.1', resolve);
    else server.listen(socket, resolve);
  });
  // Only the socket is mounted. Its connect permission is independent of host secrets.
  if (!httpTestOnly) chmodSync(socket, 0o666);
  return {
    socket,
    guard,
    ...(httpTestOnly
      ? { testAddress: { hostname: '127.0.0.1', port: server.address().port } }
      : {}),
    get proposal() {
      return proposal;
    },
    async close() {
      guard.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      if (existsSync(socket)) unlinkSync(socket);
    },
  };
}
export function gatewayRequest(socket, route, value) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(value);
    const req = httpRequest(
      {
        ...(typeof socket === 'string' ? { socketPath: socket } : socket),
        path: route,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(raw),
        },
      },
      (res) => {
        const parts = [];
        let bytes = 0;
        res.on('data', (b) => {
          bytes += b.length;
          if (bytes > 2 * 1024 * 1024)
            req.destroy(new Error('Response too large'));
          else parts.push(b);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(parts).toString()));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error('Gateway timeout')));
    req.on('error', reject);
    req.end(raw);
  });
}
