# Storm Delegate Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/storm delegate <engine> "<task>"` — один движок-исполнитель с полными правами делает задачу в изолированном git worktree; Claude Code принимает работу по отчёту + diffstat + patch-файлу.

**Architecture:** Новый mode в `storm-companion.mjs` поверх существующих модулей: worktree из `workspace.mjs` + snapshot-коммит как база диффа; промпт-контракт исполнителя из `prompt.mjs`; запуск через `run-engine.mjs` (stall v2, resolvedModel); патч снимается `git diff <baseRef> --binary` в tmp-файл; опциональный `--verify` через `runExperiment`. Спека: `docs/specs/2026-07-02-storm-delegate-design.md`.

**Tech Stack:** Node 20+ ESM, zero runtime deps, `node --test`.

## Global Constraints

- Zero runtime dependencies; plain Node ESM; тесты только `node --test`.
- Контекст-протекция: полный дифф и сырой stdout движка НИКОГДА не попадают в JSON-выход (только STORM_RESULT-отчёт, diffstat с капом 2000, patch-файл на диске).
- Промпт исполнителя НЕ содержит путь реального репо (инвариант fix a0dd235).
- Реальный репо не пишется companion'ом ни при каком статусе.
- `delegate` работает только с git-репо: не-git `--cwd` → exit 2.
- Дефолт `delegate.verifyTimeoutMs`: **120000**.
- Все тесты управляемые (runner-инъекция / fake-engine), никаких реальных CLI и sleep-гонок.
- Коммит-стиль: conventional commits, как в git log репо.

---

### Task 1: adapters — рефактор `cfg.proof` → `cfg.fullRights`

Семантика флага — «полные права», а не «proof-режим»: delegate включает его без proof.
Чистое переименование, поведение то же.

**Files:**
- Modify: `scripts/lib/adapters.mjs:22,28,46`
- Modify: `scripts/lib/fan-out.mjs:44` (строка `const cfg = { ...e, proof };`)
- Test: `tests/adapters.test.mjs:182-220` (секция proof-флагов)

**Interfaces:**
- Produces: `buildInvocation(engineId, prompt, cfg)` — full-rights флаги включаются по `cfg.fullRights === true` (раньше `cfg.proof`).
- fan-out продолжает включать полные права в proof-режиме: `{ ...e, fullRights: proof }`.

- [ ] **Step 1: Переименовать в тестах (red)**

В `tests/adapters.test.mjs` заменить секцию `// --- proof mode: full-rights flags for CLI engines ---` (строки 182-220) на:

```js
// --- full rights: flags for CLI engines (proof mode and delegate mode) ---

test('codex fullRights => danger-full-access', () => {
  const inv = buildInvocation('codex', 'p', { fullRights: true });
  assert.deepEqual(inv.args, ['exec', '-s', 'danger-full-access']);
});

test('codex no fullRights => plain exec (0.8.0)', () => {
  const inv = buildInvocation('codex', 'p', {});
  assert.deepEqual(inv.args, ['exec']);
});

test('claude fullRights => bypassPermissions', () => {
  const inv = buildInvocation('claude', 'p', { fullRights: true });
  assert.ok(inv.args.includes('--permission-mode'));
  assert.ok(inv.args.includes('bypassPermissions'));
});

test('claude no fullRights => no permission-mode (0.8.0)', () => {
  const inv = buildInvocation('claude', 'p', {});
  assert.ok(!inv.args.includes('--permission-mode'));
});

test('glm fullRights => bypassPermissions', () => {
  const inv = buildInvocation('glm', 'p', { apiKey: 'K', fullRights: true });
  assert.ok(inv.args.includes('--permission-mode'));
  assert.ok(inv.args.includes('bypassPermissions'));
});

test('glm no fullRights => no permission-mode (0.8.0)', () => {
  const inv = buildInvocation('glm', 'p', { apiKey: 'K' });
  assert.ok(!inv.args.includes('--permission-mode'));
});

test('gemini fullRights => unchanged (read-only wrapper, no exec)', () => {
  const inv1 = buildInvocation('gemini', 'p', { apiKey: 'K', fullRights: true });
  const inv2 = buildInvocation('gemini', 'p', { apiKey: 'K' });
  assert.deepEqual(inv1.args, inv2.args);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test tests/adapters.test.mjs 2>&1 | grep -E '✖|fail [0-9]'`
Expected: 3 падения (codex/claude/glm fullRights — флаги не появились).

- [ ] **Step 3: Переименовать в коде**

В `scripts/lib/adapters.mjs`:
- строка 22 (claude): `...(cfg.proof ? [...] : [])` → `...(cfg.fullRights ? ['--permission-mode', 'bypassPermissions'] : [])`
- строка 28 (codex): `cfg.proof ? ['exec', '-s', 'danger-full-access'] : ['exec']` → `cfg.fullRights ? ['exec', '-s', 'danger-full-access'] : ['exec']`
- строка 46 (glm): `...(cfg.proof ? [...] : [])` → `...(cfg.fullRights ? ['--permission-mode', 'bypassPermissions'] : [])`

В `scripts/lib/fan-out.mjs` строку:

```js
        const cfg = { ...e, proof };
```

заменить на:

```js
        // fullRights: proof engines self-experiment with write/exec/network in
        // their worktrees; delegate mode sets this unconditionally.
        const cfg = { ...e, fullRights: proof };
```

- [ ] **Step 4: Прогнать адаптеры и fan-out**

Run: `node --test tests/adapters.test.mjs tests/fan-out.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/adapters.mjs scripts/lib/fan-out.mjs tests/adapters.test.mjs
git commit -m "refactor(adapters): rename cfg.proof -> cfg.fullRights (delegate reuses it)"
```

---

### Task 2: prompt — контракт исполнителя `buildDelegatePrompt`

**Files:**
- Modify: `scripts/lib/prompt.mjs` (добавить в конец)
- Test: `tests/prompt.test.mjs` (добавить в конец)

**Interfaces:**
- Produces: `buildDelegatePrompt({ task }) → string` — без role-строки, без пути репо; STORM_RESULT-маркеры обязательны.

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `tests/prompt.test.mjs`:

```js
// --- delegate: executor contract ---
import { buildDelegatePrompt } from '../scripts/lib/prompt.mjs';

test('delegate prompt: task, executor contract, markers — and NO repo path, NO role line', () => {
  const p = buildDelegatePrompt({ task: 'fix the flaky retry logic' });
  assert.match(p, /fix the flaky retry logic/);
  assert.match(p, /EXECUTOR/);
  assert.match(p, /isolated copy/i);
  assert.match(p, /<STORM_RESULT>/);
  assert.match(p, /<\/STORM_RESULT>/);
  assert.doesNotMatch(p, /Repository:/);
  assert.doesNotMatch(p, /senior code reviewer/i);
});

test('delegate prompt: asks for a report (did/verified/limitations), not findings grammar', () => {
  const p = buildDelegatePrompt({ task: 'x' });
  assert.match(p, /what you did/i);
  assert.match(p, /what you verified/i);
  assert.doesNotMatch(p, /\[FINDING\]/);
});
```

