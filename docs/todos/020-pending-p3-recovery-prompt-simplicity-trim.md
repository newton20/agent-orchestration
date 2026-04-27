---
status: pending
priority: p3
issue_id: "020"
tags: [code-review, templates, recovery, simplicity, prose]
dependencies: []
---

# recovery-prompt.md prose can be trimmed ~30 LOC without losing safety

## Problem Statement

PR #6's recovery-prompt.md grew from ~135 lines to ~385 lines (mostly in step 3 of pre-resume verification, the role-conditional dirty-index handling). The /ce:review code-simplicity pass identified ~30 LOC of trim opportunities in this surface that lose no safety, no codex-fix property, and no agent-native clarity. They're prose verbosity, not contract richness.

## Findings (from /ce:review code-simplicity-reviewer)

1. **L40-47** — "Original prompt context" preamble paragraph: "not strictly less" / "mirror the role-specific prompt sections" framing is meta-justification. Trim to ~2 lines.
2. **L49-63** — section-level role ladder duplicates per-subsection ladders. Delete entirely.
3. **L80-86** — `.original.md` suffix justification ("disambiguates 'your current recovery prompt' from 'the prompt the prior session was running'") — agent doesn't care about naming rationale.
4. **L100-101 + L113-114 + L136 + L154** — "If your role is not X: skip" repeated 4× across subsections. Hoist to one preamble line.
5. **L202-213** — sibling-agent caveat: 12 lines for what is a 4-line contract. Can be ~5 lines.
6. **L238-241** — "advisory-only recording reserved" sentence: pre-empts a misread the affirmative branch already prevents. Remove.
7. **L262-294** — porcelain-classification debug-prose, parentheticals (~33→~12 lines).
8. **L296-299** — repo-wide-command warning (~4 lines → 1 line). The recipe is path-scoped by construction.
9. **L325-338** — Hard boundaries section's expanded "narrow exception" prose: step 3 already describes the exception fully.

Total estimated trim: ~30 lines (~12% of recovery-prompt.md).

## Proposed Solutions

### Option A — Apply all 9 trims in a single follow-up PR
- **Pros**: Captures the full reduction; consistent voice across the file.
- **Cons**: ~9 small edits; some risk of accidentally trimming a load-bearing sentence.
- **Effort**: Medium.
- **Risk**: Low–medium (need careful re-read against codex/QA findings to confirm no safety loss).

### Option B — Apply only the 3 highest-impact trims (#2, #7, #9)
Section-level role ladder, porcelain-classification verbosity, and Hard boundaries duplication. ~25 LOC. Defer the smaller trims.

- **Pros**: Lowest-risk subset; fastest review.
- **Cons**: Leaves 5 lines of redundant prose.
- **Effort**: Small.
- **Risk**: Low.

### Option C — Defer entirely; ship as-is
PR #6 already shipped. Verbosity is a quality-of-life issue, not a correctness issue.

- **Pros**: No follow-up churn.
- **Cons**: Agents pay token + reading-time cost on every dispatch.
- **Effort**: None.
- **Risk**: Low.

## Recommended Action

(empty — fill in during triage)

## Technical Details

**Affected file:** `agent-orchestrator/templates/recovery-prompt.md`

CRITICAL — must NOT remove (codex/QA P1/P2 findings):
- Path-scoped discard procedure (`git restore --staged --worktree --` + `git clean -f --`)
- Role-conditional empty-state gating (qa-recovery blocks on missing scope/playbook/target)
- Original-prompt preservation contract (audit step blocks on missing `${role}-prompt.original.md`)
- `dispatcher_advisories` increment instruction in qa-prompt's Cross-verification

## Acceptance Criteria

- [ ] recovery-prompt.md reads tightly — no paragraph repeats a fact already stated above.
- [ ] All codex round 1-13 P1/P2 properties preserved (verify by re-running `codex exec review`).
- [ ] Render check still passes (no unsubstituted placeholders).

## Work Log

(empty)

## Resources

- /ce:review (PR #6): code-simplicity-reviewer findings 1-9
- `agent-orchestrator/templates/recovery-prompt.md`
