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

### Option A — Per-spawn signal id encoded in artifact frontmatter (recommended)
- Orchestrator generates a fresh `spawn_id` (UUID or monotonic integer) per spawn. Persists it to manifest-status alongside `started_at`. Renders the spawn_id into the agent's prompt template (or passes via argv/env) so the agent embeds it into produced signal artifacts (`{role}-complete.md` frontmatter, `qa-verdict.json` field).
- The orchestrator-side cleanup pass: a signal counts as fresh iff its embedded `spawn_id` matches the current spawn's id; otherwise stale, eligible for cleanup. Cleanup runs **post-success only** (preserving the partial-failure protection from current main; signals from a failed spawn never get written, so no rollback issue).
- Eliminates mtime comparison entirely. The freshness invariant is "spawn_id matches" — no timestamp involved, so coarse-FS resolution is irrelevant. Spawn-failure-safe: if `spawnFn` throws or EFLAGTIMEOUT fires, the new spawn never wrote a signal, so the previous tick's signal (with its old spawn_id) is still on disk for the next tick to consume. The orchestrator's transition logic for review retries / QA dispatch sees the signal it expects (the verdict that triggered the transition is whatever was on disk before this spawn, and it's still there because the failed spawn didn't write a new one).
- Pros: FS-resolution-independent at the design level; spawn-failure-safe (post-success cleanup preserves the existing partial-failure semantics); auditable (spawn_id is in the artifact frontmatter, easy to inspect). Effort: medium (touches signal schemas + agent prompt rendering). Risk: low.
- Cons: schema bump for signal frontmatter (operator-visible).

### Option B — Pre-spawn sweep of (phase, role) signals
- Before launching a spawn, sweep and delete all `(phase, role)` signal artifacts. After spawn, any signal that appears is necessarily from the new spawn.
- Cons: **rolls back the partial-failure protection on main.** If `spawn-session` throws or hits `EFLAGTIMEOUT` AFTER the sweep, executeActions skips the matching persist (per the partial-failure policy at orchestrate.js:1670-1690 from codex round 17), and the next tick has no verdict signal — the orchestrator's review-retry/QA-dispatch transition logic that expected to see the verdict is broken. Codex round 8 surfaced this. Pre-spawn sweep without a staging/rollback design is unsafe.
- Could be salvaged with a staging design: move signals to `<protocol-dir>/.staged/<spawn-id>/` instead of deleting; on spawn success, delete; on spawn failure, restore. More moving parts than Option A's spawn_id approach.

### Option C — mtime snapshot at spawn time (`mtime >= started_at`)
- Cons: **still has the equality-boundary case** on coarse FS (codex round 7). Doesn't fully close the bug.

### Option D — `>=` instead of `>`
- Cons: same equality-boundary issue at a different spot.

## Recommended Action

**Option A — revised 2026-05-04 post-codex rounds 7+8.** Per-spawn `spawn_id` encoded in signal artifact frontmatter is the only design that BOTH eliminates the mtime equality bug AND preserves the partial-failure protection currently on main. Coord's first pass chose mtime vs `started_at` (codex round 7 showed the equality boundary still bites); the second pass pivoted to pre-spawn sweep (codex round 8 showed it breaks the verdict-survival invariant on spawn failure). The `spawn_id` design avoids both classes. Bundle in PR #23 cleanup wave. Implementer must coordinate with the prompt-rendering pipeline (templates/*.md and scripts/generate-prompt.js) to embed `spawn_id` in agent prompts and verify agents propagate it into signal artifacts.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:1992-2003, 2474-2492`

## Acceptance Criteria

- [ ] Orchestrator generates a fresh `spawn_id` per spawn; persists in manifest-status alongside `started_at`.
- [ ] Agent prompt templates render `{{spawn_id}}` into the rendered prompt (or pass via argv/env to the spawned tab).
- [ ] Agent embeds `spawn_id` into produced signal artifacts (`{role}-complete.md` frontmatter, `qa-verdict.json` field).
- [ ] Orchestrator-side cleanup: signal is fresh iff its embedded `spawn_id` matches the current spawn's id; otherwise stale.
- [ ] Cleanup runs **post-success only** — preserves partial-failure protection (orchestrate.js:1670-1690).
- [ ] Test: spawn fails (`spawn-session` throws) → previous-tick signal (with its old spawn_id) is preserved; next tick's verdict-survival semantics intact.
- [ ] Test: signal written one mtime-bucket before spawn launch but with old spawn_id → marked stale by spawn_id mismatch (NOT by mtime).
- [ ] Test: FAT-2s coarse-FS scenario — spawn_id check is independent of mtime, so coarse resolution doesn't matter.
- [ ] Test: NFS subsecond-less scenario — same as FAT-2s case.
- [ ] Test: spawn succeeds, agent writes signal with current spawn_id → recognized as fresh; signal from a previous spawn (different spawn_id) cleaned up.
- [ ] Cleanup is auditable: dedicated function (e.g., `cleanupStaleSignals(phaseId, role, currentSpawnId)`).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
