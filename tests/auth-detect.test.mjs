// tests/auth-detect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAuthPrompt } from '../scripts/lib/auth-detect.mjs';

test('detects real CLI auth prompts', () => {
  assert.equal(detectAuthPrompt('You are not logged in. Run `claude login` to continue.'), true);
  assert.equal(detectAuthPrompt('Please sign in with ChatGPT to use Codex.'), true);
  assert.equal(detectAuthPrompt('Authentication required. Visit https://auth.example.com/device to sign in.'), true);
  assert.equal(detectAuthPrompt('Error: not authenticated. Please re-authenticate.'), true);
  assert.equal(detectAuthPrompt('Your session has expired. Sign in to continue.'), true);
  // z.ai / Anthropic-compatible backend rejecting the key (the 209s-hang case)
  assert.equal(detectAuthPrompt('Failed to authenticate. API Error: 401 token expired or incorrect'), true);
  assert.equal(detectAuthPrompt('API Error: 401 {"error":{"message":"Invalid API key"}}'), true);
});

test('does NOT false-positive on code review prose about auth', () => {
  assert.equal(detectAuthPrompt('The login flow validates the OAuth token before granting access.'), false);
  assert.equal(detectAuthPrompt('Consider adding a sign-in button to the authorized users page.'), false);
  assert.equal(detectAuthPrompt('This function handles authentication and authorization logic.'), false);
  assert.equal(detectAuthPrompt('<STORM_RESULT>\n- The auth module looks solid\n</STORM_RESULT>'), false);
  assert.equal(detectAuthPrompt('Users should run `gh login` before cloning private repos.'), false);
  assert.equal(detectAuthPrompt('The script calls run `npm login` at the start of CI.'), false);
  // a bare HTTP 401 discussed in code-review prose must NOT trip the detector
  assert.equal(detectAuthPrompt('The endpoint returns a 401 status when the JWT is missing.'), false);
  assert.equal(detectAuthPrompt('We map error 401 to a re-login screen in the client.'), false);
});

test('empty / non-string -> false', () => {
  assert.equal(detectAuthPrompt(''), false);
  assert.equal(detectAuthPrompt(undefined), false);
});
