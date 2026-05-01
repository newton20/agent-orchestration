---
status: ready
priority: p2
issue_id: "076"
tags: [code-review, unit-8, check-health, cli, documentation, agent-native]
dependencies: []
---

# check-health: --help does not describe JSON output schema or pidAlive tri-state

`--help` lists input flags and exit codes but says nothing about
the output JSON schema. An agent or operator running `--help`
learns nothing about: (a) stdout is JSON, (b) `pidAlive` is
true | false | null with null meaning "couldn't decide, do not
trigger recovery," (c) other field names and types. Forces every
consumer to read 722 lines of source.

## Problem Statement

`check-health.js:638-653` (`printHelp`) is the help-text printer.
Today it documents:

- Flags: `--manifest`, `--phase`, `--role`, `--json`.
- Exit codes.

It does NOT document:

- Stdout is JSON (in `--json` mode).
- The output object shape: `pidAlive`, `timedOut`, `heartbeatAge`,
  `lastCheckpoint`, `phaseDir`, `error`, etc.
- `pidAlive` is tri-state (true / false / null); null means
  "couldn't decide; do not trigger recovery."
- `heartbeatAge` is in seconds (verify) and may be null.
- `error` may be present alongside meaningful diagnostics
  (mid-flight) or alongside sentinel values (pre-flight) — see
  todo #072.

Agent-native principle: machine-readable help should be sufficient
for an agent to consume the tool without source-diving.

## Findings

- Help printer: `check-health.js:638-653`.
- Result shape: `check-health.js:624-633` (constructed) plus
  `:419-426` (baseResult fields).
- Test file: `check-health.test.js` — no assertion on help-text
  schema mention.

## Proposed Solutions

### Option A — Extend printHelp with output schema section (recommended)

Add an "OUTPUT" section listing each field, type, and tri-state
semantics. Add a worked example block. Cross-reference any new
fields added by companion todos (`pidAliveReason` from #071,
`errorKind` from #072, `schema_version` from #075).

- **Pros:** Single source of truth for consumers. Lets an agent
  consume `check-health` purely from `--help`.
- **Cons:** Help-text grows; needs updating on every shape change.
- **Effort:** Small (~30 lines of help text + 1 test asserting
  key fields are mentioned).
- **Risk:** Low.

### Option B — Reference a separate doc

Add `agent-orchestrator/docs/check-health.md` and reference it in
help.

- **Pros:** Help stays compact. Doc can be deeper.
- **Cons:** Separate doc is more likely to drift; agents prefer
  inline help. Two places to keep in sync.
- **Effort:** Small.
- **Risk:** Low — but adds maintenance burden.

### Option C — Defer

Document the JSON schema only in JSDoc comments inside the source
file.

- **Pros:** Zero churn for the CLI surface.
- **Cons:** Doesn't help agent / operator consumption from
  `--help`.
- **Effort:** Trivial.
- **Risk:** Medium.

## Recommended Action

**Option A — approved 2026-04-29 by coord.** Extend `printHelp`
with an "Output schema" section documenting:
- stdout is JSON, single object
- All fields with type + meaning: `schema_version`, `alive`,
  `pidAlive` (true | false | null with each null-reason),
  `pidAliveReason` (when null), `timedOut`, `heartbeatAge`,
  `heartbeatStale`, `heartbeatCorrupt` (per todo 083),
  `lastCheckpoint`, `error` (when fatal), `errorKind` (per todo
  072)
- Exit code semantics: 0 = check completed (alive/dead carried
  in JSON), 1 = validation/config error

Bundle with todos 071, 072, 075, 083 as a coherent V1 schema
definition. The --help text is the agent-facing contract for the
JSON output; it should match the schema_version: 1 spec exactly.

Option B (separate doc) makes the help text incomplete in the
field where it's first read. Option C (defer) leaves operators
reading source.

Dispatch as part of the **pre-Unit-11 hardening PR bundle**.

## Technical Details

- Affected file: `agent-orchestrator/scripts/check-health.js`
- Site: `:638-653` (`printHelp`).
- Test file: `agent-orchestrator/scripts/check-health.test.js`
- Companion todos: #071 (pidAliveReason), #072 (errorKind),
  #074 (CLI flags), #075 (schema_version).

## Acceptance Criteria

- [ ] `--help` includes an OUTPUT section.
- [ ] `pidAlive`'s tri-state is explained, including the policy
      "null means do not trigger recovery on its own."
- [ ] Each output field is listed with type.
- [ ] A worked example block shows a real JSON output.
- [ ] One test asserts the help text mentions `pidAlive`,
      `heartbeatAge`, and the tri-state semantics.

## Work Log

_(empty)_

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: feat/unit-8-health-checker @ 285085b
- Affected files:
  - `agent-orchestrator/scripts/check-health.js`
  - `agent-orchestrator/scripts/check-health.test.js`
