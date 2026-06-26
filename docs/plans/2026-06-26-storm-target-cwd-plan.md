# Storm target-cwd Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Storm aim the council at a target repository (not just the session's cwd) by passing `--cwd`, threaded into a single point (`spawn`'s `cwd`) that cascades to all four engines and the Gemini sandbox, with fail-fast path validation and a `repoPath` echo.

**Architecture:** One real lever — set `cwd` on `spawn` in `run-engine.mjs`. CLI-engines (claude/codex/glm) take their working dir from the child process cwd; the Gemini runner builds its sandbox from `process.cwd()`; all inherit the spawned `cwd`. A small `cli-args` parser extracts/validates `--cwd` (absent => `process.cwd()`; bad path => throw). The companion echoes the resolved path as `repoPath`.

**Tech Stack:** Plain Node ESM, zero runtime dependencies, `node --test`.

## Global Constraints

- Node.js 20+; **zero runtime dependencies** (built-ins only).
- TDD: red → green → commit, one behavior per test.
- Default behavior (no `--cwd`) must be **byte-for-byte identical to 0.7.0** — `spawn` with `cwd: undefined` inherits the parent working dir.
- **Fail-fast, never silent fallback:** a `--cwd` that doesn't resolve to an existing directory throws / exits non-zero. It must NOT fall back to `process.cwd()` (that reintroduces the silent wrong-repo bug).
- Engines stay read-only: this changes only *which* dir they read, never their permissions.
- Specs/plans/decisions in Russian (repo convention); code comments in English; conventional-commit messages, no emoji.

---

### Task 1: `cwd` reaches `spawn` (the core lever)

**Files:**
- Modify: `tests/fixtures/fake-engine.mjs` (add a `cwd` mode)
- Test: `tests/run-engine.test.mjs` (2 new tests)
- Modify: `scripts/lib/run-engine.mjs:44-47` (spawn options)

**Interfaces:**
- Consumes: `runInvocation(invocation, opts)` where `opts` already carries `timeoutMs/stallMs/authGraceMs`.
- Produces: `opts.cwd` (string | undefined) — the working directory passed to `spawn`. `undefined` => inherit.

- [ ] **Step 1: Add a `cwd` mode to the fake engine**

In `tests/fixtures/fake-engine.mjs`, after the `echo-env` block (around line 82), add:

```js
// cwd: print our own working directory inside the markers, so a test can assert
// run-engine passed `cwd` to spawn (the child inherits it). process.cwd() is the realpath.
else if (mode === 'cwd') {
  process.stdout.write(`<STORM_RESULT>\n${process.cwd()}\n</STORM_RESULT>\n`);
  process.exit(0);
}
```

- [ ] **Step 2: Write the failing tests**

In `tests/run-engine.test.mjs`, add imports at the top (after the existing imports):

```js
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

Then add:

```js
test('cwd opt is passed to spawn: child process.cwd() == the given dir', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'storm-cwd-')));
  const r = await runInvocation(
    { engine: 'fake', cmd: process.execPath, args: [FAKE, 'cwd'] },
    { cwd: dir, timeoutMs: 5000 },
  );
  assert.equal(r.status, 'ok', `expected ok, got ${r.status}: ${r.error}`);
  assert.equal(r.result, dir);
});

test('no cwd opt -> child inherits the parent working directory (regression)', async () => {
  const r = await runInvocation(
    { engine: 'fake', cmd: process.execPath, args: [FAKE, 'cwd'] },
    { timeoutMs: 5000 },
  );
  assert.equal(r.status, 'ok', `expected ok, got ${r.status}: ${r.error}`);
  assert.equal(r.result, realpathSync(process.cwd()));
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/run-engine.test.mjs`
Expected: the first new test FAILS — `r.result` is the parent's cwd (run-engine ignores `opts.cwd`), not the temp dir. The regression test passes already.

- [ ] **Step 4: Pass `cwd` into spawn**

In `scripts/lib/run-engine.mjs`, change the `spawn` options (lines 44-47) to:

```js
      child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: opts.cwd, // undefined => Node inherits the parent working directory (default)
        env: env ? { ...process.env, ...env } : process.env,
      });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/run-engine.test.mjs`
Expected: PASS (all, including the two new tests).

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/fake-engine.mjs tests/run-engine.test.mjs scripts/lib/run-engine.mjs
git commit -m "feat(run-engine): pass opts.cwd to spawn (engines read the target dir)"
```

