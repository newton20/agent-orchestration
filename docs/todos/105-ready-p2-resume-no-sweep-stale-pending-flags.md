---
status: ready
priority: p2
issue_id: "105"
tags: [unit-11, orchestrate, post-pr-19, ce-review, adversarial, resume, stale-flags, pending-flags]
dependencies: []
---

# orchestrate: --resume does not sweep stale .pending-* flags at startup — stale flag delivered to unrelated newly-spawned sessions

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:2624-2647, 2262-2279`, the `--resume` startup path does not sweep stale `.pending-*` flags from the protocol directory. If a prior orchestrator died after writing a `.pending-orch-<phase>-<role>` flag but before the target session consumed it, that flag persists. On `--resume`, when a new session for the same `(phase, role)` spawns, it consumes the stale flag — delivering an outdated prompt to a freshly-spawned agent, with the same wrong-prompt-to-wrong-agent semantics as todo 099 but at startup boundary.

## Findings

- `--resume` does not sweep stale `.pending-*` flags at startup → stale flag delivered to unrelated newly-spawned sessions.
- /ce:review reviewer attribution: adversarial.

## Proposed Solutions

### Option A — Aggressive sweep of all `.pending-*` on `--resume` (recommended)
- On `--resume` entry, before the main loop starts, unlink every `.pending-*` in the protocol directory unconditionally.
- Rationale: by definition `--resume` runs after the prior orchestrator died. The prior orchestrator was the only legitimate writer of `.pending-*` flags; nothing the prior orchestrator wrote could still be valid for the new orchestrator's spawns (each new spawn writes a fresh `.pending-<name>` for the (phase, role) it dispatches). The contract "exists ↔ produced by THIS orchestrator's most recent spawn for that name" is violated for any flag found at resume entry, regardless of age.
- The first spawn this resume issues writes its own `.pending-<name>` after the sweep, so legitimate in-flight pendings re-appear within milliseconds.
- Pros: simple; correct against the protocol model; no mtime threshold to misjudge. Effort: trivial. Risk: low.

### Option B — Targeted mtime-based startup sweep
- On `--resume` entry, scan `.pending-*` files; unlink any whose mtime predates some threshold.
- **Codex round 10 ruled this out:** comparing against the prior orchestrator's lockfile mtime fails because the prior orchestrator wrote the lockfile at startup and `.pending-*` flags later, so post-lockfile-mtime stale flags survive the sweep. Comparing against `resume start - 60s` works only by accident — flags written less than 60s before the new orchestrator starts get to leak into the new run.
- Cons: every mtime threshold has a similar leak-window; the protocol model doesn't need any preservation, so this option only adds risk.

### Option C — No sweep
- Current behavior. Cons: re-introduces the cross-tick wrong-prompt-to-wrong-agent class at the resume boundary.

## Recommended Action

**Option A — revised 2026-05-04 post-codex round 10.** Aggressive sweep on `--resume`. The protocol model says any `.pending-*` flag found at resume entry is by-definition stale; mtime thresholds add risk without benefit. Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:2624-2647, 2262-2279`

## Acceptance Criteria

- [ ] `--resume` on a dir with any `.pending-*` files (regardless of mtime) → ALL of them removed before main loop starts.
- [ ] Sweep is logged (count of unlinked + filenames).
- [ ] Test: orphan `.pending-orch-phase-1-impl` from prior run + `--resume` → flag swept, no wrong-prompt delivery.
- [ ] Test: the resume's first spawn writes its own `.pending-<name>` after the sweep; the SessionStart hook for that spawn finds and consumes it (i.e., the sweep doesn't break the new orchestrator's first-tick happy path).
- [ ] Test: `--resume` with a recently-written `.pending-*` (e.g., 5 seconds before resume start) → still swept (the protocol model says no flag is preservable across orchestrator instances).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
