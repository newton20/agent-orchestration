---
status: pending
priority: p3
issue_id: "049"
tags: [code-review, post-pr-13, ce-review, scripts, architecture, api-surface]
dependencies: []
---

# `varsUsed` aggregates header + role only — playbook two-pass render is dropped

PR #13 ce:review's architecture-strategist flagged that the
aggregated `varsUsed` returned from `generatePrompt` reflects only
the protocol-header and role-template renders. The qa-playbook
two-pass render's `varsUsed` is silently dropped, which means
qa/recovery-as-qa dispatches under-report which variables actually
touched the rendered prompt.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:791-793`:

```js
const varsUsed = [
  ...new Set([...headerOut.varsUsed, ...roleOut.varsUsed]),
].sort();
```

Earlier in `generatePrompt()` (lines 743-752), when the dispatch is
qa or recovery-with-recoveryRole=qa, the code does a separate
`renderTemplate` pass for `qa-playbook-prompt.md`:

```js
const playbookSrc = readTemplate(o.templatesDir, QA_PLAYBOOK_FILE);
const rendered = renderTemplate(playbookSrc, context, { templateName: QA_PLAYBOOK_FILE });
playbookText = rendered.text;
context.qa_playbook_block = playbookText;
```

The playbook render's `rendered.varsUsed` is never aggregated into
the final `varsUsed` returned to the caller. The text it produced
ends up inside the role template's body via the
`{{qa_playbook_block}}` substitution (which itself appears in
`roleOut.varsUsed` as just one entry), so the *actual* set of
variables consumed by the rendered prompt is a strict superset of
what we return.

For Unit 11 telemetry — "what variables touched this render" — qa
and recovery-as-qa dispatches will systematically under-report.
That is a correctness gap if the telemetry is consulted for cache
keys, drift detection, or audit.

## Findings

PR #13 ce:review architecture-strategist P3:

> "`generate-prompt.js:791-793` aggregates varsUsed from header +
> role only. The qa-playbook two-pass render's varsUsed is
> silently dropped. For Unit 11 telemetry that logs 'what
> variables touched this render,' qa dispatches under-report.
> Either union the playbook's varsUsed when present, or rename
> the field to clarify scope."

## Proposed Solutions

### Option A — Union the playbook render's `varsUsed`

Capture the playbook render's `varsUsed` when the playbook pass
runs and union it into the final aggregation:

```js
let playbookVarsUsed = [];
if (needsPlaybook) {
  const rendered = renderTemplate(playbookSrc, context, { templateName: QA_PLAYBOOK_FILE });
  playbookText = rendered.text;
  context.qa_playbook_block = playbookText;
  playbookVarsUsed = rendered.varsUsed;
}
// ...
const varsUsed = [
  ...new Set([...headerOut.varsUsed, ...roleOut.varsUsed, ...playbookVarsUsed]),
].sort();
```

- **Pros:** Reported `varsUsed` matches the union of variables
  actually substituted into the final prompt text. Future telemetry
  / cache-key consumers see the truth.
- **Cons:** Slightly bigger field for qa/recovery-as-qa dispatches.
  Existing tests asserting exact `varsUsed` arrays for qa would
  need updates.
- **Effort:** Small.
- **Risk:** Low.

### Option B — Rename to `topLevelVarsUsed`

Keep current behavior; rename the field to `topLevelVarsUsed` (or
add a comment + JSDoc paragraph clarifying the scope is
header+role only, excluding nested template renders).

- **Pros:** No semantic change. Documents what the field means.
- **Cons:** Pushes the under-report problem onto the caller.
  Telemetry that wants the full picture has to assemble it
  externally.
- **Effort:** Trivial (rename + doc).
- **Risk:** Low.

### Option C — Defer

No caller relies on `varsUsed` today (Unit 11 is not yet built).
Leave as-is until a real consumer exposes the gap.

- **Pros:** Zero churn.
- **Cons:** Defers a known semantic bug into Unit 11 implementation
  pressure. Telemetry consumer may not realize the under-report
  until it produces wrong results.
- **Effort:** Zero.
- **Risk:** Low today, latent for Unit 11.

## Recommended Action

Coord triage pending. Recommend Option A if/when this lands in the
post-Unit-7 doc cleanup PR — it preserves the field's documented
meaning ("variables that touched this render"), while Option B
narrows the field's value.

## Technical Details

- Affected file: `agent-orchestrator/scripts/generate-prompt.js`
- Lines: 743-752 (playbook render), 791-793 (aggregation).
- Test impact: existing qa/recovery-as-qa tests asserting exact
  `varsUsed` may need updated expectations to include
  playbook-only variables (e.g. `test_commands_block`).

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: returned `varsUsed` for a qa dispatch includes any
  variable referenced only by `qa-playbook-prompt.md`.
- [ ] If A: returned `varsUsed` for an impl/coord dispatch is
  unchanged.
- [ ] If B: JSDoc clarifies the field's scope; field name (or a
  sibling field) reflects scope.
- [ ] Tests still green.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (architecture-strategist P3). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js:743-752` — qa
  playbook two-pass render.
- `agent-orchestrator/scripts/generate-prompt.js:791-793` — final
  `varsUsed` aggregation.
