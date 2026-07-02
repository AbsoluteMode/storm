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

test('proof on => self-experiment contract present', () => {
  const p = buildStormPrompt({ task: 'audit', role: 'reviewer', repoPath: '/x', proof: true });
  assert.match(p, /PROOF MODE — self-experiment/);
  assert.match(p, /\[FINDING\]/);
  assert.match(p, /The orchestrator will re-run/);
});

test('proof off => no proof contract (0.8.0 behavior)', () => {
  const p = buildStormPrompt({ task: 'audit', role: 'reviewer', repoPath: '/x', proof: false });
  assert.doesNotMatch(p, /PROOF MODE/);
  assert.doesNotMatch(p, /\[FINDING\]/);
});

test('buildStormPrompt: default (no proof) stays marker-only, no proof grammar', () => {
  const p = buildStormPrompt({ task: 'review' });
  assert.doesNotMatch(p, /PROOF MODE/);
  assert.ok(p.includes('<STORM_RESULT>'));
});

// --- delegate: executor contract ---
import { buildDelegatePrompt } from '../scripts/lib/prompt.mjs';

test('delegate prompt: task, executor contract, markers — and NO repo path, NO role line', () => {
  const p = buildDelegatePrompt({ task: 'fix the flaky retry logic' });
  assert.match(p, /fix the flaky retry logic/);
  assert.match(p, /EXECUTOR/);
  assert.match(p, /isolated copy/i);
  assert.match(p, /<STORM_RESULT>/);
  assert.match(p, /<\/STORM_RESULT>/);
  assert.doesNotMatch(p, /Repository:/);
  assert.doesNotMatch(p, /senior code reviewer/i);
});

test('delegate prompt: asks for a report (did/verified/limitations), not findings grammar', () => {
  const p = buildDelegatePrompt({ task: 'x' });
  assert.match(p, /what you did/i);
  assert.match(p, /what you verified/i);
  assert.doesNotMatch(p, /\[FINDING\]/);
});
