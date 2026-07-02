// tests/cli-args.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseStormArgs } from '../scripts/lib/cli-args.mjs';

test('no --cwd: positionals parsed, cwd defaults to the provider', () => {
  const { mode, task, cwd } = parseStormArgs(['plan', 'do a thing'], { cwd: () => '/fake/wd' });
  assert.equal(mode, 'plan');
  assert.equal(task, 'do a thing');
  assert.equal(cwd, '/fake/wd');
});

test('--cwd <existing dir>: resolved to absolute', () => {
  const dir = mkdtempSync(join(tmpdir(), 'storm-args-'));
  const { mode, task, cwd } = parseStormArgs(['plan', 'task', '--cwd', dir]);
  assert.equal(mode, 'plan');
  assert.equal(task, 'task');
  assert.equal(cwd, resolve(dir));
});

test('--cwd is position-independent (flag before positionals)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'storm-args-'));
  const { mode, task, cwd } = parseStormArgs(['--cwd', dir, 'plan', 'task']);
  assert.equal(mode, 'plan');
  assert.equal(task, 'task');
  assert.equal(cwd, resolve(dir));
});

test('--cwd <nonexistent>: throws (fail-fast, no silent fallback)', () => {
  assert.throws(() => parseStormArgs(['plan', 'task', '--cwd', '/no/such/dir/xyz']), /does not exist/);
});

test('--cwd pointing at a file (not a dir): throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'storm-args-'));
  const f = join(dir, 'file.txt');
  writeFileSync(f, 'x');
  assert.throws(() => parseStormArgs(['plan', 'task', '--cwd', f]), /not a directory/);
});

test('--cwd with no value: throws', () => {
  assert.throws(() => parseStormArgs(['plan', 'task', '--cwd']), /requires a path/);
});

// --- delegate mode arguments ---

test('delegate: positionals are [mode, engine, task]', () => {
  const { mode, engine, task } = parseStormArgs(['delegate', 'codex', 'fix the bug']);
  assert.equal(mode, 'delegate');
  assert.equal(engine, 'codex');
  assert.equal(task, 'fix the bug');
});

test('plan: engine is null, task in the old position (backward compat)', () => {
  const { mode, engine, task } = parseStormArgs(['plan', 'review this']);
  assert.equal(mode, 'plan');
  assert.equal(engine, null);
  assert.equal(task, 'review this');
});

test('--verify is captured position-independently', () => {
  const a = parseStormArgs(['delegate', 'glm', 't', '--verify', 'npm test']);
  assert.equal(a.verify, 'npm test');
  const b = parseStormArgs(['--verify', 'npm test', 'delegate', 'glm', 't']);
  assert.equal(b.verify, 'npm test');
  assert.equal(b.engine, 'glm');
});

test('--verify without a value throws (fail-fast)', () => {
  assert.throws(() => parseStormArgs(['delegate', 'codex', 't', '--verify']), /--verify requires/);
});

test('no --verify => verify is null', () => {
  assert.equal(parseStormArgs(['plan', 't']).verify, null);
});
