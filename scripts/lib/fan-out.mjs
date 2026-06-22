// scripts/lib/fan-out.mjs
import { runEngine } from './run-engine.mjs';
import { buildStormPrompt } from './prompt.mjs';

export async function runAll(task, engines, opts = {}) {
  const runner = opts.runner ?? runEngine;
  const role = opts.role ?? 'reviewer';
  const prompt = buildStormPrompt({ task, role, repoPath: opts.repoPath });
  const settled = await Promise.allSettled(
    engines.map((e) => {
      try {
        return runner(e.id, prompt, e, { timeoutMs: opts.timeoutMs, stallMs: opts.stallMs });
      } catch (err) {
        return Promise.reject(err);
      }
    })
  );
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { engine: engines[i].id, status: 'error', error: s.reason?.message ?? String(s.reason) }
  );
}
