// scripts/lib/adapters.mjs
//
// Each adapter returns { cmd, args } for argv flags only.
// The prompt travels via stdin (the `input` field added by buildInvocation),
// NOT as an argv element — avoids OS ARG_MAX failures on large prompts.
//
// Stdin forms verified 2026-06-22:
//   claude  : `claude -p`           — no prompt arg; -p with no argument reads stdin
//   codex   : `codex exec`          — no prompt arg; reads stdin when arg omitted
//   agy     : `agy --model M -p ...`— no prompt arg; -p with no argument reads stdin

import { fileURLToPath } from 'node:url';

const OPENROUTER_RUNNER = fileURLToPath(new URL('./openrouter-runner.mjs', import.meta.url));
const STREAM_FLAGS = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

const ADAPTERS = {
  claude: {
    cmd: 'claude',
    stream: true,
    buildArgs: (_prompt, cfg) => ['-p',
      ...(cfg.proof ? ['--permission-mode', 'bypassPermissions'] : []),
      ...(cfg.model ? ['--model', cfg.model] : []),
      ...STREAM_FLAGS],
  },
  codex: {
    cmd: 'codex',
    buildArgs: (_prompt, cfg) => cfg.proof ? ['exec', '-s', 'danger-full-access'] : ['exec'],
  },
  antigravity: {
    cmd: 'agy',
    buildArgs: (_prompt, cfg) => [
      '--model', cfg.model ?? 'Gemini 3.1 Pro (High)',
      '-p',
      '--dangerously-skip-permissions',
      '--print-timeout', cfg.printTimeout ?? '120s', // default when config omits the key
    ],
  },
  // glm: z.ai's GLM on the Claude Code harness — same `claude` binary, but the
  // backend is redirected to z.ai via env (NOT global settings, so the user's own
  // Claude Code stays on Anthropic). The key travels as ANTHROPIC_AUTH_TOKEN.
  glm: {
    cmd: 'claude',
    stream: true,
    buildArgs: (_prompt, cfg) => ['-p',
      ...(cfg.proof ? ['--permission-mode', 'bypassPermissions'] : []),
      '--model', cfg.model ?? 'glm-5.2',
      ...STREAM_FLAGS,
      ...(cfg.effort ? ['--effort', cfg.effort] : [])],
    buildEnv: (cfg) => {
      if (!cfg.apiKey) throw new Error('glm: missing apiKey (z.ai key required — set it in .storm-secrets.json)');
      return {
        ANTHROPIC_BASE_URL: cfg.baseUrl ?? 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: cfg.apiKey,
        API_TIMEOUT_MS: String(cfg.apiTimeoutMs ?? 3000000),
        // Dedicated config dir: the child claude must NOT inherit the user's logged-in
        // session — that OAuth token would be sent to z.ai and rejected (401). A
        // separate dir is not logged in, so it authenticates with ANTHROPIC_AUTH_TOKEN.
        CLAUDE_CONFIG_DIR: cfg.configDir ?? `${process.env.HOME}/.storm-glm-claude`,
      };
    },
  },
  // gemini: an HTTP provider (Gemini via OpenRouter), run through a small node
  // wrapper that streams SSE. It isn't a CLI of its own — the wrapper is the
  // "binary". content -> stdout (answer), reasoning -> stderr (heartbeat).
  gemini: {
    cmd: process.execPath, // node
    buildArgs: (_prompt, cfg) => [OPENROUTER_RUNNER, cfg.model ?? 'google/gemini-3.5-flash', cfg.reasoning ?? 'high'],
    buildEnv: (cfg) => {
      if (!cfg.apiKey) throw new Error('gemini: missing apiKey (OpenRouter key required — set openrouterApiKey in .storm-secrets.json)');
      return { OPENROUTER_API_KEY: cfg.apiKey };
    },
  },
};

export function buildInvocation(engineId, prompt, cfg = {}) {
  const a = ADAPTERS[engineId];
  if (!a) throw new Error(`unknown engine: ${engineId}`);
  // env is per-engine backend config (only glm needs it today); undefined for the rest.
  const env = a.buildEnv ? a.buildEnv(cfg) : undefined;
  return { cmd: a.cmd, args: a.buildArgs(prompt, cfg), input: prompt, env, stream: a.stream ?? false };
}
