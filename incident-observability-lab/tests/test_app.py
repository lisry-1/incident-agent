import importlib.util
import json
from pathlib import Path
import threading
import unittest
import urllib.request
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location('lab_app', Path(__file__).resolve().parents[1] / 'app.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class AppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def fetch(self, route, body=None):
        request = urllib.request.Request(self.base + route,
                                         data=None if body is None else json.dumps(body).encode(),
                                         headers={} if body is None else {'Content-Type': 'application/json'})
        try:
            response = urllib.request.urlopen(request, timeout=2)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.read().decode()

    def test_actual_requests_increment_metrics_and_fault_control_is_reversible(self):
        self.fetch('/control/mode', {'mode': 'healthy'})
        before = app.STATE['count']
        status, body = self.fetch('/checkout')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['data_mode'], 'live_lab')
        self.fetch('/control/mode', {'mode': 'fault'})
        status, body = self.fetch('/checkout')
        self.assertEqual(status, 503)
        self.assertEqual(app.STATE['count'], before + 2)
        _, exposition = self.fetch('/metrics')
        self.assertIn('status="503"} 1', exposition)
        self.assertIn('checkout_request_duration_seconds_bucket', exposition)
        self.assertGreater(app.STATE['sum'], 0)
        self.fetch('/control/mode', {'mode': 'healthy'})
        self.assertEqual(self.fetch('/checkout')[0], 200)

    def test_health_and_metrics_do_not_count_as_checkout_traffic(self):
        before = app.STATE['count']
        self.assertEqual(self.fetch('/health')[0], 200)
        self.assertEqual(self.fetch('/metrics')[0], 200)
        self.assertEqual(app.STATE['count'], before)

    def test_control_rejects_unknown_modes_and_get_mutation(self):
        before = app.STATE['mode']
        self.assertEqual(self.fetch('/control/mode', {'mode': 'restart'})[0], 400)
        self.assertEqual(self.fetch('/control/mode', {'mode': 'fault', 'extra': True})[0], 400)
        self.assertEqual(self.fetch('/control/mode')[0], 404)
        self.assertEqual(app.STATE['mode'], before)


if __name__ == '__main__':
    unittest.main()
