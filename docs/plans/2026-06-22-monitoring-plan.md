# Storm Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blind total-timeout as the primary kill trigger with inactivity-detection (kill on silence, not on a wall-clock cap), add narrow auth-prompt detection, and return a diagnostic reason — so rare engine hangs fail gracefully instead of as a mute timeout.

**Architecture:** `run-engine.mjs` tracks `lastActivity` (time of the last stdout OR stderr chunk), arms a rolling stall-timer reset on every chunk (`stallMs`), keeps the total-timeout as a far backstop (`timeoutMs`), scans recent output for narrow CLI auth-prompt patterns, and includes `lastActivityMs` + a clear status in every result. A new `auth-detect.mjs` holds the patterns, tested in isolation.

**Tech Stack:** Node.js ESM, built-in `node:test` + `node:child_process`, zero runtime dependencies.

## Global Constraints

- Node ESM only; ZERO runtime dependencies; tests on built-in `node:test`. No emoji.
- Preserve ALL existing run-engine invariants: `let timer`-style declarations before try (no TDZ), single `finish` choke-point with settled-guard (no double-resolve), `setEncoding('utf8')` on stdout+stderr, parse-output-not-exit-code, degraded statuses returned not thrown, prompt-via-stdin with EPIPE-safety, salvage on `no_marker` (>= 40 chars).
- Status set after this work: `ok`, `no_result`, `salvaged`, `timeout`, `error`, `stalled`, `auth_required`.
- Rare-case principle: monitoring handles infrequent hangs; do NOT over-engineer (no claude stream-json, no live-UI, no per-engine thresholds in v1).
- All timers (stall + backstop) cleared in `finish`.

## File Structure

```
scripts/lib/auth-detect.mjs     # NEW: detectAuthPrompt(text) -> bool (narrow patterns)
scripts/lib/run-engine.mjs      # MODIFY: lastActivity, rolling stall-timer, auth-scan, lastActivityMs
scripts/config.json             # MODIFY: add stallMs, raise timeoutMs to backstop
commands/storm.md               # MODIFY (minor): mention new statuses
skills/storm-runtime/SKILL.md   # MODIFY (minor): mention new statuses
tests/auth-detect.test.mjs      # NEW
tests/run-engine.test.mjs       # MODIFY: stalled / auth_required / no-false-stall / lastActivityMs
tests/fixtures/fake-engine.mjs  # MODIFY: add silent-hang, auth-prompt, slow-stream modes
```

---

### Task M1: Auth-prompt detector

**Files:**
- Create: `scripts/lib/auth-detect.mjs`
- Test: `tests/auth-detect.test.mjs`

**Interfaces:**
- Produces: `detectAuthPrompt(text: string) -> boolean`. NARROW: matches CLI auth-failure phrasing, NOT generic auth vocabulary, so reviewing auth-related code does not false-positive.

- [ ] **Step 1: Write the failing test**

```js
// tests/auth-detect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAuthPrompt } from '../scripts/lib/auth-detect.mjs';

test('detects real CLI auth prompts', () => {
  assert.equal(detectAuthPrompt('You are not logged in. Run `claude login` to continue.'), true);
  assert.equal(detectAuthPrompt('Please sign in with ChatGPT to use Codex.'), true);
  assert.equal(detectAuthPrompt('Authentication required. Visit https://auth.example.com/device to sign in.'), true);
  assert.equal(detectAuthPrompt('Error: not authenticated. Please re-authenticate.'), true);
});

test('does NOT false-positive on code review prose about auth', () => {
  assert.equal(detectAuthPrompt('The login flow validates the OAuth token before granting access.'), false);
  assert.equal(detectAuthPrompt('Consider adding a sign-in button to the authorized users page.'), false);
  assert.equal(detectAuthPrompt('This function handles authentication and authorization logic.'), false);
  assert.equal(detectAuthPrompt('<STORM_RESULT>\n- The auth module looks solid\n</STORM_RESULT>'), false);
});

test('empty / non-string -> false', () => {
  assert.equal(detectAuthPrompt(''), false);
  assert.equal(detectAuthPrompt(undefined), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/storm && node --test tests/auth-detect.test.mjs`
