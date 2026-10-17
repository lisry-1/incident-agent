"""Local HTTP fault-injection target. Counters measure actual handled requests."""
import json
import os
import signal
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from log_exporter import LokiPublisher
from trace_exporter import TracePublisher, request_spans

LOCK = threading.Lock()
LOG_LOCK = threading.Lock()
LOGGER = None
TRACER = None
INSTANCE_ID = uuid.uuid4().hex
STATE = {"mode": "healthy", "200": 0, "503": 0, "sum": 0.0, "count": 0}
BOUNDS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]
BUCKETS = {b: 0 for b in BOUNDS}
LABELS = 'service="checkout-api",namespace="demo"'


def metrics():
    with LOCK:
        lines = ['# HELP checkout_requests_total Actual checkout responses.',
                 '# TYPE checkout_requests_total counter']
        for status in ['200', '503']:
            lines.append(f'checkout_requests_total{{{LABELS},status="{status}"}} {STATE[status]}')
        lines += ['# HELP checkout_request_duration_seconds Measured checkout handling latency.',
                  '# TYPE checkout_request_duration_seconds histogram']
        for bound in BOUNDS:
            lines.append(f'checkout_request_duration_seconds_bucket{{{LABELS},le="{bound}"}} {BUCKETS[bound]}')
        lines.append(f'checkout_request_duration_seconds_bucket{{{LABELS},le="+Inf"}} {STATE["count"]}')
        lines.append(f'checkout_request_duration_seconds_sum{{{LABELS}}} {STATE["sum"]}')
        lines.append(f'checkout_request_duration_seconds_count{{{LABELS}}} {STATE["count"]}')
        return ('\n'.join(lines) + '\n').encode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, status, value, content_type='application/json'):
        body = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path == '/health':
            return self.respond(200, {'status': 'ok', 'data_mode': 'live_lab',
                                      'log_exporter': LOGGER.snapshot() if LOGGER else {'enabled': False},
                                      'trace_exporter': TRACER.snapshot() if TRACER else {'enabled': False},
                                      'instance_id': INSTANCE_ID, 'mode': STATE['mode'],
                                      'pod_uid': os.getenv('POD_UID')})
        if self.path == '/ready':
            with LOCK:
                ready = STATE['mode'] == 'healthy'
            return self.respond(200 if ready else 503, {'ready': ready, 'data_mode': 'live_lab'})
        if self.path == '/metrics':
            return self.respond(200, metrics(), 'text/plain; version=0.0.4; charset=utf-8')
        if self.path != '/checkout':
            return self.respond(404, {'error': 'NOT_FOUND'})
        start_ns = time.time_ns()
        start = time.monotonic()
        trace_id, root_id, child_id = uuid.uuid4().hex, uuid.uuid4().hex[:16], uuid.uuid4().hex[:16]
        with LOCK:
            mode = STATE['mode']
        # Deliberately inject HTTP failures; this is not a real database pool.
        child_start = time.time_ns()
        time.sleep(0.02 if mode == 'healthy' else 0.12)
        child_end = time.time_ns()
        status = 200 if mode == 'healthy' else 503
        elapsed = time.monotonic() - start
        with LOCK:
            STATE[str(status)] += 1
            STATE['count'] += 1
            STATE['sum'] += elapsed
            for b in BOUNDS:
                if elapsed <= b:
                    BUCKETS[b] += 1
        request_id = uuid.uuid4().hex
        with LOG_LOCK:
            timestamp_ns = time.time_ns()
            stamp = datetime.fromtimestamp(timestamp_ns // 1_000_000_000, timezone.utc)
            timestamp = stamp.strftime('%Y-%m-%dT%H:%M:%S') + f'.{timestamp_ns // 1_000_000 % 1000:03d}Z'
            record = {'timestamp': timestamp, 'service': 'checkout-api', 'namespace': 'demo',
                      'status': status, 'duration_ms': round(elapsed * 1000, 3),
                      'request_id': request_id, 'fault_injected': mode == 'fault',
                      'data_mode': 'live_lab', 'level': 'ERROR' if status == 503 else 'INFO',
                      'message': 'Injected HTTP 503 in local experiment' if status == 503 else 'Checkout request completed'}
            if os.getenv('LAB_JOB') == 'checkout-k8s-lab':
                record.update(cluster='incident-lab', pod=os.environ['POD_NAME'], pod_uid=os.environ['POD_UID'])
            if TRACER:
                record.update(trace_id=trace_id, span_id=root_id)
            print(json.dumps(record), flush=True)
            if LOGGER:
                LOGGER.emit(timestamp_ns, record)
        self.respond(status, {'status': 'ok' if status == 200 else 'injected_failure',
                              'request_id': request_id, 'data_mode': 'live_lab',
                              **({'trace_id': trace_id, 'span_id': root_id} if TRACER else {})})
        if TRACER:
            TRACER.emit(request_spans(trace_id, root_id, child_id, request_id, start_ns,
                                      child_start, child_end, time.time_ns(), status))

    def do_POST(self):
        # Local operator-only experiment control. Not exposed as an Agent tool.
        if self.path != '/control/mode':
            return self.respond(404, {'error': 'NOT_FOUND'})
        if self.headers.get('Content-Type') != 'application/json':
            return self.respond(415, {'error': 'JSON_REQUIRED'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 128:
                raise ValueError('invalid body length')
            value = json.loads(self.rfile.read(size))
            if not isinstance(value, dict) or set(value) != {'mode'} or value['mode'] not in ['healthy', 'fault']:
                raise ValueError('invalid mode')
        except (ValueError, TypeError):
            return self.respond(400, {'error': 'INVALID_MODE'})
        with LOCK:
            STATE['mode'] = value['mode']
        self.respond(200, {'mode': value['mode'], 'data_mode': 'live_lab'})


if __name__ == '__main__':
    # PID 1 needs an explicit handler for the approved local SIGTERM restart.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    if os.getenv('LOKI_PUSH_URL'):
        LOGGER = LokiPublisher(os.environ['LOKI_PUSH_URL'])
        LOGGER.start()
    if os.getenv('OTLP_TRACES_URL'):
        TRACER = TracePublisher(os.environ['OTLP_TRACES_URL'])
        TRACER.start()
    server = ThreadingHTTPServer((os.getenv('LAB_BIND', '0.0.0.0'), int(os.getenv('LAB_PORT', '8080'))), Handler)
    server.daemon_threads = True
    server.serve_forever()
