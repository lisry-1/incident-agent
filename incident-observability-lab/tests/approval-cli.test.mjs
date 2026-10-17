import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('operator approval rejects piped text before loading or signing a proposal', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const r = spawnSync(
    process.execPath,
    ['incident-observability-lab/approval/cli.mjs', 'approve', id],
    { encoding: 'utf8', input: `APPROVE ${id} fabricated\n` },
  );
  assert.equal(r.status, 1);
  const value = JSON.parse(r.stderr.trim());
  assert.equal(value.code, 'HUMAN_TTY_REQUIRED');
});