- [ ] **Step 2: Убедиться, что падают**

Run: `node --test tests/prompt.test.mjs 2>&1 | grep -E '✖|fail [0-9]'`
Expected: FAIL — `buildDelegatePrompt` не экспортирован.

- [ ] **Step 3: Имплементация**

Добавить в конец `scripts/lib/prompt.mjs`:

```js
// Delegate mode: the engine is a full-rights EXECUTOR in an isolated worktree.
// No role framing, no repo path (isolation invariant, see fix a0dd235) — the
// contract's "." is all it needs. File changes are collected as a patch by the
// orchestrator, so committing is not required.
const DELEGATE_CONTRACT = [
  'You are the EXECUTOR of a delegated task.',
  'Your working directory (`.`) is an isolated copy of the repository. Work only here.',
  'Do the task end-to-end: write code, run commands and tests, experiment freely.',
  'You have full rights in this copy. Committing is not required — file changes',
  'are collected automatically when you finish.',
  'When done, output ONLY a report wrapped in the markers, nothing after the close:',
  '<STORM_RESULT>',
  '- what you did (files touched, approach)',
  '- what you verified (commands run, results)',
  '- known limitations / follow-ups',
  '</STORM_RESULT>',
];

export function buildDelegatePrompt({ task } = {}) {
  return [`Task: ${task}`, '', ...DELEGATE_CONTRACT].join('\n');
}
```

- [ ] **Step 4: Прогнать**

Run: `node --test tests/prompt.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/prompt.mjs tests/prompt.test.mjs
git commit -m "feat(prompt): delegate executor contract (no repo path, report-shaped output)"
```

---

### Task 3: workspace — `isGitRepo` + `snapshotWorkspace`

Snapshot-коммит отсекает перенесённые uncommitted-правки владельца от работы движка:
патч потом диффится от `baseRef` и содержит строго работу исполнителя.

**Files:**
- Modify: `scripts/lib/workspace.mjs`
- Test: `tests/workspace.test.mjs` (добавить в конец)

**Interfaces:**
- Produces: `isGitRepo(repoPath, deps?) → boolean`; `snapshotWorkspace(dir, deps?) → string` (sha снапшот-коммита).
- `makeEngineWorkspace` не меняет поведения (proof-путь нетронут).

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `tests/workspace.test.mjs` (в файле уже есть импорты `mkdtempSync`/`join`/`tmpdir`/`execFileSync` и helper создания репо — если helper называется иначе, использовать местный; ниже — самодостаточный вариант):

```js
import { isGitRepo, snapshotWorkspace } from '../scripts/lib/workspace.mjs';

function initRepoWS() {
  const dir = mkdtempSync(join(tmpdir(), 'storm-ws-snap-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'committed\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

test('isGitRepo: true for a git repo, false for a plain dir', () => {
  const repo = initRepoWS();
  const plain = mkdtempSync(join(tmpdir(), 'storm-ws-plain-'));
  try {
    assert.equal(isGitRepo(repo), true);
    assert.equal(isGitRepo(plain), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test('snapshotWorkspace: commits transferred state, returns a sha; works with clean tree too', () => {
  const repo = initRepoWS();
  try {
    // dirty file (simulates transferred uncommitted work)
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');
    const sha = snapshotWorkspace(repo);
    assert.match(sha, /^[0-9a-f]{40}$/);
    const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.equal(status.trim(), '', 'snapshot must leave a clean tree');
    // clean tree: --allow-empty makes a second snapshot still return a sha
    const sha2 = snapshotWorkspace(repo);
    assert.match(sha2, /^[0-9a-f]{40}$/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
```

Если каких-то импортов (`writeFileSync`, `rmSync`, `execFileSync`, `mkdtempSync`, `join`, `tmpdir`, `test`, `assert`) в шапке файла нет — добавить в существующие import-строки.

- [ ] **Step 2: Убедиться, что падают**

Run: `node --test tests/workspace.test.mjs 2>&1 | grep -E '✖|fail [0-9]'`
Expected: FAIL — экспорты не существуют.

- [ ] **Step 3: Имплементация**

В `scripts/lib/workspace.mjs`:

1) Выделить и экспортировать git-детект (сейчас инлайн в `makeEngineWorkspace`, строки 20-22):

```js
// True when repoPath is inside a git work tree. Exported for delegate mode's
// fail-fast (delegate is git-only: a cp-copy has nothing to diff against).
export function isGitRepo(repoPath, deps = {}) {
  const run = deps.run ?? ((cmd, args, opts) => ({ stdout: execFileSync(cmd, args, opts) }));
  try {
    return String(git(repoPath, ['rev-parse', '--is-inside-work-tree'], run).stdout).trim() === 'true';
  } catch {
    return false;
  }
}
```

и в `makeEngineWorkspace` заменить инлайн-детект на `const isGit = isGitRepo(repoPath, { run });`.

2) Добавить snapshot:

```js
// Commit the workspace's current state (transferred uncommitted + untracked)
// as the diff base for delegate mode. Local identity: independent of the
// user's global git config. --allow-empty: a clean tree still yields a base.
export function snapshotWorkspace(dir, deps = {}) {
  const run = deps.run ?? ((cmd, args, opts) => ({ stdout: execFileSync(cmd, args, opts) }));
  run('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
  run('git', ['-C', dir, '-c', 'user.email=storm@local', '-c', 'user.name=storm',
    'commit', '-q', '--allow-empty', '-m', 'storm-delegate base snapshot'], { encoding: 'utf8' });
  return String(run('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout).trim();
}
```

- [ ] **Step 4: Прогнать workspace + полный сьют (рефактор изнутри makeEngineWorkspace)**

