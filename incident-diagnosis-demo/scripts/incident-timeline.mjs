import { parseTime } from './incident-cli.mjs';

const SOURCES = ['metrics', 'logs', 'deployments', 'pod_events', 'traces'];

/** Align ONLY observed query results. Time proximity is never a causal label. */
export function alignTimeline({
  scope,
  observations,
  sliceMs = 60_000,
  dataMode = 'synthetic_fixture',
}) {
  const start = parseTime(scope.start);
  const end = parseTime(scope.end);
  if (
    end <= start ||
    end - start > 3_600_000 ||
    !Number.isInteger(sliceMs) ||
    sliceMs < 1 ||
    sliceMs > 3_600_000
  ) {
    throw new Error('Invalid timeline window or slice size.');
  }
  const records = new Map();
  const coverage = Object.fromEntries(SOURCES.map((source) => [source, []]));
  let excluded = 0;
  for (const observation of observations) {
    const { input, result } = observation;
    if (!SOURCES.includes(input.source))
      throw new Error('Unknown evidence source.');
    coverage[input.source].push({
      start: input.start,
      end: input.end,
      status: result.status,
      ...(result.partial !== undefined
        ? { partial: result.partial, query_coverage: result.query_coverage }
        : {}),
    });
    for (const record of result.evidence || []) {
      const ms = parseTime(record.timestamp);
      // Validate provenance against the actual query, not just the overall run.
      if (
        record.service !== scope.service ||
        record.namespace !== scope.namespace ||
        ms < start ||
        ms >= end ||
        ms < parseTime(input.start) ||
        ms >= parseTime(input.end)
      ) {
        excluded++;
        continue;
      }
      if (
        typeof record.evidence_id !== 'string' ||
        !record.evidence_id ||
        typeof record.source !== 'string' ||
        !record.source
      ) {
        throw new Error('Evidence requires an ID and source.');
      }
      const key = `${record.source}\0${record.evidence_id}`;
      const normalized = {
        ...record,
        timestamp: new Date(ms).toISOString(),
        timestamp_ms: ms,
        source_kind: input.source,
      };
      const previous = records.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
        throw new Error('Conflicting records share an evidence ID and source.');
      }
      records.set(key, normalized);
    }
  }
  const events = [...records.values()].sort(
    (a, b) =>
      a.timestamp_ms - b.timestamp_ms ||
      a.source.localeCompare(b.source) ||
      a.evidence_id.localeCompare(b.evidence_id),
  );
  const slices = new Map();
  const groups = new Map();
  for (const event of events) {
    const index = Math.floor((event.timestamp_ms - start) / sliceMs);
    if (!slices.has(index))
      slices.set(index, {
        start: new Date(start + index * sliceMs).toISOString(),
        end: new Date(
          Math.min(end, start + (index + 1) * sliceMs),
        ).toISOString(),
        evidence: [],
      });
    const ref = { evidence_id: event.evidence_id, source: event.source };
    slices.get(index).evidence.push(ref);
    for (const field of ['trace_id', 'pod', 'version']) {
      if (typeof event[field] !== 'string' || !event[field]) continue;
      const key = `${field}\0${event[field]}`;
      if (!groups.has(key))
        groups.set(key, { field, value: event[field], evidence: [] });
      groups.get(key).evidence.push(ref);
    }
  }
  return {
    status: events.length ? 'ok' : 'empty',
    data_mode: dataMode,
    scope,
    slice_ms: sliceMs,
    events,
    slices: [...slices.values()],
    correlations: [...groups.values()].filter(
      (group) => group.evidence.length > 1,
    ),
    source_coverage: coverage,
    not_queried_sources: SOURCES.filter(
      (source) => coverage[source].length === 0,
    ),
    excluded_records: excluded,
    note: 'Observed evidence only. Shared identifiers and time slices show association, not proven causation. Unqueried or unavailable data is not healthy data.',
  };
}
