---
name: storm-runtime
description: Internal contract for invoking the Storm multi-engine council runtime
user-invocable: false
---
# Storm Runtime

Helper: `node "${CLAUDE_PLUGIN_ROOT}/scripts/storm-companion.mjs" plan "<task>"`

- Returns normalized JSON `{ mode, task, results: [{engine,status,result|error}] }`.
- Never exposes raw engine stdout — only the extracted STORM_RESULT block.
- Parse output, not exit codes.
- Engines with status `stalled`/`auth_required`/`timeout`/`error`/`no_result` are degraded,
  not fatal: synthesize from the engines that answered.
