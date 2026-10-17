import { createHash } from 'node:crypto';
import { parseTime } from '../incident-diagnosis-demo/scripts/incident-cli.mjs';
import { validateLabBase, readJson } from './prometheus-adapter.mjs';
const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};
const id = (value, bytes) => {
  if (typeof value !== 'string')
    fail('INVALID_RESPONSE', 'Missing span identity.');
  if (new RegExp(`^[a-fA-F0-9]{${bytes * 2}}$`).test(value))
    return value.toLowerCase();
  // Some protobuf JSON gateways encode bytes as base64 instead of OTLP hex.
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === bytes && decoded.toString('base64') === value)
    return decoded.toString('hex');
  fail('INVALID_RESPONSE', 'Malformed span identity.');
};
const attrs = (list) => {
  if (!Array.isArray(list) || list.length > 100)
    fail('INVALID_RESPONSE', 'Malformed span attributes.');
  const out = Object.create(null);
  for (const a of list) {
    if (
      typeof a?.key !== 'string' ||
      Object.hasOwn(out, a.key) ||
      !a.value ||
      Object.keys(a.value).length !== 1
    )
      fail('INVALID_RESPONSE', 'Malformed or duplicate attribute.');
    out[a.key] = a.value.stringValue ?? a.value.intValue ?? a.value.boolValue;
  }
  return out;
};
const ns = (value) => {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value))
    fail('INVALID_RESPONSE', 'Expected nanosecond string.');
  return BigInt(value);
};

