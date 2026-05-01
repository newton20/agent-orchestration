---
status: pending
priority: p3
issue_id: "079"
tags: [code-review, unit-8, parse-manifest, security, defense-in-depth]
dependencies: []
---

# phaseId regex allows '..', '.', '...' (defense-in-depth gap)

## Problem Statement

`VALID_ID_RE = /^[A-Za-z0-9._-]+$/` in parse-manifest.js matches the strings `'.'`, `'..'`, and `'...'`. `UNSAFE_ID_KEYS` rejects only `__proto__`, `prototype`, `constructor`. With `phaseId = '..'`, `defaultPhaseDir(manifestDir, '..')` produces `<manifestDir>/docs/orchestration/phases/..` which `path.join` normalizes to `<manifestDir>/docs/orchestration` — a sibling directory containing other phases.

Verified: `defaultPhaseDir('/x', '..')` → `/x/docs/orchestration`. Practical exploit requires an attacker-controlled manifest declaring `id: '..'` (the lookup is `.find(p => p.id === phaseId)`, so it matters only if a manifest phase carries that id). The dispatch's "manifest is trusted" stance largely covers this; flagging because (a) one-line fix, (b) existing UNSAFE_ID_KEYS guard signals project intent to harden, (c) worth fixing in parse-manifest itself so every consumer benefits.

## Findings

1. **VALID_ID_RE matches dot-only strings** — `.`, `..`, `...` all pass the validator.
2. **UNSAFE_ID_KEYS does not block dot segments** — only prototype-pollution keys are rejected.
3. **defaultPhaseDir composes with path.join** — `..` segments are normalized away, escaping the intended phase directory.
4. **Single-line fix at the right layer** — fixing in parse-manifest.js benefits every consumer of phase ids, not just check-health.

## Proposed Solutions

### Option A — Extend UNSAFE_ID_KEYS in parse-manifest to include '.', '..', '...'

Or add `/^\.+$/.test(phaseId)` check. Apply at validate-time (parse-manifest) and as defensive guard in `checkHealth`.

- **Pros**: Centralized fix; every downstream consumer inherits the guard; tiny diff.
- **Cons**: None material.
- **Effort**: Small.
- **Risk**: Low.

## Recommended Action

_Pending triage._

## Technical Details

**Affected files:**
- `agent-orchestrator/scripts/check-health.js:395` (validation)
- `agent-orchestrator/scripts/parse-manifest.js:82-83` (`VALID_ID_RE` / `UNSAFE_ID_KEYS`)

Coord-pre-acked deviations: `process.kill(pid, 0)` over tasklist; `status.pid` ignored; `manifest.workdir` not used for protocol root.

## Acceptance Criteria

- [ ] `parse-manifest.js` rejects phase/role ids matching `/^\.+$/` at validate-time.
- [ ] `checkHealth` retains a defensive guard that rejects dot-only ids.
- [ ] Tests cover `id: '.'`, `id: '..'`, `id: '...'` and verify rejection.

## Work Log

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: `feat/unit-8-health-checker` @ `285085b`
- `agent-orchestrator/scripts/check-health.js`
- `agent-orchestrator/scripts/parse-manifest.js`
