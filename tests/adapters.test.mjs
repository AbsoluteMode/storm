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
  assert.deepEqual(argsNoModel.slice(0, 1), ['-p']);

  const { args: argsModel } = buildInvocation('claude', 'PROMPT', { model: 'opus' });
  assert.deepEqual(argsModel.slice(0, 3), ['-p', '--model', 'opus']);
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
  assert.deepEqual(args.slice(0, 3), ['-p', '--model', 'glm-5.2']);
});

test('glm: custom model from cfg.model is honored', () => {
  const { args } = buildInvocation('glm', 'PROMPT', { apiKey: 'KEY', model: 'glm-5.2[1m]' });
  assert.deepEqual(args.slice(0, 3), ['-p', '--model', 'glm-5.2[1m]']);
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

// --- stream-json flags: claude/glm stream, codex/antigravity don't ---

const STREAM = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

test('claude: stream flags present and stream marker true', () => {
  const inv = buildInvocation('claude', 'PROMPT', {});
  assert.equal(inv.stream, true);
  for (const f of STREAM) assert.ok(inv.args.includes(f), `missing ${f}`);
  assert.ok(inv.args.includes('-p'));
});

test('glm: stream flags present and stream marker true; model kept', () => {
  const inv = buildInvocation('glm', 'PROMPT', { apiKey: 'K' });
  assert.equal(inv.stream, true);
  for (const f of STREAM) assert.ok(inv.args.includes(f), `missing ${f}`);
  assert.deepEqual(inv.args.slice(0, 3), ['-p', '--model', 'glm-5.2']);
});

test('codex: NOT a stream engine, no stream flags', () => {
  const inv = buildInvocation('codex', 'PROMPT');
  assert.equal(inv.stream, false);
  assert.ok(!inv.args.includes('stream-json'));
});

test('antigravity: NOT a stream engine', () => {
  const inv = buildInvocation('antigravity', 'PROMPT', { model: 'M' });
  assert.equal(inv.stream, false);
});

// --- gemini (OpenRouter HTTP wrapper engine) ---

test('gemini: runs the openrouter wrapper via node; default model; not a stream engine', () => {
  const inv = buildInvocation('gemini', 'PROMPT', { apiKey: 'K' });
  assert.equal(inv.stream, false);
  assert.equal(inv.input, 'PROMPT');
  assert.ok(inv.args[0].endsWith('openrouter-runner.mjs'), 'first arg must be the runner path');
  assert.equal(inv.args[1], 'google/gemini-3.5-flash');
  assert.ok(!inv.args.includes('PROMPT'), 'prompt must travel via stdin, not args');
});

test('gemini: env carries OPENROUTER_API_KEY from apiKey', () => {
  const { env } = buildInvocation('gemini', 'PROMPT', { apiKey: 'SECRET' });
  assert.equal(env.OPENROUTER_API_KEY, 'SECRET');
});

test('gemini: custom model honored', () => {
  const inv = buildInvocation('gemini', 'PROMPT', { apiKey: 'K', model: 'google/gemini-2.5-flash' });
  assert.equal(inv.args[1], 'google/gemini-2.5-flash');
});

test('gemini: missing apiKey throws a clear error', () => {
  assert.throws(() => buildInvocation('gemini', 'PROMPT', {}), /gemini.*apiKey|OpenRouter/i);
});

// --- explicit reasoning levels (deterministic, not env-inherited) ---

test('glm: --effort appended when cfg.effort is set', () => {
  const inv = buildInvocation('glm', 'P', { apiKey: 'K', effort: 'max' });
  const i = inv.args.indexOf('--effort');
  assert.ok(i >= 0, '--effort must be present');
  assert.equal(inv.args[i + 1], 'max');
});

test('glm: no --effort when cfg.effort unset', () => {
  const inv = buildInvocation('glm', 'P', { apiKey: 'K' });
  assert.ok(!inv.args.includes('--effort'));
});

test('gemini: reasoning effort passed as 3rd arg (default high)', () => {
  const inv = buildInvocation('gemini', 'P', { apiKey: 'K' });
  assert.equal(inv.args[2], 'high');
});

test('gemini: custom reasoning honored', () => {
  const inv = buildInvocation('gemini', 'P', { apiKey: 'K', reasoning: 'medium' });
  assert.equal(inv.args[2], 'medium');
});

// --- full rights: flags for CLI engines (proof mode and delegate mode) ---

test('codex fullRights => danger-full-access', () => {
  const inv = buildInvocation('codex', 'p', { fullRights: true });
  assert.deepEqual(inv.args, ['exec', '-s', 'danger-full-access']);
});

test('codex no fullRights => plain exec (0.8.0)', () => {
  const inv = buildInvocation('codex', 'p', {});
  assert.deepEqual(inv.args, ['exec']);
});

test('claude fullRights => bypassPermissions', () => {
  const inv = buildInvocation('claude', 'p', { fullRights: true });
  assert.ok(inv.args.includes('--permission-mode'));
  assert.ok(inv.args.includes('bypassPermissions'));
});

test('claude no fullRights => no permission-mode (0.8.0)', () => {
  const inv = buildInvocation('claude', 'p', {});
  assert.ok(!inv.args.includes('--permission-mode'));
});

test('glm fullRights => bypassPermissions', () => {
  const inv = buildInvocation('glm', 'p', { apiKey: 'K', fullRights: true });
  assert.ok(inv.args.includes('--permission-mode'));
  assert.ok(inv.args.includes('bypassPermissions'));
});

test('glm no fullRights => no permission-mode (0.8.0)', () => {
  const inv = buildInvocation('glm', 'p', { apiKey: 'K' });
  assert.ok(!inv.args.includes('--permission-mode'));
});

test('gemini fullRights => unchanged (read-only wrapper, no exec)', () => {
  const inv1 = buildInvocation('gemini', 'p', { apiKey: 'K', fullRights: true });
  const inv2 = buildInvocation('gemini', 'p', { apiKey: 'K' });
  assert.deepEqual(inv1.args, inv2.args);
});
