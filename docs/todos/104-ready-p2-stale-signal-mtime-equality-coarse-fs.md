---
status: ready
priority: p2
issue_id: "104"
tags: [unit-11, orchestrate, post-pr-19, ce-review, adversarial, mtime, stale-signal, coarse-fs, testing-gap]
dependencies: []
---

# orchestrate: stale-signal cleanup uses strict > mtime comparison — coarse-FS equality boundary deletes live verdict

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:1992-2003, 2474-2492`, the stale-signal cleanup uses a strict `>` mtime comparison to decide whether a sibling signal predates the current tick. On coarse-resolution filesystems (FAT 2-second, NFS subsecond-less), two writes within the same resolution tick produce equal mtimes; the strict-`>` test then classifies a *live* verdict as stale and deletes it. Cross-reviewer corroboration (adversarial + testing) promoted this finding — adv flagged the equality-boundary attack, testing flagged the missing coverage.

## Findings

- Stale-signal cleanup uses strict `>` mtime comparison; coarse-FS equality boundary deletes live verdict (FAT 2s, NFS subsecond-less).
- /ce:review reviewer attribution: adversarial + testing (cross-promoted, anchor 75→100).

## Proposed Solutions

### Option A — Pre-spawn sweep of (phase, role) signals (recommended)
- Before launching a spawn, the orchestrator sweeps and deletes all `(phase, role)` signal artifacts (`{role}-complete.md`, `qa-verdict.json`, completion-signal frontmatter, etc.) from the protocol directory. After spawn, ANY signal that appears is necessarily from the new spawn.
- Eliminates mtime comparison entirely. The freshness invariant is "exists ↔ produced by current spawn" — no timestamp involved, so coarse-FS resolution is irrelevant.
- Pros: FS-resolution-independent at the design level (not just the threshold); auditable (sweep happens at a single, well-defined point); resilient to future FS quirks. Effort: small (extract the sweep into a dedicated function called pre-spawn). Risk: low — the orchestrator was the writer that the agent inherits from; deleting before re-spawn is the correct semantic.
- Cons: agent must produce signals from scratch on every spawn (no continuation across restarts) — this is already the contract.

### Option B — mtime snapshot at spawn time
- Capture spawn timestamp in manifest-status `started_at` (already there per todo 078). Compare current signal `mtime >= started_at`.
- Cons: **still has the equality-boundary case** — a signal written *just before* spawn (e.g., during the spawn-launch window) sits in the same FS-resolution bucket as `started_at` on coarse FS, so `mtime >= started_at` evaluates "fresh" even though the signal predates the spawn. Codex round 7 surfaced this. Doesn't fully close the coarse-FS case.
- This was the original RA before codex round 7. Promoted to fallback only.

### Option C — `>=` instead of `>`
- Accept equal mtime as fresh.
- Cons: same equality-boundary issue at a different spot; doesn't change the underlying coupling to mtime.

## Recommended Action

**Option A — revised 2026-05-04 post-codex round 7.** Pre-spawn sweep eliminates the mtime-comparison family of bugs (`>` strict, `>=`, `>= started_at`) by changing the freshness model from "timestamps vs threshold" to "exists ↔ current". Bundle in PR #23 cleanup wave. The original Option A (mtime vs `started_at`) was floated in coord's first pass, but codex round 7 showed the equality-boundary bug survives that fix on coarse-resolution filesystems.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1992-2003, 2474-2492`

## Acceptance Criteria

- [ ] Pre-spawn sweep deletes all `(phase, role)` signal artifacts before the orchestrator launches the spawn.
- [ ] Post-spawn: orchestrator reads signals as they appear; existence is the freshness signal. No mtime comparison in the cleanup path.
- [ ] Test: signal written one mtime-bucket BEFORE spawn launch → swept; never visible to the post-spawn read path.
- [ ] Test: signal written same mtime-bucket as spawn launch (coarse-FS tie) → swept by the pre-spawn pass; not preserved by an mtime equality bug.
- [ ] Test: FAT-2s coarse-FS scenario — pre-spawn sweep deletes everything, post-spawn signal is the only one present.
- [ ] Test: NFS subsecond-less scenario — same as FAT-2s case; sweep doesn't depend on subsecond resolution.
- [ ] Sweep is auditable: dedicated function with a clear name (e.g., `sweepPriorSignals(phaseId, role)`) called from a single site in `executeSpawn` pre-spawnFn.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
