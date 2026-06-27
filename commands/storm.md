---
description: Storm — convene a 4-engine council (Claude+Codex+GLM+Gemini) on demand
---
# /storm

Usage: `/storm plan <task>` — the council reads the session's working directory by
default; for a task about a *different* local repo, target it explicitly.

You are the Storm orchestrator. On this command:

1. Run the council (reads config, spawns the four engines in parallel,
   normalizes each engine's output). By default it reads the current working
   directory. If the task is explicitly about another local repository, resolve
   that repo's ABSOLUTE path and pass it with `--cwd` so all engines (and the
   Gemini sandbox) read the right code:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/storm-companion.mjs" plan "<task>" [--cwd <abs-repo-path>]
   ```

2. You receive JSON: `{ mode, task, repoPath, results: [{ engine, status, result|error }] }`.
   `repoPath` is the directory the council actually read — surface it
   ("Council read from: `<repoPath>`") so a wrong-repo mismatch is visible. This is
   ALREADY normalized — you never see raw engine stdout (context-protection
   invariant).

3. Synthesize ONE answer:
   - Consensus (all engines agree) -> high-confidence.
   - Disagreements -> call them out explicitly for the user to review.
   - Unique findings per engine -> list them.
   - Any engine with status != ok (stalled / auth_required / timeout / no_result / error) ->
     note "<engine> did not answer (<status>)" and synthesize from the rest.

4. Return a single structured answer. Do not dump raw per-engine results
   verbatim.

When proof mode is on, results carry per-finding proof tags and the output adds
`executed_experiments` (what the orchestrator ran in an isolated copy) and
`pending_paid_experiments`. Synthesis rules:
- Only `proven` findings are reported as confirmed bugs.
- `disproven` findings are dropped (the experiment did not reproduce).
- `unproven-cannot` / `unproven-needs-paid` go in a separate "not proven" section.
- For each `pending_paid_experiments` entry, WARN the user that proving it costs
  money (show the command + provider) BEFORE any execution. Stage 1 does not run
  paid experiments — it only surfaces them.

Only `plan` mode (read-only) exists in v1. `action` mode is a future phase.
