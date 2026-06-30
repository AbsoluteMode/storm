// scripts/lib/fan-out.mjs
import { runEngine } from './run-engine.mjs';
import { buildStormPrompt } from './prompt.mjs';
import { makeEngineWorkspace } from './workspace.mjs';

export async function runAll(task, engines, opts = {}) {
  const runner = opts.runner ?? runEngine;
  const role = opts.role ?? 'reviewer';
  const proof = !!opts.proof;
  const prompt = buildStormPrompt({ task, role, repoPath: opts.cwd, proof });
  const settled = await Promise.allSettled(
    engines.map(async (e) => {
      let ws = null;
      try {
        // In proof mode: each engine gets its own isolated worktree so experiments
        // cannot cross-contaminate. The worktree dir is the engine's cwd.
        // Non-proof: all engines share opts.cwd (unchanged behaviour).
        const cwd = proof ? (ws = makeEngineWorkspace(opts.cwd, e.id)).dir : opts.cwd;
        const cfg = { ...e, proof };
        // e.experimentEnv flows to the child via run-engine's opts.env merge.
        return await runner(e.id, prompt, cfg, {
          timeoutMs: opts.timeoutMs,
          stallMs: e.stallMs ?? opts.stallMs,
          cwd,
          env: e.experimentEnv,
        });
      } finally {
        // cleanup is idempotent and never throws (workspace.mjs contract).
        if (ws) ws.cleanup();
      }
    })
  );
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { engine: engines[i].id, status: 'error', error: s.reason?.message ?? String(s.reason) }
  );
}
