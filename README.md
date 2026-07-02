# Storm

> Mixture-of-Agents for Claude Code — convene a council of frontier models on one task and synthesize a single answer.

![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)
![Node](https://img.shields.io/badge/node-%3E%3D20-green?style=flat-square)
![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen?style=flat-square)

Storm runs your prompt through three independent engines in parallel — **Claude**, **Codex** (GPT), and **GLM** (z.ai), plus an optional **Gemini** adapter (Google, via OpenRouter) — then synthesizes their outputs into one answer: consensus, disagreements, and unique findings. Different model weights make uncorrelated mistakes, so the synthesis keeps what they agree on and surfaces what only one caught.

It's a Claude Code plugin. Two commands: `/storm plan <task>` (council review) and `/storm delegate <engine> <task>` (hand a task to one engine as a full-rights executor).

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
        └─▶ glm     ─┘  (+ gemini, if enabled in config)
                     │
                     ▼
        orchestrator extracts each block → synthesizes one answer
        (consensus / disagreements / unique findings)
```

- **On your own accounts.** Each engine is a headless subprocess. Claude and Codex use their logged-in CLI sessions; GLM and Gemini use your keys. GLM runs through the Claude harness pointed at z.ai (isolated config dir, so your own Claude Code stays on Anthropic); Gemini runs through an **agentic** OpenRouter wrapper that can read repo files via sandboxed `read_file`/`list_dir`/`grep` tools (confined to the working directory; secrets and `.git` blocked).
- **Context-protected.** The orchestrator never sees raw engine chatter — only the `<STORM_RESULT>` block each engine emits. A misbehaving engine can't bloat your context.
- **Resilient.** A failed, stalled, or auth-blocked engine degrades gracefully; the council synthesizes from whoever answered.
- **Liveness = progress, not clocks.** Engines do deep work and may run for minutes; a working engine (still emitting events) is never killed, however long it takes. What IS killed: an engine silent past its calibrated per-engine `stallMs` (below). The wall-clock `timeoutMs` stays opt-in (off by default); the other time-based guard is an auth-prompt grace timer. WHY: [`docs/decisions/2026-06-25-no-timeouts-liveness.md`](docs/decisions/2026-06-25-no-timeouts-liveness.md), revisited by [`docs/decisions/2026-06-30-per-engine-stall-revisit.md`](docs/decisions/2026-06-30-per-engine-stall-revisit.md).

### Liveness & progress

Each engine has a per-engine `stallMs` in `config.json` (claude 20s / glm 60s /
codex 180s), calibrated from measured worst-case normal silence. An engine that
goes silent past its threshold while still alive is killed (`stalled`) and the
council synthesizes from whoever answered; a working engine (still streaming
events) is never killed. While the council runs, a heartbeat prints to stderr
every ~15s: `[storm +45s] claude: 130ev idle 2s | codex: 38ev idle 5s | glm: …`.
Each result also carries `resolvedModel` — the actual model the engine ran.

## Requirements

- Node.js 20+
- [`claude`](https://docs.claude.com/en/docs/claude-code) CLI — installed and authenticated
- [`codex`](https://github.com/openai/codex) CLI — installed and authenticated
- *(optional)* a [z.ai GLM Coding Plan](https://z.ai/subscribe) key — for the GLM engine
- *(optional)* an [OpenRouter](https://openrouter.ai/keys) key — for the Gemini engine (not in the default council; add it to `config.engines` to use)

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
- **Experiment key (optional)** — for [proof mode](#proof-mode), engines may run networked experiments (e.g. comparing models). Add an `experimentEnv` object and it's passed into each engine's worktree env. Use a **test key with a provider-side budget cap** — the engine spends it freely while experimenting:

  ```json
  { "experimentEnv": { "OPENROUTER_API_KEY": "your-test-key" } }
  ```

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

## Proof mode

By default (`proof.enabled` in config) each engine doesn't just *claim* a finding — it **proves** it. Every CLI engine runs in its own throwaway **git worktree** with full rights (write, execute, network), reproduces each finding with a real experiment, and attaches it:

```
[FINDING] <title>
run: <the exact command it ran>
expects: <a checkable prediction: exit!=0 | exit==N | stdout contains "X">
observed: <what happened>
```

The orchestrator then **re-runs** each locally-reproducible experiment in a fresh clean worktree and sets `proven`/`disproven` itself — an engine can't self-certify a fabricated result (*verify-don't-trust*). Networked experiments (which the engine ran with your `experimentEnv` test key) are accepted as engine-claimed. **Your real repo is never touched** — engines work only in their worktrees, and the orchestrator's re-runs happen in fresh ones.

Set `proof.enabled: false` in `scripts/config.json` to fall back to plain read-only review. WHY: [`docs/decisions/2026-06-27-stage2-self-experiment.md`](docs/decisions/2026-06-27-stage2-self-experiment.md).

## Delegate mode

`/storm delegate <engine> "<task>"` — Claude Code is the customer, one engine is
the executor. The engine gets an isolated git worktree (your uncommitted work
transferred in), full rights inside it, and does the task end-to-end: writes
code, runs tests, experiments. Nothing is discarded: the work comes back as

- a report (`result` — what it did, what it verified, limitations),
- a diffstat + a **patch file** (never a raw diff in your context),
- optionally a `--verify "<cmd>"` acceptance run executed in the worktree.

Claude Code reviews the diffstat, inspects the patch selectively, and applies it
with `git apply --3way` — or rejects it. Your repo is never written by Storm
itself; an empty patch with a good report is a valid outcome for planning tasks. Patch files live in your OS tmp dir and are cleaned up by the OS, not by Storm — they must outlive the companion run so you can apply them.
Use it when another engine is simply stronger on the task at hand.

## Configuration

`scripts/config.json`:

| Key | Default | Meaning |
|-----|---------|---------|
| `engines` | `claude`, `codex`, `glm` | The council, each with per-engine `model` / `effort` / `stallMs`. Optional adapters: `gemini` (OpenRouter), `antigravity` (Gemini via the `agy` CLI). |
| `role` | `reviewer` | Framing handed to each engine. |
| `engines[].stallMs` | claude `20000`, glm `60000`, codex `180000` | Per-engine no-progress watchdog, calibrated from measured worst-case normal silence. Silent past the threshold while alive → killed as `stalled`. |
| `stallMs` | `null` | Global fallback when an engine has no own `stallMs`; `null` disables. |
| `timeoutMs` | `null` | Opt-in wall-clock backstop; `null` (default) disables it. |
| `proof` | `{ "enabled": true, "experimentTimeoutMs": 30000 }` | Proof mode toggle + time cap for each orchestrator re-run. |

Per-engine reasoning is explicit: `glm` runs at `effort: "max"`; the optional `gemini` adapter takes `reasoning: "high"`. Tune them per engine in the config.

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
  - `workspace.mjs` — per-engine git worktree (proof mode): HEAD + uncommitted transfer, cp-fallback, cleanup
  - `proof.mjs` — proof mode: `[FINDING]` parser + orchestrator verify pass (re-run, `proven`/`disproven`)
- `commands/storm.md`, `skills/storm-runtime/SKILL.md` — orchestrator contract

Design docs in [`docs/specs/`](docs/specs/); implementation plans in [`docs/plans/`](docs/plans/).

Run the tests:

```bash
node --test
```

## Limitations

- `plan` (read-only council) and `delegate` (single-engine execution via patch) exist; parallel multi-engine `action` with smart merge is a future phase.
- A stall/timeout kill reaches the direct child only; grandchildren spawned by an engine CLI may be left orphaned.
- Engines must wrap their final answer in `<STORM_RESULT>…</STORM_RESULT>`; a partial or marker-less output is salvaged best-effort.

## License

Apache-2.0. The plugin structure (companion-runtime + skill contract + commands layout) is adapted from the [`codex`](https://github.com/openai/codex) plugin by OpenAI, licensed under Apache-2.0; see [NOTICE](NOTICE).
