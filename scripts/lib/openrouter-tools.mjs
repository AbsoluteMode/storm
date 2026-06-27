// scripts/lib/openrouter-tools.mjs
//
// Read-only file tools for the agentic Gemini engine (OpenRouter function-calling).
// Every path is confined to the working directory and screened against a blocklist
// (secrets / .env / .git) so the model can audit code but can never read keys or
// escape the sandbox. Tools return STRINGS; errors come back as strings (never
// throw) so the agentic loop can surface them to the model and continue.

import { resolve, sep, relative, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

const BLOCKED = [
  /(^|\/)\.storm-secrets\.json$/,
  /(^|\/)\.env/,
  /\.secret$/,
  /(^|\/)\.git(\/|$)/,
];
const MAX_FILE = 200_000;     // cap a single file read
const MAX_GREP_FILES = 400;   // cap files scanned by grep
const MAX_GREP_HITS = 100;    // cap reported matches

// Normalize Windows backslashes to forward slashes before matching — otherwise the
// blocklist (Unix-slash regexes) is bypassed on Windows for nested paths like
// `.git\config` or `subdir\.env`. (Found by the agentic Gemini engine auditing this
// very file.)
export function isBlocked(rel, raw) {
  const norm = (s) => String(s).replace(/\\/g, '/');
  return BLOCKED.some((re) => re.test(norm(rel)) || re.test(norm(raw)));
}

// Resolve relPath under cwd. Throws if it escapes cwd or hits the blocklist.
export function resolveInSandbox(cwd, relPath) {
  const base = resolve(cwd);
  const target = resolve(base, relPath ?? '.');
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`path outside sandbox: ${relPath}`);
  }
  const rel = relative(base, target);
  if (isBlocked(rel, relPath)) {
    throw new Error(`path blocked (secret/vcs): ${relPath}`);
  }
  return target;
}

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file within the working directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the working directory.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List entries of a directory within the working directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path relative to the working directory (default ".").' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for a substring across files under a directory within the working directory.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Directory to search (default ".").' },
        },
        required: ['pattern'],
      },
    },
  },
];

function collectFiles(dir, base, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= MAX_GREP_FILES) return;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    const rel = relative(base, full);
    if (isBlocked(rel, entry.name)) continue;
    if (entry.isDirectory()) collectFiles(full, base, out);
    else if (entry.isFile()) out.push(full);
  }
}

export function executeTool(name, args = {}, cwd) {
  try {
    if (name === 'read_file') {
      const p = resolveInSandbox(cwd, args.path);
      const buf = readFileSync(p, 'utf8');
      return buf.length > MAX_FILE ? buf.slice(0, MAX_FILE) + '\n…[truncated]' : buf;
    }
    if (name === 'list_dir') {
      const base = resolve(cwd);
      const p = resolveInSandbox(cwd, args.path || '.');
      const entries = readdirSync(p).filter((e) => {
        const rel = relative(base, join(p, e));
        return !isBlocked(rel, e) && e !== 'node_modules';
      });
      return entries.join('\n') || '(empty)';
    }
    if (name === 'grep') {
      const base = resolve(cwd);
      const root = resolveInSandbox(cwd, args.path || '.');
      const files = [];
      collectFiles(root, base, files);
      const hits = [];
      for (const f of files) {
        let lines;
        try { lines = readFileSync(f, 'utf8').split('\n'); } catch { continue; }
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(args.pattern)) {
            hits.push(`${relative(base, f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (hits.length >= MAX_GREP_HITS) break;
          }
        }
        if (hits.length >= MAX_GREP_HITS) break;
      }
      return hits.length ? hits.join('\n') : '(no matches)';
    }
    return `error: unknown tool ${name}`;
  } catch (e) {
    return `error: ${e.message}`;
  }
}