---

### Task 2: `cli-args` — parse and validate `--cwd`

**Files:**
- Create: `scripts/lib/cli-args.mjs`
- Test: `tests/cli-args.test.mjs`

**Interfaces:**
- Produces: `parseStormArgs(argv: string[], deps?: { statSync?, cwd?: () => string }) -> { mode, task, cwd }`. `cwd` is an absolute, validated existing directory; absent `--cwd` => `deps.cwd()` (default `process.cwd()`). Throws on a missing value, a non-existent path, or a non-directory.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli-args.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/cli-args.test.mjs`
Expected: FAIL — `cli-args.mjs` does not exist (import error).

- [ ] **Step 3: Implement the parser**

Create `scripts/lib/cli-args.mjs`:

```js
// scripts/lib/cli-args.mjs
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

// Parse the companion's argv tail into { mode, task, cwd }.
// --cwd <path> is optional and position-independent; the remaining positionals
// are [mode, task]. cwd is resolved to an absolute path and validated as an
// existing directory. Fail-fast: a missing value / bad path throws rather than
// silently falling back to process.cwd() (which would audit the wrong repo).
// Absent --cwd => cwd = deps.cwd() (default process.cwd()).
export function parseStormArgs(argv, deps = {}) {
  const stat = deps.statSync ?? statSync;
  const getCwd = deps.cwd ?? (() => process.cwd());
  const positionals = [];
  let cwdRaw = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') {
      cwdRaw = argv[i + 1];
      if (cwdRaw == null) throw new Error('--cwd requires a path');
      i++; // consume the value
      continue;
    }
    positionals.push(argv[i]);
  }
  const [mode, task] = positionals;
  let cwd;
  if (cwdRaw == null) {
    cwd = getCwd();
  } else {
    cwd = resolve(cwdRaw);
    let st;
    try { st = stat(cwd); } catch { throw new Error(`--cwd: path does not exist: ${cwd}`); }
    if (!st.isDirectory()) throw new Error(`--cwd: not a directory: ${cwd}`);
  }
  return { mode, task, cwd };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/cli-args.test.mjs`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/cli-args.mjs tests/cli-args.test.mjs
git commit -m "feat(cli-args): parse + fail-fast validate --cwd for the companion"
```

---

### Task 3: thread `cwd` through fan-out and the companion (+ echo `repoPath`)

**Files:**
- Test: `tests/fan-out.test.mjs` (1 new test)
- Modify: `scripts/lib/fan-out.mjs:8,12`
- Test: `tests/companion.test.mjs` (1 new test)
- Modify: `scripts/storm-companion.mjs`

**Interfaces:**
- Consumes: `parseStormArgs` (Task 2); `opts.cwd` on `runInvocation` (Task 1).
- Produces: `runAll(task, engines, { cwd, ... })` builds the prompt's `Repository:` line from `cwd` and threads `cwd` into every `runner(...)` call. Companion output JSON gains a top-level `repoPath` field.

- [ ] **Step 1: Write the failing fan-out test**

In `tests/fan-out.test.mjs`, add:

```js
test('cwd from opts is threaded into each runner call and into the prompt', async () => {
  const seen = [];
  const runner = (id, _prompt, _cfg, opts) => {
    seen.push(opts.cwd);
    return Promise.resolve({ engine: id, status: 'ok', result: 'r' });
  };
  await runAll('task', [{ id: 'claude' }, { id: 'codex' }], { runner, cwd: '/target/repo' });
  assert.deepEqual(seen, ['/target/repo', '/target/repo']);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/fan-out.test.mjs`
