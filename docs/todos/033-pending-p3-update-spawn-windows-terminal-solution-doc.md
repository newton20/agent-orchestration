---
status: pending
priority: p3
issue_id: "033"
tags: [code-review, post-pr-9, learnings, docs, solutions]
dependencies: []
---

# Update node-spawning-windows-terminal-tabs.md Section G — case-6 split branch dropped

The institutional-learnings doc
`docs/solutions/integration-issues/node-spawning-windows-terminal-tabs.md`
documents the `.exe`-subcommand-split branch (case 6) as a working
solution from the PR #3 codex iterations. PR #9 dropped that branch.
The doc needs a "superseded" note so future authors don't reintroduce
the branch citing this learning.

## Problem Statement

The doc's Section G ("quoteBinary path-with-spaces + subcommand split
heuristic") describes the working pattern from PR #3 codex round 10:

```js
const exeSplit = binary.match(/^(.+\.exe)\s+(.+)$/i);
if (exeSplit) {
  const exePart = exeSplit[1];
  const subPart = exeSplit[2];
  // ... split-and-quote
}
```

PR #9 (todo 002 finding #1) dropped this branch and replaced it with a
simpler "path+space → quote whole string" rule + a boundary-guard regex
`/\.(exe|cmd|bat|com)["']?\s/i` for pass-through. Case 6 raw
(`C:\Program Files\X\x.exe sub`) now requires manifest authors to
pre-quote the exe portion.

If a future contributor reads Section G expecting it to be the
canonical solution, they may reintroduce the branch — undoing PR #9's
simplification work.

## Findings

Surfaced by the learnings-researcher agent on PR #9:

> "Section G of `node-spawning-windows-terminal-tabs.md` explicitly
> documents the `.exe ` split branch as the working solution. If PR #9
> removes it, the learning doc needs a follow-up edit (or a new
> 'superseded' note) so future authors don't reintroduce the branch
> citing this doc."

## Proposed Solutions

### Option A — Add a "Superseded by PR #9" note at the top of Section G

Brief note pointing at todo 002 + PR #9 + the new boundary-guard
regex location at `spawn-session.js:163`. Section G stays for
historical context; the note prevents accidental reintroduction.

- **Pros:** Preserves the institutional learning of why the split
  existed in the first place.
- **Cons:** Doc gets longer.
- **Effort:** Trivial.
- **Risk:** None.

### Option B — Replace Section G with the new contract

Rewrite Section G to describe the post-PR-#9 design: simple
hasPathSep+space → quote whole; boundary guard for `.exe `/`.cmd `/
`.bat `/`.com ` boundaries; case-6 raw requires pre-quote.

- **Pros:** Doc reflects current reality.
- **Cons:** Loses the "why we tried the split" context that may matter
  if someone re-evaluates the simplification later.
- **Effort:** Small.
- **Risk:** Low.

### Option C — Both A and B

Keep the historical Section G with the superseded note, AND add a new
Section G' that documents the current design.

- **Pros:** Best of both.
- **Cons:** Slight duplication.
- **Effort:** Small.
- **Risk:** None.

## Recommended Action

_(Filled during triage.)_

## Technical Details

- Affected file:
  `docs/solutions/integration-issues/node-spawning-windows-terminal-tabs.md`
  (Section G)
- No code change.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] Section G either has a superseded note or is rewritten to
  match the post-PR-#9 design.
- [ ] A future contributor reading the doc will not reintroduce the
  dropped split branch citing the doc.

## Work Log

- **2026-04-28 — todo created** — Surfaced by learnings-researcher
  ce:review agent on PR #9.

## Resources

- PR #9: https://github.com/newton20/agent-orchestration/pull/9
- Todo 002 (closed):
  `docs/todos/002-complete-p3-simplify-spawn-session-post-codex.md`
- Existing solution doc:
  `docs/solutions/integration-issues/node-spawning-windows-terminal-tabs.md`
