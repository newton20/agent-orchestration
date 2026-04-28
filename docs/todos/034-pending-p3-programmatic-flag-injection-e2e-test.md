---
status: pending
priority: p3
issue_id: "034"
tags: [code-review, post-pr-9, agent-native, hooks, unit-11-prereq, test-coverage]
dependencies: []
---

# Add programmatic e2e flag-injection test for SessionStart hook

`agent-orchestrator/hooks/README.md:60-88` describes a manual end-to-end
test for the SessionStart hook using Windows-cmd commands (`echo`,
`dir`). PR #9's agent-native-reviewer flagged that this is human-shaped,
not agent-shaped — a future orchestrator agent (Unit 11) needs a
programmatic equivalent before it can self-verify hook firing.

## Problem Statement

The current manual test is:

```cmd
echo Start this session by reading plan.md ... > docs\orchestration\.pending-demo-1
# (start a Claude session)
dir /b docs\orchestration\.pending-* 2>nul
dir /b docs\orchestration\.consuming-* 2>nul
```

Three problems for an agent-native flow:

1. **Windows-cmd-specific.** Translates to bash/PowerShell with
   non-trivial differences. An orchestrator agent reading the README
   has to first map cmd to its native shell.
2. **Imperative prose.** Pass/fail criteria embedded in English
   ("Both commands should return nothing"). Not directly invokable
   as a test.
3. **No exit code.** A self-verifying agent needs `exit 0` on success
   / non-zero on failure.

A node script under `agent-orchestrator/scripts/` (e.g.,
`verify-flag-injection.js`) using `fs.writeFileSync`,
`fs.readdirSync`, and exit-code semantics would be the agent-native
equivalent. Unit 11 (orchestrator) could literally run it as a smoke
test before its first orchestrator-spawned session.

## Findings

Agent-native-reviewer (Warning AN-1) on PR #9:

> "An orchestrator agent that wants to verify hook firing has no
> in-tree script to call. Recommendation: add a node script under
> `agent-orchestrator/scripts/` (e.g., `verify-flag-injection.js`)
> that does write-flag → spawn-stub → assert-consumed → exit code,
> with the README pointing at it. Out of PR #9 scope; file as a Unit
> 11 prerequisite."

## Proposed Solutions

### Option A — Standalone node script + README pointer

Create `agent-orchestrator/scripts/verify-flag-injection.js` that:
1. Writes a `.pending-<id>` flag with known content
2. Invokes the hook (or stubs it via `runHook({ projectDir, ... })`)
3. Asserts: pending file is gone, consuming file is gone, hook
   stdout contains the expected `additionalContext`
4. Exits 0 on success, 1 with a clear message on failure.

Update `hooks/README.md` to point at it as the "Programmatic
equivalent" of the manual test.

- **Pros:** Agent-callable. Self-verifying. Cross-shell.
- **Cons:** New script to maintain.
- **Effort:** Small (~50 LOC).
- **Risk:** None.

### Option B — Just port the test into session-start.test.js

Add a node:test case that exercises the full path. Skip the standalone
script; the test runner is the smoke check.

- **Pros:** Reuses existing test infra.
- **Cons:** Less obvious as a smoke test for an external agent;
  you'd run the full suite to invoke it.
- **Effort:** Small.
- **Risk:** None.

### Option C — Defer to Unit 11 dispatch

Unit 11 will need this as a prerequisite. Bundle the work into Unit 11's
implementation rather than as a standalone follow-up.

- **Pros:** Avoids speculative tooling now.
- **Cons:** README's manual prose continues to mislead readers in the
  interim.
- **Effort:** Zero now.
- **Risk:** Low.

## Recommended Action

_(Filled during triage.)_

## Technical Details

- Affected files:
  - `agent-orchestrator/scripts/verify-flag-injection.js` (new) — Option A
  - `agent-orchestrator/hooks/README.md` (Option A pointer)
  - `agent-orchestrator/hooks/session-start.test.js` (Option B)

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: standalone script invokable by an agent or CLI; exit
  codes correctly map to pass/fail.
- [ ] If A or B: README points at the programmatic equivalent.

## Work Log

- **2026-04-28 — todo created** — Surfaced by agent-native-reviewer
  on PR #9.

## Resources

- PR #9: https://github.com/newton20/agent-orchestration/pull/9
- Manual test prose: `agent-orchestrator/hooks/README.md:60-88`
