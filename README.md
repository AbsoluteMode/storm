# Storm

> Mixture-of-Agents for Claude Code — convene a council of frontier models on one task and synthesize a single answer.

![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)
![Node](https://img.shields.io/badge/node-%3E%3D20-green?style=flat-square)
![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen?style=flat-square)

Storm runs your prompt through four independent engines in parallel — **Claude**, **Codex** (GPT), **GLM** (z.ai), and **Gemini** (Google, via OpenRouter) — then synthesizes their outputs into one answer: consensus, disagreements, and unique findings. Different model weights make uncorrelated mistakes, so the synthesis keeps what they agree on and surfaces what only one caught.

It's a Claude Code plugin. One command: `/storm plan <task>`.

> [!NOTE]
> Claude and Codex run on your own CLI subscriptions (no API keys). GLM and Gemini use keys you provide, kept in a local gitignored file. A missing key just drops that engine — the council runs with whoever's available.

## Why

Frontier models in a blind comparison beat any single one of them. Storm is a small, practical take on [Mixture-of-Agents](https://arxiv.org/abs/2406.04692): fan a task out to a diverse council, then synthesize. It shines for review, root-cause analysis, design critique, and second opinions — the cases where one model's blind spot is another's easy catch.

## How it works

```
/storm plan <task>
        │
        ├─▶ claude  ─┐
        ├─▶ codex   ─┤  parallel, each wraps its answer in <STORM_RESULT>…</STORM_RESULT>
        ├─▶ glm     ─┤
        └─▶ gemini  ─┘
                     │
                     ▼
        orchestrator extracts each block → synthesizes one answer
        (consensus / disagreements / unique findings)
```

- **On your own accounts.** Each engine is a headless subprocess. Claude and Codex use their logged-in CLI sessions; GLM and Gemini use your keys. GLM runs through the Claude harness pointed at z.ai (isolated config dir, so your own Claude Code stays on Anthropic); Gemini runs through an **agentic** OpenRouter wrapper that can read repo files via sandboxed `read_file`/`list_dir`/`grep` tools (confined to the working directory; secrets and `.git` blocked).
- **Context-protected.** The orchestrator never sees raw engine chatter — only the `<STORM_RESULT>` block each engine emits. A misbehaving engine can't bloat your context.
- **Resilient.** A failed, stalled, or auth-blocked engine degrades gracefully; the council synthesizes from whoever answered.
- **No wall-clock kills.** Engines do deep work and may run for minutes; silence isn't death. Liveness = the process staying alive (the OS reports exit). Timeouts are opt-in (off by default); the one time-based guard is an auth-prompt grace timer. WHY: [`docs/decisions/2026-06-25-no-timeouts-liveness.md`](docs/decisions/2026-06-25-no-timeouts-liveness.md).

## Requirements

- Node.js 20+
- [`claude`](https://docs.claude.com/en/docs/claude-code) CLI — installed and authenticated
- [`codex`](https://github.com/openai/codex) CLI — installed and authenticated
- *(optional)* a [z.ai GLM Coding Plan](https://z.ai/subscribe) key — for the GLM engine
- *(optional)* an [OpenRouter](https://openrouter.ai/keys) key — for the Gemini engine

## Install

```
/plugin marketplace add AbsoluteMode/storm
/plugin install storm@storm-marketplace
```

Then add engine keys (below). With no keys, Storm runs as a Claude + Codex duo — still a valid ensemble.

## Engine keys

GLM and Gemini need keys. Put them in `.storm-secrets.json` in the plugin root — it's gitignored and never leaves your machine:

```json
{
  "glmApiKey": "your-z.ai-key",
  "openrouterApiKey": "your-openrouter-key"
}
```

- **GLM** — get a key from the [z.ai console](https://z.ai/manage-apikey/apikey-list). It's injected only into the GLM subprocess, which runs with an isolated `CLAUDE_CONFIG_DIR`; your own Claude Code session is untouched and stays on Anthropic.
- **Gemini** — get a key from [OpenRouter](https://openrouter.ai/keys). Gemini is billed per token (cheap for occasional council runs); Claude/Codex/GLM are flat-rate subscriptions. Either key is optional — omit one and that engine is simply skipped.

## Usage

```
/storm plan <task>
```

Storm is read-only (`plan`): review, RCA, analysis, second opinions. Examples:

```
/storm plan review the auth changes in this diff for security holes
/storm plan why might this WebSocket reconnect loop be dropping messages?
/storm plan critique this caching design and rank the failure modes
```

By default the council reads the directory you run it from. To audit a *different*
repo without leaving your session, target it by absolute path:

```
/storm plan review the auth flow in my other project --cwd /abs/path/to/other-repo
```

The orchestrator passes `--cwd` to the companion; every engine (and the Gemini
sandbox) then reads that repo. A non-existent path fails fast — it never silently
falls back to the current directory.

> `action` mode (parallel implementation in isolated git worktrees + smart merge) is a future phase.

## Configuration

`scripts/config.json`:

| Key | Default | Meaning |
|-----|---------|---------|
| `engines` | `claude`, `codex`, `glm`, `gemini` | The council. An optional `antigravity` adapter (Gemini via the `agy` CLI) is also included. |
| `role` | `reviewer` | Framing handed to each engine. |
| `stallMs` | `60000` | Inactivity watchdog. Stream engines emit a real heartbeat, so silence past this means a genuine hang. |
| `timeoutMs` | `480000` | Absolute backstop, never the primary trigger. |

Per-engine reasoning is explicit: `glm` runs at `effort: "max"`, `gemini` at `reasoning: "high"`. Tune them per engine in the config.

## Architecture

Plain Node ESM, **zero runtime dependencies**, tested with `node --test`.

- `scripts/storm-companion.mjs` — CLI entrypoint (`plan "<task>"` → JSON results)
- `scripts/lib/`
  - `adapters.mjs` — per-engine invocation (cmd, args, env, stream flag)
  - `fan-out.mjs` — parallel runner, `Promise.allSettled` with per-engine isolation
  - `run-engine.mjs` — spawn + NDJSON accumulator + inactivity/auth/timeout watchdogs
  - `openrouter-runner.mjs` — agentic wrapper engine (Gemini via OpenRouter); multi-turn tool loop
  - `openrouter-tools.mjs` — sandboxed read-only file tools (`read_file`/`list_dir`/`grep`, confined to cwd, secrets/.git blocked)
  - `result-parser.mjs` — extract the last complete `<STORM_RESULT>` block; salvage partials
  - `auth-detect.mjs` — recognize CLI auth prompts (with a grace window for noisy engines)
  - `secrets.mjs` — load local keys, inject into the matching engine
  - `prompt.mjs` — build the council prompt + marker contract
- `commands/storm.md`, `skills/storm-runtime/SKILL.md` — orchestrator contract

Design docs in [`docs/specs/`](docs/specs/); implementation plans in [`docs/plans/`](docs/plans/).

Run the tests:

```bash
node --test
```

## Limitations

- Read-only (`plan`) for now; `action` mode is a future phase.
- The timeout kills the direct child only; grandchildren spawned by an engine CLI may be left orphaned.
- Engines must wrap their final answer in `<STORM_RESULT>…</STORM_RESULT>`; a partial or marker-less output is salvaged best-effort.

## License

Apache-2.0. The plugin structure (companion-runtime + skill contract + commands layout) is adapted from the [`codex`](https://github.com/openai/codex) plugin by OpenAI, licensed under Apache-2.0; see [NOTICE](NOTICE).
