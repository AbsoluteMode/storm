#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runAll } from './lib/fan-out.mjs';

async function main() {
  const [mode, task] = process.argv.slice(2);
  if (mode !== 'plan' || !task) {
    process.stderr.write('usage: storm-companion plan "<task>"\n');
    process.exit(2);
  }
  const cfg = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  const results = await runAll(task, cfg.engines, {
    role: cfg.role,
    repoPath: process.cwd(),
    timeoutMs: cfg.timeoutMs,
  });
  process.stdout.write(JSON.stringify({ mode, task, results }, null, 2) + '\n');
}

main().catch((e) => {
  process.stderr.write(`storm-companion error: ${e?.message ?? e}\n`);
  process.exit(1);
});
