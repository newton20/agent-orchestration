---
status: pending
priority: p3
issue_id: "035"
tags: [code-review, post-pr-9, simplicity, scripts, docs]
dependencies: []
---

# Trim quoteBinary header doc — move PowerShell `&` note to the call site

PR #9's simplicity reviewer noted that the post-drop `quoteBinary`
header doc (`spawn-session.js:139-157`) is ~5 lines longer than it
needs to be: the "PowerShell uses the call operator" sentence belongs
*next to* the `& '${binary}'` line, not in the function header.

## Problem Statement

`agent-orchestrator/scripts/spawn-session.js:139-157` is a 19-line
header comment for `quoteBinary` that:

- Enumerates the 4 supported binary shapes
- Explains the boundary-guard rationale
- Notes the PowerShell call-operator behavior at the top of the function
- Tells manifest authors what to do for unsupported case 6

The simplicity reviewer's observation:

> "The 'PowerShell uses the call operator' sentence (L147-149) belongs
> *next to* the `& '${binary}'` line at L165, not in the function
> header. The case enumeration + boundary explanation is right where
> it should be. Minor."

Moving the PS-call-operator detail closer to its implementation site
(L168) would shrink the header to ~14 lines while keeping the contract
documentation intact.

## Findings

Code-simplicity-reviewer P3 on PR #9:

> "Slightly verbose, keep — but ~5 lines too long. The 'PowerShell
> uses the call operator' sentence (L147-149) belongs next to the `&`
> line. Minor."

## Proposed Solutions

### Option A — Move the PowerShell sentence to the `&` branch

Header keeps shape enumeration + boundary guard rationale + case-6
note. The PowerShell call-operator explanation moves to a 2-line
inline comment immediately above `return \`& '${binary.replace(...)}'\`;`.

- **Pros:** Header is shorter and stays focused on the contract.
  Implementation detail lives where it's implemented.
- **Cons:** Splits the doc across two locations (mitigated because
  they're 20 lines apart in the same function).
- **Effort:** Trivial.
- **Risk:** None.

### Option B — Leave as-is

The header is one connected explanation. Don't split.

- **Pros:** Minimal churn.
- **Cons:** Header carries an implementation detail that future
  readers expect to find at the implementation.
- **Effort:** Zero.
- **Risk:** None.

### Option C — Aggressive trim

Drop the PowerShell-call-operator sentence entirely from the header
without re-locating it. The implementation already shows `& '...'`;
reading the code is enough.

- **Pros:** Smallest doc.
- **Cons:** Loses the explicit "PowerShell needs the call operator"
  note, which is a Windows-specific gotcha worth flagging somewhere.
- **Effort:** Trivial.
- **Risk:** Low — implementation comment may not be enough for a
  reader unfamiliar with PowerShell call operators.

## Recommended Action

_(Filled during triage.)_

## Technical Details

- Affected file: `agent-orchestrator/scripts/spawn-session.js`
  (lines 139-157 header + lines 158-168 function body)
- No test changes.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: header is ~5 lines shorter; PowerShell-call-operator
  detail lives next to its `&` branch.
- [ ] If C: header doesn't mention the call operator.
- [ ] All 130 spawn-session tests still pass (doc-only change).

## Work Log

- **2026-04-28 — todo created** — Surfaced by code-simplicity-reviewer
  on PR #9.

## Resources

- PR #9: https://github.com/newton20/agent-orchestration/pull/9
- Todo 002 (closed):
  `docs/todos/002-complete-p3-simplify-spawn-session-post-codex.md`
- Findings #2/#3/#4/#6 from todo 002 (the bigger simplifications) are
  still deferred to Unit 11.
