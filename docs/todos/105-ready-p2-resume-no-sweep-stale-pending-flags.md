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

### Option A — Targeted mtime-based startup sweep (recommended)
- On `--resume` entry, scan `.pending-*` files; unlink any whose mtime predates the prior orchestrator's lockfile last-touch (or, if no prior lockfile metadata, predates the resume's own start time minus a small grace).
- Pros: targeted; preserves any genuinely-in-flight pendings at restart. Effort: small. Risk: low.

### Option B — Aggressive sweep all .pending-* on resume
- Unlink every .pending-* on resume regardless of age.
- Cons: removes legitimate in-flight pendings if the user restarts the orchestrator quickly.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** Targeted by mtime against the prior lockfile timestamp. If lockfile metadata is unavailable (clean shutdown removed it), fall back to "predates resume start - 60s" — same hard-TTL pattern as todo 005. Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:2624-2647, 2262-2279`

## Acceptance Criteria

- [ ] `--resume` on a dir with stale `.pending-*` (mtime older than prior lockfile) → those files removed before main loop starts.
- [ ] `--resume` preserves recent `.pending-*` (within 60s of resume start when no prior lockfile metadata).
- [ ] Sweep is logged (count of unlinked + reason).
- [ ] Test: orphan `.pending-orch-phase-1-impl` from prior run + `--resume` → flag swept, no wrong-prompt delivery.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
