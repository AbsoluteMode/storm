// scripts/lib/cli-args.mjs
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

// Parse the companion's argv tail into { mode, task, cwd, engine, verify }.
// --cwd <path> is optional and position-independent; the remaining positionals
// are [mode, task] for plan mode or [mode, engine, task] for delegate mode.
// cwd is resolved to an absolute path and validated as an existing directory.
// Fail-fast: a missing value / bad path throws rather than silently falling back
// to process.cwd() (which would audit the wrong repo).
// Absent --cwd => cwd = deps.cwd() (default process.cwd()).
// delegate: [mode, engine, task]; --verify <cmd> — acceptance check (delegate only).
// WHY: docs/decisions/2026-06-26-target-cwd.md
export function parseStormArgs(argv, deps = {}) {
  const stat = deps.statSync ?? statSync;
  const getCwd = deps.cwd ?? (() => process.cwd());
  const positionals = [];
  let cwdRaw = null;
  let verify = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') {
      cwdRaw = argv[i + 1];
      if (cwdRaw == null) throw new Error('--cwd requires a path');
      i++; // consume the value
      continue;
    }
    if (argv[i] === '--verify') {
      verify = argv[i + 1];
      if (verify == null) throw new Error('--verify requires a command');
      i++; // consume the value
      continue;
    }
    positionals.push(argv[i]);
  }
  // plan: [mode, task]; delegate: [mode, engine, task]
  const [mode, ...rest] = positionals;
  const engine = mode === 'delegate' ? (rest[0] ?? null) : null;
  const task = mode === 'delegate' ? rest[1] : rest[0];
  let cwd;
  if (cwdRaw == null) {
    cwd = getCwd();
  } else {
    cwd = resolve(cwdRaw);
    let st;
    try { st = stat(cwd); } catch { throw new Error(`--cwd: path does not exist: ${cwd}`); }
    if (!st.isDirectory()) throw new Error(`--cwd: not a directory: ${cwd}`);
  }
  return { mode, task, cwd, engine, verify };
}
