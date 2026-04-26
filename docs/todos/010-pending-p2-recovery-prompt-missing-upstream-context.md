---
status: pending
priority: p2
issue_id: "010"
tags: [code-review, templates, recovery, agent-native, unit-6]
dependencies: []
---

# recovery-prompt.md drops upstream context vars; recovered agent has strictly less information than original

## Problem Statement

`agent-orchestrator/templates/recovery-prompt.md` declares only:
```
required: [role, phase_id, recovery_checkpoint_path, crash_timestamp, completed_checkpoints_block, remaining_work_block]
optional: [last_heartbeat_timestamp, prior_session_pid, output_paths, heartbeat_path]
```

It does NOT carry `previous_phase_briefing` (which `impl-prompt.md` carries), nor `qa_scope_rows` / `qa_playbook_block` (which `qa-prompt.md` carries). A respawned impl session for a phase with upstream dependencies has no access to the upstream completion-signal briefing. A respawned QA session has no access to the per-PR scope rows.

This is a safety regression: a recovered agent operating with strictly less context than the original may make different decisions, especially on conditional design calls anchored in the upstream contract.

## Findings

- Architecture review (PR #5 ce-review): "When recovery respawns an impl phase, the recovered agent has crash context and remaining-work markers but loses the upstream completion-signal briefing the original impl session had."
- Recovery-prompt.md does not document this gap — it presents itself as a complete prompt for resuming work.

## Proposed Solutions

### Option A — Add upstream-context vars to recovery-prompt frontmatter
Add `previous_phase_briefing`, `qa_scope_rows`, `qa_playbook_block` to recovery-prompt.md's `optional` list. Add a section "## Original prompt context" that conditionally renders these. Update `templates/README.md` catalog if needed.

- **Pros**: Minimum-impact fix; recovered agent now has full original context; works for impl, QA, and (future) coord recovery.
- **Cons**: Expands the recovery template; some optional vars will be empty for a given role (impl-recovery doesn't need qa_scope_rows).
- **Effort**: Small.
- **Risk**: Low.

### Option B — Redesign recovery as "original prompt + crash addendum"
Have the orchestrator concatenate the original role prompt (impl/qa) + a recovery crash-addendum file (`recovery-addendum.md`) instead of a standalone recovery template. The full original prompt is preserved verbatim.

- **Pros**: Structurally correct — recovery is exactly "you crashed, here's what we know about the crash, finish your work." No information loss possible.
- **Cons**: Orchestrator change (Unit 7 or 11); more invasive. Two-template-concatenation pattern (header + role + addendum) is novel for this PR's design.
- **Effort**: Medium.
- **Risk**: Medium — touches Unit 7 design.

### Option C — Document the limitation, defer to V1.5
Leave recovery-prompt as-is. Document in `templates/README.md` and the recovery-prompt itself that V1 recovery is a "best-effort resume with reduced context" and a `status: blocked` is the right answer if the upstream contract feels load-bearing.

- **Pros**: No code/template change. Honest about V1 trade-offs.
- **Cons**: Recovery becomes notably less useful; agents may default to blocked under a wider range of crash scenarios.
- **Effort**: Small.
- **Risk**: Recovery flow is less robust in practice.

## Recommended Action

(filled during triage — Option A is cheapest, Option B is most correct)

## Technical Details

**Affected files**:
- `agent-orchestrator/templates/recovery-prompt.md`
- `agent-orchestrator/templates/README.md` (catalog)
- Possibly: Unit 7 (`scripts/generate-prompt.js`) for Option B's concatenation

## Acceptance Criteria

- [ ] A respawned impl agent on a phase with upstream deps receives the upstream completion-signal briefing.
- [ ] A respawned QA agent receives the original scope rows.
- [ ] The recovery-prompt template documents which vars it carries and which it does not, so a coord triaging a `status: blocked` recovery report knows whether the block was caused by missing context.

## Work Log

(empty)

## Resources

- PR #5 ce-review round: architecture review (P2-A4)
- `agent-orchestrator/templates/recovery-prompt.md`
- `agent-orchestrator/templates/impl-prompt.md` (compare frontmatter)
- `agent-orchestrator/templates/qa-prompt.md` (compare frontmatter)