Run: `node --test tests/workspace.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail)'` затем `node --test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 0` оба раза.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/workspace.mjs tests/workspace.test.mjs
git commit -m "feat(workspace): isGitRepo + snapshotWorkspace (delegate diff base)"
```

---

### Task 4: heartbeat — выделить хелпер из fan-out

Delegate работает с одним движком мимо `runAll`; heartbeat переиспользуется, не дублируется.

**Files:**
- Create: `scripts/lib/heartbeat.mjs`
- Modify: `scripts/lib/fan-out.mjs` (строки 12-30, 35-37, 48, 56 — вся heartbeat-обвязка)
- Test: `tests/fan-out.test.mjs` (существующие heartbeat-тесты остаются зелёными — это и есть тест рефактора)

**Interfaces:**
- Produces: `createHeartbeat(engineIds: string[], { heartbeatMs?, onHeartbeat? }) → { onProgress(id, {chunks, lastActivityAt}), setStatus(id, status), stop() }`
- Формат строки НЕ меняется: `[storm +45s] claude: 130ev idle 2s | codex: stalled`

- [ ] **Step 1: Создать `scripts/lib/heartbeat.mjs`**

```js
// scripts/lib/heartbeat.mjs
// Periodic per-engine progress line to stderr (or a custom sink). Extracted
// from fan-out so delegate mode (single engine, no runAll) reuses it.
// heartbeatMs <= 0 / non-finite disables the timer entirely.
export function createHeartbeat(engineIds, opts = {}) {
  const hbMs = opts.heartbeatMs ?? 15000;
  const write = opts.onHeartbeat ?? ((line) => process.stderr.write(line + '\n'));
  const progress = {}; // id -> { chunks, lastActivityAt, status }
  const startedAt = Date.now();
  let timer = null;
  if (Number.isFinite(hbMs) && hbMs > 0) {
    timer = setInterval(() => {
      const now = Date.now();
      const parts = engineIds.map((id) => {
        const p = progress[id];
        if (!p) return `${id}: …`;
        if (p.status && p.status !== 'ok') return `${id}: ${p.status}`;
        const idle = Math.round((now - (p.lastActivityAt ?? now)) / 1000);
        return `${id}: ${p.chunks ?? 0}ev idle ${idle}s`;
      });
      write(`[storm +${Math.round((now - startedAt) / 1000)}s] ${parts.join(' | ')}`);
    }, hbMs);
    if (timer.unref) timer.unref();
  }
  return {
    onProgress: (id, s) => {
      progress[id] = { ...(progress[id] ?? {}), chunks: s.chunks, lastActivityAt: s.lastActivityAt, status: null };
    },
    setStatus: (id, status) => {
      progress[id] = { ...(progress[id] ?? {}), status };
    },
    stop: () => { if (timer) clearInterval(timer); },
  };
}
```

- [ ] **Step 2: Переключить fan-out на хелпер**

`scripts/lib/fan-out.mjs` целиком становится:

```js
// scripts/lib/fan-out.mjs
import { runEngine } from './run-engine.mjs';
import { buildStormPrompt } from './prompt.mjs';
import { makeEngineWorkspace } from './workspace.mjs';
import { createHeartbeat } from './heartbeat.mjs';

export async function runAll(task, engines, opts = {}) {
  const runner = opts.runner ?? runEngine;
  const role = opts.role ?? 'reviewer';
  const proof = !!opts.proof;
  // Proof engines run with full rights inside per-engine worktrees; the prompt
  // must not name the real repo path, or an engine may follow it out of its
  // isolation. The self-experiment contract already says "." is its working copy.
  const prompt = buildStormPrompt({ task, role, repoPath: proof ? undefined : opts.cwd, proof });

  const hb = createHeartbeat(engines.map((e) => e.id), {
    heartbeatMs: opts.heartbeatMs,
    onHeartbeat: opts.onHeartbeat,
  });

  const settled = await Promise.allSettled(
    engines.map(async (e) => {
      let ws = null;
      try {
        const cwd = proof ? (ws = makeEngineWorkspace(opts.cwd, e.id)).dir : opts.cwd;
        // fullRights: proof engines self-experiment with write/exec/network in
        // their worktrees; delegate mode sets this unconditionally.
        const cfg = { ...e, fullRights: proof };
        const res = await runner(e.id, prompt, cfg, {
          timeoutMs: opts.timeoutMs,
          stallMs: e.stallMs ?? opts.stallMs,
          cwd,
          env: e.experimentEnv,
          onProgress: (s) => hb.onProgress(e.id, s),
        });
        hb.setStatus(e.id, res.status);
        return res;
      } finally {
        if (ws) ws.cleanup();
      }
    })
  );

  hb.stop();

  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { engine: engines[i].id, status: 'error', error: s.reason?.message ?? String(s.reason) }
  );
}
```

- [ ] **Step 3: Прогнать fan-out (13 тестов, включая 2 heartbeat — это тест рефактора)**

Run: `node --test tests/fan-out.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 0` (все 13).

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/heartbeat.mjs scripts/lib/fan-out.mjs
git commit -m "refactor(heartbeat): extract createHeartbeat from fan-out for delegate reuse"
```

---

### Task 5: delegate core — `extractPatch` + `runDelegate`

**Files:**
- Create: `scripts/lib/delegate.mjs`
- Test: `tests/delegate.test.mjs` (новый)

**Interfaces:**
- Consumes: `makeEngineWorkspace`/`isGitRepo`/`snapshotWorkspace` (Task 3), `buildDelegatePrompt` (Task 2), `createHeartbeat` (Task 4), `runEngine` (существующий), `cfg.fullRights` (Task 1).
- Produces:
  - `extractPatch(wsDir, baseRef, engineId) → { path, files, insertions, deletions, stat } | null`
  - `runDelegate(task, engine, opts) → { mode:'delegate', engine, resolvedModel, task, repoPath, status, result?, error?, patch, verify }` (verify в этой задаче всегда `null`; Task 6 наполняет).
  - `opts`: `{ cwd, runner?, timeoutMs?, stallMs?, verify?, verifyTimeoutMs?, heartbeatMs?, onHeartbeat? }`. Не-git `opts.cwd` → reject `Error(/git repository/)`.

- [ ] **Step 1: Написать падающие тесты**

Создать `tests/delegate.test.mjs`:

