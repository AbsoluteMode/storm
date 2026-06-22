# Storm plan-v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/storm plan <task>` command — a Claude Code plugin that fans a task out to three independent engines (Claude, Codex, Antigravity/Gemini) in parallel, normalizes each engine's output to a clean result, and lets the orchestrator synthesize one answer.

**Architecture:** A Node ESM runtime (`storm-companion.mjs`) spawns the three engine CLIs as child processes, each prompted to wrap its final answer in `<STORM_RESULT>…</STORM_RESULT>` markers. Per-engine adapters build the argv; a parser extracts only the marker block (raw stdout never reaches the orchestrator's context); a fan-out runs all engines concurrently and degrades gracefully. The `commands/storm.md` prompt tells the orchestrator (main Claude) to call the runtime and synthesize the normalized JSON.

**Tech Stack:** Node.js (ESM, `"type": "module"`), built-in `node:test` + `node:child_process`, zero runtime dependencies. Claude Code plugin manifest.

## Global Constraints

- Node ESM only (`"type": "module"`); zero runtime dependencies; tests on built-in `node:test`.
- Engines & exact headless invocations (verified 2026-06-22):
  - claude → `claude -p "<prompt>" [--model <m>]`
  - codex → `codex exec "<prompt>"`
  - antigravity → `agy --model "Gemini 3.1 Pro (High)" -p "<prompt>" --dangerously-skip-permissions --print-timeout <T>`
- Context-protection invariant: orchestrator sees only normalized results, never raw engine stdout. **Parse output, not exit codes** (CLIs return exit 0 on error).
- Result markers: `<STORM_RESULT>` / `</STORM_RESULT>`.
- v1 = `plan` mode only (read-only). `action` mode is a later phase — do not build it here.
- No emoji anywhere (code, docs, commits).
- License Apache-2.0 + NOTICE attributing the `codex` plugin (OpenAI) as structural reference.

## File Structure

```
~/storm/
  .claude-plugin/plugin.json     # plugin manifest
  commands/storm.md              # /storm orchestrator instructions
  skills/storm-runtime/SKILL.md  # internal runtime contract
  scripts/
    storm-companion.mjs          # entry: plan "<task>" -> normalized JSON
    config.json                  # engines, models, timeouts, role
    lib/
      result-parser.mjs          # extractResult(raw) -> {ok, result|reason}
      prompt.mjs                 # buildStormPrompt({task,role,repoPath}) -> string
      adapters.mjs               # buildInvocation(engineId,prompt,cfg) -> {cmd,args}
      run-engine.mjs             # runInvocation / runEngine -> {engine,status,result|error}
      fan-out.mjs                # runAll(task,engines,opts) -> [results]
  tests/
    result-parser.test.mjs
    prompt.test.mjs
    adapters.test.mjs
    run-engine.test.mjs
    fan-out.test.mjs
    fixtures/fake-engine.mjs     # configurable stub CLI for run-engine tests
  package.json
  LICENSE
  NOTICE
  README.md
```

---

### Task 1: Plugin skeleton

**Files:**
- Create: `package.json`, `.claude-plugin/plugin.json`, `scripts/config.json`, `LICENSE`, `NOTICE`, `.gitignore`

**Interfaces:**
- Produces: `npm test` runs `node --test` (green on empty suite); `scripts/config.json` shape `{ role, timeoutMs, engines: [{id, model?, printTimeout?}] }`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "storm",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "Storm — multi-engine council for Claude Code (plan mode)",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Create `.claude-plugin/plugin.json`**

```json
{
  "name": "storm",
  "version": "0.1.0",
  "description": "Convene a council of three engines (Claude + Codex + Antigravity) on demand and synthesize one answer.",
  "author": { "name": "max" }
}
```

- [ ] **Step 3: Create `scripts/config.json`**

```json
{
  "role": "reviewer",
  "timeoutMs": 180000,
  "engines": [
    { "id": "claude", "model": null },
    { "id": "codex" },
    { "id": "antigravity", "model": "Gemini 3.1 Pro (High)", "printTimeout": "150s" }
  ]
}
```

- [ ] **Step 4: Create `LICENSE` (Apache-2.0) and `NOTICE`**

`LICENSE`: paste the standard Apache License 2.0 text (from https://www.apache.org/licenses/LICENSE-2.0.txt).

`NOTICE`:
```
Storm
Copyright 2026 max

This product's plugin structure (companion-runtime + skill contract +
commands layout) is adapted from the "codex" plugin by OpenAI, licensed
under the Apache License, Version 2.0.
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
*.log
.DS_Store
/tmp/
```

- [ ] **Step 6: Verify empty test run is green**

Run: `cd ~/storm && npm test`
Expected: `node --test` runs, reports 0 tests, exit 0 (no failures).

- [ ] **Step 7: Commit**

```bash
cd ~/storm && git add -A
git commit -m "feat: plugin skeleton (manifest, config, license, package)"
```

---

### Task 2: Result parser

**Files:**
- Create: `scripts/lib/result-parser.mjs`
- Test: `tests/result-parser.test.mjs`

**Interfaces:**
- Produces: `extractResult(raw: string) -> { ok: true, result: string } | { ok: false, reason: 'empty'|'no_marker'|'unterminated'|'empty_result' }`. Takes the LAST `<STORM_RESULT>` block (final answer wins over any earlier echoes).

- [ ] **Step 1: Write the failing test**

```js
// tests/result-parser.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractResult } from '../scripts/lib/result-parser.mjs';

test('extracts content between markers, trimmed', () => {
  const raw = 'noise\n<STORM_RESULT>\n- finding A\n</STORM_RESULT>\ntrailing';
  assert.deepEqual(extractResult(raw), { ok: true, result: '- finding A' });
});

test('takes the LAST block when several exist', () => {
  const raw = '<STORM_RESULT>old</STORM_RESULT>\n<STORM_RESULT>new</STORM_RESULT>';
  assert.deepEqual(extractResult(raw), { ok: true, result: 'new' });
});

test('no marker -> no_marker', () => {
  assert.deepEqual(extractResult('just chatter'), { ok: false, reason: 'no_marker' });
});

test('unterminated -> unterminated', () => {
  assert.deepEqual(extractResult('<STORM_RESULT>oops'), { ok: false, reason: 'unterminated' });
});

test('empty body -> empty_result', () => {
  assert.deepEqual(extractResult('<STORM_RESULT>   </STORM_RESULT>'), { ok: false, reason: 'empty_result' });
});

test('non-string -> empty', () => {
  assert.deepEqual(extractResult(undefined), { ok: false, reason: 'empty' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/storm && node --test tests/result-parser.test.mjs`
Expected: FAIL — cannot find module `result-parser.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/result-parser.mjs
const OPEN = '<STORM_RESULT>';
const CLOSE = '</STORM_RESULT>';

export function extractResult(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty' };
  const start = raw.lastIndexOf(OPEN);
  if (start === -1) return { ok: false, reason: 'no_marker' };
  const from = start + OPEN.length;
  const end = raw.indexOf(CLOSE, from);
  if (end === -1) return { ok: false, reason: 'unterminated' };
  const result = raw.slice(from, end).trim();
  if (result.length === 0) return { ok: false, reason: 'empty_result' };
  return { ok: true, result };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/storm && node --test tests/result-parser.test.mjs`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
cd ~/storm && git add scripts/lib/result-parser.mjs tests/result-parser.test.mjs
git commit -m "feat: result parser extracts STORM_RESULT block"
```

---

### Task 3: Prompt builder

**Files:**
- Create: `scripts/lib/prompt.mjs`
- Test: `tests/prompt.test.mjs`

**Interfaces:**
- Produces: `buildStormPrompt({ task: string, role?: 'reviewer'|'explorer'|'analyst', repoPath?: string }) -> string`. Output always contains the task text, a role line, and the marker contract instruction.

- [ ] **Step 1: Write the failing test**

```js
// tests/prompt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStormPrompt } from '../scripts/lib/prompt.mjs';

test('includes task, role line, and marker contract', () => {
  const p = buildStormPrompt({ task: 'find the deadlock', role: 'explorer', repoPath: '/repo' });
  assert.match(p, /find the deadlock/);
  assert.match(p, /explorer|investigate/i);
  assert.match(p, /<STORM_RESULT>/);
  assert.match(p, /<\/STORM_RESULT>/);
  assert.match(p, /\/repo/);
});

test('defaults to reviewer role and omits repo line when absent', () => {
  const p = buildStormPrompt({ task: 'review diff' });
  assert.match(p, /review/i);
  assert.doesNotMatch(p, /Repository:/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/storm && node --test tests/prompt.test.mjs`
Expected: FAIL — cannot find module `prompt.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/prompt.mjs
const ROLE_LINES = {
  reviewer: 'Act as a senior code reviewer. Find bugs, risks, and weak spots.',
  explorer: 'Act as a code explorer. Investigate the repository and find the root cause.',
  analyst: 'Analyze the problem and propose the single best approach.',
};

export function buildStormPrompt({ task, role = 'reviewer', repoPath } = {}) {
  const roleLine = ROLE_LINES[role] ?? ROLE_LINES.reviewer;
  return [
    roleLine,
    repoPath ? `Repository: ${repoPath}` : '',
    `Task: ${task}`,
    '',
    'Work independently. Output ONLY your final result wrapped in the markers',
    'below — no progress notes, no reasoning, nothing after the closing marker:',
    '<STORM_RESULT>',
    '- concise bullet findings or recommendation',
    '</STORM_RESULT>',
  ].filter(Boolean).join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/storm && node --test tests/prompt.test.mjs`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
cd ~/storm && git add scripts/lib/prompt.mjs tests/prompt.test.mjs
git commit -m "feat: storm prompt builder with role + marker contract"
```

---

### Task 4: Engine adapters

**Files:**
- Create: `scripts/lib/adapters.mjs`
- Test: `tests/adapters.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildInvocation(engineId: string, prompt: string, cfg?: object) -> { cmd: string, args: string[] }`. Throws `Error('unknown engine: <id>')` for unknown ids. Args are a plain argv array (no shell).

- [ ] **Step 1: Write the failing test**

```js
// tests/adapters.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvocation } from '../scripts/lib/adapters.mjs';

test('antigravity argv has model, -p, skip-permissions, print-timeout', () => {
  const { cmd, args } = buildInvocation('antigravity', 'PROMPT', { model: 'Gemini 3.1 Pro (High)', printTimeout: '150s' });
  assert.equal(cmd, 'agy');
  assert.deepEqual(args, ['--model', 'Gemini 3.1 Pro (High)', '-p', 'PROMPT', '--dangerously-skip-permissions', '--print-timeout', '150s']);
});

test('codex argv is exec + prompt', () => {
  assert.deepEqual(buildInvocation('codex', 'PROMPT'), { cmd: 'codex', args: ['exec', 'PROMPT'] });
});

test('claude argv is -p prompt, model appended when set', () => {
  assert.deepEqual(buildInvocation('claude', 'PROMPT', { model: 'opus' }), { cmd: 'claude', args: ['-p', 'PROMPT', '--model', 'opus'] });
  assert.deepEqual(buildInvocation('claude', 'PROMPT', {}), { cmd: 'claude', args: ['-p', 'PROMPT'] });
});

test('unknown engine throws', () => {
  assert.throws(() => buildInvocation('grok', 'PROMPT'), /unknown engine: grok/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/storm && node --test tests/adapters.test.mjs`
Expected: FAIL — cannot find module `adapters.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/adapters.mjs
const ADAPTERS = {
  claude: {
    cmd: 'claude',
    buildArgs: (prompt, cfg) => ['-p', prompt, ...(cfg.model ? ['--model', cfg.model] : [])],
  },
  codex: {
    cmd: 'codex',
    buildArgs: (prompt) => ['exec', prompt],
  },
  antigravity: {
    cmd: 'agy',
    buildArgs: (prompt, cfg) => [
      '--model', cfg.model ?? 'Gemini 3.1 Pro (High)',
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--print-timeout', cfg.printTimeout ?? '120s',
    ],
  },
};

export function buildInvocation(engineId, prompt, cfg = {}) {
  const a = ADAPTERS[engineId];
  if (!a) throw new Error(`unknown engine: ${engineId}`);
  return { cmd: a.cmd, args: a.buildArgs(prompt, cfg) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/storm && node --test tests/adapters.test.mjs`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
cd ~/storm && git add scripts/lib/adapters.mjs tests/adapters.test.mjs
git commit -m "feat: engine adapters build argv for claude/codex/antigravity"
```

---

### Task 5: Run engine (spawn + timeout + degrade)

**Files:**
- Create: `scripts/lib/run-engine.mjs`, `tests/fixtures/fake-engine.mjs`
- Test: `tests/run-engine.test.mjs`

**Interfaces:**
- Consumes: `buildInvocation` (Task 4), `extractResult` (Task 2).
- Produces:
  - `runInvocation({ engine, cmd, args }, opts?) -> Promise<{ engine, status: 'ok'|'timeout'|'error'|'no_result', result?, error? }>`
  - `runEngine(engineId, prompt, cfg?, opts?) -> Promise<same>` (wraps buildInvocation + runInvocation). `opts.timeoutMs` default 180000.

- [ ] **Step 1: Write the fixture stub CLI**

```js
// tests/fixtures/fake-engine.mjs
// modes: ok | nomarker | slow  (arg 1)
const mode = process.argv[2];
if (mode === 'ok') {
  process.stdout.write('progress chatter...\n<STORM_RESULT>\n- ok finding\n</STORM_RESULT>\n');
  process.exit(0);
} else if (mode === 'nomarker') {
  process.stdout.write('blah blah no markers here\n');
  process.exit(0); // exit 0 on purpose: must not be treated as success
} else if (mode === 'slow') {
  setTimeout(() => process.stdout.write('too late\n'), 10000);
}
```

- [ ] **Step 2: Write the failing test**

```js
// tests/run-engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInvocation } from '../scripts/lib/run-engine.mjs';

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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/storm && node --test tests/run-engine.test.mjs`
Expected: FAIL — cannot find module `run-engine.mjs`.

- [ ] **Step 4: Write minimal implementation**

```js
// scripts/lib/run-engine.mjs
import { spawn } from 'node:child_process';
import { buildInvocation } from './adapters.mjs';
import { extractResult } from './result-parser.mjs';

export function runInvocation({ engine, cmd, args }, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 180000;
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ engine, status: 'error', error: e.message });
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ engine, status: 'timeout', error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', (e) => finish({ engine, status: 'error', error: e.message }));
    child.on('close', () => {
      const parsed = extractResult(stdout);
      if (parsed.ok) finish({ engine, status: 'ok', result: parsed.result });
      else finish({ engine, status: 'no_result', error: parsed.reason });
    });
  });
}

export function runEngine(engineId, prompt, cfg = {}, opts = {}) {
  const { cmd, args } = buildInvocation(engineId, prompt, cfg);
  return runInvocation({ engine: engineId, cmd, args }, opts);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/storm && node --test tests/run-engine.test.mjs`
Expected: PASS (4/4).

- [ ] **Step 6: Commit**

```bash
cd ~/storm && git add scripts/lib/run-engine.mjs tests/run-engine.test.mjs tests/fixtures/fake-engine.mjs
git commit -m "feat: run-engine spawns CLI with timeout and graceful degrade"
```

---

### Task 6: Fan-out (parallel council)

**Files:**
- Create: `scripts/lib/fan-out.mjs`
- Test: `tests/fan-out.test.mjs`

**Interfaces:**
- Consumes: `runEngine` (Task 5), `buildStormPrompt` (Task 3).
- Produces: `runAll(task, engines, opts?) -> Promise<Array<{engine,status,result|error}>>`. Runs all engines concurrently. `opts.runner` (default `runEngine`) is injectable for tests. `engines` is `[{id, model?, printTimeout?}]`. One engine failing must not reject the whole call.

- [ ] **Step 1: Write the failing test**

```js
// tests/fan-out.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAll } from '../scripts/lib/fan-out.mjs';

test('runs all engines concurrently and collects results', async () => {
  const started = [];
  const runner = async (id) => {
    started.push(id);
    await new Promise((r) => setTimeout(r, 20));
    return { engine: id, status: 'ok', result: `r-${id}` };
  };
  const engines = [{ id: 'claude' }, { id: 'codex' }, { id: 'antigravity' }];
  const results = await runAll('task', engines, { runner });
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.engine).sort(), ['antigravity', 'claude', 'codex']);
  assert.equal(started.length, 3); // all kicked off
});

test('one failing engine does not break the run', async () => {
  const runner = async (id) =>
    id === 'codex' ? { engine: id, status: 'timeout', error: 't' } : { engine: id, status: 'ok', result: 'r' };
  const results = await runAll('task', [{ id: 'claude' }, { id: 'codex' }], { runner });
  const codex = results.find((r) => r.engine === 'codex');
  const claude = results.find((r) => r.engine === 'claude');
  assert.equal(codex.status, 'timeout');
  assert.equal(claude.status, 'ok');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/storm && node --test tests/fan-out.test.mjs`
Expected: FAIL — cannot find module `fan-out.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/lib/fan-out.mjs
import { runEngine } from './run-engine.mjs';
import { buildStormPrompt } from './prompt.mjs';

export async function runAll(task, engines, opts = {}) {
  const runner = opts.runner ?? runEngine;
  const role = opts.role ?? 'reviewer';
  const prompt = buildStormPrompt({ task, role, repoPath: opts.repoPath });
  return Promise.all(
    engines.map((e) => runner(e.id, prompt, e, { timeoutMs: opts.timeoutMs }))
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/storm && node --test tests/fan-out.test.mjs`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
cd ~/storm && git add scripts/lib/fan-out.mjs tests/fan-out.test.mjs
git commit -m "feat: fan-out runs engines concurrently with graceful degrade"
```

---

### Task 7: Companion entrypoint

**Files:**
- Create: `scripts/storm-companion.mjs`
- Test: `tests/companion.test.mjs`

**Interfaces:**
- Consumes: `runAll` (Task 6), `scripts/config.json` (Task 1).
- Produces: CLI `node scripts/storm-companion.mjs plan "<task>"` → prints `{ mode, task, results }` JSON to stdout. Bad/missing args → stderr usage + exit 2.

- [ ] **Step 1: Write the failing test**

```js
// tests/companion.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../scripts/storm-companion.mjs', import.meta.url));

test('missing args -> exit 2 with usage', () => {
  const r = spawnSync(process.execPath, [ENTRY], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
});

test('wrong mode -> exit 2', () => {
  const r = spawnSync(process.execPath, [ENTRY, 'action', 'x'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/storm && node --test tests/companion.test.mjs`
Expected: FAIL — cannot find module `storm-companion.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/storm-companion.mjs
#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runAll } from './lib/fan-out.mjs';

async function main() {
  const [mode, task] = process.argv.slice(2);
  if (mode !== 'plan' || !task) {
    process.stderr.write('usage: storm-companion plan "<task>"\n');
    process.exit(2);
  }
  const cfg = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  const results = await runAll(task, cfg.engines, {
    role: cfg.role,
    repoPath: process.cwd(),
    timeoutMs: cfg.timeoutMs,
  });
  process.stdout.write(JSON.stringify({ mode, task, results }, null, 2) + '\n');
}

main().catch((e) => {
  process.stderr.write(`storm-companion error: ${e?.message ?? e}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/storm && node --test tests/companion.test.mjs`
Expected: PASS (2/2).

- [ ] **Step 5: Run the full suite**

Run: `cd ~/storm && npm test`
Expected: all test files PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/storm && git add scripts/storm-companion.mjs tests/companion.test.mjs
git commit -m "feat: storm-companion entrypoint emits normalized JSON"
```

---

### Task 8: Command + runtime skill (orchestrator wiring)

**Files:**
- Create: `commands/storm.md`, `skills/storm-runtime/SKILL.md`

**Interfaces:**
- Consumes: `scripts/storm-companion.mjs` (Task 7).
- Produces: `/storm` command available in Claude Code; orchestrator instructions for synthesis.

- [ ] **Step 1: Write `commands/storm.md`**

````markdown
---
description: Storm — convene a 3-engine council (Claude+Codex+Antigravity) on demand
---
# /storm

Usage: `/storm plan <task>`

You are the Storm orchestrator. On this command:

1. Run the council (reads config, spawns the three engines in parallel,
   normalizes each engine's output):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/storm-companion.mjs" plan "<the user's task>"
   ```

2. You receive JSON: `{ results: [{ engine, status, result|error }] }`. This is
   ALREADY normalized — you never see raw engine stdout (context-protection
   invariant).

3. Synthesize ONE answer:
   - Consensus (all engines agree) -> high-confidence.
   - Disagreements -> call them out explicitly for the user to review.
   - Unique findings per engine -> list them.
   - Any engine with status != ok -> note "<engine> did not answer (<reason>)"
     and synthesize from the rest.

4. Return a single structured answer. Do not dump raw per-engine results
   verbatim.

Only `plan` mode (read-only) exists in v1. `action` mode is a future phase.
````

- [ ] **Step 2: Write `skills/storm-runtime/SKILL.md`**

```markdown
---
name: storm-runtime
description: Internal contract for invoking the Storm multi-engine council runtime
user-invocable: false
---
# Storm Runtime

Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/storm-companion.mjs" plan "<task>"`

- Returns normalized JSON `{ mode, task, results: [{engine,status,result|error}] }`.
- Never exposes raw engine stdout — only the extracted STORM_RESULT block.
- Parse output, not exit codes.
- Engines with status `timeout`/`error`/`no_result` are degraded, not fatal:
  synthesize from the engines that answered.
```

- [ ] **Step 3: Verify the plugin loads and the command is visible**

Manual check: install/enable the local plugin in Claude Code (point it at
`~/storm`), then confirm `/storm` appears in the command list and
`${CLAUDE_PLUGIN_ROOT}` resolves. If `/storm` is not listed, fix the
`commands/storm.md` frontmatter before committing.

- [ ] **Step 4: Commit**

```bash
cd ~/storm && git add commands/storm.md skills/storm-runtime/SKILL.md
git commit -m "feat: /storm command + storm-runtime contract"
```

---

### Task 9: README + live smoke test

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the whole plugin.

- [ ] **Step 1: Write `README.md`**

```markdown
# Storm

Multi-engine council for Claude Code. `/storm plan <task>` fans a task out to
three independent engines — Claude, Codex (GPT), Antigravity (Gemini 3.1 Pro
High) — in parallel, normalizes each engine's output, and synthesizes one
answer (consensus / disagreements / unique findings).

## Requirements

- `claude`, `codex`, and `agy` CLIs installed and authenticated.
- Node.js 20+.

## Usage

```
/storm plan <task>
```

v1 is read-only (review / RCA / analysis). `action` mode (parallel
implementation in git worktrees + smart merge) is a future phase.

## Config

`scripts/config.json` — engines, models, timeouts. Antigravity is pinned to
`Gemini 3.1 Pro (High)`.

## License

Apache-2.0. Plugin structure adapted from the `codex` plugin (OpenAI); see NOTICE.
```

- [ ] **Step 2: Live smoke test on a real repo**

Run from inside a real git repo:
```bash
node ~/storm/scripts/storm-companion.mjs plan "Review the most recently changed file for bugs and risks."
```
Expected: JSON on stdout with 3 entries; each engine either `status: ok` with a
`result` string, or a degraded status. Confirm no raw engine chatter leaks into
the `result` fields (only the STORM_RESULT content).

- [ ] **Step 3: Drive `/storm` end-to-end in Claude Code**

In a Claude Code session with the plugin enabled, run:
`/storm plan Review the error handling in <some file> for edge cases.`
Expected: orchestrator runs the companion, then returns one synthesized answer
with consensus / disagreement / unique-findings structure. Verify context is not
flooded with raw output.

- [ ] **Step 4: Commit**

```bash
cd ~/storm && git add README.md
git commit -m "docs: README + smoke-tested plan-v1"
```

---

## Self-Review

**Spec coverage:**
- Command `/storm`, plan mode → Task 8 (+ Task 7 runtime). OK.
- Three engines with verified invocations → Task 4 adapters, config Task 1. OK.
- Context-protection invariant (markers, parse-not-exit-code, normalized only) → Task 2 parser, Task 5 run-engine, Task 8 command instructions. OK.
- Parallel fan-out → Task 6. OK.
- Graceful degradation → Task 5 (timeout/error/no_result) + Task 6 (one failure non-fatal) + Task 8 (synthesize from rest). OK.
- Synthesis (consensus/disagreement/unique) → Task 8 orchestrator prompt. OK.
- Plugin packaging, Apache-2.0 + NOTICE attribution → Task 1. OK.
- Testing (unit adapters/parser, contract fan-out, smoke) → Tasks 2-7 unit, Task 9 smoke. OK.
- `action` mode explicitly out of scope for v1 → stated in Global Constraints, README, command. OK.

**Type consistency:** `extractResult -> {ok,result|reason}`; `runInvocation/runEngine -> {engine,status,result|error}`; `runAll -> [that]`; `buildInvocation -> {cmd,args}`; `buildStormPrompt({task,role,repoPath})`; companion emits `{mode,task,results}`. Names consistent across Tasks 2-7.

**Placeholders:** none — every code step has full code; the only manual steps are the live smoke (Task 9) and plugin-load check (Task 8), which are inherently interactive.

## Notes for the implementer

- Codex `exec` may still emit progress lines around the final message; the
  `<STORM_RESULT>` marker + `extractResult` (last block) is what isolates the
  answer. If a real Codex run produces no marker, that is a prompt-adherence
  issue — strengthen the instruction in `prompt.mjs`, do not parse Codex's
  freeform text.
- `agy` and `gemini` return exit 0 even on errors; never branch on exit code.
- Keep `storm-companion.mjs` dependency-free so it runs under the user's Node
  without an install step.
