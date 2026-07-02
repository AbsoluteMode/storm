// scripts/lib/heartbeat.mjs
// Periodic per-engine progress line to stderr (or a custom sink). Extracted
// from fan-out so delegate mode (single engine, no runAll) reuses it.
// heartbeatMs <= 0 / non-finite disables the timer entirely.
export function createHeartbeat(engineIds, opts = {}) {
  const hbMs = opts.heartbeatMs ?? 15000;
  const write = opts.onHeartbeat ?? ((line) => process.stderr.write(line + '\n'));
  const progress = {}; // id -> { chunks, lastActivityAt, status }
  const startedAt = Date.now();
  let timer = null;
  if (Number.isFinite(hbMs) && hbMs > 0) {
    timer = setInterval(() => {
      const now = Date.now();
      const parts = engineIds.map((id) => {
        const p = progress[id];
        if (!p) return `${id}: …`;
        if (p.status && p.status !== 'ok') return `${id}: ${p.status}`;
        const idle = Math.round((now - (p.lastActivityAt ?? now)) / 1000);
        return `${id}: ${p.chunks ?? 0}ev idle ${idle}s`;
      });
      write(`[storm +${Math.round((now - startedAt) / 1000)}s] ${parts.join(' | ')}`);
    }, hbMs);
    if (timer.unref) timer.unref();
  }
  return {
    onProgress: (id, s) => {
      progress[id] = { ...(progress[id] ?? {}), chunks: s.chunks, lastActivityAt: s.lastActivityAt, status: null };
    },
    setStatus: (id, status) => {
      progress[id] = { ...(progress[id] ?? {}), status };
    },
    stop: () => { if (timer) clearInterval(timer); },
  };
}
