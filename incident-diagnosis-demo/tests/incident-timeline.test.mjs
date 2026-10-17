import test from 'node:test';
import assert from 'node:assert/strict';
import { alignTimeline } from '../scripts/incident-timeline.mjs';
import { parseTime, query } from '../scripts/incident-cli.mjs';
const scope = {
  service: 'checkout-api',
  namespace: 'demo',
  start: '2026-10-15T10:00:00Z',
  end: '2026-10-15T10:02:00Z',
};
const rec = (id, timestamp, extra = {}) => ({
  evidence_id: id,
  timestamp,
  service: scope.service,
  namespace: scope.namespace,
  source: 'fixture:test:logs',
  ...extra,
});
const observation = (evidence, extra = {}) => ({
  input: { ...scope, source: 'logs', ...extra },
  result: { status: 'ok', evidence },
});
const align = (observations) => alignTimeline({ scope, observations });
test('milliseconds sort correctly; identical times have deterministic ordering', () => {
  const events = [
    rec('B', '2026-10-15T10:00:00.125Z'),
    rec('C', '2026-10-15T10:00:00.001Z'),
    rec('A', '2026-10-15T10:00:00.125Z'),
  ];
  assert.deepEqual(
    align([observation(events)]).events.map((e) => e.evidence_id),
    ['C', 'A', 'B'],
  );
});
test('half-open windows and minute slices retain boundary records only in their own slice', () => {
  const result = align([
    observation([
      rec('start', scope.start),
      rec('before', '2026-10-15T10:00:59.999Z'),
      rec('next', '2026-10-15T10:01:00.000Z'),
      rec('end', scope.end),
    ]),
  ]);
  assert.equal(result.excluded_records, 1);
  assert.deepEqual(
    result.slices.map((s) => s.evidence.map((e) => e.evidence_id)),
    [['start', 'before'], ['next']],
  );
});
test('scope mismatches and records outside their query interval are excluded', () => {
  const result = align([
    observation(
      [
        rec('wrong', scope.start, { namespace: 'production' }),
        rec('outside-query', '2026-10-15T10:01:30Z'),
      ],
      { end: '2026-10-15T10:01:00Z' },
    ),
  ]);
  assert.equal(result.events.length, 0);
  assert.equal(result.excluded_records, 2);
});
test('duplicate retrieval is deduplicated without losing query coverage', () => {
  const o = observation([rec('one', scope.start)]);
  const result = align([o, o]);
  assert.equal(result.events.length, 1);
  assert.equal(result.source_coverage.logs.length, 2);
});
test('conflicting reuse of evidence identity fails visibly', () => {
  assert.throws(
    () =>
      align([
        observation([
          rec('one', scope.start),
          rec('one', scope.start, { message: 'different' }),
        ]),
      ]),
    /Conflicting/,
  );
});
test('same ID from distinct sources remains distinguishable', () => {
  const result = align([
    observation([
      rec('same', scope.start),
      rec('same', scope.start, { source: 'fixture:other:logs' }),
    ]),
  ]);
  assert.equal(result.events.length, 2);
});
test('exact trace association survives a time-slice boundary; mere proximity is not a causal link', () => {
  const result = align([
    observation([
      rec('A', '2026-10-15T10:00:59.999Z', { trace_id: 't1' }),
      rec('B', '2026-10-15T10:01:00.001Z', { trace_id: 't1' }),
      rec('C', '2026-10-15T10:01:00.002Z'),
    ]),
  ]);
  assert.deepEqual(
    result.correlations[0].evidence.map((e) => e.evidence_id),
    ['A', 'B'],
  );
  assert.match(result.note, /not proven causation/);
});
test('reject impossible dates and malformed fractional timestamps', () => {
  for (const time of [
    '2026-02-30T10:00:00.125Z',
    '2026-10-15T10:00:00.1Z',
    '2026-10-15T25:00:00Z',
  ]) {
    assert.throws(() => parseTime(time));
  }
});
test('fixture query applies millisecond precision at start and end', () => {
  const result = query({
    case: 'release-regression',
    source: 'pod_events',
    ...scope,
    start: '2026-10-15T10:05:00.125Z',
    end: '2026-10-15T10:08:59.950Z',
  });
  assert.deepEqual(
    result.evidence.map((e) => e.evidence_id),
    ['REL-P1'],
  );
});
test('invalid slice sizes cannot create unbounded or invalid buckets', () => {
  for (const sliceMs of [0, -1, Infinity, 0.1])
    assert.throws(() => alignTimeline({ scope, observations: [], sliceMs }));
});
