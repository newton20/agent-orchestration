---
status: pending
priority: p3
issue_id: "080"
tags: [code-review, unit-8, check-health, security, defense-in-depth]
dependencies: []
---

# opts.phaseDir accepts arbitrary paths with no scope check (defense-in-depth)

## Problem Statement

The `phaseDir` opt to `checkHealth` is `path.resolve()`'d and used verbatim for `readdirSync` + `readFileSync(path.join(phaseDir, 'heartbeat.jsonl'), 'utf8')`. There is no verification that the resolved path lives under the manifest directory.

Verified: passing `phaseDir: 'C:\\Windows\\System32'` causes `findLastCheckpoint` to scan it and `lastCheckpoint` returns a real System32 filename. The dispatch declares this opt-in caller-trusted, and Unit 11 owns the call site. Concern: the `checkHealth` symbol is exported and re-used by future callers (any future MCP/web surface), and a single careless caller forwarding an HTTP-facing field straight in is a real exposure.

## Findings

1. **phaseDir is resolved but not bounded** — any absolute path passes.
2. **Reachable side effects** — `readdirSync` and `readFileSync` operate on the unsanitized path; lastCheckpoint will reflect arbitrary file listings.
3. **Public-symbol risk** — `checkHealth` is exported; future MCP/HTTP callers may forward request fields.

## Proposed Solutions

### Option A — Assert `path.resolve(phaseDir)` starts with `path.resolve(manifestDir)` (with separator boundary)

Throw `'phaseDir outside manifest tree'` otherwise. Tests can pass an explicit override flag (e.g., `_unsafePhaseDir: true`) to bypass for the existing test suite.

- **Pros**: Closes the exposure for future callers; matches existing project hardening intent.
- **Cons**: One existing test uses `customPhaseDir` under tmp; needs the bypass flag.
- **Effort**: Small.
- **Risk**: Low.

## Recommended Action

_Pending triage._

## Technical Details

**Affected file:** `agent-orchestrator/scripts/check-health.js:459-462`

Use a separator-aware prefix check (e.g., resolved + `path.sep`) to avoid `/x/manifest-evil` matching `/x/manifest`.

Coord-pre-acked deviations: `process.kill(pid, 0)` over tasklist; `status.pid` ignored; `manifest.workdir` not used for protocol root.

## Acceptance Criteria

- [ ] `checkHealth` throws when `phaseDir` resolves outside the manifest tree.
- [ ] An `_unsafePhaseDir` (or equivalent) bypass flag exists for tests; documented in JSDoc.
- [ ] Tests cover both rejection of an out-of-tree path and bypass when explicitly opted in.

## Work Log

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: `feat/unit-8-health-checker` @ `285085b`
- `agent-orchestrator/scripts/check-health.js`
- `agent-orchestrator/scripts/check-health.test.js`
