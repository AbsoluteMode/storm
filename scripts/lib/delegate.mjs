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
import { runExperiment } from './proof.mjs';
import { experimentEnv } from './sandbox.mjs';

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
  // Counts from --numstat (machine-readable: `<ins>\t<del>\t<path>`, `-` for
  // binary), not the localized --stat summary line ("N files changed…"),
  // which breaks under non-English git locales.
  const numstat = git(wsDir, ['diff', baseRef, '--numstat']);
  let files = 0, insertions = 0, deletions = 0;
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    files += 1;
    const [ins, del] = line.split('\t');
    if (ins !== '-') insertions += Number(ins);
    if (del !== '-') deletions += Number(del);
  }
  return {
    path,
    files,
    insertions,
    deletions,
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
  // Full-rights executor + npm install would write through the symlink into the real repo.
  const ws = makeEngineWorkspace(opts.cwd, `delegate-${engine.id}`, { linkNodeModules: false });
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
  } finally {
    hb.stop();
    ws.cleanup(); // idempotent, never throws (workspace contract)
  }
}
