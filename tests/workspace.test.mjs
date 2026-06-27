// tests/workspace.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
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

test('untracked symlink pointing outside the repo is recreated as a symlink, not copied as file content', () => {
  // SECURITY BUG: copyFileSync follows symlinks. An untracked symlink pointing
  // to a secret outside the repo would have its *target content* copied into
  // the engine's worktree, leaking outside-repo data and breaking the isolation
  // boundary. Fix: detect symlinks via lstatSync and recreate them as symlinks
  // (symlinkSync) instead of copying content.
  const { dir } = initRepo();

  // Create a secret file OUTSIDE the repo.
  const outerDir = mkdtempSync(join(tmpdir(), 'storm-outer-'));
  const secretPath = join(outerDir, 'secret.txt');
  writeFileSync(secretPath, 'STORM_SYMLINK_SECRET\n');

  // Place an untracked symlink inside the repo pointing to the secret.
  const symlinkInRepo = join(dir, 'leak');
  symlinkSync(secretPath, symlinkInRepo);

  const ws = makeEngineWorkspace(dir, 'codex');
  try {
    const leakInWs = join(ws.dir, 'leak');

    // After fix: the worktree entry must be a symlink (not a regular file).
    assert.ok(lstatSync(leakInWs).isSymbolicLink(), 'leak in worktree must be a symlink, not a regular file');

    // The worktree must NOT contain a regular file whose contents are the secret.
    // (A symlink entry is fine — that is just pointer metadata, not copied content.)
    assert.ok(!lstatSync(leakInWs).isFile(), 'leak in worktree must not be a regular file with secret content');
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outerDir, { recursive: true, force: true });
  }
});
