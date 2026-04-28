---
status: pending
priority: p2
issue_id: "030"
tags: [code-review, post-pr-9, ce-review, templates, docs, cross-module-coupling]
dependencies: []
---

# templates/README.md is a third site encoding `[A-Za-z0-9._-]+` ID class — not in lockstep cluster

PR #9's todo 006 added mutual-pointer comments between
`parse-manifest.js` (`VALID_ID_RE`) and `session-start.js` (`FLAG_NAME_RE`).
The PR #9 architecture review found a third site that bakes the same
character class into a user-facing contract but doesn't participate in
the cluster.

## Problem Statement

The lockstep cluster from PR #9's todo 006 is documented as:

- `agent-orchestrator/scripts/parse-manifest.js:79-81` (mutual pointer)
- `agent-orchestrator/hooks/session-start.js:31-33` (mutual pointer)
- `agent-orchestrator/hooks/README.md` "Contract invariants" section

But there is a third site encoding the same class:

- `agent-orchestrator/templates/README.md:122` —
  `| phase_id | string | Phase identifier matching VALID_ID_RE
  ([A-Za-z0-9._-]+). |`

This site is the authored manifest contract for prompt-template authors
— it's a docs surface that Unit 7's variable catalog leans on. If a
future contributor edits the class to expand it (say, adds `:` to allow
`phase:0`), they will follow the pointer chain to the two source files
but won't know about `templates/README.md:122`. Silent drift.

## Findings

- **Architecture-strategist (P2-1):** "There is a third site that bakes
  the same character class into a user-facing contract: `phase_id` row
  in `templates/README.md:122`. The mutual pointers in
  `parse-manifest.js:79-81` and `session-start.js:31-33` say 'change
  both or neither.' If a future contributor edits the class to expand
  it, they will follow the pointer chain to the two source files but
  won't know about `templates/README.md:122`."

A fourth-grade plain-prose mention also exists at
`docs/todos/001-complete-p2-cmd-percent-escape-and-quoted-name-pid-regex.md:37`
but as a closed-todo it's tagged historical / not load-bearing.

## Proposed Solutions

### Option A — Add a back-pointer in templates/README.md:122

One-line edit: append "(See parse-manifest.js — change tracked there.)"
to the row description.

- **Pros:** Smallest change.
- **Cons:** As more sites accrete (Unit 11 will likely have one), the
  back-pointer pattern fans out N pointers. Doesn't scale.
- **Effort:** Trivial.
- **Risk:** None.

### Option B — Single inventory bullet in hooks/README.md "Contract invariants"

Extend the existing Contract invariants section with a new bullet that
enumerates ALL sites encoding the same value, including documentation
sites. Specifically add:

> The `[A-Za-z0-9._-]+` ID character class is encoded at:
> - `parse-manifest.js:82` — `VALID_ID_RE`
> - `session-start.js:34` — `FLAG_NAME_RE`
> - `templates/README.md:122` — `phase_id` row
> - (future Unit 11 — orchestrator validator)
>
> When changing the class, update all sites.

- **Pros:** Single source of truth for the inventory. Doesn't fan out
  N back-pointers as more sites appear. Exactly the convention the
  architecture review recommended.
- **Cons:** Requires a contributor editing one of the regex sites to
  read the README, not just the comment-pointers above the regex.
- **Effort:** Small (5-10 LOC).
- **Risk:** Low.

### Option C — Both A and B

Add the back-pointer in templates/README.md AND the inventory bullet
in hooks/README.md. Belt-and-suspenders.

- **Pros:** Maximally defensive.
- **Cons:** Slight duplication.
- **Effort:** Small.
- **Risk:** None.

## Recommended Action

_(Filled during triage.)_

## Technical Details

- Affected files:
  - `agent-orchestrator/templates/README.md` (line 122) — Options A or C
  - `agent-orchestrator/hooks/README.md` (Contract invariants section) —
    Options B or C
- No code change.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] A contributor editing the ID class anywhere can follow back-
  pointers (or read the inventory) to find all encoded sites.

## Work Log

- **2026-04-28 — todo created** — Surfaced by PR #9 ce:review
  (architecture-strategist P2-1).

## Resources

- PR #9: https://github.com/newton20/agent-orchestration/pull/9
- Todo 006 (closed): `docs/todos/006-complete-p3-unit-5-id-regex-duplication.md`
- Architecture-strategist review output, PR #9 ce:review session 2026-04-28.
