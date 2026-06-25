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
// stream-mode invocation helper: marks the invocation as a stream engine
const invStream = (mode) => ({ engine: 'fake', cmd: process.execPath, args: [FAKE, mode], stream: true });

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

test('stdin mode: delivers a large (50K) prompt through stdin without truncation', async () => {
  // The fake-engine 'stdin' mode echoes stdin back. We use a ~50K payload:
  // large enough to exercise the stdin pipe, small enough to avoid overwhelming
  // the stdout pipe buffer when echoed back (64K result + markers).
  const bigPrompt = 'A'.repeat(50_000) + '|END';
  const r = await runInvocation(invStdin(bigPrompt), { timeoutMs: 10000 });
  assert.equal(r.status, 'ok', `expected ok, got ${r.status}: ${r.error}`);
  assert.ok(r.result.includes('|END'), 'end sentinel missing — prompt was truncated in transit');
  assert.ok(r.result.includes('AAAA'), 'large prefix content missing from result');
});

test('stdin mode: EPIPE on early-exit engine does not crash runInvocation', async () => {
  // Use 'nomarker' mode which exits immediately — stdin write may EPIPE.
  // The nomarker fixture output is intentionally under MIN_SALVAGE_LENGTH (40) chars,
  // so the salvage branch does not fire and the result is no_result (not salvaged).
  const r = await runInvocation(
    { engine: 'fake', cmd: process.execPath, args: [FAKE, 'nomarker'], input: 'some data' },
    { timeoutMs: 5000 },
  );
  // Should degrade gracefully to no_result or error, not throw and never ok
  assert.ok(['no_result', 'error'].includes(r.status), `unexpected status: ${r.status}`);
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

test('silent-hang -> stalled (no output past stallMs)', async () => {
  const r = await runInvocation(inv('silent-hang'), { stallMs: 300, timeoutMs: 5000 });
  assert.equal(r.status, 'stalled');
  assert.ok(typeof r.lastActivityMs === 'number');
});

test('auth-prompt then silence -> auth_required after grace', async () => {
  const r = await runInvocation(inv('auth-prompt'), { authGraceMs: 300, stallMs: 5000, timeoutMs: 8000 });
  assert.equal(r.status, 'auth_required');
});

test('auth phrase but engine keeps streaming -> NOT killed, finishes ok', async () => {
  // codex-flaky scenario: an auth-looking line appears, but the engine is alive
  // and keeps producing output. The grace timer must keep resetting / the phrase
  // scrolls out of the scan tail -> no false auth_required.
  const r = await runInvocation(inv('auth-then-work'), { authGraceMs: 300, stallMs: 5000, timeoutMs: 8000 });
  assert.equal(r.status, 'ok', `expected ok (engine stayed alive), got ${r.status}: ${r.error}`);
  assert.equal(r.result, '- done despite the auth noise');
});

test('slow-stream is NOT stalled (heartbeat resets inactivity)', async () => {
  // stallMs (1000) < total runtime (~2s), so without the reset it WOULD stall;
  // each ~40ms chunk re-arms the stall timer (~25x margin), so it stays ok even
  // under machine load. If reset were broken, this would fail at 1000ms.
  const r = await runInvocation(inv('slow-stream'), { stallMs: 1000, timeoutMs: 8000 });
  assert.equal(r.status, 'ok');
  assert.equal(r.result, '- slow but alive');
});

test('ok result carries lastActivityMs', async () => {
  const r = await runInvocation(inv('ok'), { stallMs: 5000, timeoutMs: 8000 });
  assert.equal(r.status, 'ok');
  assert.ok(typeof r.lastActivityMs === 'number');
});

// --- per-engine env (glm backend override travels this path) ---

test('env field is merged into child: custom var delivered, parent PATH preserved', async () => {
  const r = await runInvocation(
    { engine: 'fake', cmd: process.execPath, args: [FAKE, 'echo-env'], env: { STORM_TEST_VAR: 'hello-glm' } },
    { timeoutMs: 5000 },
  );
  assert.equal(r.status, 'ok', `expected ok, got ${r.status}: ${r.error}`);
  assert.equal(r.result, 'hello-glm|PATH_PRESENT');
});

test('no env field: child still inherits parent env (PATH present), custom var unset', async () => {
  const r = await runInvocation(
    { engine: 'fake', cmd: process.execPath, args: [FAKE, 'echo-env'] },
    { timeoutMs: 5000 },
  );
  assert.equal(r.status, 'ok', `expected ok, got ${r.status}: ${r.error}`);
  assert.equal(r.result, 'UNSET|PATH_PRESENT');
});

// --- stream-json (NDJSON) engines: claude/glm liveness + final-text extraction ---

test('stream-json: result extracted from the {type:result} event', async () => {
  const r = await runInvocation(invStream('stream-json'), { stallMs: 5000, timeoutMs: 8000 });
  assert.equal(r.status, 'ok', `expected ok, got ${r.status}: ${r.error}`);
  assert.equal(r.result, '- streamed finding');
});

test('stream-json: per-event heartbeat keeps it alive under a small stallMs', async () => {
  // 5 events x 30ms gaps = ~150ms total > stallMs(100), but each event re-arms
  // the stall timer, so it must NOT be killed.
  const r = await runInvocation(invStream('stream-json'), { stallMs: 100, timeoutMs: 8000 });
  assert.equal(r.status, 'ok', `expected ok (heartbeat alive), got ${r.status}`);
});

test('stream-json-garbage: malformed line is skipped, result still extracted', async () => {
  const r = await runInvocation(invStream('stream-json-garbage'), { stallMs: 5000, timeoutMs: 8000 });
  assert.equal(r.status, 'ok', `expected ok, got ${r.status}: ${r.error}`);
  assert.equal(r.result, '- survived garbage');
});

test('stream-json-nofinal: falls back to assembling text_delta chunks', async () => {
  const r = await runInvocation(invStream('stream-json-nofinal'), { stallMs: 5000, timeoutMs: 8000 });
  assert.ok(['ok', 'salvaged'].includes(r.status), `expected ok/salvaged, got ${r.status}`);
  assert.ok(r.result.includes('assembled from deltas'), `got: ${r.result}`);
});

test('non-stream engine still uses the raw-stdout path (regression)', async () => {
  const r = await runInvocation(inv('ok'), { stallMs: 5000, timeoutMs: 8000 });
  assert.equal(r.status, 'ok');
  assert.equal(r.result, '- ok finding');
});
