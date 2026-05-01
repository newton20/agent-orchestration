---
status: pending
priority: p3
issue_id: "082"
tags: [code-review, unit-8, check-health, comments, clarity]
dependencies: []
---

# Comment at L78-86 mentions "tasklist" twice in different roles

## Problem Statement

The deviation comment at `:78` mentions `tasklist` as the plan's directive for liveness; the comment at `:125-127` mentions `tasklist` as the kernel-equivalent backing for `process.kill(pid, 0)`. A reader skimming the file sees "tasklist" twice and may be confused which role it plays — both saying "tasklist" in nearby paragraphs, with one saying "we don't use it" and the other saying "we use the same kernel path it uses."

## Findings

1. **Two adjacent comments reference "tasklist"** with opposite framings.
2. **The second comment is the imprecise one** — `process.kill(pid, 0)` invokes the OS ACL/existence probe, not the `tasklist.exe` tool.
3. **Reader confusion is plausible** — a quick skim could conclude the file contradicts itself on whether `tasklist` is used.

## Proposed Solutions

### Option A — Tighten the second comment

Reword to "the same kernel ACL/existence probe that `tasklist` uses internally" or similar — make clear it's the OS primitive, not the tool.

- **Pros**: One-line fix; eliminates skim-time confusion.
- **Cons**: None.
- **Effort**: Trivial.
- **Risk**: Low.

## Recommended Action

_Pending triage._

## Technical Details

**Affected file:** `agent-orchestrator/scripts/check-health.js:78-86` (deviation note), `:125-127` (`process.kill` backing comment)

Coord-pre-acked deviations: `process.kill(pid, 0)` over tasklist; `status.pid` ignored; `manifest.workdir` not used for protocol root.

## Acceptance Criteria

- [ ] Comment at `:125-127` makes clear `tasklist` is referenced only as the OS primitive analogue, not the tool we call.
- [ ] No claim that `tasklist.exe` is being invoked.

## Work Log

## Resources

- PR #15: https://github.com/newton20/agent-orchestration/pull/15
- Branch: `feat/unit-8-health-checker` @ `285085b`
- `agent-orchestrator/scripts/check-health.js`
