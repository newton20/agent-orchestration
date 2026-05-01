---
status: ready
priority: p2
issue_id: "070"
tags: [code-review, unit-8, check-health, naming, clarity]
dependencies: []
---

# check-health: defaultPhaseDir(workdir, phaseId) parameter name misleading; should be manifestDir

`defaultPhaseDir(workdir, phaseId)` is named to suggest its first
argument is `manifest.workdir`, but the only in-tree caller passes
`manifestDir`. The mismatch revives precisely the mental model the
dispatch wants to retire — that protocol artifacts live under
`manifest.workdir` rather than under the manifest's directory.

## Problem Statement

`check-health.js:361-363` defines
`defaultPhaseDir(workdir, phaseId)` and exports it at line 714.
The only caller at line 462 passes `manifestDir`, NOT
`manifest.workdir`:

```js
const phaseDir = defaultPhaseDir(manifestDir, phaseId);
```

Per `docs/manifest-reference.md` §workdir, `manifest.workdir` is
the agent's working directory for git/tooling — it has nothing to
do with where the protocol scaffold lives. The protocol root is
the manifest's directory.

The test fixture at `check-health.js:1656-1661` (and likely the
unit test mirroring it) uses `'/tmp/repo'` — a workdir-shaped
value — which compounds the confusion for future readers.

This is a clarity / footgun issue, not a correctness issue today
(only one caller exists, and it passes the right value), but it
will mislead the next caller (probably Unit 11 or a recovery
agent) into passing `manifest.workdir` and silently producing the
wrong path.

## Findings

- Definition: `check-health.js:361-363`.
- Export: `check-health.js:714`.
- Sole caller: `check-health.js:462` —
  `defaultPhaseDir(manifestDir, phaseId)`.
- Test fixture: `check-health.js:1656-1661` uses workdir-shaped
  value.
- Manifest reference: `docs/manifest-reference.md` §workdir
  documents the distinction.

## Proposed Solutions

### Option A — Rename parameter to manifestDir (recommended)

Change the signature to `defaultPhaseDir(manifestDir, phaseId)`.
Update the test fixture to use a manifest-dir-shaped path
(e.g., `'/path/to/manifest-root'`). Update any JSDoc.

- **Pros:** Eliminates the footgun at the source. Aligns helper
  with documented semantics.
- **Cons:** Exported helper signature changes — but no in-tree
  caller passes a real workdir, so this is safe today.
- **Effort:** Small (rename + 1 test fixture + 1 JSDoc line).
- **Risk:** Low.

### Option B — Keep name, add JSDoc warning

Leave the parameter name and add `@param manifestDir — note:
despite the legacy name, this is the manifest directory, NOT
manifest.workdir`.

- **Pros:** Trivial.
- **Cons:** Smell remains. JSDoc warnings get ignored.
- **Effort:** Trivial.
- **Risk:** Low — but doesn't actually fix the footgun.

## Recommended Action

**Option A — approved 2026-04-29 by coord.** Rename
`defaultPhaseDir(workdir, phaseId)` → `defaultPhaseDir(manifestDir,
phaseId)` and update the JSDoc to explicitly state that protocol
artifacts live under the manifest's directory (per Unit 3's
scaffold-protocol convention), NOT under `manifest.workdir` (which
is the spawned session's cwd, a different concept).

Update the in-tree caller signature accordingly. The export shape
changes only in parameter naming; behavior unchanged.

Option B (keep name + JSDoc warning) preserves the misleading
mental model in the public API.

Dispatch as part of the **pre-Unit-11 hardening PR bundle**.

## Technical Details

- Affected file: `agent-orchestrator/scripts/check-health.js`
- Function: `defaultPhaseDir` (lines 361-363).
- Export: line 714.
- Caller: line 462.
- Test fixture: lines 1656-1661.

## Acceptance Criteria

- [ ] Function signature reads `defaultPhaseDir(manifestDir,
      phaseId)`.
- [ ] Test fixture uses a manifest-dir-shaped value (not
      `'/tmp/repo'`).
- [ ] JSDoc clarifies the parameter is the manifest's directory,
      not `manifest.workdir`.
- [ ] All existing tests pass without semantic changes.

## Work Log

_(empty)_

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: feat/unit-8-health-checker @ 285085b
- Affected files:
  - `agent-orchestrator/scripts/check-health.js`
  - `agent-orchestrator/scripts/check-health.test.js`
- Manifest reference: `docs/manifest-reference.md` §workdir
