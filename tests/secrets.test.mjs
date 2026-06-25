// tests/secrets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSecrets, injectSecrets } from '../scripts/lib/secrets.mjs';

test('loadSecrets reads and parses a secrets file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'storm-sec-'));
  const p = join(dir, '.storm-secrets.json');
  writeFileSync(p, JSON.stringify({ glmApiKey: 'KEY123' }));
  try {
    assert.deepEqual(loadSecrets(p), { glmApiKey: 'KEY123' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSecrets on missing file -> {} (graceful: storm still runs other engines)', () => {
  assert.deepEqual(loadSecrets('/nonexistent/path/.storm-secrets.json'), {});
});

test('loadSecrets on malformed JSON -> {} (graceful, no crash)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'storm-sec-'));
  const p = join(dir, '.storm-secrets.json');
  writeFileSync(p, '{ not valid json');
  try {
    assert.deepEqual(loadSecrets(p), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('injectSecrets puts glmApiKey onto the glm engine only', () => {
  const engines = [{ id: 'claude' }, { id: 'glm', model: 'glm-5.2' }, { id: 'codex' }];
  const out = injectSecrets(engines, { glmApiKey: 'SECRET' });
  assert.equal(out.find((e) => e.id === 'glm').apiKey, 'SECRET');
  assert.equal(out.find((e) => e.id === 'claude').apiKey, undefined);
  assert.equal(out.find((e) => e.id === 'codex').apiKey, undefined);
});

test('injectSecrets without glmApiKey leaves glm engine without apiKey', () => {
  const engines = [{ id: 'glm', model: 'glm-5.2' }];
  const out = injectSecrets(engines, {});
  assert.equal(out[0].apiKey, undefined);
});

test('injectSecrets does not mutate the input engine objects', () => {
  const engines = [{ id: 'glm' }];
  injectSecrets(engines, { glmApiKey: 'X' });
  assert.equal(engines[0].apiKey, undefined, 'original config must stay unmutated');
});
