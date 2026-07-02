// tests/companion.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRY = fileURLToPath(new URL('../scripts/storm-companion.mjs', import.meta.url));
const COMPANION = fileURLToPath(new URL('../scripts/storm-companion.mjs', import.meta.url));

test('missing args -> exit 2 with usage', () => {
  const r = spawnSync(process.execPath, [ENTRY], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
});

test('wrong mode -> exit 2', () => {
  const r = spawnSync(process.execPath, [ENTRY, 'action', 'x'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('--cwd nonexistent -> exit 2 (fail-fast, never a silent run)', () => {
  const r = spawnSync(process.execPath, [ENTRY, 'plan', 'task', '--cwd', '/no/such/dir/xyz'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not exist|cwd/i);
});

test('proof config block exists and is enabled by default', async () => {
  const cfg = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(new URL('../scripts/config.json', import.meta.url), 'utf8')));
  assert.equal(cfg.proof.enabled, true);
  assert.equal(typeof cfg.proof.experimentTimeoutMs, 'number');
});

test('each engine carries its calibrated per-engine stallMs', async () => {
  const fs = await import('node:fs');
  const cfg = JSON.parse(fs.readFileSync(new URL('../scripts/config.json', import.meta.url), 'utf8'));
  const byId = Object.fromEntries(cfg.engines.map((e) => [e.id, e]));
  assert.equal(byId.claude.stallMs, 20000);
  assert.equal(byId.codex.stallMs, 180000);
  assert.equal(byId.glm.stallMs, 60000);
});

test('config carries delegate.verifyTimeoutMs = 120000', async () => {
  const fs = await import('node:fs');
  const cfg = JSON.parse(fs.readFileSync(new URL('../scripts/config.json', import.meta.url), 'utf8'));
  assert.equal(cfg.delegate.verifyTimeoutMs, 120000);
});

test('delegate: unknown engine => exit 2 with a clear error, no spawn', () => {
  const r = spawnSync(process.execPath, [COMPANION, 'delegate', 'nosuchengine', 'task'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown engine: nosuchengine/);
});

test('delegate: non-git --cwd => exit 2 (fail-fast before any engine spawn)', () => {
  const plain = mkdtempSync(join(tmpdir(), 'storm-companion-plain-'));
  try {
    const r = spawnSync(process.execPath, [COMPANION, 'delegate', 'codex', 'task', '--cwd', plain], { encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /git repository/);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('delegate: missing engine/task => usage + exit 2', () => {
  const r = spawnSync(process.execPath, [COMPANION, 'delegate'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});
