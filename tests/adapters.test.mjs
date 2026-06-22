// tests/adapters.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvocation } from '../scripts/lib/adapters.mjs';

// --- prompt travels via input, not args ---

test('claude: prompt is in input, NOT in args', () => {
  const { cmd, args, input } = buildInvocation('claude', 'PROMPT', {});
  assert.equal(cmd, 'claude');
  assert.equal(input, 'PROMPT');
  assert.ok(!args.includes('PROMPT'), 'prompt must not appear in args');
});

test('claude: -p flag present, no prompt arg; model appended when set', () => {
  const { args: argsNoModel } = buildInvocation('claude', 'PROMPT', {});
  assert.deepEqual(argsNoModel, ['-p']);

  const { args: argsModel } = buildInvocation('claude', 'PROMPT', { model: 'opus' });
  assert.deepEqual(argsModel, ['-p', '--model', 'opus']);
});

test('codex: prompt is in input, NOT in args', () => {
  const { cmd, args, input } = buildInvocation('codex', 'PROMPT');
  assert.equal(cmd, 'codex');
  assert.equal(input, 'PROMPT');
  assert.ok(!args.includes('PROMPT'), 'prompt must not appear in args');
  assert.deepEqual(args, ['exec']);
});

test('antigravity: prompt is in input, NOT in args', () => {
  const { cmd, args, input } = buildInvocation('antigravity', 'PROMPT', {
    model: 'Gemini 3.1 Pro (High)',
    printTimeout: '150s',
  });
  assert.equal(cmd, 'agy');
  assert.equal(input, 'PROMPT');
  assert.ok(!args.includes('PROMPT'), 'prompt must not appear in args');
  assert.deepEqual(args, [
    '--model', 'Gemini 3.1 Pro (High)',
    '-p',
    '--dangerously-skip-permissions',
    '--print-timeout', '150s',
  ]);
});

test('antigravity: default printTimeout applied when cfg omits it', () => {
  const { args } = buildInvocation('antigravity', 'PROMPT', { model: 'M' });
  assert.ok(args.includes('120s'), 'default printTimeout 120s must be in args');
});

test('unknown engine throws', () => {
  assert.throws(() => buildInvocation('grok', 'PROMPT'), /unknown engine: grok/);
});