```js
// tests/delegate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDelegate } from '../scripts/lib/delegate.mjs';

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'storm-dlg-test-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'f.txt'), 'hello\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

// A runner that plays the executor: writes a file into its worktree (opts.cwd).
function writingRunner({ file = 'made-by-engine.txt', content = 'engine work\n', status = 'ok' } = {}) {
  return (id, _prompt, _cfg, opts) => {
    writeFileSync(join(opts.cwd, file), content);
    return Promise.resolve({ engine: id, status, result: 'did the thing', resolvedModel: 'fake-model' });
  };
}

test('happy path: patch contains the engine work; the real repo is untouched', async () => {
  const repo = initRepo();
  try {
    const out = await runDelegate('do it', { id: 'codex' }, { cwd: repo, runner: writingRunner() });
    assert.equal(out.mode, 'delegate');
    assert.equal(out.engine, 'codex');
    assert.equal(out.status, 'ok');
    assert.equal(out.result, 'did the thing');
    assert.equal(out.resolvedModel, 'fake-model');
    assert.equal(out.repoPath, repo);
    assert.ok(out.patch, 'patch expected');
    const patchText = readFileSync(out.patch.path, 'utf8');
    assert.match(patchText, /made-by-engine\.txt/);
    assert.match(patchText, /engine work/);
    assert.equal(out.patch.files, 1);
    assert.ok(out.patch.stat.includes('made-by-engine.txt'));
    // the real repo: no engine file, clean status
    assert.equal(existsSync(join(repo, 'made-by-engine.txt')), false, 'real repo must be untouched');
    const status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.equal(status.trim(), '');
    assert.equal(out.verify, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('snapshot base: transferred uncommitted work does NOT leak into the patch', async () => {
  const repo = initRepo();
  try {
    // Owner's uncommitted local edit — transferred into the worktree, must not be in the patch.
    writeFileSync(join(repo, 'owner-wip.txt'), 'owner uncommitted\n');
    const out = await runDelegate('do it', { id: 'glm' }, { cwd: repo, runner: writingRunner({ file: 'engine.txt' }) });
    const patchText = readFileSync(out.patch.path, 'utf8');
    assert.match(patchText, /engine\.txt/);
    assert.doesNotMatch(patchText, /owner-wip/, 'transferred uncommitted work must be excluded by the snapshot base');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an engine that commits in its worktree still yields the full patch (diff from baseRef)', async () => {
  const repo = initRepo();
  try {
    const committingRunner = (id, _p, _c, opts) => {
      writeFileSync(join(opts.cwd, 'committed-by-engine.txt'), 'x\n');
      execFileSync('git', ['-C', opts.cwd, 'add', '-A']);
      execFileSync('git', ['-C', opts.cwd, '-c', 'user.email=e@e', '-c', 'user.name=e', 'commit', '-qm', 'engine commit']);
      return Promise.resolve({ engine: id, status: 'ok', result: 'committed' });
    };
    const out = await runDelegate('do it', { id: 'codex' }, { cwd: repo, runner: committingRunner });
    assert.ok(out.patch, 'patch expected even when the engine committed');
    assert.match(readFileSync(out.patch.path, 'utf8'), /committed-by-engine\.txt/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('no changes => patch is null, status ok (planning tasks deliver via the report)', async () => {
  const repo = initRepo();
  try {
    const idleRunner = (id) => Promise.resolve({ engine: id, status: 'ok', result: 'the plan: …' });
    const out = await runDelegate('plan it', { id: 'claude' }, { cwd: repo, runner: idleRunner });
    assert.equal(out.status, 'ok');
    assert.equal(out.patch, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('stalled engine: status stays stalled, partial work is still snapped as a patch', async () => {
  const repo = initRepo();
  try {
    const stallingRunner = (id, _p, _c, opts) => {
      writeFileSync(join(opts.cwd, 'partial.txt'), 'half-done\n');
      return Promise.resolve({ engine: id, status: 'stalled', error: 'no output for 60000ms' });
    };
    const out = await runDelegate('do it', { id: 'glm' }, { cwd: repo, runner: stallingRunner });
    assert.equal(out.status, 'stalled');
    assert.ok(out.patch, 'partial patch expected');
    assert.match(readFileSync(out.patch.path, 'utf8'), /partial\.txt/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('delegate prompt: executor contract without the real repo path; cfg.fullRights set', async () => {
  const repo = initRepo();
  try {
    let seenPrompt = null, seenCfg = null;
    const runner = (id, prompt, cfg) => {
      seenPrompt = prompt; seenCfg = cfg;
      return Promise.resolve({ engine: id, status: 'ok', result: 'r' });
    };
    await runDelegate('t', { id: 'codex', stallMs: 180000 }, { cwd: repo, runner });
    assert.ok(!seenPrompt.includes(repo), 'prompt must not contain the real repo path');
    assert.match(seenPrompt, /EXECUTOR/);
    assert.equal(seenCfg.fullRights, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('per-engine stallMs reaches the runner opts; engine worktree is cleaned up', async () => {
  const repo = initRepo();
  try {
    let seenOpts = null, wsDir = null;
    const runner = (id, _p, _c, opts) => {
      seenOpts = opts; wsDir = opts.cwd;
      return Promise.resolve({ engine: id, status: 'ok', result: 'r' });
    };
    await runDelegate('t', { id: 'codex', stallMs: 180000 }, { cwd: repo, runner, stallMs: 999 });
    assert.equal(seenOpts.stallMs, 180000);
    assert.notEqual(wsDir, repo, 'engine must run in a worktree, not the repo');
    assert.equal(existsSync(wsDir), false, 'worktree must be cleaned up');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('non-git cwd rejects with a clear error (fail-fast, no engine spawn)', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'storm-dlg-plain-'));
  try {
    let runnerCalled = false;
    const runner = () => { runnerCalled = true; return Promise.resolve({ status: 'ok' }); };
    await assert.rejects(
      () => runDelegate('t', { id: 'codex' }, { cwd: plain, runner }),
      /git repository/
    );
    assert.equal(runnerCalled, false, 'engine must not spawn for a non-git target');
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Убедиться, что падают**

Run: `node --test tests/delegate.test.mjs 2>&1 | grep -E '✖|fail [0-9]' | head -3`
Expected: FAIL — модуля `delegate.mjs` нет.

- [ ] **Step 3: Имплементация**

Создать `scripts/lib/delegate.mjs`:

```js
// scripts/lib/delegate.mjs
// Delegate mode: one engine works as a full-rights EXECUTOR in an isolated git
// worktree; the orchestrator (Claude Code) accepts the work as a report +
// diffstat + patch file. The real repo is never written by the companion.
// WHY: docs/specs/2026-07-02-storm-delegate-design.md
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runEngine } from './run-engine.mjs';
import { buildDelegatePrompt } from './prompt.mjs';
import { makeEngineWorkspace, isGitRepo, snapshotWorkspace } from './workspace.mjs';
import { createHeartbeat } from './heartbeat.mjs';

const STAT_CAP = 2000; // context-protection: diffstat tail cap in the JSON output

function git(dir, args, opts = {}) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

