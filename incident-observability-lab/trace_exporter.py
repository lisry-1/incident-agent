"""Bounded OTLP/HTTP JSON exporter for the local experiment; no durable queue."""
import json
import queue
import threading
import urllib.request
from urllib.parse import urlsplit
from log_exporter import NoRedirect


def attributes(values):
    result = []
    for key, value in values.items():
        kind = 'boolValue' if isinstance(value, bool) else 'intValue' if isinstance(value, int) else 'stringValue'
        result.append({'key': key, 'value': {kind: str(value) if kind == 'intValue' else value}})
    return result


def request_spans(trace_id, root_id, child_id, request_id, start, child_start, child_end, end, status):
    """Times are measured by the handler; these spans do not represent a database."""
    attrs = attributes({'request.id': request_id, 'http.response.status_code': status,
                        'lab.fault_injected': status == 503, 'data.mode': 'live_lab'})
    def span(name, sid, begin, finish, kind, parent=None):
        result = {'traceId': trace_id, 'spanId': sid, 'name': name, 'kind': kind,
                  'startTimeUnixNano': str(begin), 'endTimeUnixNano': str(finish),
                  'attributes': attrs, 'status': {'code': 2 if status == 503 else 1}}
        if parent:
            result['parentSpanId'] = parent
        return result
    return [span('GET /checkout', root_id, start, end, 2),
            span('lab.simulate_response', child_id, child_start, child_end, 1, root_id)]


class TracePublisher:
    def __init__(self, endpoint, capacity=2048, retry_delay=0.2):
        url = urlsplit(endpoint)
        if (url.scheme != 'http' or url.hostname not in ('jaeger', 'localhost', '127.0.0.1')
                or url.path != '/v1/traces' or url.query or url.fragment or url.username or url.password):
            raise ValueError('Trace exporter requires the trusted local OTLP endpoint')
        self.endpoint = endpoint
        self.queue = queue.Queue(maxsize=capacity)
        self.lock = threading.Lock()
        self.sent = self.dropped = self.failures = self.pending = 0
        self.retry_delay = retry_delay
        self.stop = threading.Event()
        self.thread = None
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def emit(self, spans):
        with self.lock:
            try:
                self.queue.put_nowait(spans)
                self.pending += len(spans)
            except queue.Full:
                self.dropped += len(spans)

    def snapshot(self):
        with self.lock:
            return {'enabled': True, 'unit': 'spans', 'sent': self.sent, 'dropped': self.dropped,
                    'failed_batches': self.failures, 'pending': self.pending}

    def push(self, spans):
        payload = json.dumps({'resourceSpans': [{'resource': {'attributes': attributes({
            'service.name': 'checkout-api', 'service.namespace': 'demo'})},
            'scopeSpans': [{'scope': {'name': 'incident-lab', 'version': '1'}, 'spans': spans}]}]}).encode()
        for attempt in range(3):
            try:
                req = urllib.request.Request(self.endpoint, data=payload,
                        headers={'Content-Type': 'application/json'}, method='POST')
                with self.opener.open(req, timeout=2) as response:
                    if response.status != 200:
                        raise ValueError('OTLP did not accept spans')
                    raw = response.read(65537)
                    if len(raw) > 65536:
                        raise ValueError('Oversized OTLP response')
                    body = json.loads(raw)
                    if not isinstance(body, dict):
                        raise ValueError('Invalid OTLP response')
                    partial = body.get('partialSuccess', {})
                    # Never retry a partial acceptance; count the batch conservatively as lost.
                    if partial.get('errorMessage') or int(partial.get('rejectedSpans', 0)) != 0:
                        with self.lock:
                            self.failures += 1
                        return False
                return True
            except (OSError, ValueError, TypeError, AttributeError):
                with self.lock:
                    self.failures += 1
                if attempt < 2:
                    self.stop.wait(self.retry_delay)
        return False

    def run(self):
        while not self.stop.is_set():
            try:
                spans = self.queue.get(timeout=0.1)
            except queue.Empty:
                continue
            accepted = self.push(spans)
            with self.lock:
                self.pending -= len(spans)
                if accepted:
                    self.sent += len(spans)
                else:
                    self.dropped += len(spans)
            self.queue.task_done()

    def start(self):
        self.thread = threading.Thread(target=self.run, name='trace-exporter', daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=7)
