---
status: pending
priority: p3
issue_id: "013"
tags: [code-review, templates, prose-consistency, unit-6]
dependencies: []
---

# Templates prose consistency cleanups (empty-state phrasing, Skip case, scope-discipline overlap, decorative narrative)

## Problem Statement

PR #5 ce-review surfaced a cluster of minor prose inconsistencies across the 6 templates. Each is independently P3 — none affects functionality — but together they make future template authoring more arbitrary than it needs to be.

## Findings

### F1 — Empty-state prose phrasing varies across templates
- Three different verbs ("is empty" / "renders empty" / "is blank"), two different nouns ("section" / "block"), two different deictic constructions ("this section" / "the block above" / "the path above" / "that").
- Sites: impl-prompt.md L37, qa-prompt.md L37, qa-playbook-prompt.md L155, recovery-prompt.md L49, recovery-prompt.md L110, coordinator-briefing.md L41, protocol-header.md L108-109, protocol-header.md L135.
- Source: pattern-recognition review (P3-1)

### F2 — protocol-header `prior_phase_dirs` empty-handling weaker than `heartbeat_path`
- `heartbeat_path` (L106) is followed by an explicit "If the path above is blank, … skip the entire section." `prior_phase_dirs` (L36) is followed by "Each path above points at an upstream phase's completion signal" — asserts paths exist when block may be empty.
- Suggest mirroring the heartbeat pattern.
- Source: pattern-recognition review (P3-2)

### F3 — qa-playbook-prompt.md "Skip" capitalization
- Lines 19-21: "Skip" is never acceptable silently — but qa-prompt L19 uses all-caps SKIP consistently. Catalog and verdict format also use all-caps PASS/FAIL/SKIP.
- Source: pattern-recognition review (P3-3)

### F4 — qa-playbook-prompt.md `{{test_commands_block}}` is at file bottom
- Currently after `## Advisories` (which the agent writes after running playbook). Move before `## Playbook rows` so override is visible before P1 runs.
- Source: pattern-recognition review (P3-4)

### F5 — protocol-header `## Scope discipline` and `## Scope boundary` are near-duplicates within the same file
- Lines 42-50 vs lines 154-160. Both about "don't expand scope; surface it instead." One section would suffice (~7 lines reduction).
- Source: simplicity review (P3-S2), architecture (P3)

### F6 — impl-prompt `## Implementation discipline` gate-flow narrative is decorative
- Lines 65-92 describe codex/QA/ce:review gates the impl agent doesn't run. The instructional content is the four bullets that follow ("Tests / Lint / Conventional commits / Verification"). Could trim ~12 lines to one sentence.
- Source: simplicity review (P3-S3)

### F7 — coordinator-briefing `## Conventions` section is meta-note about template, not instruction
- Lines 112-117 explain the template is read-only-not-write-contract. Coord agents already know this from the role preamble. ~6 lines reduction.
- Source: simplicity review (P3-S4)

### F8 — qa-prompt cross-verification paragraph defends against todo-008 (dispatcher-rewrite)
- This is an active workaround. Worth tagging with `<!-- TODO: remove once todo-008 lands -->` so it doesn't outlive its purpose.
- Source: simplicity review (P3-S5)

## Proposed Solutions

Group fixes into a single "templates prose pass" follow-up PR. Order by leverage:

1. F1 — Pick one empty-state phrasing template (e.g., "If this section is empty, …" for blocks; "If the path above is blank, …" for path-singletons). Apply across all 6 templates. Document the convention in `templates/README.md`.
2. F5 — Merge the two scope sections in protocol-header.
3. F6 — Trim impl-prompt's gate-flow narrative.
4. F7 — Move or drop coord-briefing's `## Conventions`.
5. F2 — Apply heartbeat-style empty-handling pattern to `prior_phase_dirs`.
6. F4 — Reorder qa-playbook to surface `{{test_commands_block}}` early.
7. F3 — Capitalize "Skip" → "SKIP" in qa-playbook ground rules.
8. F8 — Add inline TODO comment in qa-prompt cross-verification paragraph.

Total LOC reduction: ~35-40 lines.

## Recommended Action

(filled during triage — non-blocking; deferred cleanup PR)

## Technical Details

**Affected files**:
- `agent-orchestrator/templates/protocol-header.md`
- `agent-orchestrator/templates/impl-prompt.md`
- `agent-orchestrator/templates/qa-prompt.md`
- `agent-orchestrator/templates/qa-playbook-prompt.md`
- `agent-orchestrator/templates/coordinator-briefing.md`
- `agent-orchestrator/templates/recovery-prompt.md`
- `agent-orchestrator/templates/README.md` (convention documentation)

## Acceptance Criteria

- [ ] Empty-state phrasing uses one canonical form per variable type.
- [ ] No within-file or cross-file near-duplicates remain.
- [ ] No purely-decorative narrative; every paragraph carries instruction the addressee must act on.

## Work Log

(empty)

## Resources

- PR #5 ce-review round: pattern-recognition (F1-F4), simplicity (F5-F8), architecture (F5)
- All 6 template files in `agent-orchestrator/templates/`
