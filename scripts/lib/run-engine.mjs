// scripts/lib/run-engine.mjs
import { spawn } from 'node:child_process';
import { buildInvocation } from './adapters.mjs';
import { extractResult } from './result-parser.mjs';

export function runInvocation({ engine, cmd, args }, opts = {}) {
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
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
  });
}

export function runEngine(engineId, prompt, cfg = {}, opts = {}) {
  let inv;
  try {
    inv = buildInvocation(engineId, prompt, cfg);
  } catch (e) {
    return Promise.resolve({ engine: engineId, status: 'error', error: e.message });
  }
  return runInvocation({ engine: engineId, cmd: inv.cmd, args: inv.args }, opts);
}
