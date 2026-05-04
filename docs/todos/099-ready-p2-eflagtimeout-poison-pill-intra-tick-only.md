---
status: ready
priority: p2
issue_id: "099"
tags: [unit-11, orchestrate, post-pr-19, ce-review, reliability, security, eflagtimeout, flag-consume, cross-tick]
dependencies: []
---

# orchestrate: EFLAGTIMEOUT poison-pill is intra-tick only — orphan slow tab can consume next tick's flag (cross-tick wrong-prompt-to-wrong-agent)

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js:2456`, the EFLAGTIMEOUT handling treats the poison-pill semantic as intra-tick only. If a slow tab is orphaned (the orchestrator gives up waiting on flag-consume within a tick), the tab is still alive and can consume the *next* tick's flag for an unrelated phase/role, delivering the wrong prompt to the wrong agent across tick boundaries. Both reliability and security reviewers flagged this from independent angles.

## Findings

- EFLAGTIMEOUT poison-pill is intra-tick only — orphan slow tab can consume next tick's flag (cross-tick wrong-prompt-to-wrong-agent).
- **Already in main (codex round 8 P1):** the EFLAGTIMEOUT path at `orchestrate.js:2786` already calls `bestEffortUnlink(unlinkSync, flagPath)` before throwing. So the intra-tick "delete the stale flag" mitigation is in place. The cross-tick gap remains: a slow tab whose hook fires AFTER the next tick has written a fresh `.pending-<name>` will consume that fresh flag (same session name, different prompt content), delivering wrong prompt to wrong agent.
- /ce:review reviewer attribution: reliability + security.

## Proposed Solutions

### Option A — Delete the `.pending-*` flag on EFLAGTIMEOUT (already in main; not the new work)
- On EFLAGTIMEOUT, immediately unlink the `.pending-<name>` flag. Already implemented at `orchestrate.js:2786` (codex round 8 P1).
- Pros: fits the file-protocol model. Cons: **does NOT close the cross-tick case** — orphan tab whose hook fires after the next tick writes a fresh flag still consumes it. Listed here for completeness; the actual fix is Option B (or equivalent).

### Option B — Sidecar consumption metadata + per-spawn token in flag content (recommended)
- Persist a per-spawn token in the `.pending-<name>` flag content (e.g., a UUID). The SessionStart hook reads the token at consume time and passes it to the orchestrator via the consume-side response (or the hook's existing `.consuming-<id>-<pid>-<ms>-<i>` sidecar prefix). On the orchestrator side, track the latest issued token per session-name; if the consume-side response carries a stale token (from a timed-out spawn whose orphan tab eventually fired), reject the consumption (the hook can refuse to deliver the prompt; orchestrator re-issues with a fresh token).
- Alternatively (simpler): rotate the session-name suffix on each spawn-after-EFLAGTIMEOUT for that (phase, role). Orphan tab's hook never matches a fresh flag because the name diverged. Trade-off: breaks session-name determinism within a (phase, role).
- Pros: closes the cross-tick wrong-prompt-to-wrong-agent class definitively; defensive against any future "slow start" causes.
- Cons: more file-protocol surface (token tracking) OR mild loss of session-name determinism (rotation). Cross-module work — needs SessionStart hook coordination.

## Recommended Action

**Option B — revised 2026-05-04 post-codex round 1.** Coord's original choice of Option A is already implemented in main (codex round 8 P1, `orchestrate.js:2786`); the original RA describes work that is not new. The actual cross-tick fix needs the per-spawn token (or session-name rotation) in Option B. Implementer's first task in PR #23 is to choose between the two Option B variants based on which is least disruptive to the existing SessionStart hook surface (per todos 037, 081 institutional context). Bundle in PR #23 cleanup wave; coordinate with 111 on the EFLAGTIMEOUT call site (the EFLAGTIMEOUT throw still triggers 111's spawning-marker rollback — that part of the bundling remains correct).

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:2456`

## Acceptance Criteria

- [ ] Existing intra-tick mitigation preserved: EFLAGTIMEOUT path at `orchestrate.js:2786` still calls `bestEffortUnlink` before throwing.
- [ ] Cross-tick fix landed: orphan slow tab whose hook fires AFTER a next-tick fresh flag exists for the SAME session name does NOT consume that fresh flag. Verified via either:
  - per-spawn token mismatch (hook reads token from flag content, refuses to deliver if token does not match the orchestrator's latest issued token), OR
  - session-name rotation (orphan tab's hook never finds a matching `.pending-<rotated-name>`).
- [ ] Test: simulate EFLAGTIMEOUT, then write a fresh `.pending-<same-name>` for an unrelated phase/role/iteration, then trigger the orphan tab's hook → orphan does NOT receive the unrelated prompt.
- [ ] Cross-tick wrong-prompt-to-wrong-agent eliminated end-to-end (not just the same-tick case).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
