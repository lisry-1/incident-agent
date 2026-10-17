import sys
import json
import threading
import time
import unittest
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from trace_exporter import TracePublisher, request_spans

class TraceTests(unittest.TestCase):
    def setUp(self):
        self.payloads=[];self.code=200;self.body={}
        owner=self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                owner.payloads.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(owner.code)
                if owner.code==302:self.send_header('Location','/unexpected')
                self.end_headers();self.wfile.write(json.dumps(owner.body).encode())
            def log_message(self,*_):pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.p=TracePublisher(f'http://127.0.0.1:{self.server.server_port}/v1/traces',capacity=1,retry_delay=0)
        self.spans=request_spans('a'*32,'b'*16,'c'*16,'d'*32,1000,1100,1200,1300,503)
    def tearDown(self):
        self.p.close();self.server.shutdown();self.server.server_close();self.thread.join()
    def test_otlp_http_payload_has_hex_ids_ns_strings_and_parent_child(self):
        self.assertTrue(self.p.push(self.spans))
        root,child=self.payloads[0]['resourceSpans'][0]['scopeSpans'][0]['spans']
        self.assertEqual(child['parentSpanId'],root['spanId']);self.assertEqual(root['startTimeUnixNano'],'1000')
        self.assertEqual(root['kind'],2);self.assertEqual(root['status']['code'],2)
    def test_kubernetes_resource_identity_is_carried_into_real_otlp_payload(self):
        from unittest.mock import patch
        with patch.dict('os.environ', {'LAB_JOB':'checkout-k8s-lab','POD_NAME':'checkout-k8s','POD_UID':'11111111-1111-4111-8111-111111111111'}):
            self.assertTrue(self.p.push(self.spans))
        attrs = {a['key']:a['value']['stringValue'] for a in self.payloads[0]['resourceSpans'][0]['resource']['attributes']}
        self.assertEqual(attrs['k8s.pod.name'],'checkout-k8s')
        self.assertEqual(attrs['k8s.pod.uid'],'11111111-1111-4111-8111-111111111111')
        self.assertEqual(attrs['k8s.cluster.name'],'incident-lab')

    def test_partial_acceptance_is_not_retried_or_claimed_success(self):
        self.body={'partialSuccess':{'rejectedSpans':'1','errorMessage':'rejected'}}
        self.assertFalse(self.p.push(self.spans));self.assertEqual(len(self.payloads),1)
    def test_redirects_and_failures_have_bounded_retries(self):
        for code in (302,503):
            self.code=code;before=len(self.payloads)
            self.assertFalse(self.p.push(self.spans));self.assertEqual(len(self.payloads)-before,3)
    def test_bounded_queue_counts_spans_not_requests(self):
        self.p.emit(self.spans);self.p.emit(self.spans)
        self.assertEqual(self.p.snapshot()['dropped'],2);self.p.start()
        until=time.monotonic()+2
        while self.p.snapshot()['pending'] and time.monotonic()<until:time.sleep(.01)
        self.assertEqual(self.p.snapshot()['sent'],2)
    def test_actual_checkout_log_and_exported_spans_share_identity(self):
        import test_app
        app=test_app.app
        old_tracer,old_logger=app.TRACER,app.LOGGER
        class Logs:
            def emit(_,ns,record):self.record=record
        app.TRACER=self.p;app.LOGGER=Logs();self.p.start();app.STATE['mode']='fault'
        server=ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            import urllib.request,urllib.error
            try:urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/checkout',timeout=2)
            except urllib.error.HTTPError as response:
                with response:body=json.loads(response.read())
            until=time.monotonic()+2
            while not self.payloads and time.monotonic()<until:time.sleep(.01)
            root,child=self.payloads[0]['resourceSpans'][0]['scopeSpans'][0]['spans']
            self.assertEqual(root['traceId'],body['trace_id']);self.assertEqual(root['traceId'],self.record['trace_id'])
            self.assertEqual(root['spanId'],self.record['span_id']);self.assertEqual(child['parentSpanId'],root['spanId'])
            self.assertLessEqual(int(root['startTimeUnixNano']),int(child['startTimeUnixNano']))
            self.assertGreaterEqual(int(root['endTimeUnixNano']),int(child['endTimeUnixNano']))
            self.assertGreater(int(child['endTimeUnixNano'])-int(child['startTimeUnixNano']),100000000)
        finally:
            app.TRACER=old_tracer;app.LOGGER=old_logger;app.STATE['mode']='healthy'
            server.shutdown();server.server_close();thread.join()
