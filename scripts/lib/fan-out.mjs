// scripts/lib/fan-out.mjs
import { runEngine } from './run-engine.mjs';
import { buildStormPrompt } from './prompt.mjs';
import { makeEngineWorkspace } from './workspace.mjs';

export async function runAll(task, engines, opts = {}) {
  const runner = opts.runner ?? runEngine;
  const role = opts.role ?? 'reviewer';
  const proof = !!opts.proof;
  const prompt = buildStormPrompt({ task, role, repoPath: opts.cwd, proof });

  const progress = {}; // id -> { chunks, lastActivityAt, status }
  const startedAt = Date.now();
  const hbMs = opts.heartbeatMs ?? 15000;
  const writeHeartbeat = opts.onHeartbeat ?? ((line) => process.stderr.write(line + '\n'));
  let hb;
  if (Number.isFinite(hbMs) && hbMs > 0) {
    hb = setInterval(() => {
      const now = Date.now();
      const parts = engines.map((e) => {
        const p = progress[e.id];
        if (!p) return `${e.id}: …`;
        if (p.status && p.status !== 'ok') return `${e.id}: ${p.status}`;
        const idle = Math.round((now - (p.lastActivityAt ?? now)) / 1000);
        return `${e.id}: ${p.chunks ?? 0}ev idle ${idle}s`;
      });
      writeHeartbeat(`[storm +${Math.round((now - startedAt) / 1000)}s] ${parts.join(' | ')}`);
    }, hbMs);
    if (hb.unref) hb.unref();
  }

  const settled = await Promise.allSettled(
    engines.map(async (e) => {
      let ws = null;
      const onProgress = (s) => {
        progress[e.id] = { chunks: s.chunks, lastActivityAt: s.lastActivityAt, status: null };
      };
      try {
        const cwd = proof ? (ws = makeEngineWorkspace(opts.cwd, e.id)).dir : opts.cwd;
        const cfg = { ...e, proof };
        const res = await runner(e.id, prompt, cfg, {
          timeoutMs: opts.timeoutMs,
          stallMs: e.stallMs ?? opts.stallMs,
          cwd,
          env: e.experimentEnv,
          onProgress,
        });
        progress[e.id] = { ...(progress[e.id] ?? {}), status: res.status };
        return res;
      } finally {
        if (ws) ws.cleanup();
      }
    })
  );

  if (hb) clearInterval(hb);

  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { engine: engines[i].id, status: 'error', error: s.reason?.message ?? String(s.reason) }
  );
}
