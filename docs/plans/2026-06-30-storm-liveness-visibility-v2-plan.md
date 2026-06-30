# Storm liveness & visibility v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a *hung* engine (progress stopped) without killing a slow-but-working one, complete the council from whoever answered, and make each run observable (live heartbeat + the real model each engine ran).

**Architecture:** The stall mechanism already exists in `run-engine.mjs` (`lastActivity` + `armStall`, killing on silence past `opts.stallMs`). It was disabled globally because one threshold could not fit codex. We turn it back on **per engine** by threading each engine's own `stallMs` through `fan-out`, calibrated from two spikes. Partial synthesis already falls out of `Promise.allSettled` (a stalled engine resolves, it does not hang). For visibility we add an `onProgress` callback in `run-engine`, a periodic stderr heartbeat in `fan-out`, and resolved-model capture from each engine's own output.

**Tech Stack:** Node.js (zero external deps), ES modules, `node:test`.

**Spec:** `docs/specs/2026-06-30-storm-liveness-visibility-v2-design.md`

## Global Constraints

- Zero external dependencies; ES modules only; tests use `node:test` + `node:assert/strict`.
- Per-engine stall thresholds (calibrated from spikes): claude `20000`, glm `60000`, codex `180000` ms.
- Backward-compat: an engine without `stallMs` falls back to the global `stallMs` (currently `null` => stall disabled). All changes are independent of `proof.enabled`.
- Liveness = progress of the output stream, not wall-clock. A working engine (emitting events) is never killed; only an engine silent past its `stallMs` while still alive is killed (`status: 'stalled'`).
- Heartbeat goes to **stderr only**. `stdout` stays clean — the orchestrator parses one final JSON object from stdout.
- Tests must not depend on real wall-clock for correctness: drive timing with controlled fake-engine chunk emission and generous margins (>=3x), never a bare `sleep` asserting a precise threshold. A prior flaky timing test came from a tight margin.
- Do NOT touch: the `[FINDING]` run/expects/observed contract (`prompt.mjs`); proof-mode self-experiment + verify-don't-trust (`proof.mjs`, worktrees); "divergence > consensus" (synthesis still lists each engine's unique findings); cwd/secrets isolation.

---

### Task 1: Per-engine stallMs in config.json

**Files:**
- Modify: `scripts/config.json` (engines array)
- Test: `tests/companion.test.mjs`

**Interfaces:**
- Produces: each engine object in `config.json` gains a numeric `stallMs` field. Values: claude 20000, glm 60000, codex 180000. codex still has no `model` (it comes from `~/.codex/config.toml`).

- [ ] **Step 1: Write the failing test**

Add to `tests/companion.test.mjs` (it already imports `node:fs` inline; mirror that style):

```js
test('each engine carries its calibrated per-engine stallMs', async () => {
  const fs = await import('node:fs');
  const cfg = JSON.parse(fs.readFileSync(new URL('../scripts/config.json', import.meta.url), 'utf8'));
  const byId = Object.fromEntries(cfg.engines.map((e) => [e.id, e]));
  assert.equal(byId.claude.stallMs, 20000);
  assert.equal(byId.codex.stallMs, 180000);
  assert.equal(byId.glm.stallMs, 60000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/companion.test.mjs`
Expected: FAIL — `byId.claude.stallMs` is `undefined`, not `20000`.

- [ ] **Step 3: Add stallMs to each engine in `scripts/config.json`**

The `engines` array becomes exactly:

```json
  "engines": [
    { "id": "claude", "model": "opus", "stallMs": 20000 },
    { "id": "codex", "stallMs": 180000 },
    { "id": "glm", "model": "glm-5.2", "effort": "max", "stallMs": 60000 }
  ]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/companion.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/config.json tests/companion.test.mjs
git commit -m "feat(config): per-engine stallMs thresholds (claude 20s / glm 60s / codex 180s)"
```

---

### Task 2: Thread per-engine stallMs through fan-out + assert partial synthesis

