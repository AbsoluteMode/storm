// scripts/lib/run-engine.mjs
import { spawn } from 'node:child_process';
import { buildInvocation } from './adapters.mjs';
import { extractResult, salvageTail } from './result-parser.mjs';
import { detectAuthPrompt } from './auth-detect.mjs';

const MIN_SALVAGE_LENGTH = 40;
const AUTH_SCAN_TAIL = 1000; // scan only the recent tail for auth prompts (cheap, catches splits)

export function runInvocation({ engine, cmd, args, input, env }, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 300000; // far backstop, not the primary trigger
  const stallMs = opts.stallMs ?? 90000;      // inactivity (primary trigger)
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let lastActivity = Date.now();
    let backstopTimer;
    let stallTimer;
    const clearTimers = () => { clearTimeout(backstopTimer); clearTimeout(stallTimer); };
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ ...res, lastActivityMs: Date.now() - lastActivity });
    };
    let child;
    try {
      // Merge per-engine env over the inherited environment (glm redirects the
      // Claude Code backend to z.ai this way). undefined env => inherit unchanged.
      child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env ? { ...process.env, ...env } : process.env,
      });
    } catch (e) {
      return finish({ engine, status: 'error', error: e.message });
    }
    // FIX: set UTF-8 encoding so multi-byte chars split across chunks decode correctly.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ engine, status: 'stalled', error: `no output for ${stallMs}ms` });
      }, stallMs);
    };
    // v1: kills the direct child only; grandchildren spawned by the engine CLI may orphan on timeout.
    backstopTimer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ engine, status: 'timeout', error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    armStall();

    const onActivity = () => {
      lastActivity = Date.now();
      armStall(); // reset inactivity timer on any output
      const tail = (stdout.slice(-AUTH_SCAN_TAIL)) + '\n' + (stderr.slice(-AUTH_SCAN_TAIL));
      if (detectAuthPrompt(tail)) {
        child.kill('SIGKILL');
        finish({ engine, status: 'auth_required', error: 'authentication prompt detected' });
      }
    };
    child.stdout.on('data', (d) => { stdout += d; onActivity(); });
    child.stderr.on('data', (d) => { stderr += d; onActivity(); });
    child.on('error', (e) => finish({ engine, status: 'error', error: e.message }));
    child.on('close', () => {
      const parsed = extractResult(stdout);
      if (parsed.ok) {
        finish({ engine, status: 'ok', result: parsed.result });
      } else {
        // Salvage: when the engine produced substantial output but forgot markers,
        // recover the tail rather than discarding the engine's work entirely.
        // Only salvage on no_marker (not unterminated/empty_result — those had markers).
        if (parsed.reason === 'no_marker') {
          const salvaged = salvageTail(stdout);
          if (salvaged.length >= MIN_SALVAGE_LENGTH) {
            finish({ engine, status: 'salvaged', result: salvaged, error: 'no_marker (salvaged)' });
            return;
          }
        }
        // stderr (not the model's stdout answer) is included for diagnostics; some CLIs echo prompt/model text here.
        const tail = stderr.trim().slice(0, 500);
        finish({ engine, status: 'no_result', error: tail ? `${parsed.reason}: ${tail}` : parsed.reason });
      }
    });

    // Deliver the prompt via stdin to avoid ARG_MAX limits on large prompts.
    // Guard against EPIPE: an engine that exits early (e.g. on bad input) may
    // close its stdin before we finish writing. That raises EPIPE — we swallow
    // it so the run degrades to whatever status close() already resolved.
    if (input != null) {
      child.stdin.on('error', (e) => {
        if (e.code !== 'EPIPE') {
          // Unexpected stdin error — surface as error status if not yet settled.
          finish({ engine, status: 'error', error: `stdin write error: ${e.message}` });
        }
        // EPIPE: the child already exited; close() will fire and settle normally.
      });
      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch (e) {
        // Synchronous write errors (e.g. if the stream is already destroyed) are rare
        // but must not crash the caller. Let close() settle as no_result/error.
      }
    } else {
      // No stdin input — close stdin immediately so the child is not blocked
      // waiting for input that will never come.
      child.stdin.end();
    }
  });
}

export function runEngine(engineId, prompt, cfg = {}, opts = {}) {
  let inv;
  try {
    inv = buildInvocation(engineId, prompt, cfg);
  } catch (e) {
    return Promise.resolve({ engine: engineId, status: 'error', error: e.message });
  }
  return runInvocation({ engine: engineId, cmd: inv.cmd, args: inv.args, input: inv.input, env: inv.env }, opts);
}
