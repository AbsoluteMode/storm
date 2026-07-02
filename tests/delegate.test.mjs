// tests/delegate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
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

test('patch counts come from git --numstat (locale-proof, not the localized --stat summary line)', async () => {
  const repo = initRepo();
  try {
    const out = await runDelegate('do it', { id: 'codex' }, {
      cwd: repo, runner: writingRunner({ content: 'line1\nline2\nline3\n' }),
    });
    assert.equal(out.patch.files, 1);
    assert.equal(out.patch.insertions, 3);
    assert.equal(out.patch.deletions, 0);
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

test('delegate worktree does not symlink the real repo node_modules (full-rights executor + npm install would write through it)', async () => {
  const repo = initRepo();
  try {
    // gitignore node_modules like a real repo would, so the untracked-file
    // transfer loop doesn't create it as a real dir for the wrong reason.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'gitignore node_modules']);
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'node_modules', 'marker.txt'), 'real nm\n');
    let sawNodeModules = null;
    const runner = (id, _p, _c, opts) => {
      sawNodeModules = existsSync(join(opts.cwd, 'node_modules'));
      return Promise.resolve({ engine: id, status: 'ok', result: 'r' });
    };
    await runDelegate('t', { id: 'codex' }, { cwd: repo, runner });
    assert.equal(sawNodeModules, false, 'delegate worktree must not have node_modules symlinked in');
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
