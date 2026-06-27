// tests/openrouter-tools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveInSandbox, executeTool, TOOLS, isBlocked } from '../scripts/lib/openrouter-tools.mjs';

test('isBlocked: catches Windows backslash paths too (cross-platform sandbox)', () => {
  // forward-slash (works on macOS/Linux)
  assert.ok(isBlocked('.git/config', '.git/config'));
  assert.ok(isBlocked('sub/.env', 'sub/.env'));
  // backslash (Windows) — must also be blocked
  assert.ok(isBlocked('.git\\config', '.git\\config'), '.git\\config must be blocked');
  assert.ok(isBlocked('sub\\.env', 'sub\\.env'), 'nested .env via backslash must be blocked');
  assert.ok(isBlocked('a\\.storm-secrets.json', 'a\\.storm-secrets.json'));
  // a normal source file is NOT blocked
  assert.ok(!isBlocked('scripts/lib/run-engine.mjs', 'scripts/lib/run-engine.mjs'));
});

test('isBlocked: blocks .envrc and other .env* variants', () => {
  assert.ok(isBlocked('.envrc', '.envrc'), '.envrc must be blocked');
  assert.ok(isBlocked('sub/.envrc', 'sub/.envrc'), 'nested .envrc must be blocked');
  assert.ok(isBlocked('.env.local', '.env.local'), '.env.local must be blocked');
  assert.ok(isBlocked('.env.example', '.env.example'), '.env.example must be blocked');
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'storm-sb-'));
  writeFileSync(join(dir, 'a.txt'), 'hello world\nsecond line\n');
  writeFileSync(join(dir, '.storm-secrets.json'), '{"glmApiKey":"SECRET"}');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'b.txt'), 'needle here\n');
  return dir;
}

// --- resolveInSandbox: containment ---

test('resolveInSandbox: a path inside cwd resolves to an absolute path', () => {
  const dir = sandbox();
  try {
    assert.equal(resolveInSandbox(dir, 'a.txt'), join(dir, 'a.txt'));
    assert.equal(resolveInSandbox(dir, 'sub/b.txt'), join(dir, 'sub', 'b.txt'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveInSandbox: ../ escape throws', () => {
  const dir = sandbox();
  try {
    assert.throws(() => resolveInSandbox(dir, '../escape'), /outside|sandbox/i);
    assert.throws(() => resolveInSandbox(dir, 'sub/../../escape'), /outside|sandbox/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveInSandbox: absolute path outside cwd throws', () => {
  const dir = sandbox();
  try {
    assert.throws(() => resolveInSandbox(dir, '/etc/passwd'), /outside|sandbox/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveInSandbox: secret/vcs files are blocked even though inside cwd', () => {
  const dir = sandbox();
  try {
    assert.throws(() => resolveInSandbox(dir, '.storm-secrets.json'), /block/i);
    assert.throws(() => resolveInSandbox(dir, '.env'), /block/i);
    assert.throws(() => resolveInSandbox(dir, '.git/config'), /block/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- executeTool: returns strings, errors as strings (never throws) ---

test('executeTool read_file returns the file content', () => {
  const dir = sandbox();
  try {
    const r = executeTool('read_file', { path: 'a.txt' }, dir);
    assert.ok(r.includes('hello world'), `got: ${r}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executeTool read_file on the secrets file -> blocked error string (NOT the secret)', () => {
  const dir = sandbox();
  try {
    const r = executeTool('read_file', { path: '.storm-secrets.json' }, dir);
    assert.match(r, /error/i);
    assert.ok(!r.includes('SECRET'), 'must NOT leak the secret content');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executeTool read_file outside sandbox -> error string, does not throw', () => {
  const dir = sandbox();
  try {
    const r = executeTool('read_file', { path: '../../../etc/passwd' }, dir);
    assert.match(r, /error|outside|block/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executeTool list_dir lists entries', () => {
  const dir = sandbox();
  try {
    const r = executeTool('list_dir', { path: '.' }, dir);
    assert.ok(r.includes('a.txt'), `got: ${r}`);
    assert.ok(r.includes('sub'), `got: ${r}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executeTool grep finds matching lines with file path', () => {
  const dir = sandbox();
  try {
    const r = executeTool('grep', { pattern: 'needle', path: '.' }, dir);
    assert.ok(r.includes('needle'), `got: ${r}`);
    assert.ok(r.includes('b.txt'), `should cite the file; got: ${r}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executeTool unknown tool -> error string', () => {
  const dir = sandbox();
  try {
    assert.match(executeTool('rm_rf', {}, dir), /unknown tool/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TOOLS: function defs for read_file, list_dir, grep', () => {
  const names = TOOLS.map((t) => t.function.name);
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('list_dir'));
  assert.ok(names.includes('grep'));
  for (const t of TOOLS) assert.equal(t.type, 'function');
});
