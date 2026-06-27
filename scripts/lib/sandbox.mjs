// scripts/lib/sandbox.mjs
// Throwaway copy of a repo for running proof experiments in isolation. The copy
// captures the working tree as-is (incl. uncommitted changes) but excludes .git
// (so an experiment can never push/rewrite the real repo), node_modules, and
// secrets. Experiment env carries no provider keys.
import { cpSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const EXCLUDE = new Set(['.git', 'node_modules', '.storm-secrets.json', '.venv', '.pytest_cache', '__pycache__', 'dist', 'build']);
const EXCLUDE_RE = [/^\.env/, /\.secret$/];

function included(src) {
  const base = basename(src);
  if (EXCLUDE.has(base)) return false;
  return !EXCLUDE_RE.some((re) => re.test(base));
}

export function makeThrowawayCopy(repoPath) {
  const dir = mkdtempSync(join(tmpdir(), 'storm-exp-'));
  cpSync(repoPath, dir, { recursive: true, filter: included });
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

// Minimal env for experiments: no secrets, no provider/backend keys, no Doppler.
export function experimentEnv() {
  const { PATH, HOME, LANG, TMPDIR } = process.env;
  return { PATH, HOME, LANG: LANG ?? 'en_US.UTF-8', TMPDIR };
}
