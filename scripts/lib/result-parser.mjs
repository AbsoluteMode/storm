// scripts/lib/result-parser.mjs
const OPEN = '<STORM_RESULT>';
const CLOSE = '</STORM_RESULT>';

export function extractResult(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty' };
  const start = raw.lastIndexOf(OPEN);
  if (start === -1) return { ok: false, reason: 'no_marker' };
  const from = start + OPEN.length;
  const end = raw.indexOf(CLOSE, from);
  if (end === -1) return { ok: false, reason: 'unterminated' };
  const result = raw.slice(from, end).trim();
  if (result.length === 0) return { ok: false, reason: 'empty_result' };
  return { ok: true, result };
}
