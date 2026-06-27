#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runAll } from './lib/fan-out.mjs';
import { loadSecrets, injectSecrets } from './lib/secrets.mjs';
import { parseStormArgs } from './lib/cli-args.mjs';

async function main() {
  let mode, task, cwd;
  try {
    ({ mode, task, cwd } = parseStormArgs(process.argv.slice(2)));
  } catch (e) {
    // Bad --cwd / missing value: fail fast, never a silent wrong-repo run.
    process.stderr.write(`storm-companion: ${e.message}\n`);
    process.exit(2);
  }
  if (mode !== 'plan' || !task) {
    process.stderr.write('usage: storm-companion plan "<task>" [--cwd <abs-path>]\n');
    process.exit(2);
  }
  const cfg = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  // Inject local secrets (z.ai/GLM + OpenRouter keys + experimentEnv) into engines.
  const engines = injectSecrets(cfg.engines, loadSecrets());
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
