// tests/adapters.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvocation } from '../scripts/lib/adapters.mjs';

test('antigravity argv has model, -p, skip-permissions, print-timeout', () => {
  const { cmd, args } = buildInvocation('antigravity', 'PROMPT', { model: 'Gemini 3.1 Pro (High)', printTimeout: '150s' });
  assert.equal(cmd, 'agy');
  assert.deepEqual(args, ['--model', 'Gemini 3.1 Pro (High)', '-p', 'PROMPT', '--dangerously-skip-permissions', '--print-timeout', '150s']);
});

test('codex argv is exec + prompt', () => {
  assert.deepEqual(buildInvocation('codex', 'PROMPT'), { cmd: 'codex', args: ['exec', 'PROMPT'] });
});

test('claude argv is -p prompt, model appended when set', () => {
  assert.deepEqual(buildInvocation('claude', 'PROMPT', { model: 'opus' }), { cmd: 'claude', args: ['-p', 'PROMPT', '--model', 'opus'] });
  assert.deepEqual(buildInvocation('claude', 'PROMPT', {}), { cmd: 'claude', args: ['-p', 'PROMPT'] });
});

test('unknown engine throws', () => {
  assert.throws(() => buildInvocation('grok', 'PROMPT'), /unknown engine: grok/);
});
