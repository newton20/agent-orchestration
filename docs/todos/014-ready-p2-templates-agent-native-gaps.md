---
status: ready
priority: p2
issue_id: "014"
tags: [code-review, templates, agent-native, recovery, qa, coord, unit-6]
dependencies: []
---

# Templates agent-native gaps (qa scope wording, coord divergence-recording, dispatcher-advisory machine-parse, recovery dirty git index)

## Problem Statement

PR #5 ce-review's agent-native review surfaced four gaps where the templates either give the agent contradictory scope, ask for an action with no protocol affordance, or lose machine-parseable signal in human prose.

## Findings

### F1 — qa-prompt scope boundary uses ambiguous "phase's workspace"
- Location: `agent-orchestrator/templates/qa-prompt.md:96-98` — "Do not modify files outside this phase's workspace except for invoking tests and running git commands."
- "phase's workspace" is undefined. Could be `phase_dir` (artifact dir) or `workdir` (source tree). A literal-reading QA agent cannot run tests at all under `phase_dir`. Same pattern as P1-1 (already fixed in impl-prompt) — the wording needs to align with protocol-header's `workdir` boundary.
- Source: agent-native review (P2-AN1)

### F2 — Coord agent has no protocol affordance to record divergence from briefing
- Location: `coordinator-briefing.md:84-90` and `:113-114` — instruction tells coord to "record the divergence and reason under its own **Decisions** block in its own next artifact" but the coord's downstream artifacts (impl-prompt, session-handoff) don't have a Decisions output section.
- A coord-agent that diverges from `coord_next_actions` has nowhere protocol-defined to record why.
- Source: agent-native review (P2-AN2). Also overlaps with todo 009 (coord-briefing authority semantics).

### F3 — QA cross-verification advisory has no machine-parseable bridge
- Location: `qa-prompt.md:50-58` — QA can detect a dispatcher rewrite, run the row as the impl artifacts said, and "flag the rewrite as an advisory in your report." But the resulting QA report has `status: complete` (impl was correct) plus a free-prose Advisories section.
- The orchestrator/coord parsing the report by frontmatter alone never sees the dispatcher-bug signal. A coord-agent has to natural-language pattern-match to discover that a generation/dispatch bug exists.
- Suggested fix: add a frontmatter field for `dispatcher_advisories: <count>` or `[]`, or define an `[advisory:dispatcher-rewrite]` severity tag the parser can grep for.
- Source: agent-native review (P2-AN3)

### F4 — Recovery flow doesn't address dirty git index inheritance
- Location: `recovery-prompt.md:64-83` (pre-resume verification) — covers `.tmp-*` artifacts and checkpoint matching, but if the prior session ran `git add foo bar` and crashed before commit, the recovery agent inherits a dirty index.
- Should the recovery agent commit (over-claiming intent), reset (discarding work), or stash? Template is silent. Combined with protocol-header's "stage only the files you modified" rule, the recovery agent will either accidentally commit prior work as its own or discard it.
- Suggested fix: add a verification step: "Run `git status` and `git diff --cached`. If files are staged, decide whether to commit them as `wip(...)` preserving prior work, or `git reset HEAD` to unstage; document the choice in **Decisions**."
- Source: agent-native review (P2-AN5)

## Proposed Solutions

Group as a single "templates agent-native pass" follow-up. Each finding is a small targeted edit:

1. F1 — Align qa-prompt scope wording with protocol-header `workdir` boundary.
2. F4 — Add dirty-index verification step to recovery-prompt pre-resume.
3. F3 — Add `dispatcher_advisories` field to QA completion-signal frontmatter shape (or define an advisory tag convention).
4. F2 — Resolve in concert with todo 009 (coord authority semantics): either give coord a real artifact to write decisions into, or remove the unimplementable instruction.

## Recommended Action

**Approved 2026-04-26 by coord** — fix three of the four findings
in this bundle; the fourth is closed by todo 009.

- **F1 (qa-prompt scope wording)** → fix. Align `qa-prompt.md`'s
  scope sentence with `protocol-header.md`'s `workdir` boundary,
  matching the pattern already applied to `impl-prompt.md` in the
  PR #5 P1-1 fix. Same prose pattern, different file.
- **F4 (recovery dirty git index)** → fix. Add a verification step
  in `recovery-prompt.md`'s pre-resume checklist:
  > Run `git status` and `git diff --cached`. If files are staged,
  > document the choice in your completion signal: either commit
  > as `wip(...)` to preserve prior work, or `git reset HEAD` to
  > unstage. Do not silently inherit a dirty index.
- **F3 (dispatcher_advisories machine-parse)** → fix. Add
  `dispatcher_advisories: <count>` to the QA completion-signal
  frontmatter shape (in `protocol-header.md`'s schema section + the
  example in `schema/completion-signal-example.md`). Default 0;
  QA increments when it detects a dispatcher rewrite per
  `qa-prompt.md:50-58`.
- **F2 (coord divergence-recording instruction)** → **closed by
  todo 009**. Option A's rename of `## Instructions` →
  `## Dispatched next action` removes the unimplementable
  divergence-recording instruction along with the heading. No
  separate fix needed here.

Dispatch as part of the pre-Unit-7 template-fixes PR bundle along
with todos 009, 010, 011.

## Technical Details

**Affected files**:
- `agent-orchestrator/templates/qa-prompt.md`
- `agent-orchestrator/templates/recovery-prompt.md`
- `agent-orchestrator/templates/coordinator-briefing.md`
- `agent-orchestrator/templates/protocol-header.md` (if F3 adds a frontmatter field)

## Acceptance Criteria

- [ ] qa-prompt scope wording is unambiguous (workdir vs phase_dir).
- [ ] Recovery agent has a documented protocol for handling dirty git index.
- [ ] Dispatcher-bug advisories are machine-parseable from the QA report frontmatter.
- [ ] Coord divergence-recording instruction is implementable (either has a real output slot, or is removed).

## Work Log

(empty)

## Resources

- PR #5 ce-review round: agent-native review (P2-AN1, P2-AN2, P2-AN3, P2-AN5)
- Related: docs/todos/009 (coord authority), docs/todos/010 (recovery context)
