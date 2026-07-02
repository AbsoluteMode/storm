# Per-engine stall detection — revisiting no-timeouts

- Date: 2026-06-30
- Supersedes (in part): docs/decisions/2026-06-25-no-timeouts-liveness.md

## Context

A live run had glm hang for 30 minutes (CPU 0.1%, no output). `fan-out` waits
for all engines, so the council never finished. This is the exact tradeoff the
no-timeouts decision accepted ("a deadlocked-but-alive process hangs until
Ctrl-C").

## Decision

Re-enable stall detection, but per-engine and calibrated, not a single global
threshold. Thresholds (from two instrumented spikes, max normal silence + margin):
claude 20s, glm 60s, codex 180s. An engine silent past its threshold WHILE ALIVE
is killed (`stalled`); a working engine (emitting stream events) re-arms the timer
and is never killed. Partial synthesis falls out of `Promise.allSettled`.

## Why this does not reintroduce the old bug

No-timeouts removed stall because claude/glm went silent during reasoning and
codex under xhigh is silent up to ~60s — a blind global stall killed working
engines. That was before heartbeat existed. Now claude/glm stream NDJSON
throughout and codex streams item events in stderr; the spikes measured each
engine's worst normal silence, so a per-engine threshold with margin kills only
a genuinely silent engine. "Liveness, not clocks" is preserved and sharpened:
liveness = stream progress measured per engine.

## What we rejected

- Single global stall threshold — one number cannot fit both claude (4s) and
  codex (67s); that is why it was disabled.
- Wall-clock cap per engine — kills a slow-but-working engine; the whole point is
  to distinguish "working long" from "hung".
- fs-watch on the worktree as an extra signal — spike showed file writes coincide
  with stream events (filesInGap=0); redundant.
