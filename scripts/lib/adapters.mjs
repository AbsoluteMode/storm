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

const ADAPTERS = {
  claude: {
    cmd: 'claude',
    buildArgs: (_prompt, cfg) => ['-p', ...(cfg.model ? ['--model', cfg.model] : [])],
  },
  codex: {
    cmd: 'codex',
    buildArgs: () => ['exec'],
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
};

export function buildInvocation(engineId, prompt, cfg = {}) {
  const a = ADAPTERS[engineId];
  if (!a) throw new Error(`unknown engine: ${engineId}`);
  return { cmd: a.cmd, args: a.buildArgs(prompt, cfg), input: prompt };
}
