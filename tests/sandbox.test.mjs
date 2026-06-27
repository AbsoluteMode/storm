// tests/sandbox.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeThrowawayCopy, experimentEnv } from '../scripts/lib/sandbox.mjs';

function fakeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'storm-src-'));
  writeFileSync(join(dir, 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, '.storm-secrets.json'), '{"glmApiKey":"SECRET"}');
  writeFileSync(join(dir, '.env'), 'TOKEN=abc');
  writeFileSync(join(dir, '.envrc'), 'export TOKEN=x');
  mkdirSync(join(dir, '.git')); writeFileSync(join(dir, '.git', 'config'), '[core]');
  mkdirSync(join(dir, 'node_modules')); writeFileSync(join(dir, 'node_modules', 'x.js'), 'x');
  return dir;
}

test('makeThrowawayCopy: copies source, excludes .git/node_modules/secrets', () => {
  const src = fakeRepo();
  const { dir, cleanup } = makeThrowawayCopy(src);
  try {
    assert.ok(existsSync(join(dir, 'app.js')), 'real source file copied');
    assert.ok(!existsSync(join(dir, '.git')), '.git excluded');
    assert.ok(!existsSync(join(dir, 'node_modules')), 'node_modules excluded');
    assert.ok(!existsSync(join(dir, '.storm-secrets.json')), 'secrets excluded');
    assert.ok(!existsSync(join(dir, '.env')), '.env excluded');
    assert.ok(!existsSync(join(dir, '.envrc')), '.envrc excluded');
  } finally { cleanup(); rmSync(src, { recursive: true, force: true }); }
});

test('makeThrowawayCopy: cleanup removes the copy', () => {
  const src = fakeRepo();
  const { dir, cleanup } = makeThrowawayCopy(src);
  assert.ok(existsSync(dir));
  cleanup();
  assert.ok(!existsSync(dir), 'copy removed after cleanup');
  rmSync(src, { recursive: true, force: true });
});

test('experimentEnv: carries PATH/HOME but no provider secrets', () => {
  const env = experimentEnv();
  assert.ok('PATH' in env);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
});