Expected: FAIL — cannot find module `auth-detect.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/auth-detect.mjs
// NARROW patterns: target CLI auth-FAILURE phrasing, not generic auth vocabulary.
// Storm reviews auth-related code, so generic words ("login", "oauth", "authorize")
// must NOT trigger. Only phrasings a CLI emits when it cannot authenticate do.
const AUTH_PATTERNS = [
  /\bnot (authenticated|logged in|signed in)\b/i,
  /\bplease (re-?)?(authenticate|sign in|log in)\b/i,
  /\b(run|execute) `?[a-z]+ login`?/i,          // "run `claude login`"
  /\bsign in with (chatgpt|google|github|your)\b/i,
  /\bauthentication (required|failed)\b/i,
  /\bvisit https?:\/\/\S+ to (sign in|log in|authenticate)\b/i,
];

export function detectAuthPrompt(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return AUTH_PATTERNS.some((re) => re.test(text));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/storm && node --test tests/auth-detect.test.mjs`
Expected: PASS (3/3). If a false-positive test fails, TIGHTEN the offending pattern (do not loosen the assertions).

- [ ] **Step 5: Commit**

```bash
cd ~/storm && git add scripts/lib/auth-detect.mjs tests/auth-detect.test.mjs
git commit -m "feat: narrow CLI auth-prompt detector (monitoring)"
```

---

### Task M2: Inactivity-detect + auth-scan + diagnostics in run-engine

**Files:**
- Modify: `scripts/lib/run-engine.mjs` (the `runInvocation` function)
- Modify: `scripts/config.json`
- Modify: `tests/fixtures/fake-engine.mjs` (add modes)
- Modify: `tests/run-engine.test.mjs`
- Modify: `commands/storm.md`, `skills/storm-runtime/SKILL.md` (mention new statuses)

**Interfaces:**
- Consumes: `detectAuthPrompt` (Task M1), `extractResult` + `salvageTail` (existing), `buildInvocation` (existing).
- Produces: `runInvocation({engine,cmd,args,input}, opts?)` now honors `opts.stallMs` (default 90000) and `opts.timeoutMs` (default 300000), and every resolved result includes `lastActivityMs: number`. New statuses `stalled` and `auth_required`.

- [ ] **Step 1: Add fixture modes**

Add to `tests/fixtures/fake-engine.mjs` (alongside existing modes):

```js
// silent-hang: produce NO output and never exit on its own (until killed)
else if (mode === 'silent-hang') {
  setInterval(() => {}, 1000); // keep process alive, emit nothing
}
// auth-prompt: emit a CLI auth-failure line, then keep quiet
else if (mode === 'auth-prompt') {
  process.stdout.write('You are not logged in. Run `claude login` to continue.\n');
  setInterval(() => {}, 1000);
}
// slow-stream: emit a heartbeat chunk every 120ms for ~1.2s, then a valid result
else if (mode === 'slow-stream') {
  let n = 0;
  const iv = setInterval(() => {
    process.stdout.write(`. tick ${n}\n`);
    if (++n >= 10) {
      clearInterval(iv);
      process.stdout.write('<STORM_RESULT>\n- slow but alive\n</STORM_RESULT>\n');
      process.exit(0);
    }
  }, 120);
}
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/run-engine.test.mjs`:

