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

// --- glm (z.ai GLM running on the Claude Code harness with an overridden backend) ---

test('glm: prompt is in input NOT args; cmd=claude; default model glm-5.2', () => {
  const { cmd, args, input } = buildInvocation('glm', 'PROMPT', { apiKey: 'KEY' });
  assert.equal(cmd, 'claude');
  assert.equal(input, 'PROMPT');
  assert.ok(!args.includes('PROMPT'), 'prompt must not appear in args');
  assert.deepEqual(args, ['-p', '--model', 'glm-5.2']);
});

test('glm: custom model from cfg.model is honored', () => {
  const { args } = buildInvocation('glm', 'PROMPT', { apiKey: 'KEY', model: 'glm-5.2[1m]' });
  assert.deepEqual(args, ['-p', '--model', 'glm-5.2[1m]']);
});

test('glm: env carries z.ai backend override; apiKey lands in ANTHROPIC_AUTH_TOKEN', () => {
  const { env } = buildInvocation('glm', 'PROMPT', { apiKey: 'SECRET_KEY' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'SECRET_KEY');
  assert.equal(env.API_TIMEOUT_MS, '3000000');
});

test('glm: cfg can override baseUrl and timeout defaults', () => {
  const { env } = buildInvocation('glm', 'PROMPT', { apiKey: 'K', baseUrl: 'https://custom.example', apiTimeoutMs: 5000 });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://custom.example');
  assert.equal(env.API_TIMEOUT_MS, '5000');
});

test('glm: env isolates auth via a dedicated CLAUDE_CONFIG_DIR (no inherited OAuth session)', () => {
  const { env } = buildInvocation('glm', 'PROMPT', { apiKey: 'K' });
  assert.ok(
    typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.length > 0,
    "CLAUDE_CONFIG_DIR must be set so the glm child does not inherit the user's claude OAuth session",
  );
  const { env: env2 } = buildInvocation('glm', 'PROMPT', { apiKey: 'K', configDir: '/custom/dir' });
  assert.equal(env2.CLAUDE_CONFIG_DIR, '/custom/dir');
});

test('glm: missing apiKey throws a clear error (no silent 401 later)', () => {
  assert.throws(() => buildInvocation('glm', 'PROMPT', {}), /glm.*apiKey/i);
});

test('non-glm engines carry no env (backward compat)', () => {
  assert.equal(buildInvocation('claude', 'P', {}).env, undefined);
  assert.equal(buildInvocation('codex', 'P').env, undefined);
  assert.equal(buildInvocation('antigravity', 'P', { model: 'M' }).env, undefined);
});
