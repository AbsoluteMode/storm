# Storm

> Mixture-of-Agents for Claude Code — convene a council of frontier models on one task and synthesize a single answer.

![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)
![Node](https://img.shields.io/badge/node-%3E%3D20-green?style=flat-square)
![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen?style=flat-square)

Storm runs your prompt through three independent engines in parallel — **Claude**, **Codex** (GPT), and **GLM** (z.ai) — then synthesizes their outputs into one answer: consensus, disagreements, and unique findings. Different model weights make uncorrelated mistakes, so the synthesis keeps what they agree on and surfaces what only one caught.

It's a Claude Code plugin. One command: `/storm plan <task>`.

> [!NOTE]
> Storm uses your own CLI subscriptions (Claude, Codex) as headless subprocesses — no API keys for those. The only key it needs is a z.ai key for the GLM engine, and that stays on your machine.

## Why

Three frontier models in a blind comparison beat any single one of them. Storm is a small, practical take on [Mixture-of-Agents](https://arxiv.org/abs/2406.04692): fan a task out to a diverse council, then synthesize. It shines for review, root-cause analysis, design critique, and second opinions — the cases where one model's blind spot is another's easy catch.

## How it works

```
/storm plan <task>
        │
        ├─▶ claude  ─┐
        ├─▶ codex   ─┤  parallel, each wraps its answer in <STORM_RESULT>…</STORM_RESULT>
        └─▶ glm     ─┘
                     │
                     ▼
        orchestrator extracts each block → synthesizes one answer
        (consensus / disagreements / unique findings)
```

- **On your subscriptions.** Each engine is a headless CLI subprocess running on your own plan. Claude and Codex use their logged-in sessions; GLM uses your z.ai key, injected into an isolated subprocess so your own Claude Code stays on Anthropic.
- **Context-protected.** The orchestrator never sees raw engine chatter — only the `<STORM_RESULT>` block each engine emits. A misbehaving engine can't bloat your context.
- **Resilient.** A failed, stalled, or auth-blocked engine degrades gracefully; the council synthesizes from whoever answered.
- **Live heartbeat.** Claude and GLM are silent while reasoning. Storm runs them with `--output-format stream-json`, turning their event stream into a liveness signal so a working-but-silent engine is never killed mid-thought.

## Requirements

- Node.js 20+
- [`claude`](https://docs.claude.com/en/docs/claude-code) CLI — installed and authenticated
- [`codex`](https://github.com/openai/codex) CLI — installed and authenticated
- A [z.ai GLM Coding Plan](https://z.ai/subscribe) API key (for the GLM engine — optional, see below)

## Install

```
/plugin marketplace add AbsoluteMode/storm
/plugin install storm@storm-marketplace
```

Then configure the GLM key (below). Without it, Storm runs as a Claude + Codex duo — still a valid ensemble.

## GLM setup (z.ai)

Storm's third engine is GLM, run through the Claude Code harness pointed at z.ai's Anthropic-compatible endpoint. Get an API key from the [z.ai API console](https://z.ai/manage-apikey/apikey-list) (GLM Coding Plan), then create `.storm-secrets.json` in the plugin root:

```json
{ "glmApiKey": "your-z.ai-key" }
```

This file is gitignored and never leaves your machine. The key is injected only into the GLM subprocess, which runs with an isolated `CLAUDE_CONFIG_DIR` — your own Claude Code session is untouched and stays on Anthropic.

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

> `action` mode (parallel implementation in isolated git worktrees + smart merge) is a future phase.

## Configuration

`scripts/config.json`:

| Key | Default | Meaning |
|-----|---------|---------|
| `engines` | `claude`, `codex`, `glm` | The council. An optional `antigravity` adapter (Gemini via the `agy` CLI) is included for those who have it. |
| `role` | `reviewer` | Framing handed to each engine. |
| `stallMs` | `60000` | Inactivity watchdog. Stream engines emit a real heartbeat, so silence past this means a genuine hang. |
| `timeoutMs` | `480000` | Absolute backstop, never the primary trigger. |

## Architecture

Plain Node ESM, **zero runtime dependencies**, tested with `node --test`.

- `scripts/storm-companion.mjs` — CLI entrypoint (`plan "<task>"` → JSON results)
- `scripts/lib/`
  - `adapters.mjs` — per-engine invocation (cmd, args, env, stream flag)
  - `fan-out.mjs` — parallel runner, `Promise.allSettled` with per-engine isolation
  - `run-engine.mjs` — spawn + NDJSON accumulator + inactivity/auth/timeout watchdogs
  - `result-parser.mjs` — extract the last complete `<STORM_RESULT>` block; salvage partials
  - `auth-detect.mjs` — recognize CLI auth prompts (with a grace window for noisy engines)
  - `secrets.mjs` — load the local z.ai key, inject into the GLM engine
  - `prompt.mjs` — build the council prompt + marker contract
- `commands/storm.md`, `skills/storm-runtime/SKILL.md` — orchestrator contract

Design docs live in [`docs/specs/`](docs/specs/); implementation plans in [`docs/plans/`](docs/plans/).

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
