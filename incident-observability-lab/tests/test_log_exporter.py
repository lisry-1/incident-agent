import sys
import json
import threading
import time
import unittest
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from log_exporter import LokiPublisher


class ExporterTests(unittest.TestCase):
    def setUp(self):
        self.payloads = []
        self.code = 204
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                owner.payloads.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(owner.code)
                if owner.code == 302:
                    self.send_header('Location', '/unexpected')
                self.end_headers()
            def log_message(self, *_):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.publisher = LokiPublisher(f'http://127.0.0.1:{self.server.server_port}/loki/api/v1/push', retry_delay=0)

    def tearDown(self):
        self.publisher.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_actual_http_push_preserves_ns_strings_and_groups_low_cardinality_labels(self):
        ns = 1792216800000123456
        self.assertTrue(self.publisher.push([(str(ns+1), '{"request_id":"one"}', '503'), (str(ns), '{}', '503')]))
        stream = self.payloads[0]['streams'][0]
        self.assertEqual(stream['values'][0][0], str(ns))
        self.assertEqual(stream['stream'], {'job':'checkout-lab','service':'checkout-api','namespace':'demo','status':'503'})
        self.assertNotIn('request_id', stream['stream'])

    def test_retry_is_bounded_redirects_not_followed_and_260_is_not_accepted(self):
        for code in (503, 302, 260):
            before = len(self.payloads)
            self.code = code
            self.assertFalse(self.publisher.push([('1', '{}', '503')]))
            self.assertEqual(len(self.payloads)-before, 3)

    def test_queue_bound_counts_loss_and_delivery_stats(self):
        p = self.publisher = LokiPublisher(self.publisher.endpoint, capacity=1, retry_delay=0)
        p.emit(1, {'status': 503})
        p.emit(2, {'status': 503})
        self.assertEqual(p.snapshot()['dropped'], 1)
        p.start()
        until = time.monotonic()+2
        while p.snapshot()['pending'] and time.monotonic()<until:
            time.sleep(0.01)
        self.assertEqual(p.snapshot()['sent'], 1)
        self.assertEqual(p.snapshot()['pending'], 0)

    def test_checkout_request_is_exported_with_response_request_id(self):
        import test_app
        app=test_app.app
        before=app.LOGGER
        app.LOGGER=self.publisher
        self.publisher.start()
        server=app.ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            import urllib.request
            app.STATE['mode']='fault'
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/checkout',timeout=2)
            except urllib.error.HTTPError as response:
                with response:
                    body=json.loads(response.read())
            until=time.monotonic()+2
            while self.publisher.snapshot()['pending'] and time.monotonic()<until:
                time.sleep(0.01)
            line=json.loads(self.payloads[0]['streams'][0]['values'][0][1])
            self.assertEqual(line['request_id'],body['request_id'])
            self.assertEqual(line['status'],503)
            self.assertTrue(line['fault_injected'])
        finally:
            app.LOGGER=before
            app.STATE['mode']='healthy'
            server.shutdown();server.server_close();thread.join()
