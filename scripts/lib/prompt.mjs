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

const PROOF_CONTRACT = [
  'Work independently. Every bug you report MUST be PROVABLE. Do NOT assert a bug',
  'from reading alone. Tag EACH finding inside the markers using this grammar:',
  '  [NEEDS-EXPERIMENT] <one-line title>',
  '    run: <a shell command that reproduces the bug>',
  '    expects: <what output proves it: exit!=0 | stdout contains "X" | stderr contains "X", joined by AND>',
  '    cost: free | paid:<provider>   (free = local, no network; paid = needs a network/paid API)',
  '  [UNPROVEN-CANNOT] <title> — why: <race / nondeterminism / no tool available>',
  'Do NOT output [PROVEN] yourself — the orchestrator runs your experiment and decides.',
  'Output ONLY the tagged findings wrapped in the markers, nothing after the close:',
  '<STORM_RESULT>',
  '[NEEDS-EXPERIMENT] ...',
  '</STORM_RESULT>',
];

export function buildStormPrompt({ task, role = 'reviewer', repoPath, proof = false } = {}) {
  const roleLine = ROLE_LINES[role] ?? ROLE_LINES.reviewer;
  return [
    roleLine,
    repoPath ? `Repository: ${repoPath}` : '',
    `Task: ${task}`,
    '',
    ...(proof ? PROOF_CONTRACT : DEFAULT_CONTRACT),
  ].filter(Boolean).join('\n');
}
