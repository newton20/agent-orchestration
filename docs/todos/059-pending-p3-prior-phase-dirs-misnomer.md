---
status: pending
priority: p3
issue_id: "059"
tags: [code-review, post-pr-13, ce-review, templates, agent-native, naming]
dependencies: []
---

# `prior_phase_dirs` is a misnomer — it carries signal file paths, not directories

PR #13 ce:review's agent-native-reviewer flagged that the variable
name `prior_phase_dirs` no longer matches its content. The block
carries newline-joined **completion-signal file paths**, not
directories. Today's template prose at protocol-header.md:38
clarifies this for the agent ("Each path above points at an upstream
phase's completion signal"), but the variable name itself misleads
any future template author who renames the block.

## Problem Statement

`agent-orchestrator/templates/protocol-header.md:36` renders:

```
- **Prior phase outputs you may read (one per line; empty if this phase has no upstream dependencies):**

{{prior_phase_dirs}}

Each path above points at an upstream phase's completion signal. Read
them before starting work.
```

The variable name says "dirs," the prose says "completion signal,"
and the upstream populator (Unit 11's `priorPhaseSignals` →
`generate-prompt.js:553-563`) joins **file paths** with `\n`. A
future author scanning only the variable name could mistakenly
switch the populator from signal paths to directory paths,
silently breaking downstream agent expectations.

## Findings

PR #13 ce:review agent-native-reviewer P3:

> "`templates/protocol-header.md:36` calls the block
> `prior_phase_dirs` but the content is signal file paths joined
> with `\n`. The prose at line 38 ('Each path above points at an
> upstream phase's completion signal') saves the agent. The naming
> only misleads future template authors. Either rename to
> `prior_phase_signals` (lockstep with templates/README.md catalog
> and generate-prompt.js) or pin the semantics in the README
> catalog entry so a renamer hits the constraint."

## Proposed Solutions

### Option A — Rename to `prior_phase_signals` (lockstep edit)

Rename the variable across three loci:

1. `agent-orchestrator/templates/protocol-header.md:36` —
   `{{prior_phase_dirs}}` → `{{prior_phase_signals}}`.
2. `agent-orchestrator/templates/README.md:144` — catalog entry
   key + description.
3. `agent-orchestrator/scripts/generate-prompt.js:553-563` —
   variable assignment + populator block.

- **Pros:** Variable name now matches content. Future authors
  cannot accidentally switch to directories without also touching
  the populator.
- **Cons:** Lockstep edit across three files; touches a public-ish
  template variable name (anyone consuming the rendered protocol
  header for parsing would notice if they grep). Risk of missing a
  reference.
- **Effort:** Small (~15 min, three coordinated edits).
- **Risk:** Low (mechanical rename + test run).

### Option B — Document the semantics; keep the name

Update only `agent-orchestrator/templates/README.md:144` catalog
entry to explicitly state: "The block contains absolute paths to
upstream phases' completion-signal files (one per line). Despite
the `_dirs` suffix, this is paths to files, not directories."

- **Pros:** Single-file edit. No churn to template variable name.
  Backward-compatible with any external consumer parsing the
  rendered output.
- **Cons:** The misleading name persists. Documentation-as-fence
  loses to a confused refactorer who skips the README.
- **Effort:** Trivial.
- **Risk:** None.

### Option C — Defer

Per V1-freeze, leave it. Agent-native-reviewer's verdict was P3
("minor friction").

- **Pros:** Zero churn.
- **Cons:** Misnomer ages into the codebase.
- **Effort:** Zero.
- **Risk:** None.

## Recommended Action

Coord triage pending. Recommend Option A for the post-Unit-7 doc
cleanup PR.

## Technical Details

- Affected files (Option A):
  - `agent-orchestrator/templates/protocol-header.md:36`
  - `agent-orchestrator/templates/README.md:144`
  - `agent-orchestrator/scripts/generate-prompt.js:553-563`
- Tests: `generate-prompt.test.js` likely references the variable
  name in fixtures; sweep + update.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: variable renamed lockstep across three files; tests
  green.
- [ ] If A: rendered protocol-header.md output for a phase with
  signals matches the new variable name.
- [ ] If B: README catalog entry documents the file-not-dir
  semantics.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (agent-native-reviewer P3). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/templates/protocol-header.md:36`
- `agent-orchestrator/templates/README.md:144`
- `agent-orchestrator/scripts/generate-prompt.js:553-563`
- Unit 11 plan: introduces `priorPhaseSignals` populator.
