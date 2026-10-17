export const scope = {
  service: 'checkout-api',
  namespace: 'demo',
  start: '2026-10-17T10:00:00.000Z',
  end: '2026-10-17T10:02:00.000Z',
};
const startNs = BigInt(Date.parse(scope.start)) * 1000000n;
const attr = (key, value, type = 'stringValue') => ({
  key,
  value: { [type]: value },
});
export function log(i = 1) {
  return {
    evidence_id: `LOKI-${i}`,
    source: 'loki:checkout-lab:logs',
    data_mode: 'live_lab',
    ...scope,
    timestamp: '2026-10-17T10:01:00.120Z',
    timestamp_ns: String(startNs + 60120000000n),
    trace_id: i.toString(16).padStart(32, '0'),
    span_id: 'a'.repeat(16),
    request_id: i.toString(16).padStart(32, '1'),
  };
}
export function payload(e = log()) {
  const common = {
    traceId: e.trace_id,
    attributes: [
      attr('request.id', e.request_id),
      attr('data.mode', 'live_lab'),
      attr('http.response.status_code', '503', 'intValue'),
      attr('lab.fault_injected', true, 'boolValue'),
    ],
    status: { code: 2 },
  };
  return {
    result: {
      resourceSpans: [
        {
          resource: {
            attributes: [
              attr('service.name', 'checkout-api'),
              attr('service.namespace', 'demo'),
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  ...common,
                  spanId: e.span_id,
                  name: 'GET /checkout',
                  startTimeUnixNano: String(startNs + 60000000000n),
                  endTimeUnixNano: String(startNs + 60130000000n),
                },
                {
                  ...common,
                  spanId: 'b'.repeat(16),
                  parentSpanId: e.span_id,
                  name: 'lab.simulate_response',
                  startTimeUnixNano: String(startNs + 60001000000n),
                  endTimeUnixNano: String(startNs + 60121000000n),
                },
              ],
            },
          ],
        },
      ],
    },
  };
}
