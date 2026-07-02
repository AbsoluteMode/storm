---
description: Storm — multi-engine council (plan) and single-engine delegation (delegate)
---
# /storm

Usage: `/storm plan <task>` — the council reads the session's working directory by
default; for a task about a *different* local repo, target it explicitly.
`/storm delegate <engine> <task>` — delegate the task to one engine as a full-rights executor in an isolated worktree.

You are the Storm orchestrator. On this command:

1. Run the council (reads config, spawns the configured engines in parallel,
   normalizes each engine's output). By default it reads the current working
   directory. If the task is explicitly about another local repository, resolve
   that repo's ABSOLUTE path and pass it with `--cwd` so all engines read the right code:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/storm-companion.mjs" plan "<task>" [--cwd <abs-repo-path>]
   ```

2. You receive JSON: `{ mode, task, repoPath, results: [{ engine, resolvedModel, status, result|error }] }`.
   `repoPath` is the directory the council actually read — surface it
   ("Council read from: `<repoPath>`") so a wrong-repo mismatch is visible. This is
   ALREADY normalized — you never see raw engine stdout (context-protection
   invariant).

3. Synthesize ONE answer:
   - State which engine ran which model, from each result's `resolvedModel`
     (e.g. "claude: claude-opus-4-8, codex: gpt-5.5, glm: glm-5.2"). Never
     describe models from memory — `resolvedModel` is the source of truth.
   - Consensus (engines agree) -> high-confidence.
   - Disagreements -> call them out explicitly for the user to review.
   - Unique findings per engine -> list them (divergence is the point; do not
     drop a finding just because only one engine raised it).
   - For EVERY engine with status != ok (stalled / auth_required / timeout /
     no_result / error): report "<engine> (<resolvedModel>) did not answer:
     <status> — <error>". Do not silently synthesize from a subset; the user
     must see who dropped and why.

4. Return a single structured answer. Do not dump raw per-engine results
   verbatim.

When proof mode is on (`config.proof.enabled`), each result's `findings` carry a
tag, and the output adds `verified_experiments` (experiments the orchestrator
re-ran itself in a fresh clean worktree) and `engine_claimed_experiments`
(networked experiments the engine ran with its own budget-capped test key —
NOT re-run by the orchestrator). Synthesis rules:
- `proven` (orchestrator re-ran the experiment and the prediction matched) ->
  report as confirmed bugs.
- `disproven` (re-run did not match) -> dropped (the experiment did not reproduce).
- `engine-claimed` -> own section, marked "engine-claimed (networked, not
  independently verified)".
- `unproven` / `unproven-cannot` -> a separate "not proven" section (include the
  engine's stated why when present).

## /storm delegate <engine> "<task>"

One engine (codex | glm | claude) works as the EXECUTOR in an isolated git
worktree with full rights inside it; you are the customer accepting the work.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/storm-companion.mjs" delegate <engine> "<task>" [--cwd <abs-repo-path>] [--verify "<cmd>"]
```

- Long delegations: run in a background shell; a per-engine heartbeat streams
  to stderr (`[storm +45s] codex: 38ev idle 5s`) — check it periodically.
- You receive JSON: `{ mode:"delegate", engine, resolvedModel, task, repoPath,
  status, result|error, patch, verify }`. A non-ok status carries `error` (the
  reason) and may omit `result`. `patch` is `{ path, files, insertions,
  deletions, stat }` or `null` (a planning/research task delivers via `result`
  alone — that is a valid outcome). `verify` is `{ run, exitCode, stdoutTail,
  stderrTail, timedOut }` or `null`.
- Acceptance flow (you are the customer):
  1. Read `result` (the executor's report) and `patch.stat`.
  2. Inspect the patch file selectively (Read with offset/limit) — NEVER dump
     it whole into the conversation.
  3. If `verify` ran: `exitCode != 0` or `timedOut` => do NOT apply; report to
     the user, return the task to the executor or fix it yourself.
  4. Apply: `git apply --3way "<patch.path>"`, run your own checks; to roll
     back: `git apply -R "<patch.path>"`.
  5. `status != ok` => the patch (if any) is partial work of a killed engine;
     default to NOT applying — surface it to the user instead.
- Surface `repoPath` and `resolvedModel`, as in plan mode.

`plan` (council review) and `delegate` (single-engine execution) exist. Parallel multi-engine implementation (`action` with smart merge) is a future phase.
