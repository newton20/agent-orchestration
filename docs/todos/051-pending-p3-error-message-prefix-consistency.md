---
status: pending
priority: p3
issue_id: "051"
tags: [code-review, post-pr-13, ce-review, scripts, architecture, error-handling]
dependencies: []
---

# Standardize error message prefixes in `generate-prompt.js`

PR #13 ce:review's architecture-strategist observed that the
`throw new Error(...)` sites in `generate-prompt.js` use four or
five different prefix conventions. For Unit 11's error routing
(which may classify errors by prefix), a stable scheme would help.

## Problem Statement

The `throw` sites in
`agent-orchestrator/scripts/generate-prompt.js` use these prefix
conventions:

- `frontmatter YAML parse error:` — line 171.
- `interpolation:` — line 196.
- `template <tn>:` — lines 225, 241, 263, 266 (where `<tn>` is the
  template name, e.g. `qa-playbook-prompt.md`).
- `extractPlanUnit:` — lines 358, 377.
- `previous-phase-briefing:` (warning, not throw) — line 426.
- `upstream signal <path>:` (warning) — lines 438, 446, 451.
- `generatePrompt:` — lines 691, 698, 705, 711, 714.

Each prefix is reasonable in isolation. As a set, they don't share
a parseable shape. A regex-based classifier (Unit 11's likely
error router) has to know all of them; the order of "subsystem
name : human message" is inconsistent (some are `subsystem:
message`, some are `subsystem name:`, some are
`<noun> <variable>: message`).

## Findings

PR #13 ce:review architecture-strategist P3:

> "Multiple lines in generate-prompt.js — error message prefixes
> are inconsistent: `extractPlanUnit:`, `interpolation:`,
> `generatePrompt:`, `template <tn>:`, `frontmatter YAML parse
> error:`. For Unit 11's error routing (regex-based or
> prefix-classification), a stable scheme would help. Either
> standardize the prefix shape, or document the taxonomy in
> JSDoc."

## Proposed Solutions

### Option A — Standardize to `generate-prompt: <subsystem>: <message>`

Rewrite every throw to share a top-level `generate-prompt:`
prefix, then a subsystem token, then the human message. Example
diffs:

```js
// before:
throw new Error(`extractPlanUnit: no unit matching "${unitMarker}" found in ${planPath}`);
// after:
throw new Error(`generate-prompt: extract-plan-unit: no unit matching "${unitMarker}" found in ${planPath}`);

// before:
throw new Error(`template ${tn}: missing YAML frontmatter`);
// after:
throw new Error(`generate-prompt: template ${tn}: missing YAML frontmatter`);
```

- **Pros:** Unit 11's error router gets a stable
  `^generate-prompt:` prefix to filter on. Subsystem token is
  always the second segment.
- **Cons:** Touches every throw in the file. Existing tests
  asserting exact error messages need updates. Verbose: most
  errors gain ~16 leading characters that the user already
  knows from the calling context.
- **Effort:** Medium (touch every throw + every test that
  asserts error text).
- **Risk:** Low (mechanical rewrite, tests catch divergence).

### Option B — Document the prefix taxonomy in JSDoc

Add a comment block (top-of-file or near `generatePrompt`) listing
the prefix taxonomy currently in use, so Unit 11's error router
has an authoritative inventory:

```
Error message prefixes used by this module:
  - "frontmatter YAML parse error: ..."   parseFrontmatter
  - "template <name>: ..."                renderTemplate (declared/required)
  - "interpolation: ..."                  interpolate (defense-in-depth)
  - "extractPlanUnit: ..."                extractPlanUnit
  - "generatePrompt: ..."                 generatePrompt arg validation
Warnings (not throws) use "upstream signal <path>:" and
"previous-phase-briefing:".
```

- **Pros:** Zero behavioral change. Documents what already exists.
  Cheap.
- **Cons:** Doesn't fix the inconsistency, just labels it. Future
  throws still drift.
- **Effort:** Trivial.
- **Risk:** None.

### Option C — Defer until Unit 11 surfaces a real classifier need

Unit 11's error routing is not yet implemented. Whatever shape it
needs may dictate a different scheme than Option A.

- **Pros:** Avoids premature standardization that Unit 11 then
  re-changes.
- **Cons:** When Unit 11 lands, the prefix-rewrite churn touches
  the same file again.
- **Effort:** Zero.
- **Risk:** Low.

## Recommended Action

Coord triage pending. Recommend Option B if/when this lands in the
post-Unit-7 doc cleanup PR — taxonomy documentation is the cheap
half of Option A and gives Unit 11 implementers an inventory
without committing to a specific prefix scheme prematurely.

## Technical Details

- Affected file: `agent-orchestrator/scripts/generate-prompt.js`
- Throw sites: 171, 196, 225, 241, 263, 266, 358, 377, 691, 698,
  705, 711, 714.
- Warning sites (not throws but same shape concern): 426, 438,
  446, 451.
- Test files asserting error text:
  `agent-orchestrator/scripts/generate-prompt.test.js`,
  `agent-orchestrator/test/generate-prompt-cli.test.js` (if
  applicable).

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: every throw in the file matches
  `^generate-prompt: [a-z][a-z0-9-]*: ` shape.
- [ ] If A: tests asserting error text are updated.
- [ ] If B: JSDoc taxonomy lists every prefix currently thrown,
  cross-referenced to the originating function.
- [ ] Tests still green.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (architecture-strategist P3). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js` — see throw
  sites enumerated above.
