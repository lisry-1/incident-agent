import assert from 'node:assert/strict';
import {
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ns = (value) => {
  assert.match(value, /^\d{1,20}$/);
  return BigInt(value);
};
const identity = (e) => `${e.source}\0${e.evidence_id}`;

/** Verifies original domain-tool audit records, not the model's prose. */
export function verifyKubernetesModel(events) {
  assert.ok(events.length > 0, 'Empty audit.');
  assert.equal(new Set(events.map((e) => e.run_id)).size, 1, 'Mixed runs.');
  assert.ok(
    events.every((e) => e.data_mode === 'live_lab'),
    'Expected live_lab only.',
  );
  assert.ok(
    !events.some((e) => e.type === 'permission' && e.decision !== 'allow'),
    'Contains a denied domain request.',
  );
  const rows = events.filter((e) => e.type === 'tool_result');
  assert.deepEqual(
    rows.map((e) => e.tool),
    [
      'incident.probe',
      'incident.investigate',
      'incident.investigate',
      'incident.investigate',
      'incident.timeline',
    ],
    'Expected five domain calls.',
  );
  assert.deepEqual(
    rows.slice(0, 4).map((e) => e.input.source),
    ['metrics', 'logs', 'traces', 'pod_events'],
  );
  assert.ok(
    rows.every((e) => e.result.status === 'ok'),
    'A tool did not return ok.',
  );
  const transition = events.findIndex(
    (e) =>
      e.type === 'stage_transition' && e.from === 'probe' && e.to === 'deep',
  );
  assert.ok(
    transition > events.indexOf(rows[0]) &&
      transition < events.indexOf(rows[1]),
    'Missing ordered probe → deep.',
  );
  const groups = rows.map((e) => e.result.events ?? e.result.evidence);
  assert.ok(
    groups.every((e) => Array.isArray(e) && e.length > 0),
    'Expected evidence from each source.',
  );
  const sources = [
    'prometheus:checkout-k8s-lab:metrics',
    'loki:checkout-k8s-lab:logs',
    'jaeger:checkout-k8s-lab:traces',
    'kubernetes:incident-lab:pod_events',
  ];
  const prefixes = ['PROM-', 'LOKI-', 'JAEGER-', 'KUBE-'];
  for (let i = 0; i < 4; i++) {
    for (const e of groups[i]) {
      assert.equal(e.source, sources[i]);
      assert.ok(e.evidence_id.startsWith(prefixes[i]));
      assert.equal(e.data_mode, 'live_lab');
      assert.equal(e.service, 'checkout-api');
      assert.equal(e.namespace, 'demo');
      const time = Date.parse(e.timestamp);
      if (e.timestamp_ns !== undefined)
        assert.equal(
          Number(ns(e.timestamp_ns) / 1000000n),
          time,
          'Nanosecond and millisecond timestamps disagree.',
        );
      assert.ok(
        Number.isFinite(time) &&
          time >= Date.parse(rows[i].input.start) &&
          time < Date.parse(rows[i].input.end),
        'Evidence is outside its query window.',
      );
    }
  }
  assert.deepEqual(
    new Set(groups[4].map(identity)),
    new Set(groups.slice(0, 4).flat().map(identity)),
    'Timeline evidence union mismatch.',
  );
  assert.equal(
    groups[4].length,
    new Set(groups[4].map(identity)).size,
    'Duplicate timeline evidence.',
  );
  assert.ok(
    !groups[4].some((e) => e.observed_at || e.current_snapshot),
    'Current snapshot was inserted into history.',
  );
  const [metrics, logs, spans, podEvents, timeline] = groups;
  const uids = new Set([...logs, ...spans, ...podEvents].map((e) => e.pod_uid));
  assert.equal(uids.size, 1, 'Pod UID mismatch.');
  const podUid = [...uids][0];
  assert.match(podUid, /^[a-f0-9-]{36}$/);
  assert.equal(rows[3].result.current_snapshot?.pod_uid, podUid);
  assert.ok(
    rows[4].result.correlations?.some(
      (c) => c.field === 'pod_uid' && c.value === podUid,
    ),
    'Missing Pod UID association.',
  );
  const coverage = rows[2].result.query_coverage.traces;
  const traces = new Map();
  for (const span of spans) {
    if (!traces.has(span.trace_id)) traces.set(span.trace_id, []);
    traces.get(span.trace_id).push(span);
  }
  assert.equal(
    coverage.candidate_traces,
    new Set(logs.map((e) => e.trace_id)).size,
  );
  assert.equal(coverage.selected_traces, traces.size);
  assert.equal(coverage.returned_traces, traces.size);
  assert.equal(coverage.returned_spans, spans.length);
  assert.ok(traces.size <= 8);
  assert.deepEqual(coverage.failures, []);
  assert.equal(
    coverage.sampled,
    coverage.candidate_traces > coverage.selected_traces,
  );
  if (coverage.sampled) assert.equal(rows[2].result.partial, true);
  const examples = [];
  for (const [traceId, pair] of traces) {
    assert.equal(pair.length, 2, 'Each selected trace must contain two spans.');
    const root = pair.find(
      (e) => !e.parent_span_id && e.operation === 'GET /checkout',
    );
    assert.ok(root, 'Missing root span.');
    const child = pair.find(
      (e) =>
        e.parent_span_id === root.span_id &&
        e.operation === 'lab.simulate_response',
    );
    assert.ok(child, 'Missing nested child.');
    const log = logs.find(
      (e) =>
        e.trace_id === traceId &&
        e.span_id === root.span_id &&
        e.request_id === root.request_id,
    );
    assert.ok(log, 'Missing matching request log.');
    assert.equal(child.request_id, root.request_id);
    const begin = ns(root.timestamp_ns),
      end = ns(root.end_timestamp_ns),
      logTime = ns(log.timestamp_ns);
    assert.ok(
      begin <= ns(child.timestamp_ns) &&
        ns(child.end_timestamp_ns) <= end &&
        ns(child.timestamp_ns) <= ns(child.end_timestamp_ns),
    );
    assert.ok(
      begin <= logTime && logTime <= end,
      'Log must be inside root span.',
    );
    for (const e of pair)
      assert.ok(
        Math.abs(
          e.duration_ms -
            Number(ns(e.end_timestamp_ns) - ns(e.timestamp_ns)) / 1e6,
        ) < 1e-6,
        'Span duration mismatch.',
      );
    examples.push({
      trace_id: traceId,
      root_duration_ms: root.duration_ms,
      child_duration_ms: child.duration_ms,
      log_before_root_end_ms: Number(end - logTime) / 1e6,
    });
  }
  for (const e of podEvents) {
    assert.ok(Number.isInteger(e.count) && e.count >= 1);
    assert.equal(e.aggregated, e.count > 1);
  }
  return {
    status: 'verified',
    run_id: rows[0].run_id,
    data_mode: 'live_lab',
    domain_tool_calls: 5,
    evidence: {
      metrics: metrics.length,
      logs: logs.length,
      spans: spans.length,
      pod_events: podEvents.length,
      timeline: timeline.length,
    },
    partial: Object.fromEntries(
      rows.slice(0, 4).map((e) => [e.input.source, e.result.partial]),
    ),
    pod_uid: podUid,
    trace_coverage: coverage,
    pod_event_aggregation: podEvents.map((e) => ({
      evidence_id: e.evidence_id,
      count: e.count,
      aggregated: e.aggregated,
    })),
    current_snapshot: rows[3].result.current_snapshot,
    example_trace: examples[0],
    note: 'Verifies domain audit only. It does not verify model prose, prove absence of other host tools, or measure diagnostic accuracy.',
  };
}
function main() {
  const dir = path.resolve('data/groups/main/incident-audit');
  const files = readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => path.join(dir, n))
    .filter((p) => statSync(p).size > 0);
  const file = process.argv[2]
    ? path.resolve(process.argv[2])
    : files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  assert.ok(file, 'No nonempty audit found.');
  const events = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const result = verifyKubernetesModel(events);
  const target = path.resolve('docs/evidence/kubernetes-model-run.jsonl');
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(file, target);
  console.log(
    JSON.stringify({ ...result, audit_file: file, saved_to: target }, null, 2),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      JSON.stringify({ status: 'verification_failed', message: error.message }),
    );
    process.exitCode = 1;
  }
}
