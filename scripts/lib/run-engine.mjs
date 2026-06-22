// scripts/lib/run-engine.mjs
import { spawn } from 'node:child_process';
import { buildInvocation } from './adapters.mjs';
import { extractResult } from './result-parser.mjs';

export function runInvocation({ engine, cmd, args }, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 180000;
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
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
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ engine, status: 'timeout', error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', (e) => finish({ engine, status: 'error', error: e.message }));
    child.on('close', () => {
      const parsed = extractResult(stdout);
      if (parsed.ok) finish({ engine, status: 'ok', result: parsed.result });
      else finish({ engine, status: 'no_result', error: parsed.reason });
    });
  });
}

export function runEngine(engineId, prompt, cfg = {}, opts = {}) {
  const { cmd, args } = buildInvocation(engineId, prompt, cfg);
  return runInvocation({ engine: engineId, cmd, args }, opts);
}
