"""Small bounded in-memory Loki exporter for the local experiment (not a durable agent)."""
import json
import queue
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class LokiPublisher:
    def __init__(self, endpoint, capacity=2048, retry_delay=0.2):
        url = urlsplit(endpoint)
        if (url.scheme != 'http' or url.hostname not in ('loki', 'localhost', '127.0.0.1')
                or url.path != '/loki/api/v1/push' or url.query or url.fragment
                or url.username or url.password):
            raise ValueError('Loki exporter requires the trusted local push endpoint')
        self.endpoint = endpoint
        self.queue = queue.Queue(maxsize=capacity)
        self.lock = threading.Lock()
        self.sent = self.dropped = self.failures = self.pending = 0
        self.retry_delay = retry_delay
        self.stop = threading.Event()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self.run, name='loki-exporter', daemon=True)
        self.thread.start()

    def emit(self, timestamp_ns, record):
        # Enqueue only; remote latency cannot delay an HTTP checkout response.
        with self.lock:
            try:
                self.queue.put_nowait((str(timestamp_ns), json.dumps(record), str(record['status'])))
                self.pending += 1
            except queue.Full:
                self.dropped += 1

    def snapshot(self):
        with self.lock:
            return {'enabled': True, 'sent': self.sent, 'dropped': self.dropped,
                    'failed_batches': self.failures, 'pending': self.pending}

    def push(self, batch):
        groups = {}
        for timestamp, line, status in batch:
            groups.setdefault(status, []).append([timestamp, line])
        streams = []
        for status, values in groups.items():
            streams.append({'stream': {'job': 'checkout-lab', 'service': 'checkout-api',
                                       'namespace': 'demo', 'status': status},
                            'values': sorted(values, key=lambda p: int(p[0]))})
        payload = json.dumps({'streams': streams}).encode()
        for attempt in range(3):
            try:
                request = urllib.request.Request(self.endpoint, data=payload,
                                                  headers={'Content-Type': 'application/json'}, method='POST')
                with self.opener.open(request, timeout=2) as response:
                    # Loki accepts writes with 204; 260 can mean ingestion is blocked.
                    if response.status != 204:
                        raise ValueError('Loki did not accept the batch')
                return True
            except (OSError, ValueError, urllib.error.URLError):
                with self.lock:
                    self.failures += 1
                if attempt < 2:
                    self.stop.wait(self.retry_delay)
        return False

    def run(self):
        while not self.stop.is_set():
            try:
                first = self.queue.get(timeout=0.1)
            except queue.Empty:
                continue
            batch = [first]
            while len(batch) < 32:
                try:
                    batch.append(self.queue.get_nowait())
                except queue.Empty:
                    break
            accepted = self.push(batch)
            with self.lock:
                self.pending -= len(batch)
                if accepted:
                    self.sent += len(batch)
                else:
                    self.dropped += len(batch)
            for _ in batch:
                self.queue.task_done()

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=7)
