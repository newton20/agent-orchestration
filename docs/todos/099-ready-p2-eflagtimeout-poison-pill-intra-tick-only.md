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

### Option B — Out-of-band token binding (recommended; only viable variant)

**The Unit 5 SessionStart hook iterates ALL fresh `.pending-*` candidates regardless of session name** (per the bounded-readdir design); it does NOT filter by tab/session name. So variants that rely solely on the orchestrator changing the on-disk filename (e.g., session-name rotation `.pending-orch-<phase>-<role>-r1`) do NOT close the bug — the orphan tab's hook would still find and consume the rotated retry flag because the hook doesn't filter by name.

The cross-tick fix REQUIRES out-of-band token binding:

- **Orchestrator generates a per-spawn token (UUID)** and passes it to the spawned tab via an out-of-band channel — argv (`--expected-flag-token <uuid>`), env var (`AGENT_FLAG_TOKEN`), or a per-tab manifest entry. The token is also written into the `.pending-<name>` flag content (or a sidecar metadata file).
- **The SessionStart hook reads the file's token AND the out-of-band tab-bound token**, and refuses to deliver the prompt unless they match.
- An orphan tab carries the token from its original (now timed-out) spawn. When the hook fires and grabs whatever fresh `.pending-*` exists, the file-token is the orchestrator's NEW per-spawn token while the tab's argv/env token is still the OLD one → mismatch → prompt refused.

**Critical:** comparing tokens read only from the flag file is NOT sufficient — the hook would just read the fresh-tick token and accept it (the bug). The token must be bound to the spawned tab out-of-band so it cannot be replaced by reading a different file.

**Pros:** closes the cross-tick wrong-prompt-to-wrong-agent class definitively; defensive against any future "slow start" cause; doesn't require breaking session-name determinism.
**Cons:** cross-module — needs SessionStart hook coordination (hook reads argv/env in addition to the flag file). Requires a new hook-side schema bump for the token-comparison step.

## Recommended Action

**Option B — revised 2026-05-04 post-codex rounds 1+5+7.** Coord's original choice of Option A is already implemented in main (codex round 8 P1, `orchestrate.js:2786`); the original RA describes work that is not new. The actual cross-tick fix is **out-of-band token binding** as described in Option B above. (Earlier revisions floated session-name rotation as an alternative; codex round 7 confirmed that doesn't work because the SessionStart hook doesn't filter by name, so any rotated-name flag is still consumable by an orphan tab.)

Implementer follows Option B in PR #23 cleanup wave. Coordinate with the SessionStart hook (todos 037, 081 institutional context) for the file-token + tab-bound-token comparison logic. The hook export surface changes — coordinate with 087-cluster lockstep contracts. Bundle in PR #23 cleanup wave; coordinate with 111 on the EFLAGTIMEOUT call site (the EFLAGTIMEOUT throw still triggers 111's spawning-marker rollback — that part of the bundling remains correct).

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js:2740-2796` (flag-consume busy-wait + EFLAGTIMEOUT throw). The source doc's cite of `:2456` is stale; the actual unlink call is at `:2786` and the throw is at `:2792`.

## Acceptance Criteria

- [ ] Existing intra-tick mitigation preserved: EFLAGTIMEOUT path at `orchestrate.js:2786` still calls `bestEffortUnlink` before throwing.
- [ ] Cross-tick fix landed via **out-of-band token binding**: hook reads the file-token AND the tab-bound token (from argv/env/per-tab manifest), and refuses to deliver the prompt unless both match.
- [ ] Test specifically covers the orphan-grabs-fresh-flag case: orphan tab's argv-token is OLD (from its original timed-out spawn), the fresh next-tick `.pending-*` file's token is NEW, the hook detects the mismatch and refuses to deliver the prompt.
- [ ] Test that does NOT pass under a session-name-rotation-only design: a rotated-name `.pending-orch-<phase>-<role>-r1` is written for an unrelated retry; the orphan tab's hook (whose tab was launched for the original name) still scans all fresh candidates and would consume the rotated flag absent the token check. The token-binding fix must reject this.
- [ ] Test: simulate EFLAGTIMEOUT, then write a fresh `.pending-<same-name>` for an unrelated phase/role/iteration, then trigger the orphan tab's hook → orphan does NOT receive the unrelated prompt.
- [ ] Cross-tick wrong-prompt-to-wrong-agent eliminated end-to-end (not just the same-tick case).

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- /ce:review run: `20260502-235111-f52dc7d2`
- Source: `~/.claude/handoffs/newton20-agent-orchestration/20260503-073701-ce-review-pr19.md` (P2 table)
