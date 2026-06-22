// scripts/lib/run-engine.mjs
import { spawn } from 'node:child_process';
import { buildInvocation } from './adapters.mjs';
import { extractResult } from './result-parser.mjs';

export function runInvocation({ engine, cmd, args, input }, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 180000;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ engine, status: 'error', error: e.message });
    }
    // FIX: set UTF-8 encoding so multi-byte chars split across chunks decode correctly.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    timer = setTimeout(() => {
      // v1: kills the direct child only; grandchildren spawned by the engine CLI may orphan on timeout.
      child.kill('SIGKILL');
      finish({ engine, status: 'timeout', error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish({ engine, status: 'error', error: e.message }));
    child.on('close', () => {
      const parsed = extractResult(stdout);
      if (parsed.ok) {
        finish({ engine, status: 'ok', result: parsed.result });
      } else {
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
  return runInvocation({ engine: engineId, cmd: inv.cmd, args: inv.args, input: inv.input }, opts);
}
