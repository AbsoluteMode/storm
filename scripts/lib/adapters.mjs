// scripts/lib/adapters.mjs
const ADAPTERS = {
  claude: {
    cmd: 'claude',
    buildArgs: (prompt, cfg) => ['-p', prompt, ...(cfg.model ? ['--model', cfg.model] : [])],
  },
  codex: {
    cmd: 'codex',
    buildArgs: (prompt) => ['exec', prompt],
  },
  antigravity: {
    cmd: 'agy',
    buildArgs: (prompt, cfg) => [
      '--model', cfg.model ?? 'Gemini 3.1 Pro (High)',
      '-p', prompt,
      '--dangerously-skip-permissions',
      '--print-timeout', cfg.printTimeout ?? '120s', // default when config omits the key
    ],
  },
};

export function buildInvocation(engineId, prompt, cfg = {}) {
  const a = ADAPTERS[engineId];
  if (!a) throw new Error(`unknown engine: ${engineId}`);
  return { cmd: a.cmd, args: a.buildArgs(prompt, cfg) };
}
