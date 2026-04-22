---
status: complete
priority: p2
issue_id: "003"
tags: [code-review, plan-hygiene, unit-4, unit-4.5, unit-5-preparation]
dependencies: []
---

# Backfill plan with Unit 4 / Unit 4.5 deltas before Unit 5 starts

The architecture review of PR #3 identified five places where the
shipped Unit 4 implementation deviated from the plan — additive,
non-breaking, but load-bearing for Unit 5's implementer. Unit 5 is
scheduled next and its design is ALREADY reshaped by Unit 4.5's
findings (flag-file fallback, not name-based detection). If Unit 5's
implementer reads the plan in its current form, they'll start from
an inaccurate baseline.

## Problem Statement

Plan deviations NOT currently reflected in
`docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md`:

1. **Plan line 389-391** shows Unit 4's default-launcher command
   without `--suppressApplicationTitle`. Shipped code hard-codes
   this flag (driven by Unit 0 finding §752; the flag is what
   makes `orch-*` tab titles stick). Plan examples should include
   it so future implementers don't "simplify it away."

2. **Plan line 394** says `getSessionPid(name)` uses `tasklist`.
   Shipped code uses WMI `Get-CimInstance` via PowerShell because
   `tasklist /V` cannot see background wt tabs' titles (wt -w 0
   collapses tabs under one WindowsTerminal process; title-match
   fails). Codex P1 in round 10 forced this change. Plan should
   reflect the correct primary mechanism.

3. **`auto_mode_flag` cross-shell default bleed** is not in the
   plan. `resolveLauncher` picks DEFAULT_LAUNCHER or AGENCY_LAUNCHER
   as the baseline based on the user-provided `shell` value —
   otherwise `shell: powershell` would inherit cmd's `/k` and
   `--permission-mode auto`, producing a broken PS command. Codex
   P2 in round 2. Worth one bullet under Unit 4 so it doesn't get
   "simplified" back.

4. **`spawnSession` return shape** silently extends the plan's
   `{pid, command, sessionName, spawnedAt}` to
   `{pid, command, argv, sessionName, title, spawnedAt}`. `argv`
   will likely be Unit 11's preferred log format (single source of
   truth). Worth ratifying in the plan rather than leaving
   "accidentally public."

5. **Unit 4.5 decision-matrix outcome.** Plan's row 1 ("Direct
   claude, name in env → name-based detection, Unit 5 as
   designed") is invalidated. Row 3 ("Name lost → flag-file
   fallback") is the correct path. Plan should mark row 1 as
   closed (strikethrough + "resolved: name not exposed — see
   spikes/launcher-compat-findings.md") and highlight row 3 as the
   shipped outcome so Unit 5's implementer starts from the right
   spec.

## Findings (from architecture strategist review)

- All 5 are documentation issues, not code bugs. Unit 4 works as
  shipped.
- Unit 5 is the first consumer that will hit these — every other
  caller is downstream.
- `docs/solutions/integration-issues/*.md` captures the findings
  at a cross-cutting ecosystem level, but the plan itself is
  Unit 5's starting point.

## Proposed Solutions

### Option A — Single plan-amendment commit

Edit `docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md`
in-place with one commit that addresses all five deviations. Use
the existing "Unit X Validation Findings" and "Post-review fixes"
section style (see "Unit 0 Validation Findings" at line 735 — the
plan already has a precedent for in-place updates driven by spike
outcomes).

- **Pros:** One atomic update; Unit 5 implementer sees the right
  spec in the one place they'll look.
- **Cons:** None material — this is what the plan style already
  supports.
- **Effort:** Small. ~30-50 line edit in the plan.
- **Risk:** Low. Documentation-only, no code changes.

### Option B — Plan appendix with deltas

Add a "Unit 4 shipped deviations" section at the end of the plan
without editing the in-body Unit 4 description. Cross-reference
from the header.

- **Pros:** Preserves the historical "as-designed" text for
  archaeology.
- **Cons:** Readers have to know to scroll to the bottom. Unit 5
  implementer might miss it.
- **Effort:** Small.
- **Risk:** Low.

### Option C — Rely on the solution docs + PR #3 comment

Do nothing in the plan. Trust that Unit 5's implementer will read
the cross-cutting docs and the PR #3 discussion.

- **Pros:** Zero churn.
- **Cons:** Fragile. Plans are supposed to be the single source of
  truth for their scope.
- **Effort:** Zero.
- **Risk:** Medium. Unit 5's implementer (likely a fresh agent
  session) will read the plan first.