// Snap the executor's work as a patch file. baseRef is the post-transfer
// snapshot, so the patch is strictly the engine's own work (committed or not:
// `git add -A` makes new files tracked; diff vs baseRef covers engine commits
// too). Returns null when nothing changed. The patch file lives in its own tmp
// dir and survives worktree cleanup.
export function extractPatch(wsDir, baseRef, engineId) {
  git(wsDir, ['add', '-A']);
  const patch = git(wsDir, ['diff', baseRef, '--binary']);
  if (!patch.trim()) return null;
  const stat = git(wsDir, ['diff', baseRef, '--stat']);
  const dir = mkdtempSync(join(tmpdir(), 'storm-delegate-'));
  const path = join(dir, `delegate-${engineId}.patch`);
  writeFileSync(path, patch);
  const m = stat.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  return {
    path,
    files: m ? Number(m[1]) : null,
    insertions: m?.[2] ? Number(m[2]) : 0,
    deletions: m?.[3] ? Number(m[3]) : 0,
    stat: stat.trim().slice(-STAT_CAP),
  };
}

export async function runDelegate(task, engine, opts = {}) {
  const runner = opts.runner ?? runEngine;
  // Fail-fast BEFORE any workspace/spawn work: delegate is git-only (a cp-copy
  // has nothing to diff a patch against).
  if (!isGitRepo(opts.cwd)) {
    throw new Error(`delegate requires a git repository at --cwd, got: ${opts.cwd}`);
  }
  const ws = makeEngineWorkspace(opts.cwd, `delegate-${engine.id}`);
  const hb = createHeartbeat([engine.id], { heartbeatMs: opts.heartbeatMs, onHeartbeat: opts.onHeartbeat });
  try {
    const baseRef = snapshotWorkspace(ws.dir);
    const prompt = buildDelegatePrompt({ task });
    const res = await runner(engine.id, prompt, { ...engine, fullRights: true }, {
      timeoutMs: opts.timeoutMs,
      stallMs: engine.stallMs ?? opts.stallMs,
      cwd: ws.dir,
      env: engine.experimentEnv,
      onProgress: (s) => hb.onProgress(engine.id, s),
    });
    hb.setStatus(engine.id, res.status);
    // Snap the patch for ANY status: partial work of a stalled/killed engine
    // may be valuable; the caller decides by status (default: don't apply).
    const patch = extractPatch(ws.dir, baseRef, engine.id);
    return {
      mode: 'delegate',
      engine: engine.id,
      resolvedModel: res.resolvedModel ?? null,
      task,
      repoPath: opts.cwd,
      status: res.status,
      ...(res.result !== undefined ? { result: res.result } : {}),
      ...(res.error !== undefined ? { error: res.error } : {}),
      patch,
      verify: null, // filled by --verify (Task 6)
    };
  } finally {
    hb.stop();
    ws.cleanup(); // idempotent, never throws (workspace contract)
  }
}
```

- [ ] **Step 4: Прогнать**

Run: `node --test tests/delegate.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 0` (8 тестов).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/delegate.mjs tests/delegate.test.mjs
git commit -m "feat(delegate): executor worktree run + patch extraction from snapshot base"
```

---

### Task 6: delegate — приёмочный `--verify`

**Files:**
- Modify: `scripts/lib/delegate.mjs`
- Test: `tests/delegate.test.mjs` (добавить в конец)

**Interfaces:**
- Consumes: `runExperiment(run, cwd, {timeoutMs, env})` из `proof.mjs`, `experimentEnv()` из `sandbox.mjs` (оба существуют).
- Produces: `opts.verify` (строка-команда) → поле `verify: { run, exitCode, stdoutTail, stderrTail, timedOut }` в выходе `runDelegate`; таймаут `opts.verifyTimeoutMs ?? 120000`.

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `tests/delegate.test.mjs`:

```js
// --- --verify: acceptance check inside the worktree, before the patch is handed over ---

test('verify pass: exitCode 0 lands in the output', async () => {
  const repo = initRepo();
  try {
    const out = await runDelegate('t', { id: 'codex' }, { cwd: repo, runner: writingRunner(), verify: 'exit 0' });
    assert.ok(out.verify, 'verify block expected');
    assert.equal(out.verify.run, 'exit 0');
    assert.equal(out.verify.exitCode, 0);
    assert.equal(out.verify.timedOut, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('verify fail: non-zero exitCode is reported, patch still extracted', async () => {
  const repo = initRepo();
  try {
    const out = await runDelegate('t', { id: 'codex' }, { cwd: repo, runner: writingRunner(), verify: 'echo broken >&2; exit 3' });
    assert.equal(out.verify.exitCode, 3);
    assert.match(out.verify.stderrTail, /broken/);
    assert.ok(out.patch, 'patch is still handed over; applying is the caller\'s decision');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('verify timeout: timedOut true, exitCode null', async () => {
  const repo = initRepo();
  try {
    const out = await runDelegate('t', { id: 'codex' }, {
      cwd: repo, runner: writingRunner(), verify: 'sleep 5', verifyTimeoutMs: 200,
    });
    assert.equal(out.verify.timedOut, true);
    assert.equal(out.verify.exitCode, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('verify runs INSIDE the worktree and AFTER patch extraction (its artifacts stay out of the patch)', async () => {
  const repo = initRepo();
  try {
    const out = await runDelegate('t', { id: 'codex' }, {
      cwd: repo, runner: writingRunner(), verify: 'echo artifact > verify-artifact.txt; test -f made-by-engine.txt',
    });
    assert.equal(out.verify.exitCode, 0, 'verify must see the engine work in its cwd (worktree)');
    assert.doesNotMatch(readFileSync(out.patch.path, 'utf8'), /verify-artifact/, 'verify artifacts must not be in the patch');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Убедиться, что падают**

Run: `node --test tests/delegate.test.mjs 2>&1 | grep -E '✖|fail [0-9]' | head -5`
Expected: 4 новых FAIL (`out.verify` — `null`).

- [ ] **Step 3: Имплементация**

В `scripts/lib/delegate.mjs`:

1) Импорты сверху:

```js
import { runExperiment } from './proof.mjs';
import { experimentEnv } from './sandbox.mjs';
```

2) В `runDelegate` заменить строку `const patch = extractPatch(ws.dir, baseRef, engine.id);` и блок `return` на:

```js
    const patch = extractPatch(ws.dir, baseRef, engine.id);
    // Acceptance check AFTER patch extraction (its artifacts stay out of the
    // patch) and INSIDE the worktree (dirt never reaches the real repo).
    // experimentEnv: minimal env, no provider keys — same policy as proof re-runs.
    let verify = null;
    if (opts.verify) {
      const v = await runExperiment(opts.verify, ws.dir, {
        timeoutMs: opts.verifyTimeoutMs ?? 120000,
        env: experimentEnv(),
      });
      verify = { run: opts.verify, exitCode: v.exitCode, stdoutTail: v.stdoutTail, stderrTail: v.stderrTail, timedOut: v.timedOut };
    }
    return {
      mode: 'delegate',
      engine: engine.id,
      resolvedModel: res.resolvedModel ?? null,
      task,
      repoPath: opts.cwd,
      status: res.status,
      ...(res.result !== undefined ? { result: res.result } : {}),
      ...(res.error !== undefined ? { error: res.error } : {}),
      patch,
      verify,
    };
