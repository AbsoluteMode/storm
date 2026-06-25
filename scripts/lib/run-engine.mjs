// scripts/lib/run-engine.mjs
import { spawn } from 'node:child_process';
import { buildInvocation } from './adapters.mjs';
import { extractResult, salvageTail } from './result-parser.mjs';
import { detectAuthPrompt } from './auth-detect.mjs';

const MIN_SALVAGE_LENGTH = 40;
const AUTH_SCAN_TAIL = 1000; // scan only the recent tail for auth prompts (cheap, catches splits)

export function runInvocation({ engine, cmd, args, input, env, stream }, opts = {}) {
  // Timeouts are OPT-IN: a positive number arms the timer; null/0 disables it.
  // Storm's default policy is NO wall-clock kill — engines (codex under xhigh, deep
  // agentic runs) can legitimately work for many minutes to hours, silent while
  // reasoning. Silence != death. Liveness is instead the process staying alive
  // (close/error are the terminal signals) plus output growth (diagnostics). The
  // one kept guard is the auth-prompt grace timer below, which catches a real
  // input-wait hang (engine asked for auth, stdin is closed -> waits forever).
  // WHY: docs/decisions/2026-06-25-no-timeouts-liveness.md
  const timeoutMs = opts.timeoutMs === undefined ? 300000 : opts.timeoutMs; // null/0 => disabled
  const stallMs = opts.stallMs === undefined ? 90000 : opts.stallMs;        // null/0 => disabled
  const authGraceMs = opts.authGraceMs ?? 30000; // wait after an auth prompt before declaring auth_required (a live engine that merely echoes auth words keeps streaming)
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let jsonBuf = '';      // unparsed NDJSON tail (stream engines only)
    let finalText = null;  // null = no result event seen yet; '' = an empty result event
    const deltas = [];     // text_delta chunks (fallback when no result event)
    let settled = false;
    let lastActivity = Date.now();
    let backstopTimer;
    let stallTimer;
    let authTimer;
    const clearTimers = () => { clearTimeout(backstopTimer); clearTimeout(stallTimer); clearTimeout(authTimer); };
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

    const stallEnabled = Number.isFinite(stallMs) && stallMs > 0;
    const armStall = () => {
      if (!stallEnabled) return; // disabled: a silent-but-alive engine is presumed working
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ engine, status: 'stalled', error: `no output for ${stallMs}ms` });
      }, stallMs);
    };
    // Backstop wall-clock kill — only when explicitly enabled (positive timeoutMs).
    // v1: kills the direct child only; grandchildren spawned by the engine CLI may orphan on timeout.
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      backstopTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ engine, status: 'timeout', error: `timeout after ${timeoutMs}ms` });
      }, timeoutMs);
    }
    armStall();

    // Arm/re-arm a short grace timer when an auth prompt is seen. It fires only if
    // the engine then goes SILENT (a real auth hang = prompt + waiting for input).
    // A live engine that merely echoes auth vocabulary (codex) keeps streaming, so
    // the timer keeps resetting / the phrase scrolls out of the tail -> no false kill.
    const armAuthGrace = () => {
      clearTimeout(authTimer);
      authTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ engine, status: 'auth_required', error: 'auth prompt detected; engine went silent after it' });
      }, authGraceMs);
    };
    // Parse complete NDJSON lines from jsonBuf. Tolerant: never throws on a bad
    // line. Captures the final answer (result event) and text deltas (fallback).
    const consumeStream = () => {
      let nl;
      while ((nl = jsonBuf.indexOf('\n')) >= 0) {
        const line = jsonBuf.slice(0, nl);
        jsonBuf = jsonBuf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'result' && typeof ev.result === 'string') {
          finalText = ev.result;
        } else if (
          ev.type === 'content_block_delta' &&
          ev.delta && ev.delta.type === 'text_delta' &&
          typeof ev.delta.text === 'string'
        ) {
          deltas.push(ev.delta.text);
        }
      }
    };
    const onActivity = () => {
      lastActivity = Date.now();
      armStall(); // reset inactivity timer on any output
      const tail = (stdout.slice(-AUTH_SCAN_TAIL)) + '\n' + (stderr.slice(-AUTH_SCAN_TAIL));
      if (detectAuthPrompt(tail)) {
        armAuthGrace();
      } else {
        clearTimeout(authTimer); // auth text scrolled out of the tail -> engine moved on
      }
    };
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stream) { jsonBuf += d; consumeStream(); }
      onActivity();
    });
    child.stderr.on('data', (d) => { stderr += d; onActivity(); });
    child.on('error', (e) => finish({ engine, status: 'error', error: e.message }));
    child.on('close', () => {
      // Flush a final NDJSON line that arrived without a trailing newline.
      if (stream && jsonBuf.trim()) { jsonBuf += '\n'; consumeStream(); }
      // Stream engines: the answer lives in the assembled final text (result event),
      // not raw NDJSON stdout (where markers are split across token-deltas). Use ?? so
      // an empty-string result event is honored, not treated as "no result seen".
      const sourceText = stream ? (finalText ?? (deltas.length ? deltas.join('') : stdout)) : stdout;
      const parsed = extractResult(sourceText);
      if (parsed.ok) {
        finish({ engine, status: 'ok', result: parsed.result });
      } else {
        // Salvage: when the engine produced substantial output but forgot markers,
        // recover the tail rather than discarding the engine's work entirely.
        // Only salvage on no_marker (not unterminated/empty_result — those had markers).
        if (parsed.reason === 'no_marker') {
          const salvaged = salvageTail(sourceText);
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
  return runInvocation({ engine: engineId, cmd: inv.cmd, args: inv.args, input: inv.input, env: inv.env, stream: inv.stream }, opts);
}
