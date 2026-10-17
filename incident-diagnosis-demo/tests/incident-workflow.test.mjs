import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IncidentHarness } from '../scripts/incident-harness.mjs';
import { query } from '../scripts/incident-cli.mjs';

const args = {
  case: 'release-regression',
  service: 'checkout-api',
  namespace: 'demo',
  start: '2026-10-15T10:00:00Z',
  end: '2026-10-15T10:15:00Z',
  source: 'metrics',
};
const req = (tool, input = args) => ({ tool, arguments: input });
const probe = (h) => h.dispatch(req('incident.probe'));
const deep = (h, source) =>
  h.dispatch(req('incident.investigate', { ...args, source }));
const timeline = (h) => h.dispatch(req('incident.timeline', {}));
function setup(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'incident-stage-'));
  let calls = 0;
  const harness = new IncidentHarness({
    caseId: args.case,
    auditDirectory: dir,
    staged: true,
    executeQuery: (input) => {
      calls++;
      return query(input);
    },
    ...options,
  });
  t.after(() => {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    harness,
    calls: () => calls,
    records: () =>
      readFileSync(harness.auditFile, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse),
  };
}
test('deep and timeline calls before probe are denied without execution; old entry cannot bypass', (t) => {
  const { harness: h, calls } = setup(t);
  assert.equal(deep(h, 'logs').code, 'STAGE_DENIED');
  assert.equal(timeline(h).code, 'STAGE_DENIED');
  assert.equal(h.dispatch(req('incident.query')).code, 'TOOL_NOT_ALLOWED');
  assert.equal(calls(), 0);
  assert.deepEqual(h.availableTools, ['incident.probe']);
});
test('scope denial and non-metric probe cannot unlock deep stage', (t) => {
  const { harness: h, calls } = setup(t);
  assert.equal(
    h.dispatch(req('incident.probe', { ...args, namespace: 'production' }))
      .code,
    'SCOPE_DENIED',
  );
  assert.equal(
    h.dispatch(req('incident.probe', { ...args, source: 'traces' })).code,
    'STAGE_DENIED',
  );
  assert.equal(h.stage, 'probe');
  assert.equal(calls(), 0);
});
test('observed abnormal metrics unlock deep tools and emit an ordered audit transition', (t) => {
  const { harness: h, records } = setup(t);
  assert.equal(probe(h).stage, 'deep');
  assert.deepEqual(h.availableTools, [
    'incident.investigate',
    'incident.timeline',
  ]);
  assert.equal(probe(h).code, 'STAGE_DENIED');
  assert.equal(deep(h, 'metrics').code, 'STAGE_DENIED');
  const audit = records();
  assert.deepEqual(
    audit.slice(0, 3).map((e) => e.type),
    ['permission', 'tool_result', 'stage_transition'],
  );
  assert.equal(audit[2].from, 'probe');
  assert.equal(audit[2].to, 'deep');
  assert.deepEqual(
    audit.map((e) => e.sequence),
    audit.map((_, i) => i + 1),
  );
});
test('unavailable probe remains in probe and third identical failure is blocked', (t) => {
  const { harness: h } = setup(t, {
    executeQuery: () => ({ status: 'unavailable', evidence: [] }),
  });
  assert.equal(probe(h).result.status, 'unavailable');
  assert.equal(probe(h).result.status, 'unavailable');
  assert.equal(probe(h).code, 'CIRCUIT_OPEN');
  assert.equal(h.stage, 'probe');
});
test('no observed anomaly completes collection without claiming health or enabling deep tools', (t) => {
  const { harness: h } = setup(t);
  const r = h.dispatch(
    req('incident.probe', { ...args, end: '2026-10-15T10:05:00Z' }),
  );
  assert.equal(r.stage, 'complete');
  assert.equal(deep(h, 'logs').code, 'STAGE_DENIED');
  const aligned = timeline(h).result;
  assert.equal(aligned.events.length, 1);
  assert.equal(aligned.source_coverage.metrics[0].end, '2026-10-15T10:05:00Z');
  assert.ok(aligned.not_queried_sources.includes('logs'));
});
test('full collection aligns eight fixture records with trace/log links and precise pod timestamps', (t) => {
  const { harness: h, calls } = setup(t);
  probe(h);
  for (const source of ['traces', 'logs', 'pod_events', 'deployments'])
    assert.equal(deep(h, source).result.status, 'ok');
  const aligned = timeline(h).result;
  assert.equal(calls(), 5); // Timeline must not silently fetch more evidence.
  assert.equal(aligned.events.length, 8);
  assert.deepEqual(aligned.not_queried_sources, []);
  assert.equal(
    aligned.events.find((e) => e.evidence_id === 'REL-P1').timestamp,
    '2026-10-15T10:05:00.125Z',
  );
  const link = aligned.correlations.find((c) => c.field === 'trace_id');
  assert.deepEqual(link.evidence.map((e) => e.evidence_id).sort(), [
    'REL-L2',
    'REL-T1',
  ]);
});
test('timeline uses protected observations rather than caller-mutated tool results', (t) => {
  const { harness: h } = setup(t);
  const r = probe(h);
  r.result.evidence[0].http_5xx_ratio = 0.99;
  assert.equal(timeline(h).result.events[0].http_5xx_ratio, 0.002);
});
test('timeline rejects caller-supplied evidence and requests share one budget', (t) => {
  const { harness: h, calls } = setup(t, { maxAttempts: 3 });
  assert.equal(deep(h, 'logs').code, 'STAGE_DENIED');
  probe(h);
  assert.equal(
    h.dispatch(req('incident.timeline', { evidence: [] })).code,
    'INVALID_ARGUMENTS',
  );
  assert.equal(timeline(h).code, 'BUDGET_EXHAUSTED');
  assert.equal(calls(), 1);
});
test('missing and unqueried sources remain explicit in the aligned result', (t) => {
  const { harness: h } = setup(t, { caseId: 'insufficient-evidence' });
  const call = (source) =>
    h.dispatch(
      req(source === 'metrics' ? 'incident.probe' : 'incident.investigate', {
        ...args,
        case: 'insufficient-evidence',
        source,
      }),
    );
  call('metrics');
  call('logs');
  call('logs');
  assert.equal(call('logs').code, 'CIRCUIT_OPEN');
  const aligned = timeline(h).result;
  assert.equal(aligned.events.length, 1);
  assert.equal(aligned.source_coverage.logs[0].status, 'unavailable');
  assert.ok(aligned.not_queried_sources.includes('traces'));
});
test('each run starts with its own probe stage and no inherited observations', (t) => {
  const first = setup(t).harness;
  const second = setup(t).harness;
  probe(first);
  assert.equal(second.stage, 'probe');
  assert.equal(deep(second, 'logs').code, 'STAGE_DENIED');
});
