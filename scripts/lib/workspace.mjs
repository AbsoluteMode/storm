// scripts/lib/workspace.mjs
// Per-engine isolated working root. git repo -> git worktree (HEAD + transferred
// uncommitted + symlinked node_modules); non-git -> cp-fallback. cleanup is
// idempotent and never throws. WHY: docs/decisions/2026-06-27-stage2-self-experiment.md
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, symlinkSync, mkdirSync, copyFileSync, rmSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { makeThrowawayCopy } from './sandbox.mjs';

function git(repo, args, run) {
  return run('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

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

export function makeEngineWorkspace(repoPath, label, deps = {}) {
  const run = deps.run ?? ((cmd, args, opts) => ({ stdout: execFileSync(cmd, args, opts) }));
  const tmpRoot = deps.tmpRoot ?? tmpdir();

  // Detect git repo; on any failure, fall back to a plain copy.
  const isGit = isGitRepo(repoPath, { run });

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
    try {
      mkdirSync(dirname(dst), { recursive: true });
      // Use lstatSync (not statSync) to detect symlinks without following them.
      // copyFileSync follows symlinks and copies the target's content, which would
      // leak outside-repo data into the worktree if a symlink points beyond the
      // repo boundary. Instead, recreate symlinks faithfully as symlinks.
      if (lstatSync(src).isSymbolicLink()) {
        symlinkSync(readlinkSync(src), dst);
      } else {
        copyFileSync(src, dst);
      }
    } catch { /* skip unreadable */ }
  }

  // Symlink node_modules so dependency-needing experiments work without reinstall.
  // Opt-out for delegate: a full-rights executor's `npm install` would write
  // through the symlink into the real repo's node_modules.
  if (deps.linkNodeModules ?? true) {
    const nm = join(repoPath, 'node_modules');
    if (existsSync(nm)) { try { symlinkSync(nm, join(dir, 'node_modules')); } catch { /* exists/unsupported */ } }
  }

  const cleanup = once(() => {
    try { git(repoPath, ['worktree', 'remove', '--force', dir], run); } catch { /* already gone */ }
    try { git(repoPath, ['worktree', 'prune'], run); } catch { /* best effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  });

  return { dir, kind: 'worktree', cleanup };
}

function once(fn) { let done = false; return () => { if (done) return; done = true; fn(); }; }
