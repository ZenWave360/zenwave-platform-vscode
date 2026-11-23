import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SMOKE_REMOTE_PORT } from '../../scripts/smoke-remote.mjs';

test('the smoke fixture server, the smoke and the remote manifest agree on one port', () => {
  const smoke = readFileSync('test/smoke-remote.ts', 'utf8');
  const manifest = readFileSync('test/fixtures/remote/arch/zenwave-architecture.yml', 'utf8');
  assert.ok(smoke.includes(`REMOTE_PORT = ${SMOKE_REMOTE_PORT}`));
  assert.ok(manifest.includes(`http://127.0.0.1:${SMOKE_REMOTE_PORT}`));
});
