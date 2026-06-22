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
