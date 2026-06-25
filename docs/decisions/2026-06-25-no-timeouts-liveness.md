# No engine timeouts — liveness over wall-clock

**Date:** 2026-06-25

## Context

Storm fans a task out to N engine CLIs (claude, codex, glm) as child processes and
waits for each to finish. `run-engine.mjs` guarded every child with two wall-clock
kills: a backstop `timeoutMs` (total runtime) and an inactivity `stallMs` (SIGKILL
if no stdout/stderr for N seconds). claude/glm stream NDJSON token deltas
(continuous heartbeat), so a 60s stall was safe for them. codex (`codex exec`) does
not stream while reasoning.

A live `/storm` run marked codex `stalled` ("no output for 60000ms"). Reproduction
(instrumenting codex exactly as Storm spawns it — `codex exec`, prompt via stdin):
under `model_reasoning_effort=xhigh`, codex emitted startup chatter on stderr (~7s)
then went **completely silent for ~61s** while reasoning, then printed a valid
answer and exited 0. The stall timer SIGKILLed a healthy process ~1s before it
would have answered. `codex exec --json` emits events only at item boundaries
(thread/turn/item.started/completed) with **no reasoning deltas**, so even JSONL
mode cannot provide a token-level heartbeat during a long silent reasoning stretch.

## Decision

Remove wall-clock kills as the default policy. Engines may legitimately run for
minutes to hours; **silence is not death.** Liveness is determined by:

- **process staying alive** — `child.on('close')` / `child.on('error')` are the
  terminal signals (the OS reports death; no timer needed);
- **output growth** — tracked (`lastActivityMs`) as a health/diagnostic signal,
  not a kill trigger.

`timeoutMs` and `stallMs` become opt-in: a positive number arms the timer, `null`/`0`
disables it. The shipped `config.json` sets both to `null`. The one kept time-based
guard is the **auth-prompt grace timer**: it arms only after an auth/permission
prompt is detected in output and fires only if the engine then goes silent — a real
input-wait hang (engine asked for input, but stdin is closed, so it waits forever).
State-triggered, not a blind clock.

## Why

- These engines do deep agentic work. Any fixed threshold eventually false-kills a
  legitimate long run; raising it just moves the cliff. Owner's intent: never murder
  a working engine — wait, or abort manually.
- codex cannot be given a token-level heartbeat (no reasoning deltas in any output
  mode), so a stall timer can never reliably tell "reasoning" from "hung" for it.
  The correct liveness signal is process state, which the OS already provides for
  free via close/exit.
- claude/glm streaming stays useful for progress visibility, but is no longer
  load-bearing for liveness.

## What we tested

- Reproduced the root cause: plain `codex exec` silent ~61s mid-reasoning, then a
  valid answer, exit 0 — confirming the kill was a false positive on a healthy run.
- Confirmed `codex exec --json` has no reasoning deltas (events only at item
  boundaries) → token heartbeat impossible.
- Unit tests: a disabled stall (`null`) lets a quietly-working engine finish ok; the
  same engine WOULD be stalled under a tiny enabled `stallMs` (contrast); auth-grace
  still fires with stall+timeout disabled. 82/82 green.
- Live e2e through the real config (timers `null`): codex returned `ok` at 69.1s
  (silent past the old 60s point), relying solely on process exit.

## Rejected

- **Raise codex's stall threshold (e.g. 300s) / per-engine stall override** — still
  a wall-clock cliff; false-kills longer runs. (This was the first fix; superseded.)
- **Switch codex to `codex exec --json` for a heartbeat** — item-boundary events
  only, no reasoning deltas → a long silent reasoning stretch still stalls; also
  needs a codex-specific result parser. Kept as a possible future progress-visibility
  enhancement, not a liveness fix.
- **A very large safety backstop (hours)** — still a cliff; owner wants none. Trivial
  to re-enable per-engine (timers are opt-in).
- **CPU / waiting-on-read polling to detect hangs** — network-wait and reasoning look
  idle too; brittle.

**Tradeoff accepted:** a process that is alive but truly deadlocked (no output, never
exits, no auth prompt) is not auto-killed — it waits until manual abort. Rare for
these CLIs; auth-grace covers the common input-wait case.

Shipped: Storm 0.6.0 (branch `fix/no-engine-timeouts`).