```js
test('silent-hang -> stalled (no output past stallMs)', async () => {
  const r = await runInvocation(inv('silent-hang'), { stallMs: 300, timeoutMs: 5000 });
  assert.equal(r.status, 'stalled');
  assert.ok(typeof r.lastActivityMs === 'number');
});

test('auth-prompt -> auth_required quickly', async () => {
  const r = await runInvocation(inv('auth-prompt'), { stallMs: 5000, timeoutMs: 8000 });
  assert.equal(r.status, 'auth_required');
});

test('slow-stream is NOT stalled (heartbeat resets inactivity)', async () => {
  // stallMs (250) < total runtime (~1.2s), but each chunk (~120ms) resets the stall timer
  const r = await runInvocation(inv('slow-stream'), { stallMs: 250, timeoutMs: 5000 });
  assert.equal(r.status, 'ok');
  assert.equal(r.result, '- slow but alive');
});

test('ok result carries lastActivityMs', async () => {
  const r = await runInvocation(inv('ok'), { stallMs: 5000, timeoutMs: 8000 });
  assert.equal(r.status, 'ok');
  assert.ok(typeof r.lastActivityMs === 'number');
});
```

(`inv(mode)` is the existing helper returning `{engine, cmd: process.execPath, args:[FAKE, mode]}`.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/storm && node --test tests/run-engine.test.mjs`
Expected: FAIL — `stalled`/`auth_required` statuses not produced yet; slow-stream may be killed or lastActivityMs undefined.

- [ ] **Step 4: Rewrite `runInvocation`**

Replace the `runInvocation` function in `scripts/lib/run-engine.mjs` with:

```js
import { spawn } from 'node:child_process';
import { buildInvocation } from './adapters.mjs';
import { extractResult, salvageTail } from './result-parser.mjs';
import { detectAuthPrompt } from './auth-detect.mjs';

const MIN_SALVAGE_LENGTH = 40;
const AUTH_SCAN_TAIL = 1000; // scan only the recent tail for auth prompts (cheap, catches splits)

export function runInvocation({ engine, cmd, args, input }, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 300000; // far backstop, not the primary trigger
  const stallMs = opts.stallMs ?? 90000;      // inactivity (primary trigger)
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let lastActivity = Date.now();
    let backstopTimer;
    let stallTimer;
    const clearTimers = () => { clearTimeout(backstopTimer); clearTimeout(stallTimer); };
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ ...res, lastActivityMs: Date.now() - lastActivity });
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ engine, status: 'error', error: e.message });
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ engine, status: 'stalled', error: `no output for ${stallMs}ms` });
      }, stallMs);
    };
    backstopTimer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ engine, status: 'timeout', error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    armStall();

    const onActivity = () => {
      lastActivity = Date.now();
      armStall(); // reset inactivity timer on any output
      const tail = (stdout.slice(-AUTH_SCAN_TAIL)) + '\n' + (stderr.slice(-AUTH_SCAN_TAIL));
      if (detectAuthPrompt(tail)) {
        child.kill('SIGKILL');
        finish({ engine, status: 'auth_required', error: 'authentication prompt detected' });
      }
    };
    child.stdout.on('data', (d) => { stdout += d; onActivity(); });
    child.stderr.on('data', (d) => { stderr += d; onActivity(); });
    child.on('error', (e) => finish({ engine, status: 'error', error: e.message }));
    child.on('close', () => {
      const parsed = extractResult(stdout);
      if (parsed.ok) {
        finish({ engine, status: 'ok', result: parsed.result });
      } else {
        if (parsed.reason === 'no_marker') {
          const salvaged = salvageTail(stdout);
          if (salvaged.length >= MIN_SALVAGE_LENGTH) {
            finish({ engine, status: 'salvaged', result: salvaged, error: 'no_marker (salvaged)' });
            return;
          }
        }
        const tail = stderr.trim().slice(0, 500);
        finish({ engine, status: 'no_result', error: tail ? `${parsed.reason}: ${tail}` : parsed.reason });
      }
    });

    if (input != null) {
      child.stdin.on('error', (e) => {
        if (e.code !== 'EPIPE') {
          finish({ engine, status: 'error', error: `stdin write error: ${e.message}` });
        }
      });
      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch (e) {
        // synchronous write error: let close() settle
      }
    } else {
      child.stdin.end();
    }
  });
}
```

(Keep the existing `runEngine` wrapper below unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/storm && node --test tests/run-engine.test.mjs`
Expected: PASS — including the new stalled/auth_required/slow-stream/lastActivityMs tests, AND all prior run-engine tests (ok/no_result/salvaged/timeout/EPIPE/stdin/sync-throw) still green.

