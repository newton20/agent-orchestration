---
status: ready
priority: p2
issue_id: "072"
tags: [code-review, unit-8, check-health, api-contract, error-handling, unit-11-prep]
dependencies: []
---

# check-health: error field overloads "fatal config" with "live diagnostic"

The `error` string field is set in two semantically different
cases — pre-flight config failures (manifest not found, invalid
YAML, phase id absent) and mid-flight diagnostics (phase directory
missing). Unit 11 must decide policy from one field, but the two
cases need opposite policies. Today disambiguation requires
inspecting error STRING content (regex against future-drifting
messages) — leaky abstraction.

## Problem Statement

`check-health.js:432-446` and `:611-633` both populate `error`,
but their meanings diverge:

**Case A: Pre-flight config failure** (`:432-446`)
- Manifest not found, manifest invalid YAML, phase id absent.
- All other fields default null/false.
- Unit 11 should pause and surface to operator.

**Case B: Mid-flight diagnostic** (`:611-633`)
- Phase directory missing on disk.
- `pidAlive`, `timedOut`, `heartbeatAge` are still meaningfully
  populated.
- Unit 11 should treat as "session crashed mid-run, scaffold lost"
  and trigger recovery flow.

A polling loop that does
`if (result.error) { stopPolling(); }`
will tear down a transient git-checkout move (case B). A loop that
does
`if (result.error) { logAndContinue(); }`
will silently log a missing manifest forever (case A).

Distinguishing today requires regex against the error string
contents. Future error message rewording silently breaks Unit 11's
matcher.

## Findings

- Case A site: `check-health.js:432-446`.
- Case B site: `check-health.js:611-633`.
- The shape of `result` differs between the two cases — in case A
  most fields are sentinel (null / false), in case B they are
  meaningful.
- Unit 11 spec (per dispatch): policy must differ between the two
  cases, but no discriminator is provided at the API boundary.

## Proposed Solutions

### Option A — Add errorKind discriminator (recommended)

Two viable shapes:

1. Replace `error` (string) with
   `error: { kind: 'config' | 'transient', message: string } |
   null`.
2. Keep `error` (string) AND add `errorKind: 'config' |
   'transient' | null`.

Either approach makes the policy decision crisp at the API
boundary. `kind: 'config'` → pause + surface. `kind: 'transient'`
→ count toward recovery heuristic but keep polling. Variant 2 is
backward-compatible with any existing string consumer; variant 1
is cleaner. Pick at triage.

- **Pros:** Crisp. Stable across error-message rewording. Easy to
  extend (`'permission'`, `'fs-race'`, etc.).
- **Cons:** Tiny shape addition.
- **Effort:** Small (~15 lines + 2 tests).
- **Risk:** Low.

### Option B — Document the substring tags Unit 11 should match

Stabilize the error-message wording and document the substrings
Unit 11 may rely on (e.g., "manifest not found", "phase id absent",
"phase directory missing").

- **Pros:** Trivial.
- **Cons:** Doc-only; future error-message tightening will silently
  break the contract. Substring matching across modules is the
  canonical "leaky abstraction" anti-pattern.
- **Effort:** Trivial.
- **Risk:** Medium — drift over time.

## Recommended Action

**Option A — approved 2026-04-29 by coord.** Add an `errorKind`
discriminator to `checkHealth`'s return value when `error` is set.
Values:
- `'config'` — pre-flight config failure (manifest not found,
  invalid YAML, phase id absent in manifest). Unit 11 should not
  retry; the caller's config is broken.
- `'runtime'` — mid-flight diagnostic (phase directory missing
  but config valid; transient FS error). Unit 11 may retry or
  treat as not-yet-spawned.

Eliminates substring-matching against drifting message strings.
The `error` field stays as the human-readable detail; `errorKind`
becomes the machine-parseable policy switch.

Bundle the schema-doc update with todo 075 (schema_version) + 076
(--help) for a single coherent JSON-output story.

Dispatch as part of the **pre-Unit-11 hardening PR bundle**.

## Technical Details

- Affected file: `agent-orchestrator/scripts/check-health.js`
- Sites:
  - `:432-446` (config errors)
  - `:611-633` (phase-dir-missing diagnostic)
- Result shape: `:419-426` (baseResult).
- Test file: `agent-orchestrator/scripts/check-health.test.js`
- Companion: must be documented in `--help` (see todo #076).
- Companion: bumps the JSON `schema_version` when adopted (see
  todo #075).

## Acceptance Criteria

- [ ] When manifest is missing / invalid / phase absent,
      `errorKind === 'config'` (or equivalent shape).
- [ ] When phase directory is missing on disk,
      `errorKind === 'transient'` and `pidAlive`, `timedOut`,
      `heartbeatAge` are populated as today.
- [ ] One test per case.
- [ ] Existing error-message tests pass with adjusted assertions.

## Work Log

_(empty)_

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: feat/unit-8-health-checker @ 285085b
- Affected files:
  - `agent-orchestrator/scripts/check-health.js`
  - `agent-orchestrator/scripts/check-health.test.js`
