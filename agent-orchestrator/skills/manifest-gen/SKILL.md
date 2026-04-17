---
name: orchestrate:init
description: Scaffold an agent-orchestrator manifest.yaml from an existing plan document. Reads the plan's Implementation Units, groups them into phases, proposes agent roles, and emits a manifest draft the user can hand-edit before running /orchestrate.
argument-hint: "[plan.md path]"
---

# /orchestrate:init — Manifest generator from a plan document

**Status: stub, deferred to V1.5.** This skill is scaffolded by Unit 1 of
the implementation plan so the slash command is discoverable and the
manifest-generation workflow has a home. The executable logic lands in
Unit 12, which is explicitly V1.5 (post-V1 ship).

In the meantime, copy [`../../schema/manifest-example.yaml`](../../schema/manifest-example.yaml) and
edit it by hand.

## What it will do (Unit 12, V1.5)

1. Accept a plan document path as argument (usually
   `docs/plans/*-plan.md`).
2. Parse the plan's Implementation Units section to extract unit IDs,
   goals, file lists, and dependencies.
3. Infer phase groupings — consecutive units with no cross-dependencies
   can merge into a single phase; units with mid-plan handoffs become
   explicit review-loop boundaries.
4. Emit a draft `manifest.yaml` at the project root with:
   - One phase per grouped unit cluster.
   - Suggested `agent.role` (impl / qa / coordinator) based on the
     unit's Verification section language.
   - Conservative `depends_on` edges derived from the plan's
     explicit Dependencies field.
   - Commented-out template lines for `parallel_with` and
     `review_loop` so the user can opt in.
5. Report diagnostics: any units it could not fit, any ambiguous
   dependencies, any unrecognized agent roles.

## Why this is V1.5

V1 can ship without it — users can write manifests by hand from
[`../../schema/manifest-example.yaml`](../../schema/manifest-example.yaml). Hand-authored manifests are also
a forcing function for the user to think about phasing deliberately.
The scaffolder is a convenience, not a blocker.

## See also

- [Implementation plan, Unit 12](../../../docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md) — the deferred unit.
- [Manifest reference](../../docs/manifest-reference.md) — the shape this will produce.
