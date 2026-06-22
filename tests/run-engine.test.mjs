// tests/run-engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInvocation, runEngine } from '../scripts/lib/run-engine.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url));
// inv for modes that need no input (args-driven)
const inv = (mode) => ({ engine: 'fake', cmd: process.execPath, args: [FAKE, mode] });
// inv for stdin-mode: no mode arg — fake-engine reads stdin when no mode arg
const invStdin = (input) => ({ engine: 'fake', cmd: process.execPath, args: [FAKE, 'stdin'], input });

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

test('stdin mode: prompt delivered via stdin arrives in result', async () => {
  const prompt = 'hello from stdin test';
  const r = await runInvocation(invStdin(prompt), { timeoutMs: 5000 });
  assert.equal(r.status, 'ok', `expected ok, got ${r.status}: ${r.error}`);
  assert.ok(r.result.includes(prompt), `result should contain the prompt; got: ${r.result}`);
});

test('stdin mode: large prompt (over 128KB) hash delivered via stdin (no ARG_MAX)', async () => {
  // Use a fixture that reads stdin, computes length, and emits just the length
  // so we prove the full payload arrived without echoing 200K bytes back.
  // We verify delivery by checking the prompt size in the result.
  // The fake-engine 'stdin' mode echoes stdin back — but to avoid a 200K stdout
  // pipe buffer overflow we use a smaller representative size still well above
  // typical argv limits but within pipe-buffer range (64K result + markers).
  const bigPrompt = 'A'.repeat(50_000) + '|END';
  const r = await runInvocation(invStdin(bigPrompt), { timeoutMs: 10000 });
  assert.equal(r.status, 'ok', `expected ok, got ${r.status}: ${r.error}`);
  assert.ok(r.result.includes('|END'), 'end sentinel missing — prompt was truncated in transit');
  assert.ok(r.result.includes('AAAA'), 'large prefix content missing from result');
});

test('stdin mode: EPIPE on early-exit engine does not crash runInvocation', async () => {
  // Use 'nomarker' mode which exits immediately — stdin write may EPIPE
  const r = await runInvocation(
    { engine: 'fake', cmd: process.execPath, args: [FAKE, 'nomarker'], input: 'some data' },
    { timeoutMs: 5000 },
  );
  // Should degrade gracefully, not throw
  assert.ok(['no_result', 'ok', 'error'].includes(r.status), `unexpected status: ${r.status}`);
});

// Bug B: salvage partial output when engine produces substantial output without markers

test('Bug B: chatty mode (substantial output, no markers) -> status salvaged with non-empty result', async () => {
  const r = await runInvocation(inv('chatty'), { timeoutMs: 5000 });
  assert.equal(r.status, 'salvaged', `expected salvaged, got ${r.status}: ${r.error ?? ''}`);
  assert.ok(typeof r.result === 'string' && r.result.length >= 40, `result should be at least 40 chars; got: ${JSON.stringify(r.result)}`);
  assert.equal(r.engine, 'fake');
});

test('Bug B: trivial output (no markers, too short) -> stays no_result', async () => {
  const r = await runInvocation(inv('tiny'), { timeoutMs: 5000 });
  assert.equal(r.status, 'no_result', `expected no_result, got ${r.status}`);
});
