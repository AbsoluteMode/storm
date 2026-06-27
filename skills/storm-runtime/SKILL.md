---
name: storm-runtime
description: Internal contract for invoking the Storm multi-engine council runtime
user-invocable: false
---
# Storm Runtime

Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/storm-companion.mjs" plan "<task>" [--cwd <abs-path>]`

- Returns normalized JSON `{ mode, task, repoPath, results: [{engine,status,result|error}] }`.
- `--cwd <abs-path>`: directory the engines read (default: the companion's cwd). For a
  task about a different local repo, pass its absolute path. A bad path => exit 2
  (fail-fast — never a silent wrong-repo run).
- `repoPath` echoes the directory actually read.
- Never exposes raw engine stdout — only the extracted STORM_RESULT block.
- Parse output, not exit codes.
- Engines with status `stalled`/`auth_required`/`timeout`/`error`/`no_result` are degraded,
  not fatal: synthesize from the engines that answered.
- Proof mode (`config.proof.enabled`): findings are tagged proven/disproven/unproven-*;
  output adds `executed_experiments` + `pending_paid_experiments`. Only `proven` are
  confirmed bugs; paid experiments are surfaced, never auto-run.