```

(комментарий `verify: null, // filled by --verify (Task 6)` удалить.)

- [ ] **Step 4: Прогнать**

Run: `node --test tests/delegate.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 0` (12 тестов).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/delegate.mjs tests/delegate.test.mjs
git commit -m "feat(delegate): --verify acceptance run in the worktree (post-patch, pre-handover)"
```

---

### Task 7: cli-args — `delegate <engine>` + `--verify`

**Files:**
- Modify: `scripts/lib/cli-args.mjs`
- Test: `tests/cli-args.test.mjs` (добавить в конец)

**Interfaces:**
- Produces: `parseStormArgs(argv, deps?) → { mode, task, cwd, engine, verify }`:
  - `plan`: positionals `[mode, task]`, `engine`/`verify` = `null`/`null` (verify парсится, но plan его игнорирует).
  - `delegate`: positionals `[mode, engine, task]`.
  - `--verify` без значения → throw `Error('--verify requires a command')`.
- Существующее поведение `plan`/`--cwd` не меняется (обратная совместимость тестов).

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `tests/cli-args.test.mjs` (файл уже импортирует `parseStormArgs`; deps-стаб для `--cwd` смотри в существующих тестах файла и переиспользуй его подход):

```js
// --- delegate mode arguments ---

test('delegate: positionals are [mode, engine, task]', () => {
  const { mode, engine, task } = parseStormArgs(['delegate', 'codex', 'fix the bug']);
  assert.equal(mode, 'delegate');
  assert.equal(engine, 'codex');
  assert.equal(task, 'fix the bug');
});

test('plan: engine is null, task in the old position (backward compat)', () => {
  const { mode, engine, task } = parseStormArgs(['plan', 'review this']);
  assert.equal(mode, 'plan');
  assert.equal(engine, null);
  assert.equal(task, 'review this');
});

test('--verify is captured position-independently', () => {
  const a = parseStormArgs(['delegate', 'glm', 't', '--verify', 'npm test']);
  assert.equal(a.verify, 'npm test');
  const b = parseStormArgs(['--verify', 'npm test', 'delegate', 'glm', 't']);
  assert.equal(b.verify, 'npm test');
  assert.equal(b.engine, 'glm');
});

test('--verify without a value throws (fail-fast)', () => {
  assert.throws(() => parseStormArgs(['delegate', 'codex', 't', '--verify']), /--verify requires/);
});

test('no --verify => verify is null', () => {
  assert.equal(parseStormArgs(['plan', 't']).verify, null);
});
```

- [ ] **Step 2: Убедиться, что падают**

Run: `node --test tests/cli-args.test.mjs 2>&1 | grep -E '✖|fail [0-9]' | head -3`
Expected: FAIL (engine/verify undefined).

- [ ] **Step 3: Имплементация**

`scripts/lib/cli-args.mjs`, внутри `parseStormArgs`: добавить парсинг `--verify` в цикл и разложить positionals по mode. Функция целиком:

```js
export function parseStormArgs(argv, deps = {}) {
  const stat = deps.statSync ?? statSync;
  const getCwd = deps.cwd ?? (() => process.cwd());
  const positionals = [];
  let cwdRaw = null;
  let verify = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') {
      cwdRaw = argv[i + 1];
      if (cwdRaw == null) throw new Error('--cwd requires a path');
      i++; // consume the value
      continue;
    }
    if (argv[i] === '--verify') {
      verify = argv[i + 1];
      if (verify == null) throw new Error('--verify requires a command');
      i++; // consume the value
      continue;
    }
    positionals.push(argv[i]);
  }
  // plan: [mode, task]; delegate: [mode, engine, task]
  const [mode, ...rest] = positionals;
  const engine = mode === 'delegate' ? (rest[0] ?? null) : null;
  const task = mode === 'delegate' ? rest[1] : rest[0];
  let cwd;
  if (cwdRaw == null) {
    cwd = getCwd();
  } else {
    cwd = resolve(cwdRaw);
    let st;
    try { st = stat(cwd); } catch { throw new Error(`--cwd: path does not exist: ${cwd}`); }
    if (!st.isDirectory()) throw new Error(`--cwd: not a directory: ${cwd}`);
  }
  return { mode, task, cwd, engine, verify };
}
```

(шапка файла и комментарий WHY остаются; в комментарий добавить строку `// delegate: [mode, engine, task]; --verify <cmd> — acceptance check (delegate only).`)

- [ ] **Step 4: Прогнать cli-args + companion (companion деструктурирует parseStormArgs — совместимость)**

Run: `node --test tests/cli-args.test.mjs tests/companion.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/cli-args.mjs tests/cli-args.test.mjs
git commit -m "feat(cli): parse delegate <engine> positionals + --verify flag"
```

---

### Task 8: companion — ветвление mode + config + fail-fast тесты

**Files:**
- Modify: `scripts/storm-companion.mjs`
- Modify: `scripts/config.json` (блок `delegate`)
- Test: `tests/companion.test.mjs` (добавить в конец)

**Interfaces:**
- Consumes: `runDelegate` (Task 5-6), `parseStormArgs` (Task 7), `injectSecrets`/`loadSecrets` (существующие).
- Produces: CLI `delegate <engine> "<task>" [--cwd] [--verify]`; exit 2 на: неизвестный engine, не-git cwd, отсутствие task/engine. JSON delegate-результата на stdout.

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `tests/companion.test.mjs` (в файле уже есть импорты для чтения config; для spawn добавить импорты как ниже):

```js
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPANION = fileURLToPath(new URL('../scripts/storm-companion.mjs', import.meta.url));

test('config carries delegate.verifyTimeoutMs = 120000', async () => {
  const fs = await import('node:fs');
  const cfg = JSON.parse(fs.readFileSync(new URL('../scripts/config.json', import.meta.url), 'utf8'));
  assert.equal(cfg.delegate.verifyTimeoutMs, 120000);
});

test('delegate: unknown engine => exit 2 with a clear error, no spawn', () => {
  const r = spawnSync(process.execPath, [COMPANION, 'delegate', 'nosuchengine', 'task'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown engine: nosuchengine/);
});

test('delegate: non-git --cwd => exit 2 (fail-fast before any engine spawn)', () => {
  const plain = mkdtempSync(join(tmpdir(), 'storm-companion-plain-'));
  try {
    const r = spawnSync(process.execPath, [COMPANION, 'delegate', 'codex', 'task', '--cwd', plain], { encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /git repository/);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('delegate: missing engine/task => usage + exit 2', () => {
  const r = spawnSync(process.execPath, [COMPANION, 'delegate'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});
```

