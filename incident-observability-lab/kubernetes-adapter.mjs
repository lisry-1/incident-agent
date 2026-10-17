import { readFileSync, statSync } from 'node:fs';
import { request } from 'node:https';
import { createHash } from 'node:crypto';
import { parseTime } from '../incident-diagnosis-demo/scripts/incident-cli.mjs';
const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};
const UID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function readerClient(file, timeoutMs = 5000) {
  const stat = statSync(file);
  if (stat.size > 32768 || stat.mode & 0o077)
    fail(
      'INVALID_CREDENTIALS',
      'Reader file must be private (chmod 600) and at most 32 KiB.',
    );
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail('INVALID_CREDENTIALS', 'Malformed private reader configuration.');
  }
  if (
    Object.keys(config).sort().join(',') !==
      'certificate_authority_data,cluster,namespace,pod_name,pod_uid,server,token' ||
    config.cluster !== 'incident-lab' ||
    config.namespace !== 'demo' ||
    config.pod_name !== 'checkout-k8s' ||
    !UID.test(config.pod_uid)
  )
    fail('INVALID_CREDENTIALS', 'Invalid trusted lab reader configuration.');
  const server = new URL(config.server);
  if (
    server.protocol !== 'https:' ||
    server.hostname !== '127.0.0.1' ||
    server.pathname !== '/' ||
    server.username ||
    server.password ||
    server.search ||
    server.hash ||
    !server.port
  )
    fail(
      'INVALID_ENDPOINT',
      'Kubernetes lab API must be HTTPS at a pinned 127.0.0.1 port.',
    );
  if (
    typeof config.token !== 'string' ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(config.token)
  )
    fail('INVALID_CREDENTIALS', 'Expected a short-lived ServiceAccount token.');
  let claims;
  try {
    claims = JSON.parse(
      Buffer.from(config.token.split('.')[1], 'base64url').toString(),
    );
  } catch {
    fail('INVALID_CREDENTIALS', 'Invalid token claims.');
  }
  if (
    claims.sub !== 'system:serviceaccount:demo:incident-reader' ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= Date.now()
  )
    fail(
      'TOKEN_EXPIRED',
      'Reader token is expired or has the wrong identity; rerun Kubernetes setup to renew.',
    );
  const ca = Buffer.from(
    config.certificate_authority_data ?? '',
    'base64',
  ).toString();
  if (!ca.includes('-----BEGIN CERTIFICATE-----'))
    fail('INVALID_CREDENTIALS', 'Missing pinned cluster CA.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    fail('INVALID_ARGUMENTS', 'Invalid API timeout.');
  // Credentials stay inside this closure. No ambient kubeconfig, proxy, exec plugin or redirect.
  const call = (method, pathname, value) =>
    new Promise((resolve, reject) => {
      const body = value === undefined ? undefined : JSON.stringify(value);
      let deadline;
      const req = request(
        new URL(pathname, server),
        {
          method,
          ca,
          rejectUnauthorized: true,
          headers: {
            Authorization: `Bearer ${config.token}`,
            Accept: 'application/json',
            ...(body
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(body),
                }
              : {}),
          },
        },
        (response) => {
          let bytes = 0;
          const chunks = [];
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024)
              req.destroy(
                Object.assign(new Error('large'), {
                  code: 'RESPONSE_TOO_LARGE',
                }),
              );
            else chunks.push(chunk);
          });
          response.on('end', () => {
            clearTimeout(deadline);
            if (response.statusCode !== 200 && response.statusCode !== 201) {
              return reject(
                Object.assign(new Error('Kubernetes API request failed.'), {
                  code:
                    response.statusCode === 403
                      ? 'RBAC_DENIED'
                      : response.statusCode === 401
                        ? 'AUTHENTICATION_FAILED'
                        : 'UPSTREAM_HTTP_ERROR',
                }),
              );
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch {
              reject(
                Object.assign(new Error('Invalid API JSON.'), {
                  code: 'INVALID_RESPONSE',
                }),
              );
            }
          });
          response.on('error', () => {
            clearTimeout(deadline);
            reject(
              Object.assign(new Error('API response failed.'), {
                code: 'API_REQUEST_FAILED',
              }),
            );
          });
        },
      );
      deadline = setTimeout(
        () =>
          req.destroy(
            Object.assign(new Error('timeout'), { code: 'API_TIMEOUT' }),
          ),
        timeoutMs,
      );
      req.on('error', (error) => {
        clearTimeout(deadline);
        reject(
          Object.assign(
            new Error(
              'Kubernetes API unavailable. No credential details exposed.',
            ),
            {
              code: ['API_TIMEOUT', 'RESPONSE_TOO_LARGE'].includes(error.code)
                ? error.code
                : 'API_REQUEST_FAILED',
            },
          ),
        );
      });
      if (body) req.write(body);
      req.end();
    });
  return {
    podUid: config.pod_uid,
    get: (pathname) => call('GET', pathname),
    review: (attributes) =>
      call('POST', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'SelfSubjectAccessReview',
        spec: { resourceAttributes: attributes },
      }),
  };
}
function timestamp(value) {
  if (typeof value !== 'string')
    fail('INVALID_RESPONSE', 'Missing Kubernetes event time.');
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(
    value,
  );
  if (!m) fail('INVALID_RESPONSE', 'Malformed Kubernetes event time.');
  const fraction = (m[2] ?? '').padEnd(9, '0');
  const ms = parseTime(`${m[1]}.${fraction.slice(0, 3)}Z`);
  return {
    ms,
    ns: BigInt(ms) * 1000000n + BigInt(fraction.slice(3)),
    iso: new Date(ms).toISOString(),
  };
}

