---
status: complete
priority: p1
issue_id: "092"
tags: [unit-11, orchestrate, security, abuse-resistance, qa-verdict, completion-signal, post-pr-19, ce-review]
dependencies: []
---

# orchestrate: parseQaVerdict has no size cap; agent-written giant file OOMs orchestrator

## Problem Statement

`parseQaVerdict` and `parseCompletionSignal` (`orchestrate.js:790-816, 758-788`) read agent-written files via `fs.readFileSync` with no size cap and no symlink rejection. A hostile or buggy agent that writes a giant `qa-verdict.json` (or symlinks it to `/dev/zero`) OOMs the orchestrator. The hostile-agent threat model that the spec invokes is not honored on inbound JSON reads.

## Findings

1. `orchestrate.js:790-816` — `parseQaVerdict` calls `readFileSync` without size pre-check.
2. `orchestrate.js:758-788` — `parseCompletionSignal` similarly unbounded.
3. Heartbeat reads (Unit 8) are bounded at 64 KiB → 256 KiB → 1 MiB tail-window — the precedent exists.
4. `lstat` is not used to reject symlinks before read.

## Proposed Solutions

*Option A (recommended) — size-cap + symlink rejection*: stat+size-cap (e.g., 64 KiB for qa-verdict.json, 256 KiB for completion-signal) before `readFileSync`. Use `lstat` to refuse symlinks. Apply to both files plus `priorPhaseSignals` reads.
- Pros: closes the OOM + symlink classes at one site. Effort: small.
- Cons: chooses size limits arbitrarily — pick caps that comfortably exceed legitimate use (qa-verdict.json is structured JSON ~few KB; completion-signal frontmatter ~few KB).

*Option B — read via the bounded heartbeat-style path*: factor out a shared "bounded read with size cap and symlink check" helper from check-health's heartbeat reader and reuse here.
- Pros: one-shop bounded-read. Cons: more refactor than necessary.

## Recommended Action

_Pending triage._ Coord lean: Option A.

## Technical Details

- `agent-orchestrator/scripts/orchestrate.js:790-816` — parseQaVerdict.
- `agent-orchestrator/scripts/orchestrate.js:758-788` — parseCompletionSignal.

## Acceptance Criteria

- [ ] Test: write a 100 MiB `qa-verdict.json` → orchestrator returns parse error, does not OOM.
- [ ] Test: replace `qa-verdict.json` with a symlink to a regular file → orchestrator refuses to read.

## Work Log

### 2026-05-03 — Closed in PR #19

**By:** Impl (Unit 11 implementation agent).

**Actions:**
- See PR #19 fix commit `09dd710` (initial /ce:review round 1 — P1s 088-092 closed).

**Resolution:** `safeReadAgentFile` helper introduced with size cap + `lstat`-based symlink rejection. Applied to `parseQaVerdict`, `parseCompletionSignal`, and prior-phase-signals reads. Caps chosen to comfortably exceed legitimate use (per Option A); oversize / symlinked inputs surface a parse error rather than OOMing the orchestrator.

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md`
- Adversarial reviewer: adv-4.
