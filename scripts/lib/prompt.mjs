// scripts/lib/prompt.mjs
const ROLE_LINES = {
  reviewer: 'Act as a senior code reviewer. Find bugs, risks, and weak spots.',
  explorer: 'Act as a code explorer. Investigate the repository and find the root cause.',
  analyst: 'Analyze the problem and propose the single best approach.',
};

const DEFAULT_CONTRACT = [
  'Work independently. Output ONLY your final result wrapped in the markers',
  'below — no progress notes, no reasoning, nothing after the closing marker:',
  '<STORM_RESULT>',
  '- concise bullet findings or recommendation',
  '</STORM_RESULT>',
];

const SELF_EXPERIMENT_CONTRACT = [
  'PROOF MODE — self-experiment in your isolated copy:',
  '- Your working directory (`.`) is a throwaway copy of the repo. Do anything:',
  '  write files, run commands, install deps, use the network.',
  '- For each finding, REPRODUCE it yourself with a minimal experiment in this',
  '  copy. Do not describe hypothetically — run it.',
  '- Attach to each finding, exactly:',
  '  [FINDING] <one-line title>',
  '  run: <exact command you ran>',
  '  expects: <checkable prediction: exit!=0 | exit==N | stdout contains "X" | stderr contains "X"; join clauses with AND>',
  '  observed: <what actually happened>',
  '- Mark a finding proven ONLY if you actually reproduced it. If you cannot',
  '  reproduce it (no tool / non-deterministic), use:',
  '  [UNPROVEN-CANNOT] <title> — why: <reason>',
  'The orchestrator will re-run your `run`/`expects` in a clean copy. Fabricated',
  'results will be caught.',
  'Output ONLY the tagged findings wrapped in the markers, nothing after the close:',
  '<STORM_RESULT>',
  '[FINDING] ...',
  '</STORM_RESULT>',
];

export function buildStormPrompt({ task, role = 'reviewer', repoPath, proof = false } = {}) {
  const roleLine = ROLE_LINES[role] ?? ROLE_LINES.reviewer;
  return [
    roleLine,
    repoPath ? `Repository: ${repoPath}` : '',
    `Task: ${task}`,
    '',
    ...(proof ? SELF_EXPERIMENT_CONTRACT : DEFAULT_CONTRACT),
  ].filter(Boolean).join('\n');
}
