---
status: pending
priority: p3
issue_id: "054"
tags: [code-review, post-pr-13, ce-review, scripts, security, information-disclosure]
dependencies: []
---

# `dispatcher_advisories` warnings include absolute upstream signal paths

PR #13 ce:review's security-sentinel noted (for completeness) that
the warning strings emitted from `buildPreviousPhaseBriefing`
include the absolute path to each upstream signal. Information
disclosure is low-value here (the prompt body already carries
workdir paths via `{{workdir}}` and `{{phase_dir}}`), but the
finding is captured for the post-Unit-7 cleanup pass.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:425-455` emits
warnings such as:

```js
warnings.push(
  `previous-phase-briefing: cannot read upstream signal at ${signalPath}: ${err.message}`,
);
warnings.push(
  `upstream signal ${signalPath} has malformed frontmatter: ${err.message}`,
);
warnings.push(
  `upstream signal ${signalPath}: dispatcher_advisories must be a non-negative integer (V1 schema), got ${JSON.stringify(v)}`,
);
warnings.push(
  `upstream signal ${signalPath}: dispatcher_advisories=${v} — coord should investigate the dispatcher / prompt generator before the next phase advances`,
);
```

`signalPath` is the absolute path of an upstream completion signal
(`/abs/workdir/phases/phase-N/role-complete.md` or similar). When
these warnings reach a coordinator who renders them into a UI or
log, the absolute path is exposed.

The disclosure is low-value because:

- The same workdir/phaseDir paths already appear in the rendered
  prompt body via the `{{workdir}}` and `{{phase_dir}}`
  substitutions (which the agent is expected to read).
- Warnings are consumed by the orchestrator/operator, not by
  less-trusted agents.
- Warnings deliberately surface dispatcher health to a human; a
  path is what the human needs to investigate the underlying
  signal.

For completeness — and to match the codex-round-9 stance that file
paths should not flow gratuitously into operator-facing strings
when a workdir-relative form is available — this is captured.

## Findings

PR #13 ce:review security-sentinel P3:

> "`generate-prompt.js:425-455` — warning strings include the
> absolute upstream signal path (e.g. `upstream signal
> /full/path/to/phase-N/role-complete.md: dispatcher_advisories=2
> — coord should investigate ...`). Information disclosure of
> low value (the prompt body already contains workdir paths via
> `{{workdir}}` and `{{phase_dir}}`), but flagged for
> completeness."

## Proposed Solutions

### Option A — Render paths workdir-relative when possible

Pass `workdir` (or `phasesRoot`) into `buildPreviousPhaseBriefing`
and use `path.relative(workdir, signalPath)` for the warning
string. Fall back to absolute when relative would produce a
`..`-prefixed path (signal lives outside the workdir).

- **Pros:** Warnings become shorter and reveal less about the
  filesystem layout. Aligns with the codex round 9 stance on
  path disclosure.
- **Cons:** Requires plumbing workdir into the briefing builder
  (currently `priorPhaseSignals` is the only argument). New
  param means an API surface change. Tests asserting exact
  warning text need updates.
- **Effort:** Small (add param + update warnings + tests).
- **Risk:** Low.

### Option B — Accept (paths are already in prompts; warnings are operator-facing, not less-trusted)

Document at the function declaration that warnings intentionally
include absolute paths because the operator consuming them needs
the path to investigate. Treat as out-of-scope.

- **Pros:** Zero churn. Pragmatic — warnings are for humans, and
  humans need the path.
- **Cons:** Doesn't address the disclosure asymmetry between
  prompts (operator-controlled paths only) and warnings (any
  signal path Unit 11 passes in).
- **Effort:** Trivial (JSDoc paragraph).
- **Risk:** None.

### Option C — Defer

The disclosure is harmless in V1 (no untrusted operator surface).

- **Pros:** Zero churn.
- **Cons:** Persists as a small latent finding into Unit 11.
- **Effort:** Zero.
- **Risk:** None today.

## Recommended Action

Coord triage pending. Recommend Option B if/when this lands in the
post-Unit-7 doc cleanup PR — Option A's API change for a
low-value disclosure trade is not obviously net positive. A JSDoc
paragraph clarifying that warnings intentionally include absolute
paths (so operators can investigate) is the right
documentation-only fix.

## Technical Details

- Affected file: `agent-orchestrator/scripts/generate-prompt.js`
- Lines: 425-455 (warning emission sites in
  `buildPreviousPhaseBriefing`).
- API impact (Option A): `buildPreviousPhaseBriefing` signature
  gains a `workdir` (or options) parameter. Caller in
  `generatePrompt` already has `o.workdir`.
- Test impact: existing warning-text assertions need updates if
  Option A is selected.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: warnings emit workdir-relative paths when the signal
  lives under workdir; absolute paths otherwise.
- [ ] If A: tests asserting exact warning text are updated.
- [ ] If B: JSDoc clarifies intent.
- [ ] Tests still green.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (security-sentinel P3). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js:425-455` —
  warning emission sites.
- Codex round 9 — original stance on file-path disclosure.
