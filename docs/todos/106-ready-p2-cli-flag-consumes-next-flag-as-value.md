---
status: ready
priority: p2
issue_id: "106"
tags: [unit-11, orchestrate, post-pr-19, ce-review, cli-readiness, flag-parsing]
dependencies: []
---

# orchestrate: --plugin-dir / --project-name silently consume next -prefixed flag as their value

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:3092-3098, 3132-3137`, the CLI flag parser for `--plugin-dir` and `--project-name` greedily consumes the next argv token as the flag value with no sanity check. Invocations like `--plugin-dir --resume foo.yaml` parse `pluginDir = '--resume'` and silently drop `--resume` (which the operator clearly intended as a separate flag). The user has no signal that a flag was lost.

## Findings

- `--plugin-dir` / `--project-name` silently consume next `-`-prefixed flag as their value; e.g., `--plugin-dir --resume foo.yaml` parses `pluginDir = '--resume'` and silently drops `--resume`.
- /ce:review reviewer attribution: cli-readiness.

## Proposed Solutions

### Option A — Reject `-`-prefixed values for these flags (recommended)
- For flags with required string arg (`--plugin-dir`, `--project-name`), if the next argv token starts with `-`, error out with a clear message: `--plugin-dir requires a path; got '--resume' (looks like another flag — use --plugin-dir=<path> for paths starting with -)`.
- Pros: simple; catches the canonical foot-gun. Effort: small. Risk: low.

### Option B — Warn but accept
- Same parse, but log a warning when next token starts with `-`.
- Cons: ambiguous semantics; user may not see the warning.

## Recommended Action

**Option A — approved 2026-05-04 by coord.** Hard reject. Operators using genuinely-`-`-prefixed paths can use the `--flag=value` form. Bundle in PR #23 cleanup wave; symmetric across `--plugin-dir` and `--project-name`.

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:3092-3098, 3132-3137`

## Acceptance Criteria

- [ ] `--plugin-dir foo --resume bar.yaml` → `pluginDir=foo`, `resume=true` (existing happy path preserved).
- [ ] `--plugin-dir --resume bar.yaml` → error: missing value for `--plugin-dir`; exit code 1; clear error message naming the offending token.
- [ ] `--plugin-dir=--special-path --resume bar.yaml` → `pluginDir=--special-path`, `resume=true` (escape hatch via `=`).
- [ ] Symmetric for `--project-name`.

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
