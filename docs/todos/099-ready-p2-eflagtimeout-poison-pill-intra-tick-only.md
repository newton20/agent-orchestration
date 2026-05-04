---
status: ready
priority: p2
issue_id: "099"
tags: [unit-11, orchestrate, post-pr-19, ce-review, reliability, security, eflagtimeout, flag-consume, cross-tick]
dependencies: []
---

# orchestrate: EFLAGTIMEOUT poison-pill is intra-tick only — orphan slow tab can consume next tick's flag (cross-tick wrong-prompt-to-wrong-agent)

## Problem Statement

At `agent-orchestrator/scripts/orchestrate.js` (flag-consume + EFLAGTIMEOUT throw site, around `:2740-2796`; the source /ce:review doc cited `:2456` but the actual current site is `:2786` for the unlink call and `:2792` for the throw), the EFLAGTIMEOUT handling treats the poison-pill semantic as intra-tick only. If a slow tab is orphaned (the orchestrator gives up waiting on flag-consume within a tick), the tab is still alive and can consume the *next* tick's flag for an unrelated phase/role, delivering the wrong prompt to the wrong agent across tick boundaries. Both reliability and security reviewers flagged this from independent angles.

## Findings

- EFLAGTIMEOUT poison-pill is intra-tick only — orphan slow tab can consume next tick's flag (cross-tick wrong-prompt-to-wrong-agent).
- **Already in main (codex round 8 P1):** the EFLAGTIMEOUT path at `orchestrate.js:2786` already calls `bestEffortUnlink(unlinkSync, flagPath)` before throwing. So the intra-tick "delete the stale flag" mitigation is in place. The cross-tick gap remains: a slow tab whose hook fires AFTER the next tick has written a fresh `.pending-<name>` will consume that fresh flag (same session name, different prompt content), delivering wrong prompt to wrong agent.
- /ce:review reviewer attribution: reliability + security.

## Proposed Solutions

### Option A — Delete the `.pending-*` flag on EFLAGTIMEOUT (already in main; not the new work)
- On EFLAGTIMEOUT, immediately unlink the `.pending-<name>` flag. Already implemented at `orchestrate.js:2786` (codex round 8 P1).
- Pros: fits the file-protocol model. Cons: **does NOT close the cross-tick case** — orphan tab whose hook fires after the next tick writes a fresh flag still consumes it. Listed here for completeness; the actual fix is Option B (or equivalent).

### Option B — Out-of-band token binding OR session-name rotation (recommended)

Two viable variants; choose at implementation time based on minimal disruption to existing surface (per todos 037, 081 institutional context).

**B1: Out-of-band token binding.** Orchestrator generates a per-spawn token (UUID) and passes it to the spawned tab via an out-of-band channel — argv (`--expected-flag-token <uuid>`), env var (`AGENT_FLAG_TOKEN`), or a per-tab manifest entry. The token is also written into the `.pending-<name>` flag content. The SessionStart hook reads the file's token AND the out-of-band token (from argv/env), and refuses to deliver the prompt unless they match. An orphan tab carries the token from its original (now timed-out) spawn; when it eventually fires and grabs whatever fresh `.pending-<name>` exists, the file-token will be the orchestrator's NEW per-spawn token while the tab's argv/env token is still the OLD one — mismatch detected, prompt refused. **Critical:** comparing tokens read only from the flag file is NOT sufficient — the hook would just read the fresh-tick token and accept it. The token must be bound to the spawned tab out-of-band so it cannot be replaced by reading a different file.

**B2: Session-name rotation.** Rotate the session-name suffix on each spawn-after-EFLAGTIMEOUT for that (phase, role) (e.g., append `-r1`, `-r2`, etc. on each retry). Orphan tab's hook looks for `.pending-<old-name>` and never finds one because the name diverged. Trade-off: breaks session-name determinism within a (phase, role); operator-visible debug paths (`tasklist`, `Get-Process`) need to track the rotated name.

**Pros (both):** close the cross-tick wrong-prompt-to-wrong-agent class definitively; defensive against any future "slow start" causes.
**Cons (both):** cross-module — needs SessionStart hook coordination (B1 reads argv/env in addition to the file; B2 changes name-derivation in spawn-session).

## Recommended Action

**Option B — revised 2026-05-04 post-codex rounds 1+5.** Coord's original choice of Option A is already implemented in main (codex round 8 P1, `orchestrate.js:2786`); the original RA describes work that is not new. The actual cross-tick fix needs the redesigned **Option B** with two viable variants:

- **B1 (out-of-band token binding)** — token must reach the spawned tab via argv/env (NOT just via the flag file), so the hook can compare the file-token to the tab-bound token before delivering. A token-only-in-file design does NOT close the bug because the hook would accept whatever token the fresh next-tick flag carries.
- **B2 (session-name rotation)** — simpler; trade-off is loss of name-determinism per (phase, role).

Implementer's first task in PR #23 is to choose between B1 and B2 based on which is least disruptive to the SessionStart hook surface (per todos 037, 081). Bundle in PR #23 cleanup wave; coordinate with 111 on the EFLAGTIMEOUT call site (the EFLAGTIMEOUT throw still triggers 111's spawning-marker rollback — that part of the bundling remains correct).

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:2740-2796` (flag-consume busy-wait + EFLAGTIMEOUT throw). The source doc's cite of `:2456` is stale; the actual unlink call is at `:2786` and the throw is at `:2792`.

## Acceptance Criteria

- [ ] Existing intra-tick mitigation preserved: EFLAGTIMEOUT path at `orchestrate.js:2786` still calls `bestEffortUnlink` before throwing.
- [ ] Cross-tick fix landed: orphan slow tab whose hook fires AFTER a next-tick fresh flag exists for the SAME session name does NOT consume that fresh flag. Verified via either:
  - **B1: out-of-band token binding** — hook reads the file-token AND the tab-bound token (from argv/env/per-tab manifest). Refuses to deliver unless both match. A test must specifically cover the orphan-grabs-fresh-flag case: orphan's argv-token is OLD, fresh flag's file-token is NEW, mismatch → prompt refused.
  - **B2: session-name rotation** — orphan tab's hook looks up `.pending-<original-name>` and finds nothing because the orchestrator wrote `.pending-<rotated-name>` for the retry.
- [ ] Test: simulate EFLAGTIMEOUT, then write a fresh `.pending-<same-name>` for an unrelated phase/role/iteration, then trigger the orphan tab's hook → orphan does NOT receive the unrelated prompt.
- [ ] Cross-tick wrong-prompt-to-wrong-agent eliminated end-to-end (not just the same-tick case).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
