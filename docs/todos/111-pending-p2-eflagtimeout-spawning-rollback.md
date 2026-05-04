---
status: pending
priority: p2
issue_id: "111"
tags: [unit-11, orchestrate, post-pr-19, re-codex-round-2, flag-consume, timeout, spawning-marker]
dependencies: []
---

# orchestrate: EFLAGTIMEOUT 'spawning' rollback — flag-consume timeout leaves marker stranded

## Problem Statement

When the flag-consume loop times out (`EFLAGTIMEOUT`) on a phase whose
manifest-status is in `'spawning'` state (set by the pre-spawn marker
from todo 090), the orchestrator does not roll back the marker. The
next tick sees stale `'spawning'`. Symmetric with todo 110 — the
reconciliation pass can eventually classify it, but the symptom is the
same: extra retry-count increment for a state the spawn-path could
have rolled back cleanly.

Per the re-codex Round 2 finding, this case and the executeSpawn-
itself-throws case (todo 110) should be handled by the **same**
rollback mechanism: any spawn-path failure path rolls the
`'spawning'` marker back to its prior status before returning control
to the main loop. EFLAGTIMEOUT is the second-most-likely failure mode
after spawnFn-throws, so the rollback hook needs to fire from both
sites.

## Findings

- EFLAGTIMEOUT during a tick whose phase is in `'spawning'` state does not roll back the marker.
- Symmetric with todo 110 (executeSpawn-throws); coord lean is to handle both via a shared rollback hook.
- Surfaced by re-codex Round 2 of PR #19 — held off the P1 gate as P2 for the same reason as 110.

## Proposed Solutions

_(To be drafted during coord triage round; the re-codex Round 2 brief did not propose options.)_

## Recommended Action

_Pending triage._

## Technical Details

- Affected file: `agent-orchestrator/scripts/orchestrate.js` (EFLAGTIMEOUT handling site within the spawn / flag-consume path; precise lines TBD — see PR #19 re-codex Round 2 emergent findings).
- Related: todo 090 (closed) — pre-spawn `'spawning'` marker introduced.
- Related: todo 110 (this batch) — prior-state restoration on spawn failure (sibling rollback site).
- Related: todo 099 (P2) — EFLAGTIMEOUT poison-pill cross-tick semantic; same call-site cluster.

## Acceptance Criteria

- [ ] _(To be drafted during coord triage round.)_

## Work Log

_(empty)_

## Resources

- PR #19: https://github.com/newton20/agent-orchestration/pull/19
- PR #19 re-codex Round 2 emergent findings (per PR #19 completion signal).
- Related closed todo: 090 (P1 — SIGTERM during spawn window).
- Related pending todo: 099 (P2 — EFLAGTIMEOUT poison-pill intra-tick only).
