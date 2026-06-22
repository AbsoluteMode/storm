// scripts/lib/auth-detect.mjs
// NARROW patterns: target CLI auth-FAILURE phrasing, not generic auth vocabulary.
// Storm reviews auth-related code, so generic words ("login", "oauth", "authorize")
// must NOT trigger. Only phrasings a CLI emits when it cannot authenticate do.
const AUTH_PATTERNS = [
  /\bnot (authenticated|logged in|signed in)\b/i,
  /\bplease (re-?)?(authenticate|sign in|log in)\b/i,
  /\b(run|execute) `?[a-z]+ login`?/i,          // "run `claude login`"
  /\bsign in with (chatgpt|google|github|your)\b/i,
  /\bauthentication (required|failed)\b/i,
  /\bvisit https?:\/\/\S+ to (sign in|log in|authenticate)\b/i,
];

export function detectAuthPrompt(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return AUTH_PATTERNS.some((re) => re.test(text));
}