Expected: FAIL — `opts.cwd` is `undefined` in the runner (fan-out doesn't forward it yet).

- [ ] **Step 3: Forward `cwd` in fan-out**

In `scripts/lib/fan-out.mjs`, change line 8 and the runner call (line 12):

```js
  const prompt = buildStormPrompt({ task, role, repoPath: opts.cwd });
```

```js
        return runner(e.id, prompt, e, { timeoutMs: opts.timeoutMs, stallMs: opts.stallMs, cwd: opts.cwd });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/fan-out.test.mjs`
Expected: PASS (all, including the existing concurrency/failure tests).

- [ ] **Step 5: Write the failing companion test**

In `tests/companion.test.mjs`, add:

```js
test('--cwd nonexistent -> exit 2 (fail-fast, never a silent run)', () => {
  const r = spawnSync(process.execPath, [ENTRY, 'plan', 'task', '--cwd', '/no/such/dir/xyz'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not exist|cwd/i);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test tests/companion.test.mjs`
Expected: FAIL — the current companion doesn't parse `--cwd`; it treats `/no/such/dir/xyz` as a stray arg, never validates, and tries to run the council (no exit 2).

- [ ] **Step 7: Wire the companion to `parseStormArgs` + echo `repoPath`**

Replace the body of `scripts/storm-companion.mjs` with:

```js
#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runAll } from './lib/fan-out.mjs';
import { loadSecrets, injectSecrets } from './lib/secrets.mjs';
import { parseStormArgs } from './lib/cli-args.mjs';

async function main() {
  let mode, task, cwd;
  try {
    ({ mode, task, cwd } = parseStormArgs(process.argv.slice(2)));
  } catch (e) {
    // Bad --cwd / missing value: fail fast, never a silent wrong-repo run.
    process.stderr.write(`storm-companion: ${e.message}\n`);
    process.exit(2);
  }
  if (mode !== 'plan' || !task) {
    process.stderr.write('usage: storm-companion plan "<task>" [--cwd <abs-path>]\n');
    process.exit(2);
  }
  const cfg = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  // Inject local secrets (z.ai/GLM + OpenRouter keys) into the matching engine; absent file => unchanged.
  const engines = injectSecrets(cfg.engines, loadSecrets());
  const results = await runAll(task, engines, {
    role: cfg.role,
    cwd, // resolved + validated; cascades to spawn cwd -> all engines + Gemini sandbox
    timeoutMs: cfg.timeoutMs,
    stallMs: cfg.stallMs,
  });
  // repoPath echoes the dir the council actually read -> wrong-repo mismatch is visible.
  process.stdout.write(JSON.stringify({ mode, task, repoPath: cwd, results }, null, 2) + '\n');
}

main().catch((e) => {
  process.stderr.write(`storm-companion error: ${e?.message ?? e}\n`);
  process.exit(1);
});
```

- [ ] **Step 8: Run companion + fan-out tests to verify they pass**

Run: `node --test tests/companion.test.mjs tests/fan-out.test.mjs`
Expected: PASS — including the existing `missing args -> exit 2` and `wrong mode -> exit 2` (parseStormArgs leaves `mode`/`task` undefined/`'action'`, the `mode !== 'plan'` guard still exits 2).

- [ ] **Step 9: Run the full suite**

Run: `node --test`
Expected: PASS (all 100+ tests; no regressions).

- [ ] **Step 10: Commit**

```bash
git add scripts/lib/fan-out.mjs scripts/storm-companion.mjs tests/fan-out.test.mjs tests/companion.test.mjs
git commit -m "feat(companion): accept --cwd, thread it to the council, echo repoPath"
```

---

### Task 4: orchestrator contract, README, live verify

**Files:**
- Modify: `commands/storm.md`
- Modify: `skills/storm-runtime/SKILL.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the `--cwd` flag (Task 2/3) and the `repoPath` output field (Task 3).
- Produces: documentation only — no code, no tests.

- [ ] **Step 1: Update the orchestrator command**

In `commands/storm.md`, change the usage line and step 1 so the orchestrator targets a non-session repo explicitly. Replace lines 6 and the step-1 block with:

```markdown
Usage: `/storm plan <task>` — the council reads the session's working directory by
default; for a task about a *different* local repo, target it explicitly.

You are the Storm orchestrator. On this command:

1. Run the council. By default it reads the current working directory. If the task
   is explicitly about another local repository, resolve that repo's ABSOLUTE path
   and pass it with `--cwd` so all engines (and the Gemini sandbox) read the right code:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/storm-companion.mjs" plan "<task>" [--cwd <abs-repo-path>]
   ```
```

And update step 2's JSON shape line to:

```markdown
2. You receive JSON: `{ mode, task, repoPath, results: [{ engine, status, result|error }] }`.
   `repoPath` is the directory the council actually read — surface it
   ("Council read from: `<repoPath>`") so a wrong-repo mismatch is visible. This is
   ALREADY normalized — you never see raw engine stdout (context-protection invariant).
```

- [ ] **Step 2: Update the runtime skill**

In `skills/storm-runtime/SKILL.md`, replace the helper line and bullets with:

```markdown
Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/storm-companion.mjs" plan "<task>" [--cwd <abs-path>]`

- Returns normalized JSON `{ mode, task, repoPath, results: [{engine,status,result|error}] }`.
- `--cwd <abs-path>`: directory the engines read (default: the companion's cwd). For a
  task about a different local repo, pass its absolute path. A bad path => exit 2
  (fail-fast — never a silent wrong-repo run).
- `repoPath` echoes the directory actually read.
- Never exposes raw engine stdout — only the extracted STORM_RESULT block.
- Parse output, not exit codes.
- Engines with status `stalled`/`auth_required`/`timeout`/`error`/`no_result` are degraded,
  not fatal: synthesize from the engines that answered.
```

- [ ] **Step 3: Document `--cwd` in the README**

In `README.md`, in the `## Usage` section after the examples block (around line 83), add:

```markdown
By default the council reads the directory you run it from. To audit a *different*
repo without leaving your session, target it by absolute path:

```
/storm plan review the auth flow in my other project --cwd /abs/path/to/other-repo
```

The orchestrator passes `--cwd` to the companion; every engine (and the Gemini
sandbox) then reads that repo. A non-existent path fails fast — it never silently
falls back to the current directory.
```

- [ ] **Step 4: Live verify the cascade**

Run a real cross-repo audit (engines must read the *target*, not the session cwd):

```bash
node /Users/maxim/storm/scripts/storm-companion.mjs plan "Name this repo's top-level modules and its main entry point. Read the actual files, don't guess." --cwd /Users/maxim/session-recall
```

Expected:
- Output JSON has `"repoPath": "/Users/maxim/session-recall"`.
- At least the `gemini` engine (agentic, sandboxed to cwd) returns findings that cite **real session-recall files** (e.g. its actual modules / entry point), proving the sandbox root followed `--cwd`. If engines describe an unrelated repo, the cascade is broken.

- [ ] **Step 5: Commit the docs**

```bash
git add commands/storm.md skills/storm-runtime/SKILL.md README.md
git commit -m "docs: --cwd targeting + repoPath echo (orchestrator contract + README)"
```

- [ ] **Step 6 (gated — do NOT do unprompted): version bump + push**

A `feat`, so a minor bump (0.7.0 → 0.8.0) in `package.json` + `.claude-plugin/plugin.json`. **Hold** the bump, the security scan (public repo — verify `.storm-secrets.json` stays gitignored and untracked, no keys in the diff), and `git push` until Maxim explicitly approves the release. Write a decision-doc (`docs/decisions/2026-06-26-target-cwd.md`) capturing *why* fail-fast over silent fallback at that point.

---

## Self-Review

**Spec coverage:**
- "accept `--cwd`" → Task 2 (parser) + Task 3 (companion wiring). ✓
- "one point — spawn cwd — cascades" → Task 1 (spawn) + Task 3 (fan-out forwards). ✓
- "Gemini sandbox follows via inheritance" → no code (openrouter-runner uses `process.cwd()`), verified live in Task 4 Step 4. ✓
- "fail-fast, not silent fallback" → Task 2 (throws) + Task 3 (companion exit 2). ✓
- "echo repoPath" → Task 3 Step 7. ✓
- "orchestrator contract in storm.md/SKILL.md" → Task 4 Steps 1-2. ✓
- "README note" → Task 4 Step 3. ✓
- "default byte-for-byte identical" → Task 1 regression test (no cwd -> inherit). ✓
- "security: sandbox still relative to cwd, no new perms" → no code path widens access; only the root moves. Noted in spec; nothing to implement.

**Placeholder scan:** no TBD/TODO; every code step shows full code; commands have expected output. ✓

**Type consistency:** `parseStormArgs(argv, deps) -> { mode, task, cwd }` used identically in Task 2 (def), Task 3 Step 7 (companion). `opts.cwd` consumed in Task 1 (spawn) and produced in Task 3 (fan-out runner call). `repoPath` output field defined once (Task 3) and documented (Task 4). ✓

**Note:** Task 4 Step 6 (bump/push) is intentionally gated on explicit approval — not auto-run.