## Recommended Action

**Option A — approved 2026-04-20, executing now by coord.** Plan
backfill is pure doc work and Unit 5's dispatch depends on the
correct spec being in-place before the impl session reads it. Coord
ships the amendment commit on main directly; no impl handoff
required. Style follows the existing "Unit 0 Validation Findings"
and "Track B Dogfood Findings" precedents already in the plan.

## Technical Details

- Affected file:
  `docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md`
- Reference sections in the same file:
  - "Unit 0 Validation Findings (2026-04-17)" — precedent for the
    pattern.
  - "Track B Dogfood Findings — session-handoff Units 3–5
    (2026-04-19)" — another precedent.
  - "PR #2 QA Validation (2026-04-19)" — another precedent.

## Acceptance Criteria

- [ ] Plan's Unit 4 section mentions `--suppressApplicationTitle`
  as required on every spawn.
- [ ] Plan's Unit 4 section documents `getSessionPid` uses WMI
  CommandLine matching (not `tasklist`).
- [ ] Plan's Unit 4 section notes the baseline-per-shell default
  resolution.
- [ ] Plan's Unit 4 section updates the return shape to include
  `argv` and `title`.
- [ ] Plan's Unit 4.5 section marks row 1 closed and row 3 as
  shipped, pointing at
  `agent-orchestrator/spikes/launcher-compat-findings.md`.
- [ ] Plan's Unit 5 section gets a preamble note: "SessionStart
  hook receives only `session_id` (UUID) + `CLAUDE_PROJECT_DIR` —
  NOT `--name`. Use the flag-file fallback (`.pending-<session-name>`
  protocol) per Unit 4.5 findings."

## Work Log

### 2026-04-20 — Plan amendment landed

**By:** Coord (Claude)

**Actions:**
- Added new section "Unit 4 + 4.5 Shipped Amendments (2026-04-20)"
  at end of
  `docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md`
  covering all 5 deltas (Δ1-Δ5) per acceptance criteria.
- Added inline "SHIPPED / see amendments below" pointers to the
  in-body Unit 4, Unit 4.5, and Unit 5 sections so Unit 5 impl
  cannot miss the reshape.
- Added side-findings from the spike run (Git Bash hook shell,
  plugin-dir vs settings.json activation) since those materially
  affect Unit 5's hook wiring.
- Preserved the original Unit 5 bullets as archaeology; the
  reshape note precedes them so readers see the current spec first.

**Learnings:**
- In-body "SHIPPED — see amendments below" is a lightweight way to
  keep historical design text intact while making the current spec
  authoritative. Works well with the existing "Unit 0 Validation
  Findings" precedent.
- Unit 5's preamble note pre-answers the "what shape does the
  hook read?" question for impl, which is the single most
  load-bearing fact from the spike.

**Checked against acceptance criteria:**
- [x] Plan's Unit 4 section mentions `--suppressApplicationTitle`
  (Δ1).
- [x] `getSessionPid` uses WMI CommandLine matching (Δ2).
- [x] Baseline-per-shell default resolution (Δ3).
- [x] Return shape includes `argv` and `title` (Δ4).
- [x] Unit 4.5 row 1 closed, row 3 shipped (Δ5).
- [x] Unit 5 gets preamble note with flag-file fallback pointer
  (Δ5 + inline Unit 5 preamble).

## Resources

- Triggering PR: https://github.com/newton20/agent-orchestration/pull/3
- Architecture review: `/ce:review` session on 2026-04-20.
- Findings doc:
  `agent-orchestrator/spikes/launcher-compat-findings.md`.
- Related compound docs:
  - `docs/solutions/integration-issues/claude-code-sessionstart-hook-windows.md`
  - `docs/solutions/integration-issues/node-spawning-windows-terminal-tabs.md`
