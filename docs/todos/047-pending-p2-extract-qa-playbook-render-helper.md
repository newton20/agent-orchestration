---
status: pending
priority: p2
issue_id: "047"
tags: [code-review, post-pr-13, ce-review, scripts, pattern, refactor]
dependencies: []
---

# Inline qa-playbook two-pass dispatch should extract to a named helper

PR #13 ce:review's pattern-recognition-specialist noted the
qa-playbook two-pass dispatch logic lives inline in `generatePrompt`
as a conditional block that mutates the `context` object in place.
Sibling modules (`parse-manifest.js`, `scaffold-protocol.js`)
extract role-conditional branches into named functions
(`normalizeAgent`, `validateLauncher`, etc.). The current inline
mutation makes the "qa playbook special case" less greppable and
hides it inside a larger function.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:743-752`:

```js
const needsPlaybook =
  !context.qa_playbook_block &&
  (o.role === 'qa' || (recovery && o.recoveryRole === 'qa'));
let playbookText = '';
if (needsPlaybook) {
  const playbookSrc = readTemplate(o.templatesDir, QA_PLAYBOOK_FILE);
  const rendered = renderTemplate(playbookSrc, context, { templateName: QA_PLAYBOOK_FILE });
  playbookText = rendered.text;
  context.qa_playbook_block = playbookText;
}
```

This is the only place the QA-specific two-pass render lives.
Reasons it stands out:

- **Inline mutation:** the block writes to `context.qa_playbook_block`
  in place rather than producing a value the caller assigns.
- **Hidden special case:** a reader scanning `generatePrompt` for
  "what's QA-specific?" has to read the body of this if-block.
- **Sibling pattern divergence:** `normalizeAgent`,
  `validateLauncher`, `coalesceFlags` — all role-conditional or
  format-conditional logic in sibling modules is named-function-
  shaped.

## Findings

PR #13 ce:review pattern-recognition-specialist P2:

> "`generate-prompt.js:743-752` — the two-pass qa-playbook
> dispatch logic happens inline in `generatePrompt`. Sibling
> modules extract role-conditional branches into named functions
> (`parse-manifest.js`'s `normalizePhases` calls `normalizeAgent`;
> `validateLauncher` is a separate function). The current inline
> mutation makes the logic less greppable and hides the 'qa
> playbook special case' inside generatePrompt. Recommend
> extracting `renderQaPlaybookIfNeeded(o, context, recovery,
> templatesDir) → string`. Caller assigns
> `context.qa_playbook_block = renderQaPlaybookIfNeeded(...)`.
> ~12 LOC, zero behavior change. Aligns with sibling factoring."

## Proposed Solutions

### Option A — Extract `renderQaPlaybookIfNeeded` helper

Pull the inline block into a named function. Mirror the existing
inline call shape — `renderTemplate` requires a full template
(frontmatter + body) and returns `{ text, varsUsed, warnings }`,
not a bare string (codex on triage caught the original sketch
calling `renderTemplate(parseFrontmatter(playbookSrc).body, ...)`,
which would throw "missing YAML frontmatter"):

```js
function renderQaPlaybookIfNeeded(o, context, recovery, templatesDir) {
  if (context.qa_playbook_block) return context.qa_playbook_block;
  const isQa = o.role === 'qa' || (recovery && o.recoveryRole === 'qa');
  if (!isQa) return '';
  const playbookSrc = readTemplate(templatesDir, QA_PLAYBOOK_FILE);
  const rendered = renderTemplate(playbookSrc, context, {
    templateName: QA_PLAYBOOK_FILE,
  });
  return rendered.text;
}
```

Caller (in `generatePrompt`):

```js
context.qa_playbook_block = renderQaPlaybookIfNeeded(
  o, context, recovery, o.templatesDir
);
```

- **Pros:** Greppable: a reader looking for "QA playbook logic"
  finds a named function. Aligns with sibling factoring style.
  Easier to unit-test in isolation. Removes the inline mutation
  pattern in favor of return-value-then-assign. ~12 LOC, zero
  behavior change.
- **Cons:** Adds one function-call frame to QA renders
  (negligible). The function takes 4 args — could be argued as
  a code smell (justifiable here since they're all narrow scalars).
- **Effort:** Small.
- **Risk:** Low — pure refactor; covered by existing tests.

### Option B — Defer

The inline form is short enough today (10 LOC). Pattern reviewer
explicitly classified this as a P2 (style/factoring), not a
correctness issue.

- **Pros:** Zero churn.
- **Cons:** The "QA special case" continues to be hidden inside
  `generatePrompt`. If todo 042's Option A or todo 045's Option
  A both want to expand this block (pre-loading bytes, drift
  check), they'll bloat the inline form further — at which
  point the extraction becomes mandatory and more disruptive.
- **Effort:** Zero.
- **Risk:** Low for V1; the extraction becomes harder if 042
  or 045 also expand the inline block.

## Recommended Action

Pending coord triage. Option A is a small, low-risk refactor
that aligns with sibling factoring style and may set up todo 042
and 045 cleanly. Option B defers. Triage should consider whether
to bundle this extraction with todo 042 / 045 (all three center
on the same ~10 LOC block — an extraction now makes both later
edits cleaner).

## Technical Details

- Affected file: `agent-orchestrator/scripts/generate-prompt.js`.
  - Extract `renderQaPlaybookIfNeeded` (~12 LOC).
  - Replace the inline block at line 743-752 with one assignment.
- Sibling reference: `agent-orchestrator/scripts/parse-manifest.js`
  — `normalizePhases` / `normalizeAgent` / `validateLauncher`
  factoring.
- Tests: existing QA-render tests already exercise the path;
  optionally add a unit test for `renderQaPlaybookIfNeeded` in
  isolation.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: `renderQaPlaybookIfNeeded` exists as a named
  function; `generatePrompt` calls it via assignment (no inline
  mutation).
- [ ] If A: signature matches sibling factoring style (small
  number of well-named scalar args).
- [ ] If A: existing tests still pass without modification;
  optional new unit test exercises the helper in isolation.
- [ ] If A: no behavior change verified by snapshot diff of
  rendered QA prompts before/after.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (pattern-recognition-specialist P2). Coord triage pending.
- **2026-04-29 — corrected via codex round 2 on triage PR** —
  original Option A helper sketch passed
  `parseFrontmatter(playbookSrc).body` to `renderTemplate`, which
  would throw "missing YAML frontmatter" since renderTemplate
  expects the full template. Also called `renderTemplate` twice
  (once on body, once on the rendered text) implying a two-pass
  semantic that does not exist. Codex correctly noted the helper
  must mirror the existing call shape: pass full `playbookSrc`,
  read `rendered.text` from the return value. Rewrote the
  snippet.
- **2026-04-29 — corrected via codex round 4 on triage PR** —
  the Problem Statement's "current inline code" excerpt still
  showed the same stale `parseFrontmatter(playbookSrc).body` +
  double-renderTemplate pattern that Option A had been
  rewritten away from. A reader scanning only the Problem
  Statement would believe the codebase looks like the broken
  sketch and might reproduce that shape. Updated the excerpt
  to match the actual current code (full playbookSrc to
  renderTemplate; read `rendered.text`).

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js:743-752` —
  the inline block to extract.
- Sibling factoring reference:
  `agent-orchestrator/scripts/parse-manifest.js` —
  `normalizePhases`, `normalizeAgent`, `validateLauncher`.
- Todo 042 (pre-rendered qaPlaybookBlock skips drift check):
  may expand this block further.
- Todo 045 (qa-playbook double-read): also touches this block.
