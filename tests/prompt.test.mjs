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

test('buildStormPrompt: proof mode adds the proof tag grammar', () => {
  const p = buildStormPrompt({ task: 'review', proof: true });
  assert.ok(p.includes('[NEEDS-EXPERIMENT]'), 'proof prompt must teach the NEEDS-EXPERIMENT tag');
  assert.ok(p.includes('run:') && p.includes('expects:') && p.includes('cost:'));
  assert.ok(p.includes('[UNPROVEN-CANNOT]'));
});

test('buildStormPrompt: default (no proof) stays marker-only, no proof grammar', () => {
  const p = buildStormPrompt({ task: 'review' });
  assert.ok(!p.includes('[NEEDS-EXPERIMENT]'));
  assert.ok(p.includes('<STORM_RESULT>'));
});
