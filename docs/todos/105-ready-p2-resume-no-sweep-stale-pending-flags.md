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

On `--resume` entry, BEFORE sweeping, run the existing 090 reconciliation pass (or a sweep-friendly variant). For each phase in manifest-status with `status: 'spawning'`, decide based on TWO orthogonal axes (live PID match? matching `.pending-<name>` present?):

| Live PID? | `.pending-<name>` present? | Meaning | Action |
|---|---|---|---|
| **Yes** | Yes | Prior orchestrator died after launching the tab but BEFORE the SessionStart hook fired. Tab is alive and waiting for its prompt. | **Preserve the flag.** Leave the `'spawning'` marker; the existing reconciliation pass will adopt once the hook consumes the flag. |
| **Yes** | No | Prior orchestrator died after the tab consumed the flag and got its prompt, but before the orchestrator persisted `'running'`. Tab is alive and working. | **Adopt now:** transition `'spawning'` → `'running'`, persist pid lazily. (No flag to preserve or sweep.) |
| **No** | Yes | Tab never started (or already died). Flag is orphaned. | Roll marker back to `'pending'`. Sweep the flag. |
| **No** | No | Tab never started. | Roll marker back to `'pending'`. (No flag to sweep.) |

AFTER the reconciliation pass, sweep all `.pending-*` files in the protocol directory EXCEPT the preserved set (the row-1 flags above). Each new spawn from this resume's main loop writes its own `.pending-<name>` after the sweep — they are not affected.

Rationale: legitimate cross-orchestrator-instance survivors fall into TWO categories — (a) the spawn-launched-but-not-yet-consumed flag (preserve) and (b) the consumed-prompt-tab-already-running case (adopt without flag). All other pendings violate the protocol model and must be swept to prevent cross-tick wrong-prompt-to-wrong-agent. Pros: correct against the protocol model; aligns with the existing 090 reconciliation table; no mtime threshold. Effort: small. Risk: low.

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

**Option A — revised 2026-05-04 post-codex rounds 10+11+12.** Reconciliation-aware sweep with the four-cell decision table above. Two legitimate cross-instance survivors: (a) live-PID + flag-present → preserve flag (tab waiting for prompt); (b) live-PID + flag-absent → adopt directly (tab already consumed and running). All other cells: roll back marker, sweep flag if present. The protocol model and the existing 090 reconciliation logic combine cleanly. Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:2624-2647, 2262-2279`

## Acceptance Criteria

- [ ] `--resume` runs the 090 spawning-marker reconciliation BEFORE sweeping, producing both a preserved-flags set and an adopted-phases set per the four-cell decision table.
- [ ] All `.pending-*` files in the protocol directory NOT in the preserved set are unlinked before the main loop starts.
- [ ] Sweep + adoption is logged (count of swept + filenames; count of preserved + filenames; count of adopted + phase/role).
- [ ] **Test (cell 1 — preserve flag):** prior orchestrator died after launching a tab but before SessionStart hook fired (`'spawning'` + live PID + matching `.pending-<name>`) → flag preserved; tab's hook eventually consumes it; reconciliation later transitions to `'running'`. Phase does NOT silently have no work.
- [ ] **Test (cell 2 — adopt without flag):** prior orchestrator died after the tab consumed its flag and got the prompt but before persisting `'running'` (`'spawning'` + live PID + NO matching `.pending-<name>`) → the new orchestrator transitions `'spawning'` → `'running'` directly during resume, persists pid. The tab is NOT re-dispatched.
- [ ] **Test (cell 3 — sweep orphan flag):** prior orchestrator died with `'spawning'` marker but no live PID, with a matching `.pending-<name>` still on disk → marker rolled back to `'pending'`; flag swept; no wrong-prompt delivery.
- [ ] **Test (cell 4 — clean rollback):** prior orchestrator died with `'spawning'` marker + no live PID + no flag → marker rolled back to `'pending'`; nothing else needed.
- [ ] Test: orphan `.pending-orch-phase-1-impl` from a prior run with NO `'spawning'` marker → swept (any pending without a live spawning binding is by-definition stale).
- [ ] Test: the resume's first new spawn writes its own `.pending-<name>` after the sweep; the SessionStart hook for that spawn finds and consumes it (sweep doesn't break first-tick happy path).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
