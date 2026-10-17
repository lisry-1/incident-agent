import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyKubernetesModel } from '../verify-kubernetes-model.mjs';
function audit() {
  const scope = {
    service: 'checkout-api',
    namespace: 'demo',
    start: '2026-10-17T10:00:00Z',
    end: '2026-10-17T10:02:00Z',
  };
  const common = {
    timestamp: '2026-10-17T10:01:00.000Z',
    data_mode: 'live_lab',
    service: 'checkout-api',
    namespace: 'demo',
    pod_uid: '11111111-1111-4111-8111-111111111111',
  };
  const begin = BigInt(Date.parse(common.timestamp)) * 1000000n;
  const root = {
    ...common,
    evidence_id: 'JAEGER-root',
    source: 'jaeger:checkout-k8s-lab:traces',
    trace_id: 'a'.repeat(32),
    span_id: 'b'.repeat(16),
    request_id: 'c'.repeat(32),
    operation: 'GET /checkout',
    timestamp_ns: String(begin),
    end_timestamp_ns: String(begin + 120000000n),
    duration_ms: 120,
  };
  const child = {
    ...root,
    evidence_id: 'JAEGER-child',
    span_id: 'd'.repeat(16),
    parent_span_id: root.span_id,
    operation: 'lab.simulate_response',
    end_timestamp_ns: String(begin + 119000000n),
    duration_ms: 119,
  };
  const groups = [
    [
      {
        ...common,
        evidence_id: 'PROM-test',
        source: 'prometheus:checkout-k8s-lab:metrics',
      },
    ],
    [
      {
        ...common,
        evidence_id: 'LOKI-test',
        source: 'loki:checkout-k8s-lab:logs',
        trace_id: root.trace_id,
        span_id: root.span_id,
        request_id: root.request_id,
        timestamp_ns: String(begin + 119500000n),
        timestamp: '2026-10-17T10:01:00.119Z',
      },
    ],
    [root, child],
    [
      {
        ...common,
        evidence_id: 'KUBE-test',
        source: 'kubernetes:incident-lab:pod_events',
        count: 24,
        aggregated: true,
      },
    ],
  ];
  const rows = groups.map((e, i) => ({
    run_id: 'one',
    data_mode: 'live_lab',
    type: 'tool_result',
    tool: i === 0 ? 'incident.probe' : 'incident.investigate',
    input: { ...scope, source: ['metrics', 'logs', 'traces', 'pod_events'][i] },
    result: { status: 'ok', partial: false, evidence: e },
  }));
  rows[2].result.query_coverage = {
    traces: {
      candidate_traces: 1,
      selected_traces: 1,
      returned_traces: 1,
      returned_spans: 2,
      sampled: false,
      failures: [],
    },
  };
  rows[3].result.current_snapshot = {
    pod_uid: common.pod_uid,
    observed_at: '2026-10-17T10:03:00Z',
    ready: 'True',
  };
  rows.push({
    run_id: 'one',
    data_mode: 'live_lab',
    type: 'tool_result',
    tool: 'incident.timeline',
    result: {
      status: 'ok',
      events: groups.flat().map((e) => ({ ...e })),
      correlations: [{ field: 'pod_uid', value: common.pod_uid }],
    },
  });
  rows.splice(1, 0, {
    run_id: 'one',
    data_mode: 'live_lab',
    type: 'stage_transition',
    from: 'probe',
    to: 'deep',
  });
  return rows;
}
test('verifier accepts original audit and computes log before parent end', () => {
  const r = verifyKubernetesModel(audit());
  assert.equal(r.domain_tool_calls, 5);
  assert.equal(r.evidence.timeline, 5);
  assert.equal(r.example_trace.log_before_root_end_ms, 0.5);
});
test('verifier rejects missing calls, mixed Pod UIDs and missing timeline evidence', () => {
  for (const change of [
    (a) => a.pop(),
    (a) =>
      (a[3].result.evidence[0].pod_uid =
        '22222222-2222-4222-8222-222222222222'),
    (a) => a[5].result.events.pop(),
  ]) {
    const a = audit();
    change(a);
    assert.throws(() => verifyKubernetesModel(a));
  }
});
test('verifier rejects timestamp/duration contradictions and history polluted with current snapshot', () => {
  for (const change of [
    (a) => (a[3].result.evidence[0].duration_ms = 42),
    (a) => (a[2].result.evidence[0].timestamp_ns = '1300000000'),
    (a) => (a[5].result.events[0].observed_at = 'now'),
  ]) {
    const a = audit();
    change(a);
    assert.throws(() => verifyKubernetesModel(a));
  }
});
test('verifier rejects foreign sources, failure coverage and missing stage transition', () => {
  for (const change of [
    (a) => (a[0].result.evidence[0].source = 'fixture:metrics'),
    (a) => a[3].result.query_coverage.traces.failures.push({ code: 'fail' }),
    (a) => a.splice(1, 1),
  ]) {
    const a = audit();
    change(a);
    assert.throws(() => verifyKubernetesModel(a));
  }
});
