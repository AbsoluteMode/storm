// scripts/lib/proof.mjs
// Proof-required review: parse engine proof tags, classify experiment cost,
// match predictions, run experiments in isolation, and orchestrate the second
// pass. PROVEN is set ONLY here (verify-don't-trust), never by an engine.

// Tolerant line parser: STORM_RESULT text -> findings. Never throws; unknown
// lines are ignored. Engine-claimed [PROVEN] is captured as 'proven-claimed'
// so the orchestrator can DOWNGRADE it (an engine cannot self-prove).
export function parseProofFindings(text) {
  const findings = [];
  let cur = null;
  const push = () => { if (cur) { findings.push(cur); cur = null; } };
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^\[NEEDS-EXPERIMENT\]\s*(.*)$/i))) {
      push();
      cur = { tag: 'needs-experiment', title: m[1].trim() };
    } else if ((m = line.match(/^\[UNPROVEN-CANNOT\]\s*(.*)$/i))) {
      push();
      const rest = m[1].trim();
      const wm = rest.match(/^(.*?)\s*[—-]\s*why:\s*(.*)$/i);
      cur = wm
        ? { tag: 'unproven-cannot', title: wm[1].trim(), why: wm[2].trim() }
        : { tag: 'unproven-cannot', title: rest };
    } else if ((m = line.match(/^\[PROVEN\]\s*(.*)$/i))) {
      push();
      cur = { tag: 'proven-claimed', title: m[1].trim() };
    } else if (cur && (m = line.match(/^run:\s*(.*)$/i))) {
      cur.run = m[1].trim();
    } else if (cur && (m = line.match(/^expects:\s*(.*)$/i))) {
      cur.expects = m[1].trim();
    } else if (cur && (m = line.match(/^cost:\s*(.*)$/i))) {
      cur.cost = m[1].trim();
    }
    // unknown lines: ignored (tolerant)
  }
  push();
  return findings;
}

const PAID_HOSTS = [/openrouter\.ai/i, /api\.openai\.com/i, /anthropic/i, /generativelanguage/i, /amazonaws\.com/i, /\bz\.ai/i];
const NET_PATTERNS = [/\bcurl\b/i, /\bwget\b/i, /\bssh\b/i, /https?:\/\//i, /\bnpm\s+(i|install)\b/i, /\bpip\s+install\b/i, /\bdocker\s+(pull|run)\b/i, /\byarn\s+add\b/i];

// Classify an experiment's cost. Declarations are NOT trusted: a command that
// looks networked/paid but is declared free is downgraded to 'unknown'. The
// caller treats 'unknown' as 'paid' (default-deny).
export function classifyCost(run, declared) {
  if (String(declared ?? '').toLowerCase().startsWith('paid')) return 'paid';
  const cmd = String(run ?? '');
  if (!cmd.trim()) return 'unknown';
  const suspicious = PAID_HOSTS.some((re) => re.test(cmd)) || NET_PATTERNS.some((re) => re.test(cmd));
  return suspicious ? 'unknown' : 'free';
}

function matchClause(c, { exitCode, stdout = '', stderr = '' }) {
  let m;
  if (/^exit\s*!=\s*0$/i.test(c)) return exitCode !== 0;
  if ((m = c.match(/^exit\s*==\s*(\d+)$/i))) return exitCode === Number(m[1]);
  if ((m = c.match(/^exit\s*!=\s*(\d+)$/i))) return exitCode !== Number(m[1]);
  if ((m = c.match(/^stdout\s+contains\s+["']?(.+?)["']?$/i))) return String(stdout).includes(m[1]);
  if ((m = c.match(/^stderr\s+contains\s+["']?(.+?)["']?$/i))) return String(stderr).includes(m[1]);
  return false; // unknown clause -> not matched (conservative)
}

// Does the captured result satisfy the engine's prediction? Clauses joined by AND.
export function predictMatches(expects, res) {
  const e = String(expects ?? '').trim();
  if (!e) return false;
  return e.split(/\s+AND\s+/i).map((c) => c.trim()).filter(Boolean).every((c) => matchClause(c, res));
}

import { spawn } from 'node:child_process';

const OUTPUT_CAP = 4000; // tail cap per stream (context-protection: bounded artifact)

// Run an experiment command in `cwd` (a throwaway copy), bounded by timeoutMs.
// Detached process group so a hung repro (and its children) is killed wholesale.
// Experiments MUST be bounded — unlike engines (no-timeouts liveness).
export function runExperiment(run, cwd, { timeoutMs = 30000, env } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false, timedOut = false;
    const start = Date.now();
    const finish = (exitCode) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdoutTail: stdout.slice(-OUTPUT_CAP), stderrTail: stderr.slice(-OUTPUT_CAP), durationMs: Date.now() - start, timedOut });
    };
    let child;
    try {
      child = spawn('/bin/sh', ['-c', run], { cwd, env: env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ exitCode: null, stdoutTail: '', stderrTail: String(e.message), durationMs: 0, timedOut: false });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += String(e.message); finish(null); });
    child.on('close', (code) => finish(code));
  });
}
