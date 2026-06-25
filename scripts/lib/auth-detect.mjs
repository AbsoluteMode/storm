// scripts/lib/auth-detect.mjs
// NARROW patterns: target CLI auth-FAILURE phrasing, not generic auth vocabulary.
// Storm reviews auth-related code, so generic words ("login", "oauth", "authorize")
// must NOT trigger. Only phrasings a CLI emits when it cannot authenticate do.
const AUTH_PATTERNS = [
  /\bnot (authenticated|logged in|signed in)\b/i,
  /\bplease (re-?)?(authenticate|sign in|log in)\b/i,
  /\b(run|execute) `?(claude|codex|agy|gemini) login\b/i,   // "Run `claude login`" — our engines only
  /\bsign in with (chatgpt|google|github)\b/i,
  /\bsign in to continue\b/i,
  /\bsession (has )?expired\b/i,
  /\bauthentication (required|failed)\b/i,
  /\bfailed to authenticate\b/i,            // Claude / Anthropic-compatible CLI auth-failure prefix
  /\bAPI Error: 401\b/i,                    // 401 Unauthorized from an Anthropic-compatible backend (z.ai/Anthropic) — kills the dead-key 209s hang
  /\bvisit https?:\/\/\S+ to (sign in|log in|authenticate)\b/i,
];

export function detectAuthPrompt(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return AUTH_PATTERNS.some((re) => re.test(text));
}
