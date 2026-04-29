---
status: pending
priority: p3
issue_id: "048"
tags: [code-review, post-pr-13, ce-review, scripts, architecture, security-defense]
dependencies: []
---

# Export `CONTEXT_ALLOWLIST` so a future second consumer can reuse it

PR #13 ce:review's architecture-strategist flagged that
`CONTEXT_ALLOWLIST` (the set of content-block keys the CLI accepts
from `--context` JSON files) lives only in CLI scope. It encodes a
real security property — "content-block JSONs cannot redirect
dispatch" — but is not part of the module's public surface.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:950-996` defines
`CONTEXT_ALLOWLIST` as a frozen `Set` of variable names the CLI's
`--context` flag is allowed to forward into the render context.
Anything outside this set is dropped before being merged into
`opts`, which is what makes the CLI safe against
content-block-driven dispatch redirection (codex P2 round 1) and
protocol-path tampering (codex P2 round 2).

The constant is module-scoped but is NOT exported via the
`module.exports = { ... }` block at lines 1099-1115. Today there is
exactly one consumer (the CLI's `main()` at the bottom of the same
file), so this is fine.

If a future trust boundary appears — a sidecar service accepting
content-block JSONs from less-trusted sources, a hook policy layer,
or a Unit 11 manifest path that pulls in operator-supplied
content blocks — that second consumer will need the same allowlist
discipline. Without an exported constant, the property gets
re-implemented (probably partially), and the canonical defense
drifts.

## Findings

PR #13 ce:review architecture-strategist P3:

> "`generate-prompt.js:950-996` CONTEXT_ALLOWLIST encodes a security
> property ('content-block JSONs cannot redirect dispatch') but
> lives only in CLI scope. If a future trust boundary appears (a
> sidecar accepting content blocks from less-trusted sources, a
> hook policy layer), the property must be re-implemented. Low
> cost to fix today by exporting the constant and labeling it as
> the canonical untrusted-input allowlist for content-block
> ingestion."

## Proposed Solutions

### Option A — Export `CONTEXT_ALLOWLIST` and document the role

Add `CONTEXT_ALLOWLIST` to `module.exports`. Update the JSDoc above
its declaration to explicitly call it out as the canonical
allowlist for content-block ingestion from untrusted callers, and
note the rationale (closes the codex P2 round 1/2 dispatch- and
protocol-path tamper vectors).

- **Pros:** Single source of truth. New consumers import the same
  predicate, get the same defense for free. Documentation makes the
  invariant grep-able.
- **Cons:** Slightly enlarges the public API. Future churn on the
  allowlist becomes a "public API" change, requiring more care
  (but the allowlist is already a public security boundary; this
  just makes the boundary explicit).
- **Effort:** Trivial (one helper function, a JSDoc paragraph).
- **Risk:** Low — but **DO NOT** export the raw `Set` directly.
  `Object.freeze(new Set(...))` does not prevent `.add()` /
  `.delete()` on the Set's internal storage (codex on triage PR
  caught this — the `Object.freeze` only freezes the wrapper
  object, not the Set's items). Export shapes that resist mutation:
  - **Recommended:** export an `isAllowedContextKey(key) -> boolean`
    predicate function that closes over the private Set.
  - **Alternative:** export a frozen Array — `Object.freeze` on an
    array DOES prevent mutation (push/pop throw in strict mode).
    Consumers iterate or convert to Set as needed.
  Exporting the raw Set is a footgun: a single `require(...).CONTEXT_ALLOWLIST.add('phaseDir')`
  inside any in-process consumer (a test fixture, a future module)
  would silently widen the trusted-key set for every subsequent
  invocation in that process.

### Option B — Defer until a second consumer exists

Leave `CONTEXT_ALLOWLIST` private until a real second consumer
appears (Unit 11, a sidecar, a hook). The "canonical allowlist"
status is implicit until needed.

- **Pros:** Zero code churn. YAGNI applied to public surface.
- **Cons:** When the second consumer arrives, the temptation is to
  re-derive the allowlist from local context rather than refactor
  to import a previously-private constant. Drift risk grows the
  longer it sits unexported.
- **Effort:** Zero.
- **Risk:** Low today, growing.

## Recommended Action

Coord triage pending. Recommend Option A if/when this lands in the
post-Unit-7 doc cleanup PR — it is a one-line export plus a JSDoc
clarification, and the security-defense framing is already implied
by the in-source comments at lines 940-995.

## Technical Details

- Affected file: `agent-orchestrator/scripts/generate-prompt.js`
- Lines: 950-996 (declaration), 1099-1115 (exports).
- Behavior: no change. Public surface adds one frozen `Set`.
- Test impact: optionally add a node:test assertion that
  `require('./generate-prompt').CONTEXT_ALLOWLIST` is a frozen
  `Set` containing at least the impl/qa/coord/recovery keys
  documented at lines 952-994.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: `CONTEXT_ALLOWLIST` appears in `module.exports`.
- [ ] If A: JSDoc above the declaration calls out the constant as
  the canonical allowlist for content-block ingestion from
  untrusted callers.
- [ ] If A: existing CLI behavior unchanged (allowlist values
  identical).
- [ ] Tests still green.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (architecture-strategist P3). Coord triage pending.
- **2026-04-29 — corrected via codex on triage PR** — original
  Option A claimed `Object.freeze(new Set(...))` made the
  allowlist immutable from external callers. Codex correctly
  noted that `Object.freeze` only freezes the wrapper object —
  the Set's internal storage stays mutable, so a consumer could
  call `.add()` / `.delete()` to widen the allowlist for the
  entire process. Rewrote Option A to recommend exporting an
  `isAllowedContextKey(key) -> boolean` predicate (closes over
  the private Set) or a frozen Array (for which `Object.freeze`
  does prevent mutation). Explicitly flagged the raw-Set-export
  footgun.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js:950-996` —
  declaration of `CONTEXT_ALLOWLIST`.
- `agent-orchestrator/scripts/generate-prompt.js:1099-1115` —
  current `module.exports` block.
- Codex P2 rounds 1/2 (PR #13 history) — original
  dispatch-redirection and protocol-path-tamper findings the
  allowlist closes.
