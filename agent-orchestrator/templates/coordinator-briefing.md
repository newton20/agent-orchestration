---
required: [phase_id, status_summary_block, decisions_block, open_questions_block, project_context_block, coord_next_actions]
optional: [plan_reference_block, git_details_block, warnings_block, artifact_pointer]
---

# Coordinator briefing — phase {{phase_id}}

> This section is prepended with the protocol header. This template
> mirrors the `~/.claude/skills/session-handoff` skill's `brief coord`
> output for sections 1–6 and 8–9 (Status summary, Decisions, Open
> questions, Plan reference, Project context, Git details, Warnings,
> Artifact pointer). Section 7 is intentionally divergent: where
> session-handoff renders `## Instructions` (an authoritative user
> directive), this template renders `## Dispatched next action` (a
> recommend-only routing signal the coord may override). The heading
> divergence is deliberate — same name, different authority semantics
> would misroute work. If you extend the shared section list, extend
> the session-handoff skill's fragment list to match.

## Role preamble

You are the coordination agent. Read this briefing, update your phase
tracker, decide next actions. Do not dive into implementation details
— your job is to route work and decide what happens next, not to write
code. If this briefing is ambiguous, leave a clarifying note under
**Open questions** in your own next artifact rather than guessing.

## Status summary

{{status_summary_block}}

A good status summary is one paragraph answering: what shipped, what is
blocked, what is next. It is written in imperative present tense ("Unit
5 is done; PR #4 merged at `540e878`; next unit is Unit 6"). Do not
repeat the full project context here — the reader already knows.

## Decisions

{{decisions_block}}

Every item in this block is tagged `[inferred from session]` when the
orchestrator or the originating agent derived it rather than having the
user state it explicitly. The coord may promote any item from inferred
to explicit by recording the confirmation in its own next artifact.

If this section renders empty, the literal string `(no decisions
captured)` appears instead — an empty **Decisions** block must never be
silently omitted, because "we looked and found nothing" differs from
"we forgot to look."

## Open questions

{{open_questions_block}}

Same inference tagging and same empty-state rule as Decisions. These
are the items the coord must triage before dispatching the next unit;
each typically has 2–3 solution options with pros/cons/effort called
out by the originating agent.

## Plan reference

{{plan_reference_block}}

The repo-relative path to every active plan this briefing touches. If
multiple plans match, the full list renders — the coord decides which
applies.

## Project context

{{project_context_block}}

- **Repo:** usually the repo slug.
- **Branch:** current working branch.
- **HEAD SHA:** short SHA.
- **Worktree state:** `clean` or `dirty`.
- **Latest checkpoint:** absolute path to the most recent checkpoint
  artifact, if one exists. Omitted if none.

## Git details

{{git_details_block}}

The last N commits and a short status or diff stat. The coord uses this
to confirm the briefing matches reality before acting on it.

## Dispatched next action

{{coord_next_actions}}

This block names the specific action the briefing recommends the coord
take next — for example, "triage todos 005/006/007 before dispatching
Unit 6" or "dispatch Unit 7 impl on branch `feat/unit-7-prompt-generator`
cut from main @ `<SHA>`". The recommendation is non-binding: the coord
is the routing authority and may choose a different next action based on
fuller context. The heading is deliberately distinct from
session-handoff's `## Instructions` so the lower authority is visible at
a glance.

## Warnings

{{warnings_block}}

Every `[warning: source -- reason -- omitted]` line from the briefing
generation surface lives here. Missing checkpoint dirs, missing
CLAUDE.md, malformed manifest status — all appear here so the coord
knows what context is absent. Like Decisions and Open questions, this
block always renders: an empty block shows `(no warnings)` literally.

## Artifact pointer

{{artifact_pointer}}

Absolute path to the full briefing on disk under
`~/.claude/handoffs/<slug>/` or the project's briefing archive.
Rendered as: "If on the same machine, read `<path>` for additional
detail."

## Conventions

The briefing above is a read artifact, not a write contract — the coord
is not expected to produce an artifact in this exact shape. When the
coord writes its own next brief (e.g., handing off to a downstream impl
session), it uses the `impl-prompt.md` template or the session-handoff
skill, not this one.

The `## Dispatched next action` heading intentionally diverges from
session-handoff's `## Instructions` so the recommend-only authority is
visible at a glance. The other section names (Status summary, Decisions,
Open questions, Plan reference, Project context, Git details, Warnings,
Artifact pointer) are kept in shape-parity with session-handoff `brief
coord` output. Maintain that parity when extending either side.

If any block above appears empty where you expected content, that is a
briefing-generation bug — file it as an issue rather than proceeding on
incomplete state.