- [ ] **Step 2: Убедиться, что падают**

Run: `node --test tests/companion.test.mjs 2>&1 | grep -E '✖|fail [0-9]' | head -5`
Expected: 4 новых FAIL (config без delegate-блока; companion отвергает mode delegate общим usage exit 2 — но без текста `unknown engine`/`git repository`, поэтому matcher-тесты падают).

- [ ] **Step 3: Имплементация**

1) `scripts/config.json` — добавить блок (после `proof`):

```json
  "delegate": { "verifyTimeoutMs": 120000 },
```

2) `scripts/storm-companion.mjs` — целиком:

```js
#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runAll } from './lib/fan-out.mjs';
import { loadSecrets, injectSecrets } from './lib/secrets.mjs';
import { parseStormArgs } from './lib/cli-args.mjs';

const USAGE = 'usage: storm-companion plan "<task>" [--cwd <abs-path>] | delegate <engine> "<task>" [--cwd <abs-path>] [--verify "<cmd>"]\n';

async function main() {
  let mode, task, cwd, engine, verify;
  try {
    ({ mode, task, cwd, engine, verify } = parseStormArgs(process.argv.slice(2)));
  } catch (e) {
    // Bad --cwd / --verify / missing value: fail fast, never a silent wrong run.
    process.stderr.write(`storm-companion: ${e.message}\n`);
    process.exit(2);
  }
  const cfg = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  // Inject local secrets (z.ai/GLM + OpenRouter keys + experimentEnv) into engines.
  const engines = injectSecrets(cfg.engines, loadSecrets());

  if (mode === 'delegate') {
    if (!engine || !task) {
      process.stderr.write(USAGE);
      process.exit(2);
    }
    const eng = engines.find((e) => e.id === engine);
    if (!eng) {
      process.stderr.write(`storm-companion: unknown engine: ${engine} (configured: ${engines.map((e) => e.id).join(', ')})\n`);
      process.exit(2);
    }
    const { runDelegate } = await import('./lib/delegate.mjs');
    let out;
    try {
      out = await runDelegate(task, eng, {
        cwd,
        verify,
        verifyTimeoutMs: cfg.delegate?.verifyTimeoutMs,
        timeoutMs: cfg.timeoutMs,
        stallMs: cfg.stallMs,
      });
    } catch (e) {
      // Non-git target and friends: fail-fast contract, same exit as bad args.
      process.stderr.write(`storm-companion: ${e.message}\n`);
      process.exit(2);
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  if (mode !== 'plan' || !task) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const results = await runAll(task, engines, {
    role: cfg.role,
    cwd, // resolved + validated; cascades to spawn cwd -> all engines + Gemini sandbox
    proof: cfg.proof?.enabled,
    timeoutMs: cfg.timeoutMs,
    stallMs: cfg.stallMs,
  });
  // repoPath echoes the dir the council actually read -> wrong-repo mismatch is visible.
  let out = { mode, task, repoPath: cwd, results };
  if (cfg.proof?.enabled) {
    const { annotateWithProof } = await import('./lib/proof.mjs');
    // annotateWithProof re-runs free experiments in fresh worktrees of its own;
    // it does NOT need experimentEnv (its re-runs are local-only, no key required).
    const proofed = await annotateWithProof(results, { repoPath: cwd, timeoutMs: cfg.proof.experimentTimeoutMs });
    out = {
      mode,
      task,
      repoPath: cwd,
      results: proofed.results,
      verified_experiments: proofed.verified_experiments,
      engine_claimed_experiments: proofed.engine_claimed_experiments,
    };
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((e) => {
  process.stderr.write(`storm-companion error: ${e?.message ?? e}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Прогнать companion + полный сьют**

Run: `node --test tests/companion.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail)'` затем `node --test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 0` оба раза.

- [ ] **Step 5: Commit**

```bash
git add scripts/storm-companion.mjs scripts/config.json tests/companion.test.mjs
git commit -m "feat(companion): delegate mode wiring (engine validation, config, fail-fast)"
```

---

### Task 9: контракт заказчика — storm.md + SKILL.md + README

**Files:**
- Modify: `commands/storm.md`
- Modify: `skills/storm-runtime/SKILL.md`
- Modify: `README.md`

Тестов нет (маркдаун); проверка — самовычитка на консистентность имён полей с JSON из Task 5/6.

- [ ] **Step 1: commands/storm.md**

1) Frontmatter description → `Storm — multi-engine council (plan) and single-engine delegation (delegate)`.
2) Usage-строку под заголовком дополнить: `` `/storm delegate <engine> <task>` — delegate the task to one engine as a full-rights executor in an isolated worktree.``
3) Перед строкой `Only \`plan\` mode (read-only) exists in v1. \`action\` mode is a future phase.` вставить секцию:

```markdown
## /storm delegate <engine> "<task>"

One engine (codex | glm | claude) works as the EXECUTOR in an isolated git
worktree with full rights inside it; you are the customer accepting the work.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/storm-companion.mjs" delegate <engine> "<task>" [--cwd <abs-repo-path>] [--verify "<cmd>"]
```

- Long delegations: run in a background shell; a per-engine heartbeat streams
  to stderr (`[storm +45s] codex: 38ev idle 5s`) — check it periodically.
- You receive JSON: `{ mode:"delegate", engine, resolvedModel, task, repoPath,
  status, result, patch, verify }`. `patch` is `{ path, files, insertions,
  deletions, stat }` or `null` (a planning/research task delivers via `result`
  alone — that is a valid outcome). `verify` is `{ run, exitCode, stdoutTail,
  stderrTail, timedOut }` or `null`.
