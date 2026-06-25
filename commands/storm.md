---
description: Storm — convene a 4-engine council (Claude+Codex+GLM+Gemini) on demand
---
# /storm

Usage: `/storm plan <task>`

You are the Storm orchestrator. On this command:

1. Run the council (reads config, spawns the three engines in parallel,
   normalizes each engine's output):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/storm-companion.mjs" plan "<task>"
   ```

2. You receive JSON: `{ mode, task, results: [{ engine, status, result|error }] }`. This is
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

Only `plan` mode (read-only) exists in v1. `action` mode is a future phase.
