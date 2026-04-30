---
status: pending
priority: p3
issue_id: "057"
tags: [code-review, post-pr-13, ce-review, scripts, performance, caller-discipline, unit-11-prep]
dependencies: []
---

# Pre-render `previousPhaseBriefing` once per phase (caller-discipline note for Unit 11)

PR #13 ce:review's performance-oracle flagged the same caller-discipline
pattern as todo 056, applied to `buildPreviousPhaseBriefing`. The
briefing is identical for impl/qa/coord within one phase; if
Unit 11 calls `generatePrompt` with the same `priorPhaseSignals`
three times, the same upstream signal files are read three times.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:413-461`:

```js
function buildPreviousPhaseBriefing(priorPhaseSignals) {
  if (!Array.isArray(priorPhaseSignals) || priorPhaseSignals.length === 0) {
    return { briefing: '', warnings: [] };
  }
  const sections = [];
  const warnings = [];
  for (const signalPath of priorPhaseSignals) {
    if (typeof signalPath !== 'string' || signalPath === '') continue;
    let content;
    try {
      content = fs.readFileSync(signalPath, 'utf8');
    } catch (err) { /* ... */ }
    sections.push(content.trimEnd());
    // dispatcher_advisories warning emission (lines 442-455)
  }
  return { briefing: sections.join('\n\n---\n\n'), warnings };
}
```

For a phase with 2 upstream signals, every call to
`buildPreviousPhaseBriefing`:
1. Reads each upstream completion signal file.
2. Parses each frontmatter.
3. Emits `dispatcher_advisories` warnings.

The briefing is identical across the impl/qa/coord renders for a
single phase. Three role dispatches with the same
`priorPhaseSignals` array → six file reads where two would
suffice. For an orchestration with N upstream phases per phase,
the redundancy multiplies.

A bonus side-effect: `dispatcher_advisories` warnings get emitted
three times (once per role render). The orchestrator currently
deduplicates? Probably not — the warnings array is plumbed up
through `generatePrompt`'s return value as a fresh array each
call. Unit 11 logging may show the same advisory three times per
phase.

The empty-string-fallthrough fix from codex round 10 (which makes
`previousPhaseBriefing: ''` route through the derive path) means a
Unit 11 caller can pre-render the briefing once and pass the
resulting string via `previousPhaseBriefing` opt.

**Important caveat (codex on triage caught):** Pre-rendering only
avoids the file rereads if the caller ALSO **stops passing
`priorPhaseSignals`** on the subsequent role dispatches. The
codex-round-6 contract keeps the warning-channel parse running
even when the caller pre-renders the briefing text — so a Unit 11
caller that pre-renders the briefing AND keeps passing
priorPhaseSignals will still re-read every signal three times
(once per role) just to extract dispatcher_advisories warnings.
Pre-rendering must be paired with omitting signals on the
secondary calls; the warnings can be plumbed directly via the
return value of the first call.

## Findings

PR #13 ce:review performance-oracle P3:

> "`generate-prompt.js:413-461` — same waste pattern as todo 056.
> buildPreviousPhaseBriefing re-reads each upstream signal once
> per render. The briefing is identical for impl/qa/coord within
> one phase; Unit 11 calling the same generatePrompt with the
> same priorPhaseSignals 3 times re-reads the files 3x. The
> empty-string-fallthrough fix from codex round 10 makes
> pre-rendering safe — a `''` triggers the derive path. Bonus:
> pre-rendering centralizes dispatcher_advisories warnings into
> one place."

## Proposed Solutions

### Option A — Document caller discipline in templates/README.md

Add a subsection (companion to todo 056's section, or unified
under "Performance notes for Unit 11"):

> **Pre-render `previousPhaseBriefing` once per phase, AND omit
> `priorPhaseSignals` from the role dispatches.** Each call to
> `generatePrompt` with `priorPhaseSignals` rebuilds the
> upstream-briefing from disk. The briefing is identical across
> the impl/qa/coord renders for a single phase. Unit 11 should
> build the briefing once per phase using
> `buildPreviousPhaseBriefing` (exported from
> `generate-prompt.js`), capture the warnings from that call,
> and pass the resulting string as `previousPhaseBriefing` to
> all three role dispatches.
>
> **Critical:** the role-dispatch calls must NOT pass
> `priorPhaseSignals` alongside the pre-rendered briefing. The
> codex-round-6 contract keeps the warning-channel parse running
> even when the briefing text is pre-rendered — so passing both
> would still re-read every signal three times just to surface
> dispatcher_advisories warnings (which the orchestrator has
> already captured from the pre-render). Pass
> `previousPhaseBriefing` only on the dispatches; keep
> `priorPhaseSignals` on the one-time pre-render call.
>
> Bonus: this also dedups the `dispatcher_advisories` warnings
> to once per phase rather than once per role render.

- **Pros:** Zero code change. Documents the discipline + the
  side-effect win on warnings dedup. Unit 7 stays simple.
- **Cons:** Discipline-by-documentation; Unit 11 implementer
  could ignore the note.
- **Effort:** Trivial.
- **Risk:** None.

### Option B — Cache reads in-module

Memoize `buildPreviousPhaseBriefing` keyed on the sorted-stringified
`priorPhaseSignals` array.

- **Pros:** Caller doesn't need to know.
- **Cons:** Same stale-cache concerns as todo 056 Option B (dev
  workflows hand-editing upstream signals). And the warnings
  aspect is now ambiguous — does cache-hit re-emit warnings or
  not?
- **Effort:** Small.
- **Risk:** Medium. Warnings emission semantics under cache hit
  need careful design.

### Option C — Defer

V1 doesn't have an orchestrator that calls `generatePrompt` in a
tight loop. Unit 11 may naturally pre-render.

- **Pros:** Zero churn.
- **Cons:** Unit 11 implementer pays the I/O + the
  triple-warnings without realizing it's avoidable.
- **Effort:** Zero.
- **Risk:** None.

## Recommended Action

Coord triage pending. Recommend Option A if/when this lands in the
post-Unit-7 doc cleanup PR — same logic as todo 056. Caller
discipline doc with explicit pre-render-once recommendation. The
warnings-dedup bonus is a real Unit 11 win that tips slightly in
favor of Option A over deferring.

## Technical Details

- Affected file (Option A):
  `agent-orchestrator/templates/README.md`.
- Affected file (Option B):
  `agent-orchestrator/scripts/generate-prompt.js:413-461`.
- Empty-string-fallthrough behavior at `buildContext` /
  `generatePrompt` (codex round 10 fix) makes Option A safe.
- `buildPreviousPhaseBriefing` is exported per
  `module.exports` at `generate-prompt.js:1099-1115`, so Unit
  11 can call it directly.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: `templates/README.md` documents the pre-render
  discipline for `previousPhaseBriefing`, references the
  empty-string-fallthrough behavior, and notes the
  warnings-dedup bonus.
- [ ] If A: companion to (or unified with) the todo 056 section.
- [ ] If B: `buildPreviousPhaseBriefing` cache + clear warnings
  semantics.
- [ ] Tests still green.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (performance-oracle P3). Coord triage pending.
- **2026-04-29 — corrected via codex on triage PR** — original
  Option A told Unit 11 to "pre-render `previousPhaseBriefing`
  once per phase and pass the resulting string to all three role
  dispatches" without warning that the codex-round-6 contract
  keeps the warning-channel parse running even when the briefing
  is pre-rendered. A naive caller that pre-renders the briefing
  AND keeps passing `priorPhaseSignals` would still re-read every
  signal three times (once per role). Rewrote Option A to add the
  critical caveat: **omit `priorPhaseSignals` from the role
  dispatches** after pre-rendering; capture the warnings from the
  one-time pre-render call instead.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js:413-461` —
  `buildPreviousPhaseBriefing`.
- Companion todo 056 — same caller-discipline pattern for
  `extractPlanUnit`.
- Codex round 10 — empty-string-fallthrough fix that makes
  pre-rendering safe.