**Files:**
- Modify: `scripts/lib/fan-out.mjs` (the `runner(...)` call in `runAll`)
- Test: `tests/fan-out.test.mjs`

**Interfaces:**
- Consumes: each engine's `e.stallMs` (Task 1); global `opts.stallMs` as fallback.
- Produces: `runAll` passes `stallMs: e.stallMs ?? opts.stallMs` to each `runner` call. No signature change to `runAll`.

Current call (in `scripts/lib/fan-out.mjs`, inside `engines.map`):
```js
return await runner(e.id, prompt, cfg, {
  timeoutMs: opts.timeoutMs,
  stallMs: opts.stallMs,
  cwd,
  env: e.experimentEnv,
});
```

- [ ] **Step 1: Write the failing tests**

Add to `tests/fan-out.test.mjs`:

```js
test('per-engine stallMs is threaded into each runner call; missing falls back to global', async () => {
  const seen = {};
  const runner = (id, _p, _c, opts) => {
    seen[id] = opts.stallMs;
    return Promise.resolve({ engine: id, status: 'ok', result: 'r' });
  };
  const engines = [{ id: 'claude', stallMs: 20000 }, { id: 'codex', stallMs: 180000 }, { id: 'glm' }];
  await runAll('task', engines, { runner, stallMs: 999 });
  assert.equal(seen.claude, 20000);
  assert.equal(seen.codex, 180000);
  assert.equal(seen.glm, 999); // no per-engine value -> global fallback
});

test('partial synthesis: a stalled engine resolves and does not block the others', async () => {
  const runner = (id) =>
    id === 'glm'
      ? Promise.resolve({ engine: id, status: 'stalled', error: 'no output for 60000ms' })
      : Promise.resolve({ engine: id, status: 'ok', result: 'r' });
  const results = await runAll('task', [{ id: 'claude' }, { id: 'glm' }, { id: 'codex' }], { runner });
  assert.equal(results.length, 3);
  assert.equal(results.find((r) => r.engine === 'glm').status, 'stalled');
  assert.equal(results.filter((r) => r.status === 'ok').length, 2);
});
```

- [ ] **Step 2: Run tests to verify the new stallMs test fails**

Run: `node --test tests/fan-out.test.mjs`
Expected: the threading test FAILS (`seen.claude` is `999`, the global, not `20000`). The partial-synthesis test already PASSES (allSettled) — keep it as a documented contract guard.

- [ ] **Step 3: Implement per-engine threading**

In `scripts/lib/fan-out.mjs`, change the `stallMs` line in the `runner(...)` call:

