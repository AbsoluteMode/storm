# Storm

Multi-engine council for Claude Code. `/storm plan <task>` fans a task out to
three independent engines — Claude, Codex (GPT), Antigravity (Gemini 3.1 Pro
High) — in parallel, normalizes each engine's output, and synthesizes one
answer (consensus / disagreements / unique findings).

## Requirements

- `claude`, `codex`, and `agy` CLIs installed and authenticated.
- Node.js 20+.

## Usage

```
/storm plan <task>
```

v1 is read-only (review / RCA / analysis). `action` mode (parallel
implementation in git worktrees + smart merge) is a future phase.

## Config

`scripts/config.json` — engines, models, timeouts. Antigravity is pinned to
`Gemini 3.1 Pro (High)`.

## Limitations (v1)

- Timeout kills the direct child process only; grandchildren spawned by the engine CLI may be left orphaned.
- stderr tail is included in `no_result` diagnostics; some CLIs echo prompt or model text there.

## License

Apache-2.0. Plugin structure adapted from the `codex` plugin (OpenAI); see NOTICE.
