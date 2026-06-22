// scripts/lib/prompt.mjs
const ROLE_LINES = {
  reviewer: 'Act as a senior code reviewer. Find bugs, risks, and weak spots.',
  explorer: 'Act as a code explorer. Investigate the repository and find the root cause.',
  analyst: 'Analyze the problem and propose the single best approach.',
};

export function buildStormPrompt({ task, role = 'reviewer', repoPath } = {}) {
  const roleLine = ROLE_LINES[role] ?? ROLE_LINES.reviewer;
  return [
    roleLine,
    repoPath ? `Repository: ${repoPath}` : '',
    `Task: ${task}`,
    '',
    'Work independently. Output ONLY your final result wrapped in the markers',
    'below — no progress notes, no reasoning, nothing after the closing marker:',
    '<STORM_RESULT>',
    '- concise bullet findings or recommendation',
    '</STORM_RESULT>',
  ].filter(Boolean).join('\n');
}
