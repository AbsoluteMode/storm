// tests/companion.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../scripts/storm-companion.mjs', import.meta.url));

test('missing args -> exit 2 with usage', () => {
  const r = spawnSync(process.execPath, [ENTRY], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
});

test('wrong mode -> exit 2', () => {
  const r = spawnSync(process.execPath, [ENTRY, 'action', 'x'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
