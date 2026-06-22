// tests/prompt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStormPrompt } from '../scripts/lib/prompt.mjs';

test('includes task, role line, and marker contract', () => {
  const p = buildStormPrompt({ task: 'find the deadlock', role: 'explorer', repoPath: '/repo' });
  assert.match(p, /find the deadlock/);
  assert.match(p, /explorer|investigate/i);
  assert.match(p, /<STORM_RESULT>/);
  assert.match(p, /<\/STORM_RESULT>/);
  assert.match(p, /\/repo/);
});

test('defaults to reviewer role and omits repo line when absent', () => {
  const p = buildStormPrompt({ task: 'review diff' });
  assert.match(p, /review/i);
  assert.doesNotMatch(p, /Repository:/);
});

test('uses analyst role line for analyst role', () => {
  const p = buildStormPrompt({ task: 'x', role: 'analyst' });
  assert.match(p, /analy/i);
});

test('falls back to reviewer for unknown role', () => {
  const p = buildStormPrompt({ task: 'x', role: 'nonsense' });
  assert.match(p, /review/i);
});
