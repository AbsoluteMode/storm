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
});

test('does NOT false-positive on code review prose about auth', () => {
  assert.equal(detectAuthPrompt('The login flow validates the OAuth token before granting access.'), false);
  assert.equal(detectAuthPrompt('Consider adding a sign-in button to the authorized users page.'), false);
  assert.equal(detectAuthPrompt('This function handles authentication and authorization logic.'), false);
  assert.equal(detectAuthPrompt('<STORM_RESULT>\n- The auth module looks solid\n</STORM_RESULT>'), false);
  assert.equal(detectAuthPrompt('Users should run `gh login` before cloning private repos.'), false);
  assert.equal(detectAuthPrompt('The script calls run `npm login` at the start of CI.'), false);
});

test('empty / non-string -> false', () => {
  assert.equal(detectAuthPrompt(''), false);
  assert.equal(detectAuthPrompt(undefined), false);
});
