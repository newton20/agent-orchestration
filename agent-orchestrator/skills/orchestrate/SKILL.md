---
name: orchestrate
description: Run a multi-phase, multi-session build from a YAML manifest. Spawns visible Claude Code sessions per phase, coordinates them via a file-drop protocol, handles review loops and crash recovery, and advances phases in dependency order.
argument-hint: "[manifest.yaml path | --resume | --init plan.md]"
---

# /orchestrate — Multi-session phased-build orchestrator

**Status: stub.** This skill is scaffolded by Unit 1 of the implementation
plan. The executable logic lands in Unit 11 (the `orchestrate.js` stateless
Node process + this skill as a thin entry point). Until then, use the
Unit 0 prototype at `../../prototype/orchestrate-prototype.js` to drive
real multi-phase runs.

## What it will do (Unit 11)

1. Accept a manifest path as argument (or run `--resume` to pick up a
   crashed run, or `--init plan.md` to scaffold a manifest from a plan).
2. Validate the manifest via `scripts/parse-manifest.js`.
3. Run `npm install` in `scripts/` if `node_modules` is missing.
4. Start `node scripts/orchestrate.js <manifest>` as a background
   Node.js process that re-reads all state from disk every 2 minutes —
   zero accumulated context window inside this Claude session.
5. Report: "Orchestrator started. PID: XXXX. Monitoring
   docs/orchestration/. Ctrl+C to stop."

The orchestrator process is external on purpose — see the plan's "Key
Technical Decisions" section. A long-running `/loop` inside a Claude
session would exhaust the context window after ~90 polling ticks.

## References (populated by later units)

- [`references/orchestration-loop.md`](./references/orchestration-loop.md) — main event loop spec (Unit 11).
- [`references/recovery-workflow.md`](./references/recovery-workflow.md) — crash detection + retry (Unit 11).
- [`references/review-loop.md`](./references/review-loop.md) — impl↔QA review cycle (Unit 11).

## See also

- [Manifest reference](../../docs/manifest-reference.md) — every manifest field.
- [Unit 0 prototype](../../prototype/README.md) — working spawn+poll+advance, no plugin required.
- [Implementation plan](../../../docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md) — full unit breakdown.
