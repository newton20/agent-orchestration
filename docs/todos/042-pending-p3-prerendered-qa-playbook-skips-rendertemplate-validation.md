---
status: pending
priority: p3
issue_id: "042"
tags: [code-review, post-pr-13, ce-review, scripts, architecture, future-proofing]
dependencies: []
---

# Pre-rendered `qaPlaybookBlock` skips `renderTemplate` validation (today a no-op; future-proofing only)

PR #13 ce:review's architecture-strategist initially flagged this as a
P2, framing it as "the on-disk frontmatter drift check is bypassed
when the caller pre-renders." Codex review of the triage caught the
premise as false: `checkTransitiveDrift(roleSrc, ...)` is called
unconditionally for QA-bound role templates and does its own load
of `qa-playbook-prompt.md` from disk, so frontmatter-drift detection
runs whether or not the caller pre-rendered the playbook text.

The actual gap is much narrower: when the caller supplies
`opts.qaPlaybookBlock` non-empty, `renderTemplate(playbookSrc,
context, ...)` is skipped — which means the playbook's `required` /
`optional` validation does not run for that dispatch. Today the
playbook declares `required: []` and `optional: [test_commands_block]`,
so the skipped validation does **nothing** anyway. This is
future-proofing: if `qa-playbook-prompt.md` ever gains a `required`
var, a pre-rendering caller would silently skip the required-vars
check.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:743-752` (post-merge):

```js
const needsPlaybook =
  !context.qa_playbook_block &&
  (o.role === 'qa' || (recovery && o.recoveryRole === 'qa'));