/** Trusted code supplies protected Loki observations; the model cannot select trace IDs. */
export class JaegerTracesAdapter {
  #scope;
  #base;
  #timeout;
  #logs = [];
  constructor({ scope, baseUrl = 'http://127.0.0.1:16686', timeoutMs = 5000 }) {
    this.#base = validateLabBase(baseUrl);
    const start = parseTime(scope.start),
      end = parseTime(scope.end);
    if (scope.service !== 'checkout-api' || scope.namespace !== 'demo')
      fail('SCOPE_DENIED', 'Invalid trace scope.');
    if (end <= start || end - start > 900000)
      fail('INVALID_WINDOW', 'Trace scope must span at most 15 minutes.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
      fail('INVALID_ARGUMENTS', 'Invalid timeout.');
    this.#scope = Object.freeze({ ...scope });
    this.#timeout = timeoutMs;
  }
  observeLogs(result) {
    // Replace, never mutate returned objects or inherit a previous run's context.
    this.#logs =
      result?.status === 'ok' ? structuredClone(result.evidence) : [];
  }
  async query(input) {
    if (
      !input ||
      Array.isArray(input) ||
      Object.keys(input).length !== 4 ||
      !['service', 'namespace', 'start', 'end'].every(
        (k) => typeof input[k] === 'string',
      )
    )
      fail(
        'INVALID_ARGUMENTS',
        'Supply only service, namespace, start and end; no trace IDs or URL.',
      );
    const start = parseTime(input.start),
      end = parseTime(input.end);
    if (
      input.service !== this.#scope.service ||
      input.namespace !== this.#scope.namespace ||
      start < parseTime(this.#scope.start) ||
      end > parseTime(this.#scope.end)
    )
      fail('SCOPE_DENIED', 'Request exceeds pinned trace scope.');
    if (end <= start) fail('INVALID_WINDOW', 'Invalid trace window.');
    const scope = { ...input };
    const contexts = new Map();
    for (const e of this.#logs) {
      if (
        e.source !== 'loki:checkout-lab:logs' ||
        e.data_mode !== 'live_lab' ||
        e.service !== input.service ||
        e.namespace !== input.namespace ||
        !/^[a-f0-9]{32}$/.test(e.trace_id ?? '') ||
        !/^[a-f0-9]{16}$/.test(e.span_id ?? '') ||
        !/^[a-f0-9]{32}$/.test(e.request_id ?? '') ||
        !/^\d{1,20}$/.test(e.timestamp_ns ?? '') ||
        Date.parse(e.timestamp) < start ||
        Date.parse(e.timestamp) >= end ||
        !Number.isFinite(Date.parse(e.timestamp))
      )
        continue;
      contexts.set(e.trace_id, e);
    }
    const selected = [...contexts.values()]
      .sort(
        (a, b) =>
          a.timestamp.localeCompare(b.timestamp) ||
          a.trace_id.localeCompare(b.trace_id),
      )
      .slice(0, 8);
    if (!selected.length)
      return {
        status: 'unavailable',
        data_mode: 'live_lab',
        scope,
        partial: true,
        evidence: [],
        error: {
          code: 'TRACE_CONTEXT_MISSING',
          message:
            'Query configured Loki logs first; no observed trace context in this window.',
        },
      };
    const evidence = [],
      failures = [];
    // At most 8 exact lookups, 4 in flight, two bounded waves. No search/fallback endpoint.
    for (let offset = 0; offset < selected.length; offset += 4) {
      await Promise.all(
        selected.slice(offset, offset + 4).map(async (context) => {
          try {
            evidence.push(...(await this.#get(context, input)));
          } catch (error) {
            failures.push({
              trace_id: context.trace_id,
              code: error.code ?? 'TRACE_QUERY_FAILED',
            });
          }
        }),
      );
    }
    evidence.sort(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp) ||
        a.evidence_id.localeCompare(b.evidence_id),
    );
    const coverage = {
      candidate_traces: contexts.size,
      selected_traces: selected.length,
      returned_traces: new Set(evidence.map((e) => e.trace_id)).size,
      returned_spans: evidence.length,
      sampled: contexts.size > selected.length,
      selection: 'earliest 8 distinct trace IDs from observed HTTP 503 logs',
      failures,
    };
    return {
      status: evidence.length ? 'ok' : 'unavailable',
      data_mode: 'live_lab',
      scope,
      partial: coverage.sampled || failures.length > 0,
      evidence,
      query_coverage: { traces: coverage },
      ...(!evidence.length
        ? {
            error: {
              code: 'TRACE_QUERY_FAILED',
              message:
                'No selected trace could be validated. No fixture fallback.',
            },
          }
        : {}),
      note: 'Actual Jaeger spans from this single-service local experiment. Sampling is explicit; traces are not full request coverage. Parent-child and shared trace IDs show recorded request structure, not proof of a production root cause.',
    };
  }
  async #get(context, input) {
    const url = new URL(`/api/v3/traces/${context.trace_id}`, this.#base);
    url.search = new URLSearchParams({
      startTime: input.start,
      endTime: input.end,
      rawTraces: 'true',
    }).toString();
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(this.#timeout),
    });
    if (!response.ok) {
      await response.body?.cancel();
      fail('UPSTREAM_HTTP_ERROR', `Jaeger HTTP ${response.status}.`);
    }
    const body = await readJson(response);
    if (body.error || !Array.isArray(body.result?.resourceSpans))
      fail('INVALID_RESPONSE', 'Expected Jaeger v3 OTLP result.');
    const records = [];
    const start = BigInt(parseTime(input.start)) * 1000000n,
      end = BigInt(parseTime(input.end)) * 1000000n;
    for (const resource of body.result.resourceSpans) {
      const resourceAttrs = attrs(resource.resource?.attributes);
      if (
        resourceAttrs['service.name'] !== input.service ||
        resourceAttrs['service.namespace'] !== input.namespace
      )
        fail(
          'RESPONSE_SCOPE_MISMATCH',
          'Returned trace resource is outside scope.',
        );
      if (!Array.isArray(resource.scopeSpans))
        fail('INVALID_RESPONSE', 'Missing span scopes.');
      for (const group of resource.scopeSpans) {
        if (!Array.isArray(group.spans))
          fail('INVALID_RESPONSE', 'Missing spans.');
        for (const span of group.spans) {
          if (records.length >= 32)
            fail('INVALID_RESPONSE', 'Too many spans in lab trace.');
          const traceId = id(span.traceId, 16),
            spanId = id(span.spanId, 8);
          const parent = span.parentSpanId
            ? id(span.parentSpanId, 8)
            : undefined;
          const begin = ns(span.startTimeUnixNano),
            finish = ns(span.endTimeUnixNano),
            a = attrs(span.attributes);
          if (
            traceId !== context.trace_id ||
            a['request.id'] !== context.request_id ||
            a['data.mode'] !== 'live_lab' ||
            begin < start ||
            begin >= end ||
            finish > end ||
            finish < begin
          )
            fail(
              'RESPONSE_SCOPE_MISMATCH',
              'Span identity or time exceeds observed request scope.',
            );
          if (
            !['GET /checkout', 'lab.simulate_response'].includes(span.name) ||
            String(a['http.response.status_code']) !== '503' ||
            a['lab.fault_injected'] !== true ||
            ![2, 'STATUS_CODE_ERROR'].includes(span.status?.code)
          )
            fail('INVALID_RESPONSE', 'Unexpected lab span schema.');
          records.push({
            evidence_id: `JAEGER-${createHash('sha256').update(`${this.#base.origin}:${traceId}:${spanId}`).digest('hex').slice(0, 16)}`,
            timestamp: new Date(Number(begin / 1000000n)).toISOString(),
            timestamp_ns: begin.toString(),
            end_timestamp_ns: finish.toString(),
            duration_ms: Number(finish - begin) / 1e6,
            source: 'jaeger:checkout-lab:traces',
            data_mode: 'live_lab',
            service: input.service,
            namespace: input.namespace,
            trace_id: traceId,
            span_id: spanId,
            ...(parent ? { parent_span_id: parent } : {}),
            request_id: context.request_id,
            operation: span.name,
            status: 'ERROR',
            http_status: 503,
            fault_injected: true,
          });
        }
      }
    }
    // This instrumentation emits exactly two spans. Missing or unrelated spans fail visibly.
    const root = records.find(
      (e) =>
        e.span_id === context.span_id &&
        !e.parent_span_id &&
        e.operation === 'GET /checkout',
    );
    const child = records.find(
      (e) =>
        e.parent_span_id === context.span_id &&
        e.operation === 'lab.simulate_response',
    );
    if (
      records.length !== 2 ||
      !root ||
      !child ||
      root.span_id === child.span_id ||
      BigInt(child.timestamp_ns) < BigInt(root.timestamp_ns) ||
      BigInt(child.end_timestamp_ns) > BigInt(root.end_timestamp_ns) ||
      BigInt(context.timestamp_ns) < BigInt(root.timestamp_ns) ||
      BigInt(context.timestamp_ns) > BigInt(root.end_timestamp_ns)
    )
      fail(
        'INCOMPLETE_TRACE',
        'Expected log-associated root and nested child span.',
      );
    return records;
  }
}
