import { createHash } from 'node:crypto';
import { parseTime } from '../incident-diagnosis-demo/scripts/incident-cli.mjs';

const SELECTOR = 'job="checkout-lab",service="checkout-api",namespace="demo"';
export const QUERIES = Object.freeze({
  http_5xx_ratio: `sum by (service,namespace) (rate(checkout_requests_total{${SELECTOR},status=~"5.."}[30s])) / sum by (service,namespace) (rate(checkout_requests_total{${SELECTOR}}[30s]))`,
  request_rate: `sum by (service,namespace) (rate(checkout_requests_total{${SELECTOR}}[30s]))`,
  p95_ms: `histogram_quantile(0.95, sum by (le,service,namespace) (rate(checkout_request_duration_seconds_bucket{${SELECTOR}}[30s]))) * 1000`,
  target_up: `min by (service,namespace) (up{${SELECTOR}})`,
});
const fail = (code, message) => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

export function validateLabBase(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    fail(
      'INVALID_ENDPOINT',
      'This lab adapter requires a trusted HTTP loopback origin without credentials or path.',
    );
  }
  return url;
}

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) fail('INVALID_RESPONSE', 'Missing response body.');
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024)
        fail('RESPONSE_TOO_LARGE', 'Prometheus response exceeds 2 MiB.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Read-only Prometheus HTTP adapter. Constructor scope is trusted caller policy. */
export class PrometheusMetricsAdapter {
  #base;
  #scope;
  #timeout;
  constructor({ scope, baseUrl = 'http://127.0.0.1:19090', timeoutMs = 5000 }) {
    this.#base = validateLabBase(baseUrl);
    if (scope.service !== 'checkout-api' || scope.namespace !== 'demo')
      fail('SCOPE_DENIED', 'Lab scope is checkout-api in demo.');
    const start = parseTime(scope.start),
      end = parseTime(scope.end);
    if (end - start < 35000 || end - start > 900000)
      fail('INVALID_WINDOW', 'Lab window must span 35 seconds to 15 minutes.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
      fail('INVALID_TIMEOUT', 'Timeout must be 1–10000 ms.');
    this.#scope = Object.freeze({ ...scope });
    this.#timeout = timeoutMs;
  }
  async query(input) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 4 ||
      !['service', 'namespace', 'start', 'end'].every(
        (k) => typeof input[k] === 'string',
      )
    ) {
      fail(
        'INVALID_ARGUMENTS',
        'Supply exactly service, namespace, start and end. Raw PromQL and endpoints are not accepted.',
      );
    }
    const requested = { ...input };
    const start = parseTime(input.start),
      end = parseTime(input.end);
    if (
      input.service !== this.#scope.service ||
      input.namespace !== this.#scope.namespace ||
      start < parseTime(this.#scope.start) ||
      end > parseTime(this.#scope.end)
    ) {
      fail('SCOPE_DENIED', 'Request exceeds the pinned lab scope.');
    }
    if (end - start < 35000)
      fail(
        'INVALID_WINDOW',
        'Need at least 35 seconds for the 30-second rate window.',
      );
    // Evaluation starts 30s into the requested source window. Even rate lookback
    // stays inside policy. End is exclusive, while Prometheus API end is inclusive.
    const evalStart = start + 30000;
    const answers = await Promise.all(
      Object.entries(QUERIES).map(async ([name, expression]) => {
        try {
          const url = new URL('/api/v1/query_range', this.#base);
          url.search = new URLSearchParams({
            query: expression,
            start: String(evalStart / 1000),
            end: String((end - 1) / 1000),
            step: '5s',
            timeout: '4s',
            lookback_delta: '5s',
          }).toString();
          const response = await fetch(url, {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(this.#timeout),
          });
          if (!response.ok) {
            await response.body?.cancel();
            fail('UPSTREAM_HTTP_ERROR', `Prometheus HTTP ${response.status}.`);
          }
          const body = await readJson(response);
          if (
            body.status !== 'success' ||
            body.data?.resultType !== 'matrix' ||
            !Array.isArray(body.data.result)
          ) {
            fail(
              'INVALID_RESPONSE',
              'Expected a successful Prometheus matrix response.',
            );
          }
          const samples = new Map();
          let omitted = 0;
          for (const series of body.data.result) {
            if (
              series.metric?.service !== input.service ||
              series.metric?.namespace !== input.namespace ||
              !Array.isArray(series.values)
            ) {
              fail(
                'RESPONSE_SCOPE_MISMATCH',
                'Returned series does not match the pinned scope.',
              );
            }
            for (const pair of series.values) {
              if (
                !Array.isArray(pair) ||
                pair.length !== 2 ||
                typeof pair[0] !== 'number' ||
                typeof pair[1] !== 'string'
              ) {
                fail('INVALID_RESPONSE', 'Malformed sample.');
              }
              const ms = Math.round(pair[0] * 1000),
                value = Number(pair[1]);
              if (!Number.isFinite(ms) || ms < evalStart || ms >= end)
                fail(
                  'RESPONSE_SCOPE_MISMATCH',
                  'Sample timestamp exceeds query evaluation bounds.',
                );
              if (!pair[1].trim() || !Number.isFinite(value)) {
                omitted++;
                continue;
              }
              if (
                value < 0 ||
                (['http_5xx_ratio', 'target_up'].includes(name) && value > 1)
              )
                fail(
                  'INVALID_RESPONSE',
                  'Metric value is outside its valid range.',
                );
              if (samples.has(ms) && samples.get(ms) !== value)
                fail(
                  'INVALID_RESPONSE',
                  'Conflicting samples at one evaluation timestamp.',
                );
              samples.set(ms, value);
            }
          }
          return {
            name,
            samples,
            coverage: {
              status: samples.size ? 'ok' : 'empty',
              omitted_non_finite_samples: omitted,
              warnings: Array.isArray(body.warnings) ? body.warnings : [],
            },
          };
        } catch (error) {
          return {
            name,
            samples: new Map(),
            coverage: {
              status: 'unavailable',
              error: {
                code:
                  error.name === 'TimeoutError'
                    ? 'QUERY_TIMEOUT'
                    : typeof error.code === 'string'
                      ? error.code
                      : 'QUERY_FAILED',
                message:
                  'Prometheus query failed; missing data is not healthy data.',
              },
            },
          };
        }
      }),
    );
    const byTime = new Map();
    for (const { name, samples } of answers)
      for (const [ms, value] of samples) {
        if (!byTime.has(ms)) byTime.set(ms, {});
        byTime.get(ms)[name] = value;
      }
    const evidence = [...byTime.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ms, fields]) => ({
        evidence_id: `PROM-${createHash('sha256')
          .update(JSON.stringify([this.#base.origin, ms, fields]))
          .digest('hex')
          .slice(0, 16)}`,
        timestamp: new Date(ms).toISOString(),
        ...fields,
        source: 'prometheus:checkout-lab:metrics',
        data_mode: 'live_lab',
        service: input.service,
        namespace: input.namespace,
        missing_metrics: Object.keys(QUERIES).filter(
          (name) => !(name in fields),
        ),
      }));
    const coverage = Object.fromEntries(
      answers.map((a) => [a.name, a.coverage]),
    );
    return {
      status: evidence.length
        ? 'ok'
        : answers.some((a) => a.coverage.status === 'unavailable')
          ? 'unavailable'
          : 'empty',
      partial:
        answers.some(
          (a) =>
            a.coverage.status !== 'ok' ||
            a.coverage.warnings?.length ||
            a.coverage.omitted_non_finite_samples > 0,
        ) || evidence.some((e) => e.missing_metrics.length),
      data_mode: 'live_lab',
      scope: requested,
      evaluation_window: {
        start: new Date(evalStart).toISOString(),
        end: input.end,
        end_exclusive: true,
      },
      rate_lookback_seconds: 30,
      query_coverage: coverage,
      evidence,
      note: 'Actual Prometheus HTTP results from an intentionally fault-injected local lab; not production data. p95 is a histogram estimate. No LLM or remediation is invoked.',
    };
  }
}
