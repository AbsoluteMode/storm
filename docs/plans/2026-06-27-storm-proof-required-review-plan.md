# Storm proof-required review (Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Storm reviewers PROVE each bug: engines tag findings as `[NEEDS-EXPERIMENT]`/`[UNPROVEN-CANNOT]`, the orchestrator runs the FREE experiments in a throwaway copy of the repo, and only an orchestrator-verified result becomes `PROVEN`; paid experiments are surfaced, never auto-run.

**Architecture:** New pure-ish module `proof.mjs` (parse tags, classify cost, match predictions, run experiments, orchestrate the second pass) + `sandbox.mjs` (throwaway `fs.cp` copy with secrets stripped). `prompt.mjs` gains a proof contract; the companion calls `annotateWithProof` after fan-out and extends the output JSON. `result-parser.mjs` is untouched.

**Tech Stack:** Plain Node ESM, zero runtime dependencies, `node --test`.

## Global Constraints

- Node.js 20+; **zero runtime dependencies** (built-ins only).
- TDD: red → green → commit, one behavior per test.
- **Verify-don't-trust:** `PROVEN` is set ONLY by the orchestrator after re-running the experiment and matching `expects`. An engine cannot self-declare proof.
- **Cost default-deny:** `unknown` cost is treated as `paid`. Paid/unknown experiments are NEVER executed in Stage 1 — only surfaced in `pending_paid_experiments`.
- **Isolation invariant:** experiments run in a throwaway copy (`experiment-cwd`), never in the real repo (`review-cwd`). The copy excludes `.git`, `node_modules`, secrets. Experiment env carries no secrets.
- **Bounded experiments:** every experiment has a wall-clock timeout + process-group kill (experiments are NOT engine reasoning — they must be killable). This does not reintroduce engine timeouts (those stay opt-in OFF).
- Default behavior with `proof.enabled=false` is byte-for-byte 0.8.0.
- Specs/plans/decisions in Russian (repo convention); code comments in English; conventional-commit messages, no emoji.

---

### Task 1: `proof.mjs` — `parseProofFindings`

**Files:**
- Create: `scripts/lib/proof.mjs`
- Test: `tests/proof.test.mjs`

**Interfaces:**
- Produces: `parseProofFindings(text: string) -> Finding[]` where `Finding = { tag: 'needs-experiment'|'unproven-cannot'|'proven-claimed', title, run?, expects?, cost?, why? }`. Tolerant line parser: unknown lines ignored, never throws.

- [ ] **Step 1: Write the failing test**

Create `tests/proof.test.mjs`:

```js
// tests/proof.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProofFindings } from '../scripts/lib/proof.mjs';

test('parseProofFindings: NEEDS-EXPERIMENT with run/expects/cost sub-grammar', () => {
  const text = [
    'preamble chatter',
    '[NEEDS-EXPERIMENT] Null deref in parser',
    '  run: node repro.mjs',
    '  expects: exit!=0 AND stderr contains "Cannot read"',
    '  cost: free',
  ].join('\n');
  const [f] = parseProofFindings(text);
  assert.equal(f.tag, 'needs-experiment');
  assert.equal(f.title, 'Null deref in parser');
  assert.equal(f.run, 'node repro.mjs');
  assert.equal(f.expects, 'exit!=0 AND stderr contains "Cannot read"');
  assert.equal(f.cost, 'free');
});

test('parseProofFindings: UNPROVEN-CANNOT with inline why', () => {
  const [f] = parseProofFindings('[UNPROVEN-CANNOT] Race in scheduler — why: nondeterministic timing');
  assert.equal(f.tag, 'unproven-cannot');
  assert.equal(f.title, 'Race in scheduler');
  assert.equal(f.why, 'nondeterministic timing');
});

test('parseProofFindings: engine-claimed PROVEN is captured as proven-claimed (to be downgraded later)', () => {
  const [f] = parseProofFindings('[PROVEN] I am sure by reading line 42');
  assert.equal(f.tag, 'proven-claimed');
  assert.equal(f.title, 'I am sure by reading line 42');
});

test('parseProofFindings: multiple findings, tolerant of junk lines', () => {
  const text = [
    '[NEEDS-EXPERIMENT] First',
    '  run: true',
    'garbage line that means nothing',
    '[UNPROVEN-CANNOT] Second',
  ].join('\n');
  const fs = parseProofFindings(text);
  assert.equal(fs.length, 2);
  assert.equal(fs[0].title, 'First');
  assert.equal(fs[1].tag, 'unproven-cannot');
});

test('parseProofFindings: empty / nullish input -> []', () => {
  assert.deepEqual(parseProofFindings(''), []);
  assert.deepEqual(parseProofFindings(null), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/proof.test.mjs`