if (needsPlaybook) {
  const playbookSrc = readTemplate(o.templatesDir, QA_PLAYBOOK_FILE);
  const rendered = renderTemplate(playbookSrc, context, { templateName: QA_PLAYBOOK_FILE });
  playbookText = rendered.text;
  context.qa_playbook_block = playbookText;
}
```

Then later, regardless of `needsPlaybook`:

```js
const transitiveWarnings = [
  ...checkTransitiveDrift(roleSrc, o.templatesDir, roleTemplateFile),
  ...
];
```

`checkTransitiveDrift` reads the playbook from disk on its own when the
role template body contains `{{qa_playbook_block}}`. So the
**frontmatter-drift check is not skipped** in the pre-rendered case.

What IS skipped on the pre-rendered path is the body validation inside
`renderTemplate`:
- Body-`{{var}}` declared in frontmatter (would catch a stale playbook
  body referencing a var the frontmatter doesn't list).
- Required-var presence + non-empty (no-op today; the playbook has
  no required vars).
- The playbook's own `varsUsed` aggregation (already noted in
  todo 049).

Of these, only the body-`{{var}}` check would catch a real drift today
— and only if the caller's pre-rendered text was generated against a
template that already had that mismatch. In practice, a sufficiently
broken playbook would fail render at the point the caller pre-rendered
it; by the time bytes reach Unit 7's call, the pre-rendered text is
already free of unresolved `{{var}}` placeholders.

## Findings

PR #13 ce:review architecture-strategist (original P2):

> "When `opts.qaPlaybookBlock` is supplied non-empty by a caller (Unit
> 11 might cache/pre-render the playbook for performance), the
> inline-render branch (`needsPlaybook`) is skipped and the on-disk
> `qa-playbook-prompt.md` is never loaded for that dispatch — which
> means `checkTransitiveDrift` cannot run on the playbook frontmatter
> for that path."

Codex on the triage commit (correction):

> "When `opts.qaPlaybookBlock` is supplied, only the in-generator
> playbook render is skipped; `generatePrompt` still calls
> `checkTransitiveDrift(roleSrc, ...)` later, and that helper reads
> `qa-playbook-prompt.md` whenever the role template contains
> `{{qa_playbook_block}}`. The on-disk frontmatter drift check is
> not skipped in the pre-rendered-block scenario."

Demoted from P2 to P3 (future-proofing) following codex correction.

## Proposed Solutions

### Option A — Defer (recommended)

Today's playbook has no required vars and no body usage that would
drift undetected. The skipped validation is a no-op. If
`qa-playbook-prompt.md` ever adds required vars or undeclared-body
usage, revisit then. The `checkTransitiveDrift` guard already covers
the realistic drift scenarios.

- **Pros:** Zero churn. Matches the V1-freeze posture.
- **Cons:** A future contributor adding required vars to the
  playbook may not notice the pre-rendered-path skip until a
  test fires.
- **Effort:** Zero.
- **Risk:** Low — the gap activates only if the playbook contract
  evolves AND a caller pre-renders.

### Option B — Document the carve-out in the JSDoc

Add a one-paragraph note to the `qaPlaybookBlock` opt docstring:
"When supplied, the playbook's `renderTemplate` validation is
skipped. Today the playbook has no required vars; if it gains any,
this carve-out becomes a real gap. Re-validate when the contract
changes." Flag the contract evolution as the trigger for revisiting.

- **Pros:** Encodes the design constraint in code where future
  contributors will see it. Still zero behavior change.
- **Cons:** Adds JSDoc noise. The constraint is also covered by
  the `checkTransitiveDrift` invariant, partially.
- **Effort:** Trivial (a 5-line JSDoc paragraph).
- **Risk:** Zero.

### Option C — Run the playbook through `renderTemplate` even when pre-rendered

Use the on-disk playbook to run `renderTemplate(playbookSrc, context, ...)`
for validation, then DISCARD the rendered text and use the caller's
pre-rendered bytes. Defeats the point of the caller's caching but
restores the validation symmetry.

- **Pros:** Closes the (theoretical) future-proofing gap unconditionally.
- **Cons:** ~5 LOC of extra plumbing. Pays a ~400µs disk read on
  every QA dispatch even when the caller cached the playbook
  (overlaps with todo 045's read-once optimization).
- **Effort:** Small.
- **Risk:** Low; behavior preserved, validation strengthened.

## Recommended Action

**Recommend Option A (defer).** The codex correction made clear the
real drift surface is already covered by `checkTransitiveDrift`. The
narrow gap that remains (`renderTemplate` validation skipped on
pre-rendered playbook) is a no-op today. Coord triage may select
Option B (JSDoc carve-out note) at low cost as a future-proofing
nudge; Option C is overengineering for the V1 surface.

## Technical Details

- Affected file: `agent-orchestrator/scripts/generate-prompt.js:743-752`
  (the in-generator playbook render path).
- Related: `checkTransitiveDrift` at `:307` (the actually-load-bearing
  drift check).
- Future trigger to revisit: `qa-playbook-prompt.md` adds a non-empty
  `required` list, OR a future caller (Unit 11 cache) pre-renders the
  playbook and the prerendered bytes can drift from on-disk.

## Acceptance Criteria

- [ ] Triage captures chosen Option (A / B / C).
- [ ] If B: JSDoc on the `qaPlaybookBlock` opt names the
  no-op-today / future-proofing-only nature of the validation gap
  and points back to this todo.
- [ ] If C: a regression test asserts that supplying a
  `qaPlaybookBlock` with a body referencing an undeclared var raises
  the same lint error the in-generator render would have raised.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (architecture-strategist P2). Coord triage pending.
- **2026-04-29 — corrected via codex on triage PR** — original
  framing claimed `checkTransitiveDrift` was bypassed when caller
  pre-renders; codex corrected: that check runs unconditionally and
  reads the playbook from disk on its own. The actual narrow gap is
  `renderTemplate` validation being skipped, which today is a no-op
  (playbook `required: []`). Demoted P2 → P3, retitled, rewrote
  problem statement and proposed solutions to reflect the corrected
  scope.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- Round-6 codex fix on `previousPhaseBriefing`: the analog the
  original architecture-strategist framing pointed at; codex on
  triage caught that the analog does not actually apply here
  because the drift check is symmetric and runs in both paths.
- Todo 045 (P2): hot-path playbook double-read; if Option C is
  chosen, that work could share the same single-read.
- Todo 049 (P3): `varsUsed` scope discrepancy in qa two-pass
  renders — adjacent concern, would be addressed by Option C.
