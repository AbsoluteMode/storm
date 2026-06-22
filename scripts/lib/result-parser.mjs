// scripts/lib/result-parser.mjs
const OPEN = '<STORM_RESULT>';
const CLOSE = '</STORM_RESULT>';

export function extractResult(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty' };

  // Algorithm: find the last COMPLETE balanced pair.
  // 1. Find the last CLOSE anywhere in the string.
  // 2. Find the last OPEN that occurs BEFORE that CLOSE.
  // This ignores any trailing unclosed OPEN after the last CLOSE,
  // and handles prompt-template echoes correctly (returns the last complete block).
  const closeIdx = raw.lastIndexOf(CLOSE);
  if (closeIdx === -1) {
    // No CLOSE anywhere. If there is an OPEN it is unterminated; otherwise no_marker.
    return raw.includes(OPEN)
      ? { ok: false, reason: 'unterminated' }
      : { ok: false, reason: 'no_marker' };
  }

  // Find the last OPEN that starts strictly before closeIdx.
  // When closeIdx === 0, closeIdx - 1 === -1, so lastIndexOf returns -1 safely (no_marker).
  const openIdx = raw.lastIndexOf(OPEN, closeIdx - 1);
  if (openIdx === -1) {
    // A CLOSE exists but no OPEN precedes it — treat as no_marker (malformed output).
    return { ok: false, reason: 'no_marker' };
  }

  const result = raw.slice(openIdx + OPEN.length, closeIdx).trim();
  if (result.length === 0) return { ok: false, reason: 'empty_result' };
  return { ok: true, result };
}

// Returns the last up-to-maxLen non-empty trimmed chars of raw.
// Used for salvaging substantial output that lacks STORM_RESULT markers.
export function salvageTail(raw, maxLen = 2000) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(trimmed.length - maxLen);
}
