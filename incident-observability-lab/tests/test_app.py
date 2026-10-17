import importlib.util
import sys
import json
from pathlib import Path
import threading
import unittest
import urllib.request
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

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

    def test_readiness_reflects_fault_and_recovers_without_counting_requests(self):
        before = app.STATE['count']
        try:
            self.fetch('/control/mode', {'mode': 'healthy'})
            self.assertEqual(self.fetch('/ready')[0], 200)
            self.fetch('/control/mode', {'mode': 'fault'})
            self.assertEqual(self.fetch('/ready')[0], 503)
            self.assertEqual(self.fetch('/health')[0], 200)
            self.fetch('/control/mode', {'mode': 'healthy'})
            self.assertEqual(self.fetch('/ready')[0], 200)
            self.assertEqual(app.STATE['count'], before)
        finally:
            self.fetch('/control/mode', {'mode': 'healthy'})

    def test_standalone_app_sigterm_exits_cleanly_for_approved_restart(self):
        import os
        import socket
        import subprocess
        import time
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve().parents[1] / 'app.py')],
            env={'PATH': os.environ.get('PATH', ''), 'LAB_BIND':'127.0.0.1', 'LAB_PORT':str(port)},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            ready = False
            for _ in range(50):
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=.2) as response:
                        health = json.load(response)
                    ready = True
                    break
                except OSError:
                    time.sleep(.02)
            self.assertTrue(ready)
            self.assertEqual(len(health['instance_id']), 32)
            process.terminate()
            self.assertEqual(process.wait(timeout=2), 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

    def test_control_rejects_unknown_modes_and_get_mutation(self):
        before = app.STATE['mode']
        self.assertEqual(self.fetch('/control/mode', {'mode': 'restart'})[0], 400)
        self.assertEqual(self.fetch('/control/mode', {'mode': 'fault', 'extra': True})[0], 400)
        self.assertEqual(self.fetch('/control/mode')[0], 404)
        self.assertEqual(app.STATE['mode'], before)

    def test_release_regression_starts_faulty_and_exposes_actual_release(self):
        import os
        import socket
        import subprocess
        import time
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve().parents[1] / 'app.py')],
            env={'PATH': os.environ.get('PATH', ''), 'LAB_BIND': '127.0.0.1',
                 'LAB_PORT': str(port), 'LAB_INITIAL_MODE': 'fault', 'LAB_RELEASE': 'regression-v2'},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            health = None
            for _ in range(50):
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=.2) as response:
                        health = json.load(response)
                    break
                except OSError:
                    time.sleep(.02)
            self.assertIsNotNone(health)
            self.assertEqual(health['mode'], 'fault')
            self.assertEqual(health['release'], 'regression-v2')
            for route in ['/ready', '/checkout']:
                with self.assertRaises(HTTPError) as error:
                    urllib.request.urlopen(f'http://127.0.0.1:{port}{route}', timeout=2)
                self.assertEqual(error.exception.code, 503)
                error.exception.close()
        finally:
            process.terminate()
            process.wait(timeout=2)


if __name__ == '__main__':
    unittest.main()
