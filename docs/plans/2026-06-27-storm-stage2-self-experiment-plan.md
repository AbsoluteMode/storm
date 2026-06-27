# Stage 2: self-experimenting engines in worktrees — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each CLI engine (codex/claude/glm) gets its own git worktree as working root with full rights (write/exec/network + test key), self-experiments iteratively, and attaches a proof-artifact; the orchestrator re-verifies claimed `proven` by re-running locally-reproducible experiments in a fresh worktree.

**Architecture:** A new `workspace.mjs` builds a per-engine git worktree (HEAD + transferred uncommitted + symlinked node_modules; cp-fallback for non-git). `fan-out.mjs` creates one workspace per engine, spawns it there with full-rights flags, and cleans up in `finally`. The new prompt contract tells engines to self-reproduce and attach `[FINDING] run/expects/observed`. `proof.mjs` is rewritten: it parses `[FINDING]`, and for locally-reproducible findings re-runs the experiment in a fresh clean worktree and sets `proven`/`disproven` itself (verify-don't-trust); networked/non-deterministic findings are accepted as engine-claimed.

**Tech Stack:** Node.js (built-ins only — `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:test`), zero runtime deps. macOS host (codex Seatbelt, `sandbox-exec` not used). git worktrees.

## Global Constraints

- **Zero runtime dependencies** — Node built-ins only. Tests use `node:test`.
- **No emoji** anywhere (code, commits, docs).
- **Conventional commits**, each ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Backward-compat gate:** `config.proof.enabled === false` ⇒ behavior byte-identical to 0.8.0 (no worktree, no rights-flags, no verify pass). Default stays `true`.
- **Secrets never committed** — keys live in gitignored `.storm-secrets.json`; never logged.
- **verify-don't-trust:** `proven` is set ONLY by the orchestrator on its own captured artifact; an engine-claimed proof is never trusted blindly. A timed-out experiment can NEVER be `proven`.
- **First pass scope:** codex/claude/glm only. gemini self-exec is explicitly out (it stays a read-only reviewer; its findings are `unproven`).
- **Empirically confirmed (spike 2026-06-27):** `git worktree add --detach <wt> HEAD` + `git diff --binary HEAD | git -C <wt> apply` (tracked) + copy `git ls-files --others --exclude-standard` (untracked) + `ln -s <repo>/node_modules <wt>/node_modules` reproduces the working tree exactly; `git worktree remove --force <wt>` cleans up.

---

### Task 1: `workspace.mjs` — per-engine git worktree

**Files:**
- Create: `scripts/lib/workspace.mjs`
- Test: `tests/workspace.test.mjs`

**Interfaces:**
- Produces: `makeEngineWorkspace(repoPath, label, deps?) → { dir: string, kind: 'worktree' | 'copy', cleanup: () => void }`.
  - `dir` — absolute path to the engine's working root.
  - `kind` — `'worktree'` for git repos, `'copy'` for the cp-fallback.
  - `cleanup` — idempotent; removes the worktree (`git worktree remove --force`) or the cp dir (`fs.rmSync`). Safe to call twice; never throws.
  - `deps` — optional injection seam for tests: `{ run?: (cmd, args, opts) => {stdout}, tmpRoot?: string }`. Default uses real `execFileSync` and `os.tmpdir()`.
- Consumes: `makeThrowawayCopy` from `sandbox.mjs` for the non-git fallback.

Helper used internally (not exported): `isGitRepo(repoPath)` via `git -C <repoPath> rev-parse --is-inside-work-tree`.

- [ ] **Step 1: Write the failing test (git worktree path reproduces working tree)**

```javascript
// tests/workspace.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEngineWorkspace } from '../scripts/lib/workspace.mjs';

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'storm-wt-test-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(dir, 'tracked.txt'), 'line1\nline2\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const x = 1\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  return { dir, git };
}

test('worktree reproduces committed + uncommitted + untracked', () => {
  const { dir } = initRepo();
  // uncommitted: modify tracked, add untracked
  writeFileSync(join(dir, 'tracked.txt'), 'line1\nMODIFIED\nline2\n');
  writeFileSync(join(dir, 'untracked.txt'), 'new\n');
  const ws = makeEngineWorkspace(dir, 'codex');
  try {
    assert.equal(ws.kind, 'worktree');
    assert.equal(readFileSync(join(ws.dir, 'tracked.txt'), 'utf8'), 'line1\nMODIFIED\nline2\n');
    assert.equal(readFileSync(join(ws.dir, 'untracked.txt'), 'utf8'), 'new\n');
    assert.equal(readFileSync(join(ws.dir, 'src', 'a.mjs'), 'utf8'), 'export const x = 1\n');
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/workspace.test.mjs`
Expected: FAIL — `makeEngineWorkspace` not exported / module missing.

- [ ] **Step 3: Implement `workspace.mjs`**

```javascript
// scripts/lib/workspace.mjs
// Per-engine isolated working root. git repo -> git worktree (HEAD + transferred
// uncommitted + symlinked node_modules); non-git -> cp-fallback. cleanup is
// idempotent and never throws. WHY: docs/decisions/2026-06-27-stage2-self-experiment.md
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, symlinkSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { makeThrowawayCopy } from './sandbox.mjs';

function git(repo, args, run) {
  return run('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

export function makeEngineWorkspace(repoPath, label, deps = {}) {
  const run = deps.run ?? ((cmd, args, opts) => ({ stdout: execFileSync(cmd, args, opts) }));
  const tmpRoot = deps.tmpRoot ?? tmpdir();
  // Detect git repo; on any failure, fall back to a plain copy.
  let isGit = false;
  try { isGit = String(git(repoPath, ['rev-parse', '--is-inside-work-tree'], run).stdout).trim() === 'true'; }
  catch { isGit = false; }
  if (!isGit) {
    const { dir, cleanup } = makeThrowawayCopy(repoPath);
    return { dir, kind: 'copy', cleanup: once(cleanup) };
  }
  const dir = mkdtempSync(join(tmpRoot, `storm-ws-${label}-`));
  // worktree add reuses `dir` (mkdtemp made it); --detach avoids a named branch.
  git(repoPath, ['worktree', 'add', '--detach', '--force', dir, 'HEAD'], run);
  // Transfer tracked uncommitted changes (binary-safe), if any.
  const diff = String(git(repoPath, ['diff', '--binary', 'HEAD'], run).stdout);
  if (diff.trim()) {
    // Pipe the diff into `git apply` inside the worktree.
    run('git', ['-C', dir, 'apply'], { input: diff });
  }
  // Transfer untracked (excluded by gitignore) files.
  const untracked = String(git(repoPath, ['ls-files', '--others', '--exclude-standard'], run).stdout)
    .split('\n').map((s) => s.trim()).filter(Boolean);
  for (const rel of untracked) {
    const src = join(repoPath, rel);
    const dst = join(dir, rel);
    try { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); } catch { /* skip unreadable */ }
  }
  // Symlink node_modules so dependency-needing experiments work without reinstall.
  const nm = join(repoPath, 'node_modules');
  if (existsSync(nm)) { try { symlinkSync(nm, join(dir, 'node_modules')); } catch { /* exists/unsupported */ } }
  const cleanup = once(() => {
    try { git(repoPath, ['worktree', 'remove', '--force', dir], run); } catch { /* already gone */ }
    try { git(repoPath, ['worktree', 'prune'], run); } catch { /* best effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  });
  return { dir, kind: 'worktree', cleanup };
}

function once(fn) { let done = false; return () => { if (done) return; done = true; fn(); }; }
```

Note: `run` returns `{ stdout }`; the default wrapper adapts `execFileSync` (which returns the buffer directly). The `input` option flows through to `execFileSync` for the `git apply` pipe.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/workspace.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add fallback + cleanup tests**

```javascript
test('cleanup removes the worktree and is idempotent', () => {
  const { dir } = initRepo();
  const ws = makeEngineWorkspace(dir, 'claude');
  assert.ok(existsSync(ws.dir));
  ws.cleanup();
  assert.equal(existsSync(ws.dir), false);
  ws.cleanup(); // second call must not throw
  rmSync(dir, { recursive: true, force: true });
});

test('non-git path falls back to a cp copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'storm-plain-'));
  writeFileSync(join(dir, 'f.txt'), 'hello\n');
  const ws = makeEngineWorkspace(dir, 'glm');
  try {
    assert.equal(ws.kind, 'copy');
    assert.equal(readFileSync(join(ws.dir, 'f.txt'), 'utf8'), 'hello\n');
  } finally { ws.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 6: Run all workspace tests, then commit**

Run: `node --test tests/workspace.test.mjs` → PASS (3 tests).

```bash
git add scripts/lib/workspace.mjs tests/workspace.test.mjs
git commit -m "feat(workspace): per-engine git worktree with uncommitted transfer + cp fallback"
```

---

### Task 2: `prompt.mjs` — self-experiment contract

**Files:**
- Modify: `scripts/lib/prompt.mjs`
- Test: `tests/prompt.test.mjs` (extend existing)

**Interfaces:**
- `buildStormPrompt({ task, role, repoPath, proof })` — unchanged signature. When `proof` is truthy, the prompt includes the NEW self-experiment contract (below) instead of the Stage-1 `[NEEDS-EXPERIMENT]` contract. When falsy, output is byte-identical to 0.8.0.

The self-experiment contract block (exact copy to embed):

```
PROOF MODE — self-experiment in your isolated copy:
- Your working directory (`.`) is a throwaway copy of the repo. Do anything:
  write files, run commands, install deps, use the network.
- For each finding, REPRODUCE it yourself with a minimal experiment in this
  copy. Do not describe hypothetically — run it.
- Attach to each finding, exactly:
  [FINDING] <one-line title>
  run: <exact command you ran>
  expects: <checkable prediction: exit!=0 | exit==N | stdout contains "X" | stderr contains "X"; join clauses with AND>
  observed: <what actually happened>
- Mark a finding proven ONLY if you actually reproduced it. If you cannot
  reproduce it (no tool / non-deterministic), use:
  [UNPROVEN-CANNOT] <title> — why: <reason>
- The orchestrator will re-run your `run`/`expects` in a clean copy. Fabricated
  results will be caught.
```

- [ ] **Step 1: Write failing tests**

```javascript
// add to tests/prompt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStormPrompt } from '../scripts/lib/prompt.mjs';

test('proof on => self-experiment contract present', () => {
  const p = buildStormPrompt({ task: 'audit', role: 'reviewer', repoPath: '/x', proof: true });
  assert.match(p, /PROOF MODE — self-experiment/);
  assert.match(p, /\[FINDING\]/);
  assert.match(p, /The orchestrator will re-run/);
});

test('proof off => no proof contract (0.8.0 behavior)', () => {
  const p = buildStormPrompt({ task: 'audit', role: 'reviewer', repoPath: '/x', proof: false });
  assert.doesNotMatch(p, /PROOF MODE/);
  assert.doesNotMatch(p, /\[FINDING\]/);
});
```

- [ ] **Step 2: Run to verify FAIL** — `node --test tests/prompt.test.mjs` → FAIL (no PROOF MODE text).

- [ ] **Step 3: Implement** — in `prompt.mjs`, replace the Stage-1 PROOF_CONTRACT constant with the `SELF_EXPERIMENT_CONTRACT` text above; keep the `proof ? contract : ''` wiring and the byte-identical DEFAULT path. Verify the existing 0.8.0 prompt test still asserts the default body.

- [ ] **Step 4: Run to verify PASS** — `node --test tests/prompt.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/prompt.mjs tests/prompt.test.mjs
git commit -m "feat(prompt): self-experiment contract in proof mode (replaces NEEDS-EXPERIMENT)"
```

---

### Task 3: `adapters.mjs` — full-rights flags in proof mode

**Files:**
- Modify: `scripts/lib/adapters.mjs`
- Test: `tests/adapters.test.mjs` (extend existing)

**Interfaces:**
- `buildInvocation(engineId, prompt, cfg)` — unchanged signature. When `cfg.proof` is truthy, CLI engines gain full-rights flags:
  - codex: args become `['exec', '-s', 'danger-full-access']` (was `['exec']`). Removes Seatbelt → write + network. (cwd=worktree is set by spawn; `-C` not needed.)
  - claude/glm: prepend `'--permission-mode', 'bypassPermissions'` after `-p`.
  - gemini: unchanged (read-only tools; no exec).
- When `cfg.proof` falsy → byte-identical to 0.8.0.

Rationale for flag choice (spec spike #1): codex `-s danger-full-access` and claude `--permission-mode bypassPermissions` both exist (confirmed via `--help`); they grant the same trust level the calling agent already has. Final confirmation on the live run (Task 7).

- [ ] **Step 1: Write failing tests**

```javascript
test('codex proof mode => danger-full-access', () => {
  const inv = buildInvocation('codex', 'p', { proof: true });
  assert.deepEqual(inv.args, ['exec', '-s', 'danger-full-access']);
});
test('codex no proof => plain exec (0.8.0)', () => {
  const inv = buildInvocation('codex', 'p', {});
  assert.deepEqual(inv.args, ['exec']);
});
test('claude proof mode => bypassPermissions', () => {
  const inv = buildInvocation('claude', 'p', { proof: true });
  assert.ok(inv.args.includes('--permission-mode'));
  assert.ok(inv.args.includes('bypassPermissions'));
});
test('claude no proof => no permission-mode (0.8.0)', () => {
  const inv = buildInvocation('claude', 'p', {});
  assert.ok(!inv.args.includes('--permission-mode'));
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** — in each CLI adapter's `buildArgs`, branch on `cfg.proof`:

```javascript
// codex
buildArgs: (_p, cfg) => cfg.proof ? ['exec', '-s', 'danger-full-access'] : ['exec'],
// claude
buildArgs: (_p, cfg) => ['-p',
  ...(cfg.proof ? ['--permission-mode', 'bypassPermissions'] : []),
  ...(cfg.model ? ['--model', cfg.model] : []), ...STREAM_FLAGS],
// glm — same pattern, after the fixed --model glm-… arg
buildArgs: (_p, cfg) => ['-p',
  ...(cfg.proof ? ['--permission-mode', 'bypassPermissions'] : []),
  '--model', cfg.model ?? 'glm-5.2', ...STREAM_FLAGS, ...(cfg.effort ? ['--effort', cfg.effort] : [])],
```

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/adapters.mjs tests/adapters.test.mjs
git commit -m "feat(adapters): full-rights flags for CLI engines in proof mode"
```

---

### Task 4: `secrets.mjs` — experiment env injection

**Files:**
- Modify: `scripts/lib/secrets.mjs`
- Test: `tests/secrets.test.mjs` (extend existing)

**Interfaces:**
- `injectSecrets(engines, secrets)` — unchanged signature. NEW: if `secrets.experimentEnv` is an object, attach it to EVERY engine as `e.experimentEnv` (shallow). Engines without it pass through. This carries the test key(s) to the spawn env (Task 6 wires it into the child environment when proof on).
- `.storm-secrets.json` shape gains: `"experimentEnv": { "OPENROUTER_API_KEY": "...", "OPENAI_API_KEY": "..." }` (optional).

- [ ] **Step 1: Write failing test**

```javascript
test('experimentEnv is attached to every engine', () => {
  const out = injectSecrets([{ id: 'codex' }, { id: 'glm' }],
    { glmApiKey: 'g', experimentEnv: { OPENAI_API_KEY: 'sk-test' } });
  assert.deepEqual(out[0].experimentEnv, { OPENAI_API_KEY: 'sk-test' });
  assert.deepEqual(out[1].experimentEnv, { OPENAI_API_KEY: 'sk-test' });
  assert.equal(out[1].apiKey, 'g'); // existing glm injection preserved
});
test('no experimentEnv => engines unchanged', () => {
  const out = injectSecrets([{ id: 'codex' }], {});
  assert.equal(out[0].experimentEnv, undefined);
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** — in `injectSecrets`, after the existing per-engine mapping, spread `experimentEnv` when present:

```javascript
export function injectSecrets(engines, secrets = {}) {
  const expEnv = secrets.experimentEnv && typeof secrets.experimentEnv === 'object' ? secrets.experimentEnv : null;
  return engines.map((e) => {
    let out = e;
    if (e.id === 'glm' && secrets.glmApiKey) out = { ...out, apiKey: secrets.glmApiKey };
    if (e.id === 'gemini' && secrets.openrouterApiKey) out = { ...out, apiKey: secrets.openrouterApiKey };
    if (expEnv) out = { ...out, experimentEnv: expEnv };
    return out;
  });
}
```

- [ ] **Step 4: Run to verify PASS.**

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/secrets.mjs tests/secrets.test.mjs
git commit -m "feat(secrets): carry experimentEnv test key to engine configs"
```

---

### Task 5: `proof.mjs` — `[FINDING]` parser + rewritten verify pass

**Files:**
- Modify: `scripts/lib/proof.mjs`
- Test: `tests/proof.test.mjs` (extend existing)

**Interfaces:**
- Consumes: `makeEngineWorkspace` (Task 1), existing `runExperiment`, `predictMatches`, `classifyCost`.
- `parseFindings(text)` — NEW tolerant parser for `[FINDING]` blocks: `{ tag: 'finding', title, run, expects, observed }`. Also still recognizes `[UNPROVEN-CANNOT]` → `{ tag: 'unproven-cannot', title, why }`. (Keep `parseProofFindings` for back-compat tests, or rename; new code calls `parseFindings`.)
- `annotateWithProof(results, { repoPath, timeoutMs, experimentEnv })` — REWRITTEN. For each `[FINDING]` with non-empty `run` + `expects`:
  - `classifyCost(run) === 'free'` (locally reproducible) → make a FRESH `makeEngineWorkspace(repoPath, 'verify')` (clean, no engine edits), `runExperiment(run, ws.dir, { timeoutMs, env })`, `predictMatches` → tag `proven` | `disproven`; record artifact. `env` = `{ ...experimentEnv }` merged via existing `experimentEnv()` base.
  - else (networked/non-deterministic) → tag `engine-claimed` (accept engine's `observed`, NOT re-run); push to `engine_claimed_experiments`.
  - timed-out re-run ⇒ never `proven` (existing guard).
  - `[UNPROVEN-CANNOT]` / finding without run|expects → `unproven`.
- Returns `{ results, verified_experiments, engine_claimed_experiments }`.

- [ ] **Step 1: Write failing tests (parser + verify)**

```javascript
test('parseFindings extracts [FINDING] run/expects/observed', () => {
  const f = parseFindings('[FINDING] crash on empty\nrun: node -e "process.exit(3)"\nexpects: exit==3\nobserved: exited 3');
  assert.equal(f[0].tag, 'finding');
  assert.equal(f[0].run, 'node -e "process.exit(3)"');
  assert.equal(f[0].expects, 'exit==3');
});

test('locally-reproducible finding is re-verified to proven', async () => {
  const results = [{ engine: 'codex', status: 'ok',
    result: '[FINDING] exits 3\nrun: sh -c "exit 3"\nexpects: exit==3\nobserved: 3' }];
  const out = await annotateWithProof(results, { repoPath: process.cwd(), timeoutMs: 5000 });
  const f = out.results[0].findings[0];
  assert.equal(f.tag, 'proven');
  assert.equal(out.verified_experiments.length, 1);
});

test('engine fabrication (claims proven but does not reproduce) => disproven', async () => {
  const results = [{ engine: 'glm', status: 'ok',
    result: '[FINDING] fake\nrun: sh -c "exit 0"\nexpects: exit!=0\nobserved: fabricated' }];
  const out = await annotateWithProof(results, { repoPath: process.cwd(), timeoutMs: 5000 });
  assert.equal(out.results[0].findings[0].tag, 'disproven');
});

test('networked finding is engine-claimed, not re-run', async () => {
  const results = [{ engine: 'codex', status: 'ok',
    result: '[FINDING] api\nrun: curl https://api.openai.com/x\nexpects: stdout contains "gpt"\nobserved: saw gpt' }];
  const out = await annotateWithProof(results, { repoPath: process.cwd(), timeoutMs: 5000 });
  assert.equal(out.results[0].findings[0].tag, 'engine-claimed');
  assert.equal(out.engine_claimed_experiments.length, 1);
  assert.equal(out.verified_experiments.length, 0);
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** — add `parseFindings`; rewrite `annotateWithProof`:

```javascript
export function parseFindings(text) {
  const out = [];
  let cur = null;
  const push = () => { if (cur) { out.push(cur); cur = null; } };
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^\[FINDING\]\s*(.*)$/i))) { push(); cur = { tag: 'finding', title: m[1].trim() }; }
    else if ((m = line.match(/^\[UNPROVEN-CANNOT\]\s*(.*)$/i))) {
      push(); const rest = m[1].trim();
      const wm = rest.match(/^(.*?)\s*[—-]\s*why:\s*(.*)$/i);
      cur = wm ? { tag: 'unproven-cannot', title: wm[1].trim(), why: wm[2].trim() } : { tag: 'unproven-cannot', title: rest };
    }
    else if (cur && (m = line.match(/^run:\s*(.*)$/i))) cur.run = m[1].trim();
    else if (cur && (m = line.match(/^expects:\s*(.*)$/i))) cur.expects = m[1].trim();
    else if (cur && (m = line.match(/^observed:\s*(.*)$/i))) cur.observed = m[1].trim();
  }
  push();
  return out;
}

import { makeEngineWorkspace } from './workspace.mjs';

export async function annotateWithProof(results, { repoPath, timeoutMs = 30000, experimentEnv: extraEnv } = {}) {
  const verified_experiments = [];
  const engine_claimed_experiments = [];
  const out = [];
  for (const r of results) {
    if (r.status !== 'ok' && r.status !== 'salvaged') { out.push(r); continue; }
    const findings = [];
    for (const f of parseFindings(r.result)) {
      if (f.tag === 'unproven-cannot' || !f.run || !f.expects) { findings.push({ ...f, tag: f.tag === 'finding' ? 'unproven' : f.tag }); continue; }
      if (classifyCost(f.run) !== 'free') {
        engine_claimed_experiments.push({ engine: r.engine, run: f.run, observed: f.observed, title: f.title });
        findings.push({ ...f, tag: 'engine-claimed' });
        continue;
      }
      // verify-don't-trust: re-run in a FRESH clean worktree (no engine edits).
      const ws = makeEngineWorkspace(repoPath, 'verify');
      let exp;
      try { exp = await runExperiment(f.run, ws.dir, { timeoutMs, env: { ...experimentEnv(), ...(extraEnv ?? {}) } }); }
      finally { ws.cleanup(); }
      const matched = !!exp && !exp.timedOut && predictMatches(f.expects, { exitCode: exp.exitCode, stdout: exp.stdoutTail, stderr: exp.stderrTail });
      verified_experiments.push({ engine: r.engine, run: f.run, exitCode: exp?.exitCode, matched, timedOut: !!exp?.timedOut });
      findings.push({ ...f, tag: matched ? 'proven' : 'disproven', proof: { run: f.run, exitCode: exp?.exitCode, stdoutTail: exp?.stdoutTail, stderrTail: exp?.stderrTail, matched } });
    }
    out.push({ ...r, findings });
  }
  return { results: out, verified_experiments, engine_claimed_experiments };
}
```

Keep `experimentEnv` import from `sandbox.mjs` and the `// WHY:` anchor pointing at the new decision-doc.

- [ ] **Step 4: Run to verify PASS** — `node --test tests/proof.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/proof.mjs tests/proof.test.mjs
git commit -m "feat(proof): [FINDING] parser + verify-claimed pass (re-run free, accept networked)"
```

---

### Task 6: `fan-out.mjs` + `storm-companion.mjs` — wire per-engine workspaces

**Files:**
- Modify: `scripts/lib/fan-out.mjs`, `scripts/storm-companion.mjs`
- Test: `tests/fan-out.test.mjs` (extend existing — use the fake-engine `cwd` mode)

**Interfaces:**
- `runAll(task, engines, opts)` — when `opts.proof`, for each engine: `ws = makeEngineWorkspace(opts.cwd, e.id)`; spawn with `cwd: ws.dir`, `cfg` carrying `proof: true` and the merged `experimentEnv` into the child env; `ws.cleanup()` in `finally`. When proof off → unchanged (shared `opts.cwd`).
- `storm-companion.mjs` — pass `proof: cfg.proof?.enabled` into `runAll`; thread `experimentEnv` from injected secrets; in the proof branch, call rewritten `annotateWithProof` and emit `{ mode, task, repoPath, results, verified_experiments, engine_claimed_experiments }`.

- [ ] **Step 1: Write failing test (each engine runs in its own worktree dir)**

```javascript
// uses fixtures/fake-engine.mjs 'cwd' mode which prints process.cwd() inside markers
test('proof mode: each engine spawns in its own worktree, cleaned up after', async () => {
  // init a temp git repo; run runAll with two fake 'cwd' engines and proof:true;
  // assert each returned result's cwd is under a storm-ws- dir != repoPath,
  // and that no storm-ws- dirs remain after (cleanup ran).
});
```

(Implementer: build the temp git repo like `tests/workspace.test.mjs`; inject a `runner` that uses the real `runEngine` against `fixtures/fake-engine.mjs cwd`, or pass engines whose `cmd` is the fake engine. Assert on `os.tmpdir()` having no leftover `storm-ws-*` for this run.)

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** in `fan-out.mjs`:

```javascript
import { makeEngineWorkspace } from './workspace.mjs';

export async function runAll(task, engines, opts = {}) {
  const runner = opts.runner ?? runEngine;
  const role = opts.role ?? 'reviewer';
  const proof = !!opts.proof;
  const prompt = buildStormPrompt({ task, role, repoPath: opts.cwd, proof });
  const settled = await Promise.allSettled(engines.map(async (e) => {
    let ws = null;
    try {
      const cwd = proof ? (ws = makeEngineWorkspace(opts.cwd, e.id)).dir : opts.cwd;
      const cfg = { ...e, proof };
      // experimentEnv flows to the child via run-engine's env merge.
      return await runner(e.id, prompt, cfg, { timeoutMs: opts.timeoutMs, stallMs: opts.stallMs, cwd, env: e.experimentEnv });
    } finally {
      if (ws) ws.cleanup();
    }
  }));
  return settled.map((s, i) => s.status === 'fulfilled' ? s.value
    : { engine: engines[i].id, status: 'error', error: s.reason?.message ?? String(s.reason) });
}
```

Note: `runEngine`/`runInvocation` already merge `opts.env`? Confirm — if not, thread `env` through `runEngine(engineId, prompt, cfg, opts)` → `runInvocation({ ...inv, env: { ...inv.env, ...opts.env } })`. The experiment env must reach the child (full-rights engine uses the test key). Add a focused run-engine test if the env path changes.

Then in `storm-companion.mjs`, replace the proof branch:

```javascript
const results = await runAll(task, engines, { role: cfg.role, cwd, proof: cfg.proof?.enabled, timeoutMs: cfg.timeoutMs, stallMs: cfg.stallMs });
let out = { mode, task, repoPath: cwd, results };
if (cfg.proof?.enabled) {
  const { annotateWithProof } = await import('./lib/proof.mjs');
  const experimentEnv = engines.find((e) => e.experimentEnv)?.experimentEnv;
  const proofed = await annotateWithProof(results, { repoPath: cwd, timeoutMs: cfg.proof.experimentTimeoutMs, experimentEnv });
  out = { mode, task, repoPath: cwd, results: proofed.results, verified_experiments: proofed.verified_experiments, engine_claimed_experiments: proofed.engine_claimed_experiments };
}
```

- [ ] **Step 4: Run to verify PASS** — `node --test` (full suite).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fan-out.mjs scripts/storm-companion.mjs scripts/lib/run-engine.mjs tests/
git commit -m "feat(fan-out): per-engine worktree + experiment env wiring in proof mode"
```

---

### Task 7: Live verify + decision-doc + bump + README + memory

**Files:**
- Modify: `scripts/config.json` (no change unless live tuning), `README.md`, `package.json`/version source, `docs/decisions/2026-06-27-proof-required-review.md` (mark superseded)
- Create: `docs/decisions/2026-06-27-stage2-self-experiment.md`

- [ ] **Step 1: Full suite green**

Run: `node --test` → all tests PASS (record count).

- [ ] **Step 2: Live verify on Storm itself** — confirm flags empirically (spec spikes #1):

```bash
# real council on Storm, proof on, into a throwaway clone so the real repo is untouched
node scripts/storm-companion.mjs plan "Find one real bug and self-reproduce it" --cwd /Users/maxim/storm
```

Expected: at least one CLI engine returns a `[FINDING]` with run/expects; orchestrator marks it `proven`/`disproven`; `git -C /Users/maxim/storm worktree list` shows NO leftover worktrees after; the real repo `git status` is unchanged. If codex `-s danger-full-access` or claude `bypassPermissions` misbehaves, adjust the Task-3 flags here and re-run.

- [ ] **Step 3: Write the decision-doc** `docs/decisions/2026-06-27-stage2-self-experiment.md` — context (why self-experiment over orchestrator-runs), the worktree + full-rights + test-key model, why no sandbox (trust = calling agent; `feedback_no_security_theater`), what was rejected (Seatbelt/no-network/paid-prove), and the superseded cost-default-deny invariant. Add `// WHY:` anchors at `workspace.mjs` and the rewritten `annotateWithProof`.

- [ ] **Step 4: Mark Stage-1 decision-doc superseded** — prepend a note to `docs/decisions/2026-06-27-proof-required-review.md`: cost-default-deny / paid-prove superseded by Stage 2 (test key + provider budget cap).

- [ ] **Step 5: README + version bump** — document proof-mode self-experiment + `experimentEnv` secret; bump version to 0.10.0 in the version source.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(release): Stage 2 self-experimenting engines — Storm 0.10.0 + decision-doc"
```

- [ ] **Step 7: Update memory** — `project_storm_multi_agent_council` (0.10.0 self-experiment model; cost-default-deny dropped; gemini self-exec deferred) and the MEMORY.md Storm line.

---

## Self-Review

**1. Spec coverage:**
- worktree + uncommitted + deps + fallback → Task 1 ✓
- self-experiment prompt contract → Task 2 ✓
- full-rights flags (codex/claude/glm) → Task 3 ✓
- test key wiring → Task 4 (secrets) + Task 6 (spawn env) ✓
- verify pass (re-run free / accept networked / timed-out guard / fabrication caught) → Task 5 ✓
- per-engine workspace + cleanup + output shape → Task 6 ✓
- gemini deferred → out of scope, noted in Global Constraints ✓
- backward-compat gate → Tasks 2/3/6 branch on proof; asserted in tests ✓
- invariant change (cost-default-deny dropped) → Task 7 decision-docs ✓
- live verify of flags + isolation → Task 7 ✓

**2. Placeholder scan:** Task 6 Step 1 test is described prose, not full code — it depends on a temp-git-repo harness identical to Task 1's `initRepo()` and the existing `fixtures/fake-engine.mjs cwd` mode; the implementer composes them. All other steps carry full code. The run-engine env-threading is flagged as "confirm/extend" because it depends on the current `runInvocation` env-merge, which the implementer verifies against the real file.

**3. Type consistency:** `makeEngineWorkspace(repoPath, label) → { dir, kind, cleanup }` used identically in Tasks 1/5/6. `annotateWithProof(results, { repoPath, timeoutMs, experimentEnv }) → { results, verified_experiments, engine_claimed_experiments }` consistent between Task 5 and Task 6. `cfg.proof` flag consistent across Tasks 3/6. `parseFindings` tags (`finding`/`unproven-cannot`) consistent with annotateWithProof's branching.
```
