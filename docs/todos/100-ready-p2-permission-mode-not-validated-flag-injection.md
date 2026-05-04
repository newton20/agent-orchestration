---
status: ready
priority: p2
issue_id: "100"
tags: [unit-11, orchestrate, post-pr-19, ce-review, security, permission-mode, flag-injection, manifest-validation]
dependencies: []
---

# orchestrate: manifest.defaults.permission_mode not validated — whitespace allows flag injection into the inner Claude command line

## Problem Statement

In the manifest validation path (`agent-orchestrator/scripts/orchestrate.js`, validate flow), `manifest.defaults.permission_mode` is read and forwarded to the spawn command without an enum / whitespace check. A manifest with `permission_mode: "acceptEdits --dangerously-skip-permissions"` (or with embedded whitespace and additional flags) would inject those tokens into the inner Claude command line at spawn time, granting privileges the operator never approved.

## Findings

- `manifest.defaults.permission_mode` not validated; whitespace allows flag injection into the inner Claude command line.
- /ce:review reviewer attribution: security.

## Proposed Solutions

### Option A — Enum validation in parse-manifest.validateLauncher (recommended)
- Validate `permission_mode` against the documented enum: `['plan', 'default', 'acceptEdits', 'bypassPermissions']`. Reject any other value (including ones with embedded whitespace or flags).
- Pros: enum is the right primitive; operators don't need arbitrary strings; matches Claude Code's actual permission_mode contract. Effort: small. Risk: low.

### Option B — Whitespace + metacharacter strip
- Strip whitespace; reject `--`, `;`, `|`, etc. Accept any other string.
- Cons: weaker than enum; future Claude Code permission_mode renames would silently accept stale values.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** Enum validation in `parse-manifest.validateLauncher` (or wherever permission_mode flows through validation). Hoist the enum constant alongside `VALID_ROLES` for cross-module access. Bundle in PR #23 cleanup wave.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js` (validate path)

## Acceptance Criteria

- [ ] `permission_mode: "acceptEdits"` accepted.
- [ ] `permission_mode: "acceptEdits --dangerously-skip-permissions"` rejected with clear error.
- [ ] `permission_mode: ""` rejected.
- [ ] `permission_mode: "unknownValue"` rejected (enum mismatch).
- [ ] Enum exported from parse-manifest for cross-module use.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
