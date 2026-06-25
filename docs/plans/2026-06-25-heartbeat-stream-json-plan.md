# Heartbeat (stream-json) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the silent claude/glm engines to `--output-format stream-json` so they emit a continuous event stream during reasoning, turning the existing inactivity watchdog into a true liveness signal (no more false `stalled` kills of working engines).

**Architecture:** Two engines (claude, glm) gain stream flags + a `stream:true` invocation marker. `run-engine` line-buffers their NDJSON stdout, extracts the final answer from the `{type:"result"}` event, and runs the existing `extractResult` on that assembled text. Liveness stays bound to raw bytes (parser-independent). codex is untouched.

**Tech Stack:** Node ESM, zero runtime deps, `node:test`, `child_process.spawn`.

## Global Constraints

- **Zero runtime npm dependencies** — built-ins only (`JSON.parse`, `child_process`).
- **Liveness must not depend on the parser** — `onActivity()` fires on raw `'data'`; a malformed JSON line must never break the heartbeat.
- **Tolerant parser** — `JSON.parse` each line in try/catch; unknown/broken lines are skipped, never thrown.
- **Marker contract preserved** — `<STORM_RESULT>…</STORM_RESULT>` is extracted from the assembled final text (it rides inside the `result` event), via the existing `extractResult`/`salvageTail`.
- **run-engine invariants** (from v1/v1.1/monitoring): `let timer` before try (no TDZ), single `finish` choke-point with settled-guard, all timers cleared in `finish`, `setEncoding('utf8')`, parse-output-not-exit-code, degraded-not-thrown, prompt-via-stdin/EPIPE-safe, salvage.
- Stream flags (exact, verbatim): `--output-format stream-json --verbose --include-partial-messages`.

## File Structure

- `scripts/lib/adapters.mjs` — add stream flags + `stream` field for claude/glm; `buildInvocation` returns `stream`.
- `scripts/lib/run-engine.mjs` — NDJSON accumulator for stream engines; extract final text from `result` event; fallback chain.
- `tests/fixtures/fake-engine.mjs` — new `stream-json` fixture mode.
- `scripts/config.json` — `stallMs` 240000 → 60000.
- Tests: `tests/adapters.test.mjs`, `tests/run-engine.test.mjs`.

---

### Task 1: adapters — stream flags for claude/glm + `stream` marker

**Files:**
- Modify: `scripts/lib/adapters.mjs`
- Test: `tests/adapters.test.mjs`

**Interfaces:**
- Produces: `buildInvocation(engineId, prompt, cfg)` now returns `{ cmd, args, input, env, stream }` where `stream === true` for claude/glm, `false` otherwise. Stream engines' `args` include `--output-format stream-json --verbose --include-partial-messages`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/adapters.test.mjs`:

```js
const STREAM = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

test('claude: stream flags present and stream marker true', () => {
  const inv = buildInvocation('claude', 'PROMPT', {});
  assert.equal(inv.stream, true);
  for (const f of STREAM) assert.ok(inv.args.includes(f), `missing ${f}`);
  assert.ok(inv.args.includes('-p'));
});

test('glm: stream flags present and stream marker true; model kept', () => {
  const inv = buildInvocation('glm', 'PROMPT', { apiKey: 'K' });
  assert.equal(inv.stream, true);
  for (const f of STREAM) assert.ok(inv.args.includes(f), `missing ${f}`);
  assert.deepEqual(inv.args.slice(0, 3), ['-p', '--model', 'glm-5.2']);
});

test('codex: NOT a stream engine, no stream flags', () => {
  const inv = buildInvocation('codex', 'PROMPT');
  assert.equal(inv.stream, false);
  assert.ok(!inv.args.includes('stream-json'));
});

test('antigravity: NOT a stream engine', () => {
  const inv = buildInvocation('antigravity', 'PROMPT', { model: 'M' });
  assert.equal(inv.stream, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/adapters.test.mjs`
Expected: FAIL — `inv.stream` is `undefined` (not `true`/`false`), stream flags absent.

- [ ] **Step 3: Implement minimal code**

In `scripts/lib/adapters.mjs`, add the shared constant above `const ADAPTERS`:

```js
const STREAM_FLAGS = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
```

Mark claude and glm as stream engines and append the flags. Replace the `claude` adapter:

```js
  claude: {
    cmd: 'claude',
    stream: true,
    buildArgs: (_prompt, cfg) => ['-p', ...(cfg.model ? ['--model', cfg.model] : []), ...STREAM_FLAGS],
  },
```

In the `glm` adapter set `stream: true` and append flags to buildArgs:

```js
    buildArgs: (_prompt, cfg) => ['-p', '--model', cfg.model ?? 'glm-5.2', ...STREAM_FLAGS],
```
(add `stream: true,` as a sibling of `cmd:` in the glm adapter object).

