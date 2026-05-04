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

### Option A — Reconciliation-aware sweep on `--resume` (recommended)
- On `--resume` entry, BEFORE sweeping, run the existing 090 reconciliation pass (or a sweep-friendly variant). For each phase in manifest-status with `status: 'spawning'`:
  - If the pidSnapshot has a live PID for the corresponding session name AND the matching `.pending-<name>` exists, the prior orchestrator died AFTER launching the tab but BEFORE the SessionStart hook fired. The tab is alive and waiting for its prompt. Mark the matching `.pending-<name>` as **preserved**.
  - Otherwise (no live PID, or no matching pending), the spawning marker is stranded: roll back to `pending` and let the matching `.pending-<name>` (if any) be swept normally.
- AFTER the reconciliation pass, sweep `.pending-*` files in the protocol directory EXCEPT the preserved set.
- Each new spawn from this resume's main loop writes its own `.pending-<name>` after the sweep — they are not affected.
- Rationale: the only legitimate `.pending-<name>` survivor across orchestrator instances is one that's bound to a live spawning marker (the prior orchestrator's spawn-launched-but-not-yet-consumed tab). All other pendings violate the protocol model and must be swept to prevent cross-tick wrong-prompt-to-wrong-agent.
- Pros: preserves the only legitimate cross-instance survivor (the in-flight spawn); correct against the protocol model; no mtime threshold. Effort: small (extends the existing 090 reconciliation pass with a sweep-set output). Risk: low.

### Option A1 — Aggressive sweep without preservation (rejected)
- Unconditional sweep of all `.pending-*` on resume.
- **Rejected post-codex round 11:** breaks the spawning-marker resume/adoption path. If the prior orchestrator died in the spawn-launched-but-not-yet-consumed window, the tab's hook fires after resume's aggressive sweep, finds no `.pending-<name>`, and the tab gets no prompt. Reconciliation marks the phase `'running'` (live PID match), but the tab silently has no work — silent broken state.

### Option B — Targeted mtime-based startup sweep
- On `--resume` entry, scan `.pending-*` files; unlink any whose mtime predates some threshold.
- **Codex round 10 ruled this out:** comparing against the prior orchestrator's lockfile mtime fails because the prior orchestrator wrote the lockfile at startup and `.pending-*` flags later, so post-lockfile-mtime stale flags survive the sweep. Comparing against `resume start - 60s` works only by accident — flags written less than 60s before the new orchestrator starts get to leak into the new run.
- Cons: every mtime threshold has a similar leak-window.

### Option C — No sweep
- Current behavior. Cons: re-introduces the cross-tick wrong-prompt-to-wrong-agent class at the resume boundary.

## Recommended Action

**Option A — revised 2026-05-04 post-codex rounds 10+11.** Reconciliation-aware sweep: the 090 spawning-marker reconciliation runs BEFORE the sweep and identifies the set of `.pending-<name>` files that are bound to a live (spawn-launched, not-yet-consumed) tab. Those are preserved; everything else is swept. The protocol model has exactly one cross-orchestrator-instance survivor (the in-flight spawn), and reconciliation is the existing mechanism for identifying it. Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:2624-2647, 2262-2279`

## Acceptance Criteria

- [ ] `--resume` runs the 090 spawning-marker reconciliation BEFORE sweeping. Reconciliation produces a set of preserved `.pending-<name>` filenames that are bound to a live PID + `'spawning'` marker.
- [ ] All `.pending-*` files in the protocol directory NOT in the preserved set are unlinked before the main loop starts.
- [ ] Sweep is logged (count of unlinked + filenames + count of preserved + reasons).
- [ ] Test: orphan `.pending-orch-phase-1-impl` from a prior run with NO live PID + `--resume` → flag swept, no wrong-prompt delivery.
- [ ] Test: prior orchestrator died after launching a tab but before SessionStart hook fired (`'spawning'` marker + live PID + matching `.pending-<name>`) → the matching flag is **preserved**, the tab's hook eventually consumes it, reconciliation transitions the phase from `'spawning'` to `'running'` correctly. The phase does NOT silently have no work.
- [ ] Test: prior orchestrator died with `'spawning'` marker but no live PID → marker rolled back to `'pending'`, matching `.pending-<name>` (if any) swept.
- [ ] Test: the resume's first new spawn writes its own `.pending-<name>` after the sweep; the SessionStart hook for that spawn finds and consumes it (sweep doesn't break the new orchestrator's first-tick happy path).
- [ ] Test: a recently-written `.pending-*` (e.g., 5 seconds before resume start) NOT bound to a live spawning marker → still swept.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
