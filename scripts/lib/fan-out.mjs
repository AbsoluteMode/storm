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
