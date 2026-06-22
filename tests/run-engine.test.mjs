// tests/run-engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInvocation, runEngine } from '../scripts/lib/run-engine.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url));
const inv = (mode) => ({ engine: 'fake', cmd: process.execPath, args: [FAKE, mode] });

test('ok mode -> status ok with parsed result, raw chatter dropped', async () => {
  const r = await runInvocation(inv('ok'), { timeoutMs: 5000 });
  assert.equal(r.status, 'ok');
  assert.equal(r.result, '- ok finding');
  assert.equal(r.engine, 'fake');
});

test('nomarker (exit 0) -> no_result, not ok', async () => {
  const r = await runInvocation(inv('nomarker'), { timeoutMs: 5000 });
  assert.equal(r.status, 'no_result');
});

test('slow -> timeout, process killed', async () => {
  const r = await runInvocation(inv('slow'), { timeoutMs: 300 });
  assert.equal(r.status, 'timeout');
});

test('bad command -> error', async () => {
  const r = await runInvocation({ engine: 'x', cmd: 'definitely-not-a-real-binary-xyz', args: [] }, { timeoutMs: 2000 });
  assert.equal(r.status, 'error');
});

test('synchronous spawn throw -> error (not thrown)', async () => {
  const r = await runInvocation({ engine: 'x', cmd: 123, args: [] }, { timeoutMs: 2000 });
  assert.equal(r.status, 'error');
});

test('utf8split mode -> round-trips multi-byte chars without U+FFFD corruption', async () => {
  const r = await runInvocation(inv('utf8split'), { timeoutMs: 5000 });
  assert.equal(r.status, 'ok', `expected ok, got ${r.status}: ${r.error}`);
  assert.ok(r.result.includes('привет'), 'Cyrillic round-trip failed');
  assert.ok(r.result.includes('café'), 'Latin extended round-trip failed');
  assert.ok(r.result.includes('你好'), 'CJK round-trip failed');
  assert.ok(r.result.includes('€'), 'Euro sign round-trip failed');
  assert.ok(!r.result.includes('�'), 'result contains U+FFFD replacement char (corruption)');
});

test('runEngine with unknown engine id resolves to error (does not throw)', async () => {
  const r = await runEngine('nonexistent-engine', 'some prompt');
  assert.equal(r.status, 'error');
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
});
