---
status: complete
priority: p1
issue_id: "091"
tags: [parse-manifest, validation, windows, case-sensitivity, portability, post-pr-19, ce-review]
dependencies: []
---

# parse-manifest: VALID_ID_RE allows Windows case-collisions (Phase-1 vs phase-1)

## Problem Statement

`VALID_ID_RE = /^[A-Za-z0-9._-]+$/` (`parse-manifest.js:82`) accepts both `Phase-1` and `phase-1` as distinct manifest phase ids. On case-insensitive NTFS (Windows default) and APFS-default (macOS), these resolve to the same on-disk phase directory. Manifest-status keys remain case-sensitive (Object lookup), but on-disk paths (`docs/orchestration/phases/<id>/`, completion-signal files, heartbeat.jsonl, `.pending-orch-<phase>-<role>` flags) collide — agent A writes a signal that agent B's orchestrator consumes.

## Findings

1. `parse-manifest.js:82` — `VALID_ID_RE = /^[A-Za-z0-9._-]+$/`.
2. `parse-manifest.js:302-303` — `validate()` builds a case-sensitive `Set` of phase ids; case-collisions pass.
3. `orchestrate.js:265-267` — phase-id lookups are case-sensitive.
4. Filesystem behavior: NTFS / APFS-default → case-insensitive. Linux ext4 → case-sensitive. The orchestrator runs on all three.

## Proposed Solutions

*Option A (recommended) — reject case-collisions at validate*: in `parse-manifest.validate()`, build a `Set` of `phase.id.toLowerCase()` and reject case-collisions with a structured config error. Document the rule in the manifest reference: phase ids are case-insensitive globally to remain portable.
- Pros: fixes the bug at the front door; one location. Effort: trivial. Risk: low (only rejects manifests that would have caused FS collisions anyway).
- Cons: technically a backward-incompatible validation tightening.

*Option B — normalize at validate*: lowercase all phase ids at validate time, rewriting them in the in-memory representation. All downstream code uses the lowercased form.
- Pros: defense-in-depth. Cons: surprising; loses operator-typed casing in error messages.

## Recommended Action

_Pending triage._ Coord lean: Option A.

## Technical Details

- `agent-orchestrator/scripts/parse-manifest.js:82, 302-303` — VALID_ID_RE + validate.
- `agent-orchestrator/scripts/orchestrate.js:265-267` — case-sensitive phase lookup.

## Acceptance Criteria

- [ ] Test: manifest with `[{id: 'Phase-1'}, {id: 'phase-1'}]` → validate fails with "case-insensitive collision: Phase-1 / phase-1" error.
- [ ] Test: manifest with `[{id: 'phase-1'}]` → validate passes (existing behavior preserved).

## Work Log

### 2026-05-03 — Closed in PR #19

**By:** Impl (Unit 11 implementation agent).

**Actions:**
- See PR #19 fix commit `09dd710` (initial /ce:review round 1 — P1s 088-092 closed).

**Resolution:** Case-collision rejection added to `parse-manifest.validate`: builds a `Set` of `phase.id.toLowerCase()` and rejects manifests where two distinct ids collide under lowercase comparison. Structured config error surfaces the colliding ids.

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md`
- Adversarial reviewer: adv-3.