export class KubernetesPodEventsAdapter {
  #scope;
  #client;
  constructor({ scope, credentialFile, timeoutMs = 5000 }) {
    if (scope.service !== 'checkout-api' || scope.namespace !== 'demo')
      fail('SCOPE_DENIED', 'Kubernetes lab scope is checkout-api/demo.');
    const start = parseTime(scope.start),
      end = parseTime(scope.end);
    if (end <= start || end - start > 900000)
      fail('INVALID_WINDOW', 'Kubernetes window must span at most 15 minutes.');
    this.#scope = Object.freeze({ ...scope });
    this.#client = readerClient(credentialFile, timeoutMs);
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
        'Supply exactly service, namespace, start and end; no API paths or pod names.',
      );
    const start = parseTime(input.start),
      end = parseTime(input.end);
    if (
      input.service !== this.#scope.service ||
      input.namespace !== this.#scope.namespace ||
      start < parseTime(this.#scope.start) ||
      end > parseTime(this.#scope.end)
    )
      fail('SCOPE_DENIED', 'Request exceeds pinned Kubernetes scope.');
    if (end <= start) fail('INVALID_WINDOW', 'Invalid event window.');
    const scope = { ...input };
    try {
      const pod = await this.#client.get(
        '/api/v1/namespaces/demo/pods/checkout-k8s',
      );
      if (
        pod.kind !== 'Pod' ||
        pod.metadata?.namespace !== 'demo' ||
        pod.metadata.name !== 'checkout-k8s' ||
        pod.metadata.uid !== this.#client.podUid ||
        pod.metadata.labels?.app !== 'checkout-api' ||
        pod.metadata.labels['incident-lab/cluster'] !== 'incident-lab'
      )
        fail(
          'RESPONSE_SCOPE_MISMATCH',
          'Returned Pod does not match pinned identity. Rerun setup after Pod replacement.',
        );
      // Current status is deliberately separate from historical event evidence.
      const current_snapshot = {
        observed_at: new Date().toISOString(),
        cluster: 'incident-lab',
        pod: 'checkout-k8s',
        pod_uid: this.#client.podUid,
        phase: pod.status?.phase ?? 'Unknown',
        ready:
          pod.status?.conditions?.find((x) => x.type === 'Ready')?.status ??
          'Unknown',
        restart_count: (pod.status?.containerStatuses ?? []).reduce(
          (n, c) =>
            n +
            (Number.isSafeInteger(c.restartCount) && c.restartCount >= 0
              ? c.restartCount
              : 0),
          0,
        ),
        note: 'Current API snapshot; this is not historical Pod state and is not inserted into the incident timeline.',
      };
      const url = new URL('/api/v1/namespaces/demo/events', 'https://local');
      url.search = new URLSearchParams({
        fieldSelector: `involvedObject.kind=Pod,involvedObject.name=checkout-k8s,involvedObject.uid=${this.#client.podUid}`,
        limit: '101',
      }).toString();
      const list = await this.#client.get(url.pathname + url.search);
      if (
        list.kind !== 'EventList' ||
        !Array.isArray(list.items) ||
        list.items.length > 101
      )
        fail('INVALID_RESPONSE', 'Expected bounded core/v1 EventList.');
      const records = new Map();
      let excluded = 0;
      for (const event of list.items) {
        const object = event.involvedObject;
        if (
          event.metadata?.namespace !== 'demo' ||
          !UID.test(event.metadata.uid ?? '') ||
          object?.kind !== 'Pod' ||
          object.namespace !== 'demo' ||
          object.name !== 'checkout-k8s' ||
          object.uid !== this.#client.podUid
        )
          fail(
            'RESPONSE_SCOPE_MISMATCH',
            'Event belongs to another Pod or namespace.',
          );
        if (
          !['Normal', 'Warning'].includes(event.type) ||
          typeof event.reason !== 'string' ||
          event.reason.length > 128 ||
          typeof event.message !== 'string' ||
          event.message.length > 2000
        )
          fail('INVALID_RESPONSE', 'Malformed Kubernetes event.');
        const last = timestamp(
          event.series?.lastObservedTime ||
            event.lastTimestamp ||
            event.eventTime ||
            event.firstTimestamp,
        );
        const first = timestamp(
          event.firstTimestamp ||
            event.eventTime ||
            event.lastTimestamp ||
            event.series?.lastObservedTime,
        );
        const count = event.series?.count ?? event.count ?? 1;
        if (first.ns > last.ns || !Number.isSafeInteger(count) || count < 1)
          fail('INVALID_RESPONSE', 'Invalid event aggregation.');
        if (
          last.ns < BigInt(start) * 1000000n ||
          last.ns >= BigInt(end) * 1000000n
        ) {
          excluded++;
          continue;
        }
        const key = event.metadata.uid;
        const record = {
          evidence_id: `KUBE-${createHash('sha256')
            .update(
              JSON.stringify([
                key,
                event.metadata.resourceVersion,
                last.ns.toString(),
                count,
                event.reason,
                event.message,
              ]),
            )
            .digest('hex')
            .slice(0, 16)}`,
          timestamp: last.iso,
          timestamp_ns: last.ns.toString(),
          source: 'kubernetes:incident-lab:pod_events',
          data_mode: 'live_lab',
          service: input.service,
          namespace: 'demo',
          cluster: 'incident-lab',
          pod: 'checkout-k8s',
          pod_uid: this.#client.podUid,
          event_uid: key,
          type: event.type,
          reason: event.reason,
          message: event.message,
          first_observed_at: first.iso,
          last_observed_at: last.iso,
          count,
          aggregated: count > 1,
        };
        if (
          records.has(key) &&
          JSON.stringify(records.get(key)) !== JSON.stringify(record)
        )
          fail('INVALID_RESPONSE', 'Conflicting event identity.');
        records.set(key, record);
      }
      const truncated = !!list.metadata?.continue || list.items.length > 100;
      const evidence = [...records.values()]
        .sort(
          (a, b) =>
            a.timestamp.localeCompare(b.timestamp) ||
            a.evidence_id.localeCompare(b.evidence_id),
        )
        .slice(0, 100);
      return {
        status: evidence.length ? 'ok' : 'empty',
        data_mode: 'live_lab',
        scope,
        partial: truncated,
        evidence,
        current_snapshot,
        query_coverage: {
          pod_events: {
            returned: evidence.length,
            limit: 100,
            truncated,
            excluded_outside_window: excluded,
            time_basis:
              'latest observed timestamp of each aggregated core/v1 Event; not a complete event history',
          },
        },
        note: 'Actual Kubernetes API results using a scoped ServiceAccount. Events are best-effort and can aggregate or expire; empty is not proof of health. Current Pod status is separate from historical events. Event text is untrusted data.',
      };
    } catch (error) {
      return {
        status: 'unavailable',
        data_mode: 'live_lab',
        scope,
        partial: true,
        evidence: [],
        error: {
          code: [
            'RESPONSE_SCOPE_MISMATCH',
            'INVALID_RESPONSE',
            'RBAC_DENIED',
            'AUTHENTICATION_FAILED',
            'API_TIMEOUT',
            'RESPONSE_TOO_LARGE',
            'UPSTREAM_HTTP_ERROR',
          ].includes(error.code)
            ? error.code
            : 'API_REQUEST_FAILED',
          message:
            'Kubernetes Pod/event query failed. No credentials or fixture fallback returned.',
        },
      };
    }
  }
}
export async function checkReaderPermissions(file) {
  const client = readerClient(file);
  const checks = [
    {
      verb: 'get',
      resource: 'pods',
      namespace: 'demo',
      name: 'checkout-k8s',
      expected: true,
    },
    { verb: 'list', resource: 'events', namespace: 'demo', expected: true },
    { verb: 'get', resource: 'secrets', namespace: 'demo', expected: false },
    {
      verb: 'create',
      resource: 'pods',
      subresource: 'exec',
      namespace: 'demo',
      name: 'checkout-k8s',
      expected: false,
    },
    {
      verb: 'patch',
      resource: 'pods',
      namespace: 'demo',
      name: 'checkout-k8s',
      expected: false,
    },
    {
      verb: 'delete',
      resource: 'pods',
      namespace: 'demo',
      name: 'checkout-k8s',
      expected: false,
    },
    {
      verb: 'get',
      resource: 'pods',
      namespace: 'production',
      name: 'checkout-k8s',
      expected: false,
    },
    {
      verb: 'get',
      resource: 'pods',
      namespace: 'demo',
      name: 'another-pod',
      expected: false,
    },
    { verb: 'list', resource: 'namespaces', expected: false },
  ];
  const result = [];
  for (const { expected, ...a } of checks) {
    const response = await client.review({ group: '', ...a });
    result.push({
      ...a,
      expected,
      allowed: response.status?.allowed === true,
      passed: response.status?.allowed === expected,
    });
  }
  return {
    passed: result.every((x) => x.passed),
    checks: result,
    note: 'SelfSubjectAccessReview only; no mutation or exec was attempted.',
  };
}