- [ ] **Step 6: Update config.json**

Edit `scripts/config.json` — set `timeoutMs` to the backstop and add `stallMs`:

```json
{
  "role": "reviewer",
  "timeoutMs": 300000,
  "stallMs": 90000,
  "engines": [
    { "id": "claude", "model": null },
    { "id": "codex" },
    { "id": "antigravity", "model": "Gemini 3.1 Pro (High)", "printTimeout": "280s" }
  ]
}
```

Then thread `stallMs` through fan-out: in `scripts/lib/fan-out.mjs`, the runner call passes `{ timeoutMs: opts.timeoutMs }` — add `stallMs: opts.stallMs`:

```js
return runner(e.id, prompt, e, { timeoutMs: opts.timeoutMs, stallMs: opts.stallMs });
```

And in `scripts/storm-companion.mjs`, pass `stallMs: cfg.stallMs` into the `runAll` opts alongside `timeoutMs`.

- [ ] **Step 7: Update docs (statuses)**

In `commands/storm.md`, in the synthesis instructions where statuses are described, add `stalled` and `auth_required` to the list of non-ok statuses to note (e.g. "status != ok (stalled / auth_required / timeout / no_result / error) -> note '<engine> did not answer (<status>)'"). In `skills/storm-runtime/SKILL.md`, add `stalled`/`auth_required` to the degraded-statuses line.

- [ ] **Step 8: Run full suite**

Run: `cd ~/storm && npm test`
Expected: all green (prior 45 + new auth-detect + new run-engine tests).

- [ ] **Step 9: Commit**

```bash
cd ~/storm && git add scripts/lib/run-engine.mjs scripts/lib/fan-out.mjs scripts/storm-companion.mjs scripts/config.json tests/run-engine.test.mjs tests/fixtures/fake-engine.mjs commands/storm.md skills/storm-runtime/SKILL.md
git commit -m "feat: inactivity-detect + auth-scan + diagnostics in run-engine (monitoring)"
```

---

## Self-Review

**Spec coverage:**
- Inactivity-detect (rolling stall-timer, stallMs) → Task M2 Step 4 (`armStall`). OK.
- Total-timeout backstop → Task M2 Step 4 (`backstopTimer`) + config Step 6. OK.
- Auth-detect by content (narrow, no false-positives) → Task M1 + M2 `onActivity` scan. OK.
- Diagnostics (lastActivityMs + status) → Task M2 `finish` wraps lastActivityMs; new statuses. OK.
- New statuses stalled/auth_required + orchestrator contract → Task M2 Step 7 docs. OK.
- Invariants preserved (settled-guard, timers cleared, setEncoding, stdin/EPIPE, salvage, no-exit-code) → all present in Step 4 rewrite. OK.
- Rare-case / no over-engineering (no stream-json, no live-UI, no per-engine) → not in plan. OK.

**Placeholder scan:** none — full code in every step.

**Type consistency:** `detectAuthPrompt(text)->bool` used in M2; result objects all carry `status` + `lastActivityMs`; `armStall`/`clearTimers`/`finish` consistent. `inv(mode)` matches existing helper. Statuses match spec set.

## Notes for the implementer

- run-engine is the highest-risk file (multiple timers + spawn + stdin + settled-guard). The single `finish` choke-point with `clearTimers()` is what keeps stall/backstop/auth/close/error/stdin paths from double-resolving — do not add resolve paths outside `finish`.
- The auth-scan runs on every chunk over a bounded tail (cheap). If it ever feels too eager in real use, tighten patterns in `auth-detect.mjs` — never broaden the test assertions.
- Fixture `silent-hang`/`auth-prompt` use `setInterval` to stay alive; the test's small `stallMs`/`timeoutMs` overrides guarantee they are killed quickly and deterministically.