```js
return await runner(e.id, prompt, cfg, {
  timeoutMs: opts.timeoutMs,
  stallMs: e.stallMs ?? opts.stallMs,
  cwd,
  env: e.experimentEnv,
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/fan-out.test.mjs`
Expected: PASS (both new tests + all existing).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fan-out.mjs tests/fan-out.test.mjs
git commit -m "feat(fan-out): thread per-engine stallMs; partial synthesis on stall"
```

---

### Task 3: run-engine onProgress callback

**Files:**
- Modify: `scripts/lib/run-engine.mjs` (`runInvocation`: add chunk counter + `opts.onProgress`)
- Test: `tests/run-engine.test.mjs`

**Interfaces:**
- Produces: `runInvocation(inv, opts)` calls `opts.onProgress?.({ chunks, lastActivityAt })` on every activity tick. `chunks` is a monotonically increasing integer; `lastActivityAt` is `Date.now()` of the tick. Optional — absent `onProgress` changes nothing.

- [ ] **Step 1: Write the failing test**

Add to `tests/run-engine.test.mjs`:

```js
test('onProgress fires on activity with a growing chunk count', async () => {
  const seen = [];
  const r = await runInvocation(inv('slow-stream'), {
    stallMs: 5000, timeoutMs: 8000,
    onProgress: (s) => seen.push(s.chunks),
  });
  assert.equal(r.status, 'ok');
  assert.ok(seen.length > 0, 'onProgress should fire at least once');
  assert.ok(seen[seen.length - 1] >= seen[0], 'chunk count should be non-decreasing');
  assert.ok(seen.every((n) => typeof n === 'number'), 'chunks should be numbers');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/run-engine.test.mjs`
Expected: FAIL — `seen` stays empty (`onProgress` never called).

- [ ] **Step 3: Implement the chunk counter + callback**

In `scripts/lib/run-engine.mjs`, add a counter near the other per-run state (next to `let lastActivity = Date.now();`):

```js
let chunkCount = 0;
```

Then in the `onActivity` function, after `armStall();`, add the progress call:

```js
const onActivity = () => {
  lastActivity = Date.now();
  chunkCount += 1;
  armStall(); // reset inactivity timer on any output
  if (opts.onProgress) opts.onProgress({ chunks: chunkCount, lastActivityAt: lastActivity });
  const tail = (stdout.slice(-AUTH_SCAN_TAIL)) + '\n' + (stderr.slice(-AUTH_SCAN_TAIL));
  if (detectAuthPrompt(tail)) {
    armAuthGrace();
  } else {
    clearTimeout(authTimer);
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/run-engine.test.mjs`
Expected: PASS (new test + all existing — the callback is additive).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/run-engine.mjs tests/run-engine.test.mjs
git commit -m "feat(run-engine): onProgress callback (chunk count + last activity)"
```

---

### Task 4: fan-out progress heartbeat (stderr)

**Files:**
- Modify: `scripts/lib/fan-out.mjs` (`runAll`: progress registry + interval + per-engine `onProgress`)
- Test: `tests/fan-out.test.mjs`

**Interfaces:**
- Consumes: `runInvocation`'s `onProgress` (Task 3).
- Produces: `runAll` accepts `opts.heartbeatMs` (default `15000`; `0`/negative disables) and `opts.onHeartbeat(line)` (default writes `line + '\n'` to `process.stderr`). It emits one line per interval: `[storm +<elapsed>s] <id>: <chunks>ev idle <n>s | ...`; a finished non-ok engine shows `<id>: <status>`.

- [ ] **Step 1: Write the failing test**

Add to `tests/fan-out.test.mjs`:

```js
test('heartbeat emits a periodic per-engine progress line to onHeartbeat', async () => {
  const lines = [];
  const runner = async (id, _p, _c, opts) => {
    opts.onProgress?.({ chunks: 3, lastActivityAt: Date.now() });
    await new Promise((r) => setTimeout(r, 70)); // ~3x the 20ms heartbeat -> >=1 tick
    return { engine: id, status: 'ok', result: 'r' };
  };
  await runAll('task', [{ id: 'claude' }, { id: 'codex' }], {
    runner, heartbeatMs: 20, onHeartbeat: (l) => lines.push(l),
  });
  assert.ok(lines.length > 0, 'should emit at least one heartbeat line');
  assert.match(lines[0], /\[storm \+\d+s\]/);
  assert.match(lines[0], /claude:/);
  assert.match(lines[0], /codex:/);
});

test('heartbeatMs <= 0 disables the heartbeat', async () => {
  const lines = [];
  const runner = (id) => Promise.resolve({ engine: id, status: 'ok', result: 'r' });
  await runAll('task', [{ id: 'claude' }], { runner, heartbeatMs: 0, onHeartbeat: (l) => lines.push(l) });
  assert.equal(lines.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/fan-out.test.mjs`
Expected: FAIL — `lines` is empty (no heartbeat emitted yet).

- [ ] **Step 3: Implement the heartbeat in `runAll`**

In `scripts/lib/fan-out.mjs`, replace the body of `runAll` so it tracks progress and runs an interval. Full updated function:

```js
export async function runAll(task, engines, opts = {}) {
  const runner = opts.runner ?? runEngine;
  const role = opts.role ?? 'reviewer';
  const proof = !!opts.proof;
  const prompt = buildStormPrompt({ task, role, repoPath: opts.cwd, proof });

  const progress = {}; // id -> { chunks, lastActivityAt, status }
  const startedAt = Date.now();
  const hbMs = opts.heartbeatMs ?? 15000;
  const writeHeartbeat = opts.onHeartbeat ?? ((line) => process.stderr.write(line + '\n'));
  let hb;
  if (Number.isFinite(hbMs) && hbMs > 0) {
    hb = setInterval(() => {
      const now = Date.now();
      const parts = engines.map((e) => {
        const p = progress[e.id];
        if (!p) return `${e.id}: …`;
        if (p.status && p.status !== 'ok') return `${e.id}: ${p.status}`;
        const idle = Math.round((now - (p.lastActivityAt ?? now)) / 1000);
        return `${e.id}: ${p.chunks ?? 0}ev idle ${idle}s`;
      });
      writeHeartbeat(`[storm +${Math.round((now - startedAt) / 1000)}s] ${parts.join(' | ')}`);
    }, hbMs);
    if (hb.unref) hb.unref();
  }

  const settled = await Promise.allSettled(
    engines.map(async (e) => {
      let ws = null;
      const onProgress = (s) => {
        progress[e.id] = { chunks: s.chunks, lastActivityAt: s.lastActivityAt, status: null };
      };
      try {
        const cwd = proof ? (ws = makeEngineWorkspace(opts.cwd, e.id)).dir : opts.cwd;
        const cfg = { ...e, proof };
        const res = await runner(e.id, prompt, cfg, {
          timeoutMs: opts.timeoutMs,
          stallMs: e.stallMs ?? opts.stallMs,
          cwd,
          env: e.experimentEnv,
          onProgress,
        });
        progress[e.id] = { ...(progress[e.id] ?? {}), status: res.status };
        return res;
      } finally {
        if (ws) ws.cleanup();
      }
    })
  );

  if (hb) clearInterval(hb);

  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { engine: engines[i].id, status: 'error', error: s.reason?.message ?? String(s.reason) }
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/fan-out.test.mjs`
Expected: PASS (new heartbeat tests + all prior fan-out tests, including the Task 2 threading test which still sees `opts.stallMs` via `e.stallMs ?? opts.stallMs`).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fan-out.mjs tests/fan-out.test.mjs
git commit -m "feat(fan-out): live progress heartbeat to stderr (per-engine, 15s)"
```

---

### Task 5: resolved-model capture (stream init + codex header) + survival through proof

**Files:**
- Modify: `scripts/lib/run-engine.mjs` (capture `resolvedModel`; include it in `finish`)
- Modify: `tests/fixtures/fake-engine.mjs` (add `model` to stream-json init; add `codex-header` mode)
- Test: `tests/run-engine.test.mjs`, `tests/proof-annotate.test.mjs`

**Interfaces:**
- Produces: every result object from `runInvocation` carries `resolvedModel` (string or `null`). Captured from the stream-json `system/init` event's `model` field (claude/glm) or from a `model: <x>` line in stderr (codex header). `annotateWithProof` preserves it via its `{ ...r }` spread.

- [ ] **Step 1: Write the failing tests**

In `tests/fixtures/fake-engine.mjs`, add `model` to the `stream-json` mode's init event (change the first event):

```js
    { type: 'system', subtype: 'init', model: 'fake-stream-model' },
```

And add a new `codex-header` mode (place it next to the other modes, before the final `slow-stream` block):

```js
// codex-header: emit a codex-style session header in stderr (carrying the model)
// then a valid result in stdout. Exercises resolvedModel capture via the stderr
// `model:` regex (codex does not use stream-json).
else if (mode === 'codex-header') {
  process.stderr.write('OpenAI Codex v0.139.0\n--------\nmodel: gpt-5.5-test\nprovider: openai\n--------\n');
  process.stdout.write('<STORM_RESULT>\n- codex finding\n</STORM_RESULT>\n');
  process.exit(0);
}
```

In `tests/run-engine.test.mjs`:

```js
test('stream-json: resolvedModel captured from the system/init event', async () => {
  const r = await runInvocation(invStream('stream-json'), { stallMs: 5000, timeoutMs: 8000 });
  assert.equal(r.status, 'ok');
  assert.equal(r.resolvedModel, 'fake-stream-model');
});

test('codex-style stderr header: resolvedModel captured via the model: regex', async () => {
  const r = await runInvocation(inv('codex-header'), { stallMs: 5000, timeoutMs: 8000 });
  assert.equal(r.status, 'ok', `expected ok, got ${r.status}: ${r.error}`);
  assert.equal(r.resolvedModel, 'gpt-5.5-test');
});

test('no model in output -> resolvedModel is null (not undefined)', async () => {
  const r = await runInvocation(inv('ok'), { stallMs: 5000, timeoutMs: 8000 });
  assert.equal(r.resolvedModel, null);
});
```

In `tests/proof-annotate.test.mjs` (it already imports `annotateWithProof`; add):

```js
test('annotateWithProof preserves resolvedModel on each result', async () => {
  const results = [{ engine: 'claude', status: 'ok', result: 'no findings here', resolvedModel: 'claude-opus-4-8' }];
  const out = await annotateWithProof(results, { repoPath: process.cwd() });
  assert.equal(out.results[0].resolvedModel, 'claude-opus-4-8');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/run-engine.test.mjs tests/proof-annotate.test.mjs`
Expected: FAIL — `r.resolvedModel` is `undefined`.

- [ ] **Step 3: Implement resolvedModel capture in `run-engine.mjs`**

Add state next to `let finalText = null;`:

```js
let resolvedModel = null; // captured from stream init (claude/glm) or codex stderr header
```

In `consumeStream`, after the `result`/`content_block_delta` handling, capture the init model. Add this branch inside the `while` loop's event handling (after the existing `else if (... content_block_delta ...)` block):

```js
        } else if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string') {
          resolvedModel = ev.model;
        }
```

In `onActivity`, add a cheap one-shot stderr scan for the codex header (only until found):

```js
    if (!resolvedModel) {
      const m = stderr.match(/^[ \t]*model:[ \t]*(.+?)[ \t]*$/m);
      if (m) resolvedModel = m[1].trim();
    }
```

Place it in `onActivity` right after `armStall();` (stderr is appended before `onActivity` runs, so the header is visible). Then include it in `finish`:

```js
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ ...res, lastActivityMs: Date.now() - lastActivity, resolvedModel });
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/run-engine.test.mjs tests/proof-annotate.test.mjs`
Expected: PASS. Run the full suite to confirm no regression: `node --test` (the stream-json `model` addition must not break existing stream tests — they assert `result`, not the init event).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/run-engine.mjs tests/fixtures/fake-engine.mjs tests/run-engine.test.mjs tests/proof-annotate.test.mjs
git commit -m "feat(run-engine): capture resolvedModel (stream init / codex header)"
```

---

### Task 6: Synthesis contract — surface resolved-model + failure reasons; de-gemini the copy

**Files:**
- Modify: `commands/storm.md`
- Modify: `skills/storm-runtime/SKILL.md`

**Interfaces:**
- No code. Updates the orchestrator's instructions so it (a) reports each engine's `resolvedModel`, (b) lists every `status != ok` engine WITH its `error` reason, (c) stops claiming four engines / gemini now that the pool is claude+codex+glm.

- [ ] **Step 1: Update `commands/storm.md`**

Line 2 `description:` and line 4 area — replace "4-engine council (Claude+Codex+GLM+Gemini)" / "four engines" with the current pool. Set the front-matter description to:

```
description: Storm — convene a multi-engine council (Claude+Codex+GLM) on demand
```

In step 1's prose, change "spawns the four engines in parallel" to "spawns the configured engines in parallel".

In step 2, update the JSON shape to include `resolvedModel`:

```
2. You receive JSON: `{ mode, task, repoPath, results: [{ engine, resolvedModel, status, result|error }] }`.
```

Replace the synthesis bullets (step 3) with:

```
3. Synthesize ONE answer:
   - State which engine ran which model, from each result's `resolvedModel`
     (e.g. "claude: claude-opus-4-8, codex: gpt-5.5, glm: glm-5.2"). Never
     describe models from memory — `resolvedModel` is the source of truth.
   - Consensus (engines agree) -> high-confidence.
   - Disagreements -> call them out explicitly for the user to review.
   - Unique findings per engine -> list them (divergence is the point; do not
     drop a finding just because only one engine raised it).
   - For EVERY engine with status != ok (stalled / auth_required / timeout /
     no_result / error): report "<engine> (<resolvedModel>) did not answer:
     <status> — <error>". Do not silently synthesize from a subset; the user
     must see who dropped and why.
```

- [ ] **Step 2: Update `skills/storm-runtime/SKILL.md`**

Line 3 description and line 10 JSON shape. Set description to "Internal contract for invoking the Storm multi-engine council runtime" (unchanged is fine). Update the results shape line:

```
- Returns normalized JSON `{ mode, task, repoPath, results: [{engine,resolvedModel,status,result|error}] }`.
```

Replace the degraded-engines bullet with:

```
- Engines with status `stalled`/`auth_required`/`timeout`/`error`/`no_result` are degraded,
  not fatal: synthesize from the engines that answered, but list each dropped engine WITH its
  reason (status + error) and its `resolvedModel`. Report each answering engine's `resolvedModel`
  (source of truth for which model ran — never describe models from memory).
```

- [ ] **Step 3: Verify no stale "four"/"gemini" references remain**

Run: `grep -niE "four engines|gemini|4-engine" commands/storm.md skills/storm-runtime/SKILL.md`
Expected: no matches (or only matches that are intentionally about gemini's future return — there should be none in these two files).

- [ ] **Step 4: Commit**

```bash
git add commands/storm.md skills/storm-runtime/SKILL.md
git commit -m "docs(synthesis): surface resolvedModel + drop reasons; de-gemini council copy"
```

---

### Task 7: Decision-doc, README, version bump, live verify

**Files:**
- Create: `docs/decisions/2026-06-30-per-engine-stall-revisit.md`
- Modify: `README.md` (add a liveness/heartbeat note)
- Modify: `package.json` (version bump)

**Interfaces:**
- No code. Documents the no-timeouts revisit, surfaces the heartbeat/thresholds in the README, bumps the version, and runs one real council to confirm the heartbeat prints and resolvedModel is populated.

- [ ] **Step 1: Write the decision-doc**

Create `docs/decisions/2026-06-30-per-engine-stall-revisit.md`:

```markdown
# Per-engine stall detection — revisiting no-timeouts

- Date: 2026-06-30
- Supersedes (in part): docs/decisions/2026-06-25-no-timeouts-liveness.md

## Context

A live run had glm hang for 30 minutes (CPU 0.1%, no output). `fan-out` waits
for all engines, so the council never finished. This is the exact tradeoff the
no-timeouts decision accepted ("a deadlocked-but-alive process hangs until
Ctrl-C").

## Decision

Re-enable stall detection, but per-engine and calibrated, not a single global
threshold. Thresholds (from two instrumented spikes, max normal silence + margin):
claude 20s, glm 60s, codex 180s. An engine silent past its threshold WHILE ALIVE
is killed (`stalled`); a working engine (emitting stream events) re-arms the timer
and is never killed. Partial synthesis falls out of `Promise.allSettled`.

## Why this does not reintroduce the old bug

No-timeouts removed stall because claude/glm went silent during reasoning and
codex under xhigh is silent up to ~60s — a blind global stall killed working
engines. That was before heartbeat existed. Now claude/glm stream NDJSON
throughout and codex streams item events in stderr; the spikes measured each
engine's worst normal silence, so a per-engine threshold with margin kills only
a genuinely silent engine. "Liveness, not clocks" is preserved and sharpened:
liveness = stream progress measured per engine.

## What we rejected

- Single global stall threshold — one number cannot fit both claude (4s) and
  codex (67s); that is why it was disabled.
- Wall-clock cap per engine — kills a slow-but-working engine; the whole point is
  to distinguish "working long" from "hung".
- fs-watch on the worktree as an extra signal — spike showed file writes coincide
  with stream events (filesInGap=0); redundant.
```

- [ ] **Step 2: Add a README liveness note**

In `README.md`, under the architecture/engines section, add a short subsection:

```markdown
### Liveness & progress

Each engine has a per-engine `stallMs` in `config.json` (claude 20s / glm 60s /
codex 180s), calibrated from measured worst-case normal silence. An engine that
goes silent past its threshold while still alive is killed (`stalled`) and the
council synthesizes from whoever answered; a working engine (still streaming
events) is never killed. While the council runs, a heartbeat prints to stderr
every ~15s: `[storm +45s] claude: 130ev idle 2s | codex: 38ev idle 5s | glm: …`.
Each result also carries `resolvedModel` — the actual model the engine ran.
```

- [ ] **Step 3: Bump the version**

In `package.json`, change `"version": "0.10.1"` to `"version": "0.11.0"`.

- [ ] **Step 4: Run the full test suite**

Run: `node --test`
Expected: all tests PASS.

- [ ] **Step 5: Live verify (one real council)**

Run a real council on the Storm repo itself and confirm the heartbeat prints and resolvedModel is populated:

```bash
node scripts/storm-companion.mjs plan "Briefly: what does scripts/lib/fan-out.mjs do?" --cwd "$(pwd)" 2>/tmp/storm-hb.txt | tee /tmp/storm-out.json >/dev/null
grep -c '\[storm +' /tmp/storm-hb.txt   # expect >= 1 heartbeat line
node -e "const o=require('/tmp/storm-out.json'); console.log(o.results.map(r=>r.engine+':'+r.resolvedModel))"
```
Expected: at least one `[storm +Ns]` heartbeat line in stderr; each result prints a real `resolvedModel` (e.g. `claude:claude-opus-4-8`, `codex:gpt-5.5`, `glm:glm-5.2`), not `null`/`undefined`. If codex shows `null`, inspect its real header line format and adjust the `model:` regex; if claude/glm show `null`, inspect the real `system/init` event shape.

- [ ] **Step 6: Commit**

```bash
git add docs/decisions/2026-06-30-per-engine-stall-revisit.md README.md package.json
git commit -m "docs+release: per-engine stall revisit, README liveness note, v0.11.0"
```

---

## Self-Review

**Spec coverage:**
- Block A1 (per-engine stallMs config) -> Task 1. ✓
- Block A2 (fan-out threading) + A4 (partial synthesis) -> Task 2. ✓
- Block A3 (progress-absence detection) -> already in run-engine; Task 2 enables it per-engine. ✓
- Block B1 (heartbeat) -> Task 3 (onProgress) + Task 4 (stderr summary). ✓
- Block B2 (resolved-model) -> Task 5. ✓
- Block B3 (no_result reason + synthesis contract) -> Task 6. ✓
- no-timeouts revisit doc + README + version -> Task 7. ✓

**Placeholder scan:** no TBD/TODO; every code step shows the exact code; every test step shows the assertions; commands have expected output.

**Type consistency:** `onProgress({ chunks, lastActivityAt })` produced in Task 3, consumed identically in Task 4. `stallMs: e.stallMs ?? opts.stallMs` consistent across Tasks 2 and 4 (Task 4's full `runAll` keeps the Task 2 line). `resolvedModel` produced in Task 5, surfaced in Task 6 docs and Task 7 live check. `heartbeatMs`/`onHeartbeat` named consistently in Task 4 and its tests.

**Note for executor:** Task 4 rewrites the whole `runAll` body and includes the Task 2 `stallMs: e.stallMs ?? opts.stallMs` line — apply Task 2 first so its test exists, then Task 4's rewrite keeps it green.