Expected: FAIL — `proof.mjs` does not exist (import error).

- [ ] **Step 3: Implement `parseProofFindings`**

Create `scripts/lib/proof.mjs`:

```js
// scripts/lib/proof.mjs
// Proof-required review: parse engine proof tags, classify experiment cost,
// match predictions, run experiments in isolation, and orchestrate the second
// pass. PROVEN is set ONLY here (verify-don't-trust), never by an engine.

// Tolerant line parser: STORM_RESULT text -> findings. Never throws; unknown
// lines are ignored. Engine-claimed [PROVEN] is captured as 'proven-claimed'
// so the orchestrator can DOWNGRADE it (an engine cannot self-prove).
export function parseProofFindings(text) {
  const findings = [];
  let cur = null;
  const push = () => { if (cur) { findings.push(cur); cur = null; } };
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^\[NEEDS-EXPERIMENT\]\s*(.*)$/i))) {
      push();
      cur = { tag: 'needs-experiment', title: m[1].trim() };
    } else if ((m = line.match(/^\[UNPROVEN-CANNOT\]\s*(.*)$/i))) {
      push();
      const rest = m[1].trim();
      const wm = rest.match(/^(.*?)\s*[—-]\s*why:\s*(.*)$/i);
      cur = wm
        ? { tag: 'unproven-cannot', title: wm[1].trim(), why: wm[2].trim() }
        : { tag: 'unproven-cannot', title: rest };
    } else if ((m = line.match(/^\[PROVEN\]\s*(.*)$/i))) {
      push();
      cur = { tag: 'proven-claimed', title: m[1].trim() };
    } else if (cur && (m = line.match(/^run:\s*(.*)$/i))) {
      cur.run = m[1].trim();
    } else if (cur && (m = line.match(/^expects:\s*(.*)$/i))) {
      cur.expects = m[1].trim();
    } else if (cur && (m = line.match(/^cost:\s*(.*)$/i))) {
      cur.cost = m[1].trim();
    }
    // unknown lines: ignored (tolerant)
  }
  push();
  return findings;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/proof.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/proof.mjs tests/proof.test.mjs
git commit -m "feat(proof): parseProofFindings — tolerant proof-tag parser"
```

---

### Task 2: `proof.mjs` — `classifyCost` + `predictMatches`

**Files:**
- Modify: `scripts/lib/proof.mjs`
- Test: `tests/proof.test.mjs`

