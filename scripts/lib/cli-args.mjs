// scripts/lib/cli-args.mjs
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

// Parse the companion's argv tail into { mode, task, cwd }.
// --cwd <path> is optional and position-independent; the remaining positionals
// are [mode, task]. cwd is resolved to an absolute path and validated as an
// existing directory. Fail-fast: a missing value / bad path throws rather than
// silently falling back to process.cwd() (which would audit the wrong repo).
// Absent --cwd => cwd = deps.cwd() (default process.cwd()).
export function parseStormArgs(argv, deps = {}) {
  const stat = deps.statSync ?? statSync;
  const getCwd = deps.cwd ?? (() => process.cwd());
  const positionals = [];
  let cwdRaw = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') {
      cwdRaw = argv[i + 1];
      if (cwdRaw == null) throw new Error('--cwd requires a path');
      i++; // consume the value
      continue;
    }
    positionals.push(argv[i]);
  }
  const [mode, task] = positionals;
  let cwd;
  if (cwdRaw == null) {
    cwd = getCwd();
  } else {
    cwd = resolve(cwdRaw);
    let st;
    try { st = stat(cwd); } catch { throw new Error(`--cwd: path does not exist: ${cwd}`); }
    if (!st.isDirectory()) throw new Error(`--cwd: not a directory: ${cwd}`);
  }
  return { mode, task, cwd };
}
