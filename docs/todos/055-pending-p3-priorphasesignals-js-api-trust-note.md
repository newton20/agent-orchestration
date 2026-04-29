---
status: pending
priority: p3
issue_id: "055"
tags: [code-review, post-pr-13, ce-review, scripts, security, unit-11-prep]
dependencies: []
---

# Document the JS-API trust assumption around `priorPhaseSignals`

PR #13 ce:review's security-sentinel noted that the CLI excludes
`priorPhaseSignals` from `--context` (codex round 9, allowlist
comment at lines 981-992) but the JS API does no path validation
whatsoever — `buildPreviousPhaseBriefing` calls
`fs.readFileSync(signalPath, 'utf8')` directly. Fine for Unit 11
(manifest-derived paths) but a Unit 11 implementer who exposes
`priorPhaseSignals` via a new CLI passthrough would re-create the
file-read disclosure bug codex round 9 closed.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:981-992` documents
the rationale for excluding `priorPhaseSignals` from the CLI
content-block allowlist:

> Note: `priorPhaseSignals` is deliberately NOT in this allowlist.
> It is an array of paths Unit 7 would `fs.readFileSync` into the
> rendered prompt — letting `--context` name arbitrary local
> paths would disclose file contents (e.g. `/etc/passwd`,
> `~/.aws/credentials`) into a prompt the agent then sees, which
> a sufficiently broad CLI dispatch can also write into
> completion-signal artifacts. CLI callers wanting to include
> upstream completion-signal content should pre-render it as
> `previousPhaseBriefing` (a string content block, no file
> reads). The JS API path used by Unit 11 still accepts
> priorPhaseSignals directly because the orchestrator controls
> those paths. Codex round 9 caught this.

The JS API path (`generatePrompt({ priorPhaseSignals: [...], ... })`
called from `buildContext` → `buildPreviousPhaseBriefing` at
`generate-prompt.js:413-461`) does no path-shape validation. It
calls `fs.readFileSync(signalPath, 'utf8')` directly on whatever
strings the caller supplied. This is correct for Unit 11 — the
orchestrator builds those paths from a manifest under its own
control.

The trust assumption is documented in the CLI allowlist comment
but NOT in the JSDoc of `buildPreviousPhaseBriefing` itself, where
a Unit 11 implementer (or any future caller) would look. A future
Unit 11 implementer who decides to "expose `priorPhaseSignals`
via a new CLI passthrough" — perhaps for a `--prior-signals`
flag or a hook policy — would skip the allowlist gate that
currently blocks this and re-introduce the codex-round-9 bug.

## Findings

PR #13 ce:review security-sentinel P3 (operational note):

> "CLI excludes priorPhaseSignals from --context (codex round 9)
> but the JS API does no path validation —
> buildPreviousPhaseBriefing calls fs.readFileSync(signalPath,
> 'utf8') directly. Fine for Unit 11 (manifest-derived paths)
> but a Unit 11 implementer who accepts priorPhaseSignals from
> operator-controlled input via a CLI flag passthrough would
> re-create the file-read disclosure bug."

## Proposed Solutions

### Option A — Add path-shape validation to `buildPreviousPhaseBriefing`

Add a `phasesRoot` parameter and validate each `signalPath`
resolves to a path under it:

```js
function buildPreviousPhaseBriefing(priorPhaseSignals, phasesRoot) {
  // ...
  for (const signalPath of priorPhaseSignals) {
    const resolved = path.resolve(signalPath);
    if (!resolved.startsWith(path.resolve(phasesRoot) + path.sep)) {
      warnings.push(
        `upstream signal ${signalPath}: outside phasesRoot, refusing to read`,
      );
      continue;
    }
    // ... existing read logic
  }
}
```

- **Pros:** Belt-and-suspenders defense in the JS API. A Unit 11
  implementer who exposes `priorPhaseSignals` to less-trusted
  input automatically gets the path containment check.
- **Cons:** Requires Unit 11 to pass `phasesRoot` (currently
  Unit 7 has no concept of phasesRoot — only the per-phase
  `phaseDir`). Adds an API parameter that V1 callers don't
  need.
- **Effort:** Small to medium (need to plumb `phasesRoot` through
  `generatePrompt` → `buildContext` →
  `buildPreviousPhaseBriefing`).
- **Risk:** Low; tests for valid manifests unchanged.

### Option B — Document the trust assumption in JSDoc + Unit 11 checklist

Add a JSDoc paragraph above `buildPreviousPhaseBriefing` that
calls out the trust assumption explicitly:

> SECURITY: This function performs `fs.readFileSync` on every
> string in `priorPhaseSignals`. It does NOT validate path
> shape. Callers MUST guarantee the array contains only paths
> the orchestrator controls (manifest-derived). Exposing this
> parameter to operator-controlled input (e.g. a new CLI flag,
> an HTTP endpoint, a content-block JSON) re-introduces the
> file-read disclosure bug codex round 9 closed for the CLI.
> See generate-prompt.js:981-992.

Plus a one-line entry in the Unit 11 checklist (in
`docs/units/011-...md` or wherever Unit 11 design lives) that
says: "If exposing `priorPhaseSignals` via any new operator
surface, gate it behind a path-containment check against
`phasesRoot`."

- **Pros:** Cheap. The trust assumption is now visible at the
  function declaration where it's actually used. Future
  implementers get an in-source warning.
- **Cons:** Doesn't enforce the constraint, just documents it.
- **Effort:** Trivial.
- **Risk:** Low.

### Option C — Defer to Unit 11 implementation

Unit 11 is the only consumer that would re-create this risk;
let Unit 11's design pass handle the guard.

- **Pros:** Zero churn now.
- **Cons:** When Unit 11 implementer reaches this code, the
  trust assumption is implicit and easy to miss.
- **Effort:** Zero.
- **Risk:** Low while Unit 11 is unimplemented.

## Recommended Action

Coord triage pending. Recommend Option B if/when this lands in the
post-Unit-7 doc cleanup PR — JSDoc + Unit 11 checklist entry is
cheap and high-leverage. Option A's `phasesRoot` plumbing is more
invasive and benefits only the speculative second-CLI-surface
case.

## Technical Details

- Affected file: `agent-orchestrator/scripts/generate-prompt.js`
- Lines: 413-461 (function body), 981-992 (CLI allowlist comment
  the JSDoc would cross-reference).
- Unit 11 design doc: `docs/units/...` or
  `docs/todos/011-...` — add a checklist note.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: `buildPreviousPhaseBriefing` rejects (warns + skips)
  signals outside `phasesRoot`.
- [ ] If A: `phasesRoot` plumbed through `generatePrompt` →
  `buildContext` → `buildPreviousPhaseBriefing`.
- [ ] If B: JSDoc above `buildPreviousPhaseBriefing` warns about
  the trust assumption and references the CLI allowlist comment.
- [ ] If B: Unit 11 design doc carries a one-line implementer
  checklist entry.
- [ ] Tests still green.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (security-sentinel P3, operational note). Coord triage
  pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js:413-461` —
  `buildPreviousPhaseBriefing`.
- `agent-orchestrator/scripts/generate-prompt.js:981-992` — CLI
  allowlist exclusion of `priorPhaseSignals` (codex round 9
  rationale).
