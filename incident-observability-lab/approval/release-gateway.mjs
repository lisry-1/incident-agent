import { createServer } from 'node:http';
import {
  mkdirSync,
  existsSync,
  chmodSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fail, digest } from './store.mjs';
import { observeRelease, bindRollback } from './rollback.mjs';

export async function startReleaseGateway({
  root,
  store,
  backend,
  stableProof,
  httpTestOnly = false,
}) {
  const directory = path.join(root, 'data/incident-approval');
  mkdirSync(path.join(directory, 'ipc'), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(root, 'data/incident-rollback'), {
    recursive: true,
    mode: 0o700,
  });
  const socket = path.join(directory, 'ipc/gateway.sock');
  if (existsSync(socket))
    fail(
      'GATEWAY_EXISTS',
      'Inspect the existing gateway before starting another run.',
    );
  const runId = randomUUID();
  const auditFile = path.join(
    root,
    'data/incident-rollback/audit-' + runId + '.jsonl',
  );
  let observing = false;
  let attempts = 0,
    observed,
    target,
    proposal;
  const audit = (type, data = {}) =>
    appendFileSync(
      auditFile,
      JSON.stringify({
        type,
        run_id: runId,
        recorded_at: new Date().toISOString(),
        ...data,
      }) + '\n',
      { mode: 0o600 },
    );
  const server = createServer(async (req, res) => {
    try {
      if (++attempts > 12)
        fail('REQUEST_BUDGET_EXCEEDED', 'Release gateway budget exhausted.');
      if (req.method !== 'POST')
        fail('ROUTE_DENIED', 'Only fixed POST diagnosis routes exist.');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 2048)
          fail('REQUEST_TOO_LARGE', 'Release request is too large.');
      }
      const input = JSON.parse(raw);
      if (req.url === '/release/observe') {
        if (Object.keys(input).length)
          fail('SCOPE_DENIED', 'The release scope is fixed by the broker.');
        if (observing)
          fail('QUERY_LIMIT', 'At most one release observation per run.');
        observing = true;
        observed = await observeRelease(backend);
        target = bindRollback(observed, stableProof);
        audit('release_observed', {
          target,
          evidence_digest: digest(observed),
        });
        res.end(
          JSON.stringify({
            status: 'observed',
            data_mode: 'live_lab',
            target,
            healthy_baseline: stableProof,
            fault_checks: observed.responses.map((r) => r.status),
            fault_health: observed.health,
            note: 'Release API and HTTP evidence only; not a four-source diagnosis of this Deployment.',
          }),
        );
        return;
      }
      if (req.url === '/release/propose') {
        if (
          Object.keys(input).sort().join(',') !== 'action,reason' ||
          input.action !== 'rollback_deployment'
        )
          fail(
            'ACTION_DENIED',
            'Only one rollback_deployment can be proposed.',
          );
        if (!observed || !target)
          fail(
            'EVIDENCE_REQUIRED',
            'Observe the real release and healthy history first.',
          );
        if (proposal) fail('PROPOSAL_LIMIT', 'A proposal already exists.');
        const observations = [
          { source: 'measured-healthy-baseline', result: stableProof },
          { source: 'kubernetes-release-and-http', result: observed },
        ];
        const scope = {
          service: 'checkout-api',
          namespace: 'demo',
          start: stableProof.checked_at,
          end: new Date().toISOString(),
        };
        proposal = store.create({
          action: input.action,
          target,
          scope,
          reason: input.reason,
          evidence_digest: digest(observations),
          evidence_run_id: runId,
        });
        writeFileSync(
          path.join(directory, 'evidence-' + runId + '.json'),
          JSON.stringify({ run_id: runId, scope, observations }, null, 2) +
            '\n',
          { mode: 0o600 },
        );
        audit('proposal_created', {
          proposal_id: proposal.proposal.proposal_id,
        });
        res.end(JSON.stringify(proposal));
        return;
      }
      fail(
        'ROUTE_DENIED',
        'No approval, execution, model, shell, or arbitrary API route exists.',
      );
    } catch (e) {
      audit('request_denied', { code: e.code ?? 'GATEWAY_ERROR' });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'denied',
          code: e.code ?? 'GATEWAY_ERROR',
          message: e.code ? e.message : 'Release gateway failed.',
        }),
      );
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    if (httpTestOnly) server.listen(0, '127.0.0.1', resolve);
    else server.listen(socket, resolve);
  });
  if (!httpTestOnly) chmodSync(socket, 0o666);
  return {
    socket,
    runId,
    auditFile,
    get proposal() {
      return proposal;
    },
    ...(httpTestOnly
      ? { testAddress: { hostname: '127.0.0.1', port: server.address().port } }
      : {}),
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      if (!httpTestOnly && existsSync(socket)) unlinkSync(socket);
    },
  };
}