Update `buildInvocation` to surface the flag:

```js
export function buildInvocation(engineId, prompt, cfg = {}) {
  const a = ADAPTERS[engineId];
  if (!a) throw new Error(`unknown engine: ${engineId}`);
  const env = a.buildEnv ? a.buildEnv(cfg) : undefined;
  return { cmd: a.cmd, args: a.buildArgs(prompt, cfg), input: prompt, env, stream: a.stream ?? false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/adapters.test.mjs`
Expected: PASS (all adapter tests, including the existing ones).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/adapters.mjs tests/adapters.test.mjs
git commit -m "feat(stream): claude/glm carry stream-json flags + stream marker"
```

---

### Task 2: run-engine — NDJSON accumulator + final-text extraction

**Files:**
- Modify: `scripts/lib/run-engine.mjs`
- Modify: `tests/fixtures/fake-engine.mjs` (add `stream-json` mode)
- Test: `tests/run-engine.test.mjs`

**Interfaces:**
- Consumes: `inv.stream` (boolean) from Task 1. `runInvocation` accepts `stream` in its destructured arg; `runEngine` forwards `inv.stream`.
- Produces: stream engines resolve `ok` with `result` extracted from the assembled final text; liveness fires on raw bytes.

- [ ] **Step 1: Add the `stream-json` fixture mode**

In `tests/fixtures/fake-engine.mjs`, add before the final `slow-stream` branch (mirror the existing `else if` style):

```js
// stream-json: emit NDJSON events with gaps (heartbeat), then a final result
// event carrying the STORM_RESULT markers. Simulates claude/glm under
// --output-format stream-json. The 30ms gaps exercise stall re-arming.
else if (mode === 'stream-json') {
  const events = [
    { type: 'system', subtype: 'init' },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'reasoning...' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '<STORM_' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'RESULT>\n- streamed\n</STORM_RESULT>' } },
    { type: 'result', subtype: 'success', result: '<STORM_RESULT>\n- streamed finding\n</STORM_RESULT>' },
  ];
  let i = 0;
  const iv = setInterval(() => {
    process.stdout.write(JSON.stringify(events[i]) + '\n');
    if (++i >= events.length) { clearInterval(iv); process.exit(0); }
  }, 30);
}
// stream-json-nofinal: text_delta events but NO result event -> exercises the
// delta-assembly fallback. Markers split across two deltas.
else if (mode === 'stream-json-nofinal') {
  const events = [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '<STORM_RESULT>\n- assembled' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: ' from deltas\n</STORM_RESULT>' } },
  ];
  let i = 0;
  const iv = setInterval(() => {
    process.stdout.write(JSON.stringify(events[i]) + '\n');
    if (++i >= events.length) { clearInterval(iv); process.exit(0); }
  }, 20);
}
// stream-json-garbage: a malformed line between valid events -> parser must skip
// it (tolerant) and still extract the result.
else if (mode === 'stream-json-garbage') {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    '{ this is not valid json',
    JSON.stringify({ type: 'result', subtype: 'success', result: '<STORM_RESULT>\n- survived garbage\n</STORM_RESULT>' }),
  ];
  let i = 0;
  const iv = setInterval(() => {
    process.stdout.write(lines[i] + '\n');
    if (++i >= lines.length) { clearInterval(iv); process.exit(0); }
  }, 20);
}
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/run-engine.test.mjs` (the `inv` helper already passes the mode as an argv arg; extend it to pass `stream`):

```js
// stream-mode invocation helper: marks the invocation as a stream engine
const invStream = (mode) => ({ engine: 'fake', cmd: process.execPath, args: [FAKE, mode], stream: true });

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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/run-engine.test.mjs`
Expected: FAIL — stream tests get `no_result`/`salvaged` of raw NDJSON (markers are split across JSON token-deltas in raw stdout), not the clean `- streamed finding`.

- [ ] **Step 4: Implement the NDJSON accumulator**

In `scripts/lib/run-engine.mjs`, update the signature to accept `stream`:

```js
export function runInvocation({ engine, cmd, args, input, env, stream }, opts = {}) {
```

Inside the Promise, near the `let stdout = '';` declarations, add accumulators:

```js
    let jsonBuf = '';      // unparsed NDJSON tail (stream engines only)
    let finalText = '';    // text from the {type:result} event
    const deltas = [];     // text_delta chunks (fallback when no result event)
```

Add a tolerant line consumer (place it just above `const onActivity = ...`):

```js
    // Parse complete NDJSON lines from jsonBuf. Tolerant: never throws on a bad
    // line. Captures the final answer (result event) and text deltas (fallback).
    const consumeStream = () => {
      let nl;
      while ((nl = jsonBuf.indexOf('\n')) >= 0) {
        const line = jsonBuf.slice(0, nl);
        jsonBuf = jsonBuf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'result' && typeof ev.result === 'string') {
          finalText = ev.result;
        } else if (
          ev.type === 'content_block_delta' &&
          ev.delta && ev.delta.type === 'text_delta' &&
          typeof ev.delta.text === 'string'
        ) {
          deltas.push(ev.delta.text);
        }
      }
    };
