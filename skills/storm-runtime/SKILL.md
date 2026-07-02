---
name: storm-runtime
description: Internal contract for invoking the Storm multi-engine council runtime
user-invocable: false
---
# Storm Runtime

Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/storm-companion.mjs" plan "<task>" [--cwd <abs-path>]`
Delegate: `node "${CLAUDE_PLUGIN_ROOT}/scripts/storm-companion.mjs" delegate <engine> "<task>" [--cwd <abs-path>] [--verify "<cmd>"]`

- Returns normalized JSON `{ mode, task, repoPath, results: [{engine,resolvedModel,status,result|error}] }`.
- `--cwd <abs-path>`: directory the engines read (default: the companion's cwd). For a
  task about a different local repo, pass its absolute path. A bad path => exit 2
  (fail-fast — never a silent wrong-repo run).
- `repoPath` echoes the directory actually read.
- Never exposes raw engine stdout — only the extracted STORM_RESULT block.
- Parse output, not exit codes.
- Engines with status `stalled`/`auth_required`/`timeout`/`error`/`no_result` are degraded,
  not fatal: synthesize from the engines that answered, but list each dropped engine WITH its
  reason (status + error) and its `resolvedModel`. Report each answering engine's `resolvedModel`
  (source of truth for which model ran — never describe models from memory).
- Proof mode (`config.proof.enabled`): findings are tagged
  `proven`/`disproven`/`engine-claimed`/`unproven`/`unproven-cannot`; output adds
  `verified_experiments` (orchestrator re-ran locally in a fresh worktree) +
  `engine_claimed_experiments` (engine-run networked experiments, not re-run).
  Only `proven` are confirmed bugs; `engine-claimed` is reported as unverified.
- Delegate mode: one engine as full-rights executor in an isolated worktree;
  returns `{ …, status, result|error, patch: {path,files,insertions,deletions,stat}|null,
  verify: {run,exitCode,stdoutTail,stderrTail,timedOut}|null }`. The patch file is
  the deliverable — inspect selectively, apply with `git apply --3way`, never dump
  it whole. `verify.exitCode != 0` / `timedOut` / `status != ok` => don't apply by
  default. Empty patch + report is a valid outcome for planning tasks.
