---
status: pending
priority: p3
issue_id: "039"
tags: [code-review, post-pr-11, ce-review, scripts, plan-update, unit-11]
dependencies: []
---

# Plan §1083 documents `session-start.js` exports for Unit 11 — `parse-manifest.js` exports also need an enumerated entry

PR #11 closed todo 029 by updating the plan's "Exported symbols for
Unit 11" section (§1083) to enumerate all five `session-start.js`
exports. PR #11 also added `VALID_ID_RE` to `parse-manifest.js`'s
`module.exports` (closing todo 027). The architecture-strategist on
PR #11 ce:review noted a corresponding plan-doc gap.

## Problem Statement

`docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md:1081-1095`
documents Unit 11's expected consumer contract for the hooks side:

> `session-start.js` exports `{ runHook, FLAG_TTL_MS,
> STALE_HARD_TTL_MS, MAX_FLAG_BYTES, FLAG_NAME_RE }`. Unit 11
> should `require()` the regex and TTL constants rather than
> re-literal them...

But `parse-manifest.js`'s public surface — which Unit 11 also
consumes — is not enumerated anywhere in the plan. Today's exports:

```
{ loadManifest, validate, validateLauncher, findDanglingDeps,
  analyzeDeps, normalizePhases, statusPathFor, runUpdate,
  KNOWN_SHELLS, VALID_ID_RE }
```

(10 elements after PR #11.)

A Unit 11 implementer reading the plan first will know to `require`
the hooks side correctly but won't have the same authoritative list
for parse-manifest. They'll have to grep `module.exports` in the
source or read the file end-to-end.

## Findings

PR #11 ce:review architecture-strategist:

> "P3-A — `parse-manifest.js`'s public-export surface is now
> broader than its plan documentation acknowledges. Plan §1083
> documents Unit-11 consumer expectations for `session-start.js`'s
> exports but says nothing about `parse-manifest.js`'s exports.
> With `VALID_ID_RE` joining `loadManifest`, `validate`,
> `runUpdate`, etc., the parser's public surface is now a real
> consumer contract too. A future 'Exported symbols for Unit 11
> (parse-manifest)' subsection would let Unit 11 implementers find
> both ends in one place."

## Proposed Solutions

### Option A — Add a sister subsection to plan §1083

Below the existing "`session-start.js` exports..." paragraph, add a
parallel paragraph:

> `parse-manifest.js` exports `{ loadManifest, validate,
> validateLauncher, findDanglingDeps, analyzeDeps,
> normalizePhases, statusPathFor, runUpdate, KNOWN_SHELLS,
> VALID_ID_RE }`. Unit 11 should consume `VALID_ID_RE` for
> phase-id validation parity with the hook's `FLAG_NAME_RE`, and
> `runUpdate` for status-file mutations during the spawn lifecycle.

- **Pros:** Symmetric with the existing hooks-side documentation.
  Unit 11 has both contracts in one place.
- **Cons:** Plan grows by ~5 lines. The list will need updating
  if Unit 11 itself or post-Unit-11 work adds new exports.
- **Effort:** Small (doc-only).
- **Risk:** None.

### Option B — Defer to Unit 11 dispatch handoff

Capture the export list in the Unit 11 dispatch instructions
rather than the plan body. Plan stays minimal; the dispatch
handoff is the right place to tell the implementer "here's
everything you need to require."

- **Pros:** Plan stays terse. Dispatch instructions are the
  natural medium for "Unit 11 consumer contract."
- **Cons:** Future readers of the plan body still won't know
  about parse-manifest's public surface.
- **Effort:** Trivial (one line in the eventual Unit 11
  handoff).
- **Risk:** Low.

### Option C — Defer indefinitely

Plan rot is acceptable for V1. Unit 11 implementer can grep
`module.exports`.

- **Pros:** Zero churn.
- **Cons:** Plan-vs-code drift on parse-manifest's surface
  persists.
- **Effort:** Zero.
- **Risk:** Low (the implementer can always grep).

## Recommended Action

**Triage: leave for post-Unit-7 doc cleanup PR.** Architecture
reviewer flagged this as P3. Option A is cheap and symmetric;
Option B fragments the documentation across plan + handoff.
Combine with todo 037 (writer atomic-rename test deferred to Unit
11) and any other plan tweaks into a single doc-cleanup PR after
Unit 7 ships. Don't dispatch a dedicated PR for this alone.

## Technical Details

- Affected file: `docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md`
  (the "Exported symbols for Unit 11" subsection at §1081-1095).
- No code change.

## Acceptance Criteria

- [ ] Triage captures chosen Option (A / B / C).
- [ ] If A: plan §1081-1095 enumerates parse-manifest.js exports
  symmetrically with the existing session-start.js paragraph.
- [ ] Plan list matches `module.exports` in source at time of merge.

## Work Log

- **2026-04-28 — todo created** — Surfaced by PR #11 ce:review
  (architecture-strategist P3-A). Coord deferred per V1-freeze.

## Resources

- PR #11: https://github.com/newton20/agent-orchestration/pull/11
- Todo 027 (closed): added `VALID_ID_RE` to the export surface.
- Todo 029 (closed): updated `session-start.js` enumeration to
  5 elements; this todo is the symmetric follow-up.