```

Feed the stream parser in the stdout handler (liveness stays on raw bytes):

```js
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stream) { jsonBuf += d; consumeStream(); }
      onActivity();
    });
```

In the `close` handler, choose the source text for stream engines:

```js
    child.on('close', () => {
      const sourceText = stream ? (finalText || deltas.join('') || stdout) : stdout;
      const parsed = extractResult(sourceText);
      if (parsed.ok) {
        finish({ engine, status: 'ok', result: parsed.result });
      } else {
        if (parsed.reason === 'no_marker') {
          const salvaged = salvageTail(sourceText);
          if (salvaged.length >= MIN_SALVAGE_LENGTH) {
            finish({ engine, status: 'salvaged', result: salvaged, error: 'no_marker (salvaged)' });
            return;
          }
        }
        const tail = stderr.trim().slice(0, 500);
        finish({ engine, status: 'no_result', error: tail ? `${parsed.reason}: ${tail}` : parsed.reason });
      }
    });
```

Finally, forward `stream` from `runEngine`:

```js
  return runInvocation({ engine: engineId, cmd: inv.cmd, args: inv.args, input: inv.input, env: inv.env, stream: inv.stream }, opts);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/run-engine.test.mjs`
Expected: PASS — all stream tests + existing tests green.

- [ ] **Step 6: Run the full suite**

Run: `node --test tests/*.test.mjs`
Expected: PASS, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/run-engine.mjs tests/fixtures/fake-engine.mjs tests/run-engine.test.mjs
git commit -m "feat(stream): NDJSON accumulator + final-text extraction for stream engines"
```

---

### Task 3: config retune + live verification

**Files:**
- Modify: `scripts/config.json`

**Interfaces:**
- Consumes: stream engines from Tasks 1-2.

- [ ] **Step 1: Lower stallMs (real heartbeat now exists)**

In `scripts/config.json` change:

```json
  "timeoutMs": 480000,
  "stallMs": 60000,
```
(keep `timeoutMs` at 480000 as the absolute floor; `stallMs` 240000 → 60000.)

- [ ] **Step 2: Full suite still green**

Run: `node --test tests/*.test.mjs`
Expected: PASS, 0 fail.

- [ ] **Step 3: Live verification — the original symptom is gone**

Run the council on a reasoning-heavy task (the one that stalled glm at 240s):

```bash
cd ~/storm && node scripts/storm-companion.mjs plan "Reason carefully, then answer: design a rate limiter for a multi-tenant API. Wrap the final answer in STORM_RESULT markers." > /tmp/storm-hb-verify.json 2>&1
node -e 'const r=JSON.parse(require("fs").readFileSync("/tmp/storm-hb-verify.json","utf8")); for(const e of r.results) console.log(e.engine, e.status, e.lastActivityMs)'
```
Expected: `claude ok`, `codex ok`, `glm ok` — glm no longer `stalled` (events stream throughout, so `lastActivityMs` is small even though total runtime is long).

- [ ] **Step 4: Commit**

```bash
git add scripts/config.json
git commit -m "feat(stream): lower stallMs to 60s now that claude/glm stream a real heartbeat"
```

- [ ] **Step 5: Bump version + final review**

Bump `package.json` and `.claude-plugin/plugin.json` to `0.5.0` (new heartbeat capability = minor). Commit:

```bash
git add package.json .claude-plugin/plugin.json
git commit -m "chore: bump to 0.5.0 (stream-json heartbeat)"
```

Then dispatch an opus whole-diff review of run-engine.mjs (risky file) before declaring done.

---

## Self-Review

**Spec coverage:**
- adapters stream flags → Task 1 ✓
- run-engine NDJSON accumulator + liveness-on-raw-bytes → Task 2 ✓
- result extraction from `result` event + fallback (deltas → raw) → Task 2 ✓
- tolerant parser (skip malformed) → Task 2 (`stream-json-garbage`) ✓
- result-parser unchanged → confirmed (Task 2 reuses `extractResult`/`salvageTail`) ✓
- config stallMs 240→60, timeout floor 480 → Task 3 ✓
- failure modes (schema drift, wedged tool, grandchildren-not-touched) → covered by tolerant parser + fallback; grandchildren explicitly out of scope ✓
- live verification (glm not stalled) → Task 3 Step 3 ✓

**Placeholder scan:** none — every code step has complete code.

**Type consistency:** `stream` boolean flows adapters → buildInvocation → runEngine → runInvocation consistently; `finalText`/`deltas`/`jsonBuf`/`consumeStream`/`sourceText` names consistent within Task 2.