- Acceptance flow (you are the customer):
  1. Read `result` (the executor's report) and `patch.stat`.
  2. Inspect the patch file selectively (Read with offset/limit) — NEVER dump
     it whole into the conversation.
  3. If `verify` ran: `exitCode != 0` or `timedOut` => do NOT apply; report to
     the user, return the task to the executor or fix it yourself.
  4. Apply: `git apply --3way "<patch.path>"`, run your own checks; to roll
     back: `git apply -R "<patch.path>"`.
  5. `status != ok` => the patch (if any) is partial work of a killed engine;
     default to NOT applying — surface it to the user instead.
- Surface `repoPath` and `resolvedModel`, as in plan mode.
```

4) Финальную строку заменить на: `` `plan` (council review) and `delegate` (single-engine execution) exist. Parallel multi-engine implementation (`action` with smart merge) is a future phase.``

- [ ] **Step 2: skills/storm-runtime/SKILL.md**

После строки `Helper: ...` (строка 8) добавить вторую helper-строку:

```markdown
Delegate: `node "${CLAUDE_PLUGIN_ROOT}/scripts/storm-companion.mjs" delegate <engine> "<task>" [--cwd <abs-path>] [--verify "<cmd>"]`
```

И в конец списка буллетов добавить:

```markdown
- Delegate mode: one engine as full-rights executor in an isolated worktree;
  returns `{ …, status, result, patch: {path,files,insertions,deletions,stat}|null,
  verify: {run,exitCode,stdoutTail,stderrTail,timedOut}|null }`. The patch file is
  the deliverable — inspect selectively, apply with `git apply --3way`, never dump
  it whole. `verify.exitCode != 0` / `timedOut` / `status != ok` => don't apply by
  default. Empty patch + report is a valid outcome for planning tasks.
```

- [ ] **Step 3: README.md**

1) Строку `It's a Claude Code plugin. One command: \`/storm plan <task>\`.` заменить на:

```markdown
It's a Claude Code plugin. Two commands: `/storm plan <task>` (council review) and `/storm delegate <engine> <task>` (hand a task to one engine as a full-rights executor).
```

2) После секции `## Proof mode` добавить:

```markdown
## Delegate mode

`/storm delegate <engine> "<task>"` — Claude Code is the customer, one engine is
the executor. The engine gets an isolated git worktree (your uncommitted work
transferred in), full rights inside it, and does the task end-to-end: writes
code, runs tests, experiments. Nothing is discarded: the work comes back as

- a report (`result` — what it did, what it verified, limitations),
- a diffstat + a **patch file** (never a raw diff in your context),
- optionally a `--verify "<cmd>"` acceptance run executed in the worktree.

Claude Code reviews the diffstat, inspects the patch selectively, and applies it
with `git apply --3way` — or rejects it. Your repo is never written by Storm
itself; an empty patch with a good report is a valid outcome for planning tasks.
Use it when another engine is simply stronger on the task at hand.
```

3) В `## Limitations` строку `- Read-only (\`plan\`) for now; \`action\` mode is a future phase.` заменить на:

```markdown
- `plan` (read-only council) and `delegate` (single-engine execution via patch) exist; parallel multi-engine `action` with smart merge is a future phase.
```

- [ ] **Step 4: Самовычитка**

Проверить, что имена полей в трёх доках совпадают с JSON из Task 5/6 (`patch.path`, `verify.exitCode`, `resolvedModel`, статусы) и с CLI из Task 7 (`--verify`).

- [ ] **Step 5: Commit**

```bash
git add commands/storm.md skills/storm-runtime/SKILL.md README.md
git commit -m "docs(delegate): customer contract in command/skill/readme"
```

---

### Task 10: релиз — decision doc + 0.12.0 + полный прогон

**Files:**
- Create: `docs/decisions/2026-07-02-delegate-mode.md`
- Modify: `package.json` (`"version": "0.11.0"` → `"0.12.0"`)
- Modify: `.claude-plugin/plugin.json` (`"version": "0.11.0"` → `"0.12.0"`)

- [ ] **Step 1: Decision doc**

Создать `docs/decisions/2026-07-02-delegate-mode.md`:

```markdown
# Delegate mode — Claude Code как заказчик, движок как исполнитель

- Дата: 2026-07-02
- Спека: docs/specs/2026-07-02-storm-delegate-design.md

## Контекст

На части задач (имплементация, планирование) другой движок объективно сильнее
Claude Code. Нужен адресный режим «отдать задачу исполнителю», а не только
read-only совет (`plan`). Proof-режим уже давал движкам полные права в worktree,
но выбрасывал их работу — забирался только текст.

## Решение

`delegate <engine> "<task>"`: один движок в изолированном worktree (полные
права), работа возвращается отчётом + diffstat + patch-файлом; заказчик (Claude
Code) ревьюит и применяет `git apply --3way`. Snapshot-коммит после переноса
uncommitted — база диффа: патч содержит строго работу исполнителя. Опциональный
`--verify "<cmd>"` гоняется в worktree ПОСЛЕ снятия патча (артефакты проверки
не загрязняют патч), ДО передачи заказчику. Патч снимается при любом статусе
(частичная работа зарезанного движка ценна) — применять решает заказчик.

## Почему

- Worktree + приёмка, а не правки на месте: изоляция от параллельной работы
  заказчика, явный ревью-гейт, откат тривиален (не применяй патч).
- Патч-файл, а не дифф в JSON: контекст-протекция (инвариант Storm).
- Один исполнитель за вызов: кейс «этот движок сильнее здесь»; параллель
  (action со smart merge) — отдельная фаза, fan-out к ней готов.
- Реюз: workspace/run-engine/adapters/secrets/runExperiment/heartbeat — новых
  подсистем нет, только delegate.mjs-оркестрация.

## Что протестировали

- Изоляция: работа движка в патче, реальный репо нетронут (clean status).
- Snapshot-база: перенесённые uncommitted владельца НЕ утекают в патч;
  коммитящий движок даёт полный патч от baseRef.
- verify: pass/fail/timeout; артефакты verify не попадают в патч.
- Fail-fast: не-git cwd и неизвестный engine → exit 2 до спавна движка.
- Stалled: частичный патч снимается, статус честный.

## Отвергли

- Правки в рабочей копии (как codex:rescue): конфликты с параллельной работой,
  нет ревью-гейта.
- Полный дифф в JSON: ломает контекст-протекцию.
- Ветка/коммиты в реальном репо от companion: пачкает рефы, требует git-дисциплины
  от движка.
- Параллельная делегация сразу: YAGNI, дорого по подпискам.
- Авто-apply: приёмка — решение заказчика.

Коммиты: feature/delegate-mode (спека 9a3f384 → имплементация).
```

- [ ] **Step 2: Version bump**

В `package.json` и `.claude-plugin/plugin.json`: `"version": "0.12.0"`.

- [ ] **Step 3: Полный прогон**

Run: `node --test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 0`, tests ≥ 215.

- [ ] **Step 4: Commit**

```bash
git add docs/decisions/2026-07-02-delegate-mode.md package.json .claude-plugin/plugin.json
git commit -m "chore(release): Storm 0.12.0 — delegate mode"
```

---

## Post-plan

После Task 10: finishing-a-development-branch (мёрж `feature/delegate-mode` → main по практике репо — ff, push). Деплой-шаг вне репо: строчка в CLAUDE.md владельца рядом с codex:rescue про `/storm delegate`.