**Interfaces:**
- Produces: `classifyCost(run: string, declared?: string) -> 'free'|'paid'|'unknown'` (default-deny: looks-networked-but-declared-free => `unknown`); `predictMatches(expects: string, {exitCode, stdout, stderr}) -> boolean` (grammar: `exit!=0`, `exit==N`, `exit!=N`, `stdout contains "X"`, `stderr contains "X"`, joined by `AND`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/proof.test.mjs`:

```js
import { classifyCost, predictMatches } from '../scripts/lib/proof.mjs';

test('classifyCost: declared paid wins', () => {
  assert.equal(classifyCost('node x.mjs', 'paid:openai'), 'paid');
});

test('classifyCost: plain local command -> free', () => {
  assert.equal(classifyCost('node --test', 'free'), 'free');
  assert.equal(classifyCost('npm test', undefined), 'free');
});

test('classifyCost: networked/paid-looking but declared free -> unknown (default-deny)', () => {
  assert.equal(classifyCost('curl https://api.openai.com/v1', 'free'), 'unknown');
  assert.equal(classifyCost('node hit.mjs && wget http://x', 'free'), 'unknown');
  assert.equal(classifyCost('npm install left-pad', 'free'), 'unknown');
});

test('classifyCost: empty command -> unknown', () => {
  assert.equal(classifyCost('', 'free'), 'unknown');
});

test('predictMatches: exit clauses', () => {
  assert.equal(predictMatches('exit!=0', { exitCode: 1 }), true);
  assert.equal(predictMatches('exit!=0', { exitCode: 0 }), false);
  assert.equal(predictMatches('exit==2', { exitCode: 2 }), true);
});

test('predictMatches: contains clauses + AND', () => {
  const res = { exitCode: 1, stdout: 'boom', stderr: 'Cannot read x' };
  assert.equal(predictMatches('stderr contains "Cannot read"', res), true);
  assert.equal(predictMatches('exit!=0 AND stdout contains "boom"', res), true);
  assert.equal(predictMatches('exit==0 AND stdout contains "boom"', res), false);
});

test('predictMatches: empty/unknown clause -> false (conservative)', () => {
  assert.equal(predictMatches('', { exitCode: 1 }), false);
  assert.equal(predictMatches('frobnicate the gizmo', { exitCode: 1 }), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/proof.test.mjs`
Expected: FAIL — `classifyCost`/`predictMatches` not exported.

- [ ] **Step 3: Implement both**

Append to `scripts/lib/proof.mjs`:

```js
const PAID_HOSTS = [/openrouter\.ai/i, /api\.openai\.com/i, /anthropic/i, /generativelanguage/i, /amazonaws\.com/i, /\bz\.ai/i];
const NET_PATTERNS = [/\bcurl\b/i, /\bwget\b/i, /\bssh\b/i, /https?:\/\//i, /\bnpm\s+(i|install)\b/i, /\bpip\s+install\b/i, /\bdocker\s+(pull|run)\b/i, /\byarn\s+add\b/i];

// Classify an experiment's cost. Declarations are NOT trusted: a command that
// looks networked/paid but is declared free is downgraded to 'unknown'. The
// caller treats 'unknown' as 'paid' (default-deny).
export function classifyCost(run, declared) {
  if (String(declared ?? '').toLowerCase().startsWith('paid')) return 'paid';
  const cmd = String(run ?? '');
  if (!cmd.trim()) return 'unknown';
  const suspicious = PAID_HOSTS.some((re) => re.test(cmd)) || NET_PATTERNS.some((re) => re.test(cmd));
  return suspicious ? 'unknown' : 'free';
}

function matchClause(c, { exitCode, stdout = '', stderr = '' }) {
  let m;
  if (/^exit\s*!=\s*0$/i.test(c)) return exitCode !== 0;
  if ((m = c.match(/^exit\s*==\s*(\d+)$/i))) return exitCode === Number(m[1]);
  if ((m = c.match(/^exit\s*!=\s*(\d+)$/i))) return exitCode !== Number(m[1]);
  if ((m = c.match(/^stdout\s+contains\s+["']?(.+?)["']?$/i))) return String(stdout).includes(m[1]);
  if ((m = c.match(/^stderr\s+contains\s+["']?(.+?)["']?$/i))) return String(stderr).includes(m[1]);
  return false; // unknown clause -> not matched (conservative)
}

// Does the captured result satisfy the engine's prediction? Clauses joined by AND.
export function predictMatches(expects, res) {
  const e = String(expects ?? '').trim();
  if (!e) return false;
  return e.split(/\s+AND\s+/i).map((c) => c.trim()).filter(Boolean).every((c) => matchClause(c, res));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/proof.test.mjs`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/proof.mjs tests/proof.test.mjs
git commit -m "feat(proof): classifyCost (default-deny) + predictMatches"
```

---

### Task 3: `sandbox.mjs` — throwaway copy + experiment env

**Files:**
- Create: `scripts/lib/sandbox.mjs`
- Test: `tests/sandbox.test.mjs`

**Interfaces:**
- Produces: `makeThrowawayCopy(repoPath) -> { dir, cleanup }` (copy excludes `.git`/`node_modules`/secrets); `experimentEnv() -> { PATH, HOME, LANG, TMPDIR }` (no secrets).

- [ ] **Step 1: Write the failing test**

Create `tests/sandbox.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/sandbox.test.mjs`
Expected: FAIL — `sandbox.mjs` does not exist.

- [ ] **Step 3: Implement `sandbox.mjs`**

Create `scripts/lib/sandbox.mjs`:

```js
// scripts/lib/sandbox.mjs
// Throwaway copy of a repo for running proof experiments in isolation. The copy
// captures the working tree as-is (incl. uncommitted changes) but excludes .git
// (so an experiment can never push/rewrite the real repo), node_modules, and
// secrets. Experiment env carries no provider keys.
import { cpSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const EXCLUDE = new Set(['.git', 'node_modules', '.storm-secrets.json', '.venv', '.pytest_cache', '__pycache__', 'dist', 'build']);
const EXCLUDE_RE = [/^\.env(\.|$)/, /\.secret$/];

function included(src) {
  const base = basename(src);
  if (EXCLUDE.has(base)) return false;
  return !EXCLUDE_RE.some((re) => re.test(base));
}

export function makeThrowawayCopy(repoPath) {
  const dir = mkdtempSync(join(tmpdir(), 'storm-exp-'));
  cpSync(repoPath, dir, { recursive: true, filter: included });
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

// Minimal env for experiments: no secrets, no provider/backend keys, no Doppler.
export function experimentEnv() {
  const { PATH, HOME, LANG, TMPDIR } = process.env;
  return { PATH, HOME, LANG: LANG ?? 'en_US.UTF-8', TMPDIR };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/sandbox.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/sandbox.mjs tests/sandbox.test.mjs
git commit -m "feat(sandbox): throwaway repo copy (excludes .git/secrets) + clean experiment env"
```

---

### Task 4: `proof.mjs` — `runExperiment` (bounded, isolated)

**Files:**
- Modify: `scripts/lib/proof.mjs`
- Test: `tests/proof-run.test.mjs`

**Interfaces:**
- Produces: `runExperiment(run, cwd, {timeoutMs, env}) -> Promise<{exitCode, stdoutTail, stderrTail, durationMs, timedOut}>`. Runs `run` via `/bin/sh -c` in a detached process group; on timeout kills the whole group.

- [ ] **Step 1: Write the failing test**

Create `tests/proof-run.test.mjs`:

```js
// tests/proof-run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { runExperiment } from '../scripts/lib/proof.mjs';

test('runExperiment: captures exit code and stdout', async () => {
  const r = await runExperiment('echo hello; exit 3', tmpdir(), { timeoutMs: 5000 });
  assert.equal(r.exitCode, 3);
  assert.ok(r.stdoutTail.includes('hello'));
  assert.equal(r.timedOut, false);
});

test('runExperiment: captures stderr', async () => {
  const r = await runExperiment('echo oops 1>&2; exit 1', tmpdir(), { timeoutMs: 5000 });
  assert.equal(r.exitCode, 1);
  assert.ok(r.stderrTail.includes('oops'));
});

test('runExperiment: a hanging command is killed at timeout', async () => {
  const r = await runExperiment('sleep 30', tmpdir(), { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 3000, `should have been killed quickly, took ${r.durationMs}ms`);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/proof-run.test.mjs`
Expected: FAIL — `runExperiment` not exported.

- [ ] **Step 3: Implement `runExperiment`**

Append to `scripts/lib/proof.mjs`:

```js
import { spawn } from 'node:child_process';

const OUTPUT_CAP = 4000; // tail cap per stream (context-protection: bounded artifact)

// Run an experiment command in `cwd` (a throwaway copy), bounded by timeoutMs.
// Detached process group so a hung repro (and its children) is killed wholesale.
// Experiments MUST be bounded — unlike engines (no-timeouts liveness).
export function runExperiment(run, cwd, { timeoutMs = 30000, env } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false, timedOut = false;
    const start = Date.now();
    const finish = (exitCode) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdoutTail: stdout.slice(-OUTPUT_CAP), stderrTail: stderr.slice(-OUTPUT_CAP), durationMs: Date.now() - start, timedOut });
    };
    let child;
    try {
      child = spawn('/bin/sh', ['-c', run], { cwd, env: env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ exitCode: null, stdoutTail: '', stderrTail: String(e.message), durationMs: 0, timedOut: false });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += String(e.message); finish(null); });
    child.on('close', (code) => finish(code));
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/proof-run.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/proof.mjs tests/proof-run.test.mjs
git commit -m "feat(proof): runExperiment — bounded, detached-group, output-capped"
```

---

### Task 5: `prompt.mjs` — proof contract

**Files:**
- Modify: `scripts/lib/prompt.mjs`
- Test: `tests/prompt.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildStormPrompt({task, role, repoPath, proof})` — when `proof` is truthy, the output instructs the engine to tag findings with the proof grammar; when falsy, the prompt is the 0.8.0 default.

- [ ] **Step 1: Write the failing test**

Add to `tests/prompt.test.mjs` (create if missing — check existing first; it exists):

```js
import { buildStormPrompt } from '../scripts/lib/prompt.mjs';
// (test file already imports test/assert)

test('buildStormPrompt: proof mode adds the proof tag grammar', () => {
  const p = buildStormPrompt({ task: 'review', proof: true });
  assert.ok(p.includes('[NEEDS-EXPERIMENT]'), 'proof prompt must teach the NEEDS-EXPERIMENT tag');
  assert.ok(p.includes('run:') && p.includes('expects:') && p.includes('cost:'));
  assert.ok(p.includes('[UNPROVEN-CANNOT]'));
});

test('buildStormPrompt: default (no proof) stays marker-only, no proof grammar', () => {
  const p = buildStormPrompt({ task: 'review' });
  assert.ok(!p.includes('[NEEDS-EXPERIMENT]'));
  assert.ok(p.includes('<STORM_RESULT>'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/prompt.test.mjs`
Expected: FAIL — proof prompt not emitted.

- [ ] **Step 3: Implement the proof contract**

Replace the body of `scripts/lib/prompt.mjs` with:

```js
// scripts/lib/prompt.mjs
const ROLE_LINES = {
  reviewer: 'Act as a senior code reviewer. Find bugs, risks, and weak spots.',
  explorer: 'Act as a code explorer. Investigate the repository and find the root cause.',
  analyst: 'Analyze the problem and propose the single best approach.',
};

const DEFAULT_CONTRACT = [
  'Work independently. Output ONLY your final result wrapped in the markers',
  'below — no progress notes, no reasoning, nothing after the closing marker:',
  '<STORM_RESULT>',
  '- concise bullet findings or recommendation',
  '</STORM_RESULT>',
];

const PROOF_CONTRACT = [
  'Work independently. Every bug you report MUST be PROVABLE. Do NOT assert a bug',
  'from reading alone. Tag EACH finding inside the markers using this grammar:',
  '  [NEEDS-EXPERIMENT] <one-line title>',
  '    run: <a shell command that reproduces the bug>',
  '    expects: <what output proves it: exit!=0 | stdout contains "X" | stderr contains "X", joined by AND>',
  '    cost: free | paid:<provider>   (free = local, no network; paid = needs a network/paid API)',
  '  [UNPROVEN-CANNOT] <title> — why: <race / nondeterminism / no tool available>',
  'Do NOT output [PROVEN] yourself — the orchestrator runs your experiment and decides.',
  'Output ONLY the tagged findings wrapped in the markers, nothing after the close:',
  '<STORM_RESULT>',
  '[NEEDS-EXPERIMENT] ...',
  '</STORM_RESULT>',
];

export function buildStormPrompt({ task, role = 'reviewer', repoPath, proof = false } = {}) {
  const roleLine = ROLE_LINES[role] ?? ROLE_LINES.reviewer;
  return [
    roleLine,
    repoPath ? `Repository: ${repoPath}` : '',
    `Task: ${task}`,
    '',
    ...(proof ? PROOF_CONTRACT : DEFAULT_CONTRACT),
  ].filter(Boolean).join('\n');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/prompt.test.mjs`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/prompt.mjs tests/prompt.test.mjs
git commit -m "feat(prompt): proof contract — engines tag findings with the proof grammar"
```

---

### Task 6: `proof.mjs` — `annotateWithProof` (second-pass orchestration)

**Files:**
- Modify: `scripts/lib/proof.mjs`
- Test: `tests/proof-annotate.test.mjs`

**Interfaces:**
- Consumes: `parseProofFindings`, `classifyCost`, `predictMatches`, `runExperiment` (Tasks 1/2/4), `makeThrowawayCopy`, `experimentEnv` (Task 3).
- Produces: `annotateWithProof(results, {repoPath, timeoutMs}) -> Promise<{results, executed_experiments, pending_paid_experiments}>`. For each ok/salvaged engine result: parse findings; FREE `needs-experiment` → run in a fresh copy → tag `proven`/`disproven`; paid/unknown → `unproven-needs-paid` + pending entry; `proven-claimed` → downgraded to `unproven-cannot`.

- [ ] **Step 1: Write the failing test**

Create `tests/proof-annotate.test.mjs`:

```js
// tests/proof-annotate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { annotateWithProof } from '../scripts/lib/proof.mjs';

const repo = () => mkdtempSync(join(tmpdir(), 'storm-annrepo-'));

test('annotateWithProof: a FREE experiment that reproduces -> proven', async () => {
  const results = [{ engine: 'claude', status: 'ok', result: [
    '[NEEDS-EXPERIMENT] Bug A',
    '  run: exit 1',
    '  expects: exit!=0',
    '  cost: free',
  ].join('\n') }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  const f = out.results[0].findings[0];
  assert.equal(f.tag, 'proven');
  assert.equal(out.executed_experiments.length, 1);
  assert.equal(out.executed_experiments[0].matched, true);
});

test('annotateWithProof: a FREE experiment that does NOT reproduce -> disproven', async () => {
  const results = [{ engine: 'claude', status: 'ok', result: [
    '[NEEDS-EXPERIMENT] Bug B',
    '  run: exit 0',
    '  expects: exit!=0',
    '  cost: free',
  ].join('\n') }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  assert.equal(out.results[0].findings[0].tag, 'disproven');
});

test('annotateWithProof: a PAID experiment is NOT run, goes to pending', async () => {
  const results = [{ engine: 'glm', status: 'ok', result: [
    '[NEEDS-EXPERIMENT] Bug C',
    '  run: curl https://api.openai.com/v1/x',
    '  expects: exit==0',
    '  cost: free',
  ].join('\n') }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  assert.equal(out.results[0].findings[0].tag, 'unproven-needs-paid');
  assert.equal(out.pending_paid_experiments.length, 1);
  assert.equal(out.executed_experiments.length, 0);
});

test('annotateWithProof: engine-claimed PROVEN is downgraded to unproven-cannot', async () => {
  const results = [{ engine: 'codex', status: 'ok', result: '[PROVEN] trust me bro' }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  assert.equal(out.results[0].findings[0].tag, 'unproven-cannot');
});

test('annotateWithProof: non-ok engine result is passed through untouched', async () => {
  const results = [{ engine: 'x', status: 'stalled', error: 'no output' }];
  const out = await annotateWithProof(results, { repoPath: repo(), timeoutMs: 5000 });
  assert.equal(out.results[0].status, 'stalled');
  assert.equal(out.results[0].findings, undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/proof-annotate.test.mjs`
Expected: FAIL — `annotateWithProof` not exported.

- [ ] **Step 3: Implement `annotateWithProof`**

Append to `scripts/lib/proof.mjs`:

```js
import { makeThrowawayCopy, experimentEnv } from './sandbox.mjs';

// Second pass: prove each engine's findings. PROVEN is granted ONLY here, on a
// matching orchestrator-captured artifact. Paid/unknown experiments are never
// run (default-deny) — surfaced for the user instead.
export async function annotateWithProof(results, { repoPath, timeoutMs = 30000 } = {}) {
  const executed_experiments = [];
  const pending_paid_experiments = [];
  const out = [];
  for (const r of results) {
    if (r.status !== 'ok' && r.status !== 'salvaged') { out.push(r); continue; }
    const findings = [];
    for (const f of parseProofFindings(r.result)) {
      if (f.tag === 'unproven-cannot') { findings.push(f); continue; }
      if (f.tag === 'proven-claimed') {
        findings.push({ tag: 'unproven-cannot', title: f.title, why: 'engine claimed proof without orchestrator verification' });
        continue;
      }
      // needs-experiment
      const cost = classifyCost(f.run, f.cost);
      if (cost !== 'free') {
        pending_paid_experiments.push({ engine: r.engine, run: f.run, cost, title: f.title });
        findings.push({ ...f, tag: 'unproven-needs-paid', cost });
        continue;
      }
      const { dir, cleanup } = makeThrowawayCopy(repoPath);
      let exp;
      try { exp = await runExperiment(f.run, dir, { timeoutMs, env: experimentEnv() }); }
      finally { cleanup(); }
      const matched = predictMatches(f.expects, { exitCode: exp.exitCode, stdout: exp.stdoutTail, stderr: exp.stderrTail });
      executed_experiments.push({ engine: r.engine, run: f.run, exitCode: exp.exitCode, matched, timedOut: exp.timedOut });
      findings.push({ ...f, tag: matched ? 'proven' : 'disproven', proof: { run: f.run, exitCode: exp.exitCode, stdoutTail: exp.stdoutTail, stderrTail: exp.stderrTail, matched } });
    }
    out.push({ ...r, findings });
  }
  return { results: out, executed_experiments, pending_paid_experiments };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/proof-annotate.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/proof.mjs tests/proof-annotate.test.mjs
git commit -m "feat(proof): annotateWithProof — orchestrator second pass, verify-don't-trust"
```

---

### Task 7: wire into companion + config + docs + live verify

**Files:**
- Modify: `scripts/config.json`
- Modify: `scripts/lib/fan-out.mjs:8`
- Modify: `scripts/storm-companion.mjs`
- Modify: `commands/storm.md`, `skills/storm-runtime/SKILL.md`

**Interfaces:**
- Consumes: `annotateWithProof` (Task 6); `buildStormPrompt({proof})` (Task 5).
- Produces: companion output gains `executed_experiments` + `pending_paid_experiments` when `proof.enabled`; engines get the proof prompt.

- [ ] **Step 1: Add the proof config block**

In `scripts/config.json`, add a top-level key (keep existing keys):

```json
  "proof": { "enabled": true, "experimentTimeoutMs": 30000 }
```

- [ ] **Step 2: Thread `proof` into the prompt via fan-out**

In `scripts/lib/fan-out.mjs`, change line 8:

```js
  const prompt = buildStormPrompt({ task, role, repoPath: opts.cwd, proof: opts.proof });
```

- [ ] **Step 3: Wire the companion (write the failing test first)**

Add to `tests/companion.test.mjs`:

```js
test('proof config block exists and is enabled by default', async () => {
  const cfg = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(new URL('../scripts/config.json', import.meta.url), 'utf8')));
  assert.equal(cfg.proof.enabled, true);
  assert.equal(typeof cfg.proof.experimentTimeoutMs, 'number');
});
```

Run: `node --test tests/companion.test.mjs` → FAIL (no proof block yet; but Step 1 added it — so this passes once Step 1 is done). If Step 1 done, this is a guard test.

- [ ] **Step 4: Wire the companion second pass**

In `scripts/storm-companion.mjs`, after `const results = await runAll(...)` and before the output line, replace the tail of `main()`:

```js
  const results = await runAll(task, engines, {
    role: cfg.role,
    cwd,
    proof: cfg.proof?.enabled,
    timeoutMs: cfg.timeoutMs,
    stallMs: cfg.stallMs,
  });
  let out = { mode, task, repoPath: cwd, results };
  if (cfg.proof?.enabled) {
    const { annotateWithProof } = await import('./lib/proof.mjs');
    const proofed = await annotateWithProof(results, { repoPath: cwd, timeoutMs: cfg.proof.experimentTimeoutMs });
    out = { mode, task, repoPath: cwd, results: proofed.results, executed_experiments: proofed.executed_experiments, pending_paid_experiments: proofed.pending_paid_experiments };
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
```

(Remove the old single `process.stdout.write({ mode, task, repoPath: cwd, results })` line.)

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS (all — proof modules + existing). No engine is spawned by unit tests.

- [ ] **Step 6: Update the orchestrator docs**

In `commands/storm.md`, after the JSON-shape step, add:

```markdown
When proof mode is on, results carry per-finding proof tags and the output adds
`executed_experiments` (what the orchestrator ran in an isolated copy) and
`pending_paid_experiments`. Synthesis rules:
- Only `proven` findings are reported as confirmed bugs.
- `disproven` findings are dropped (the experiment did not reproduce).
- `unproven-cannot` / `unproven-needs-paid` go in a separate "not proven" section.
- For each `pending_paid_experiments` entry, WARN the user that proving it costs
  money (show the command + provider) BEFORE any execution. Stage 1 does not run
  paid experiments — it only surfaces them.
```

In `skills/storm-runtime/SKILL.md`, add a bullet:

```markdown
- Proof mode (`config.proof.enabled`): findings are tagged proven/disproven/unproven-*;
  output adds `executed_experiments` + `pending_paid_experiments`. Only `proven` are
  confirmed bugs; paid experiments are surfaced, never auto-run.
```

- [ ] **Step 7: Commit**

```bash
git add scripts/config.json scripts/lib/fan-out.mjs scripts/storm-companion.mjs tests/companion.test.mjs commands/storm.md skills/storm-runtime/SKILL.md
git commit -m "feat(proof): wire proof-required review into the companion + docs"
```

- [ ] **Step 8: Live verify on a real repo**

Run a real proof-mode council against Storm's own repo, asking for a provable bug:

```bash
node /Users/maxim/storm/scripts/storm-companion.mjs plan "Find one bug you can PROVE with a runnable experiment. Prefer a small failing repro." --cwd /Users/maxim/storm
```

Expected: output JSON has `executed_experiments` with at least one entry where `matched: true` (a `proven` finding), and/or `pending_paid_experiments` is surfaced (not auto-run). Confirm no experiment ran against the real repo (experiments use a temp copy — check that the real `~/storm` working tree is unchanged: `git -C /Users/maxim/storm status --short` shows only the planned edits).

- [ ] **Step 9 (gated — do NOT do unprompted): version bump + push**

A `feat` → minor bump (0.8.0 → 0.9.0) in `package.json` + `.claude-plugin/plugin.json`. **Hold** the bump, the security scan (public repo — `.storm-secrets.json` untracked, no keys in diff), the decision-doc (`docs/decisions/2026-06-27-proof-required-review.md`, why throwaway-copy + verify-don't-trust + default-deny), and `git push` until Maxim explicitly approves.

---

## Self-Review

**Spec coverage:**
- "structured marker + second pass" → Task 1 (parse) + Task 6 (annotate) + Task 7 (companion). ✓
- "throwaway-copy isolation, secrets stripped" → Task 3. ✓
- "verify-don't-trust PROVEN; engine-claimed downgraded" → Task 6 (`proven`/`disproven` only via orchestrator; `proven-claimed` → `unproven-cannot`). ✓
- "cost-gate, default-deny, paid never auto-run" → Task 2 (`classifyCost`) + Task 6 (paid → pending). ✓
- "bounded experiments + process-group kill" → Task 4. ✓
- "proof contract in prompt" → Task 5. ✓
- "config proof block; default-off path = 0.8.0" → Task 7 (Step 1 config; `proof.enabled` gate). ✓
- "output adds executed/pending" → Task 7 Step 4. ✓
- "docs (storm.md/SKILL.md)" → Task 7 Step 6. ✓
- "predictMatches grammar" → Task 2. ✓

**Placeholder scan:** no TBD/TODO; every code step has full code; commands have expected output. ✓

**Type consistency:** `Finding.tag` values (`needs-experiment`/`unproven-cannot`/`proven-claimed` from parse; `proven`/`disproven`/`unproven-needs-paid` from annotate) consistent across Tasks 1/6. `runExperiment` return shape (`exitCode`/`stdoutTail`/`stderrTail`/`timedOut`) used identically in Task 4 (def) and Task 6 (consume). `makeThrowawayCopy` → `{dir, cleanup}` consistent Tasks 3/6. `annotateWithProof` → `{results, executed_experiments, pending_paid_experiments}` consistent Tasks 6/7. ✓

**Note:** Task 7 Step 9 (bump/push) is intentionally gated on explicit approval.
