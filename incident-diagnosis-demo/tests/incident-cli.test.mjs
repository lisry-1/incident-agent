import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { demo, event, query } from '../scripts/incident-cli.mjs';

const scope = { case: 'release-regression', source: 'logs', service: 'checkout-api', namespace: 'demo', start: '2026-10-15T10:00:00Z', end: '2026-10-15T10:15:00Z' };
test('evidence includes its source and requested scope', () => {
  const r = query(scope);
  assert.equal(r.status, 'ok');
  assert.ok(r.evidence.length > 0);
  for (const e of r.evidence) {
    assert.ok(e.evidence_id);
    assert.equal(e.source, 'fixture:release-regression:logs');
    assert.equal(e.service, scope.service);
  }
});
test('time window includes its start and excludes its end', () => {
  const r = query({ ...scope, start: '2026-10-15T10:08:00Z', end: '2026-10-15T10:09:00Z' });
  assert.deepEqual(r.evidence.map((e) => e.evidence_id), ['REL-L1']);
});
test('reject a namespace outside the fixture scope', () => {
  assert.equal(event({ ...scope, namespace: 'production' }).error.code, 'SCOPE_DENIED');
});
test('reject a service outside the fixture scope', () => {
  assert.equal(event({ ...scope, service: 'billing-api' }).error.code, 'SCOPE_DENIED');
});
test('reject a traversal path as a case name', () => {
  assert.equal(event({ ...scope, case: '../../secret' }).error.code, 'UNKNOWN_CASE');
});
test('reject mutation tools', () => {
  assert.equal(event({ ...scope, source: 'restart' }).error.code, 'SOURCE_NOT_ALLOWED');
  const p = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/incident-cli.mjs', import.meta.url)), 'restart'], { encoding: 'utf8' });
  assert.equal(p.status, 1);
  assert.equal(JSON.parse(p.stdout).error.code, 'COMMAND_NOT_ALLOWED');
});
test('reject missing, malformed and impossible timestamps', () => {
  for (const start of [undefined, 'yesterday', '2026-02-30T10:00:00Z']) {
    assert.equal(event({ ...scope, start }).error.code, 'INVALID_TIME');
  }
});
test('reject reversed, empty and excessive windows', () => {
  for (const end of ['2026-10-15T09:59:00Z', scope.start, '2026-10-15T12:00:00Z']) {
    assert.equal(event({ ...scope, end }).error.code, 'INVALID_WINDOW');
  }
});
test('missing source differs from an empty query result', () => {
  assert.equal(query({ ...scope, case: 'insufficient-evidence' }).status, 'unavailable');
  assert.equal(query({ ...scope, start: '2026-10-15T11:00:00Z', end: '2026-10-15T11:10:00Z' }).status, 'empty');
});
test('all smoke cases explicitly disclose synthetic data and no LLM execution', () => {
  for (const id of ['release-regression', 'upstream-timeout', 'insufficient-evidence']) {
    const r = demo(id);
    assert.equal(r.llm_called, false);
    assert.equal(r.events.length, 3);
    assert.equal(new Set(r.events.map((e) => e.run_id)).size, 1);
    assert.ok(r.events.every((e) => e.status !== 'error'));
    assert.equal(r.data_mode, 'synthetic_fixture');
  }
});
