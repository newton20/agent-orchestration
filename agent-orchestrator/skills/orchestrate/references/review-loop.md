# Review loop — impl ↔ QA cycle (Unit 11)

When a phase declares `review_loop.enabled: true`, the orchestrator
advances it through a per-iteration impl→QA cycle. This document
specifies the contract.

## V2 lifecycle

With `schema_version: 2`, production dispatch is disabled. An explicit
programmatic fixture adapter exercises the durable lifecycle without live
engine execution. The remaining sections in this document describe V1;
their conventional artifact paths, counter resets, and operator escape
hatches do not apply to V2.

V2 stores the run, phase, role, zero-based review iteration and attempt ID
before dispatch. Prompts and reports use attempt-specific directories
under `docs\orchestration\runs\<run_id>\`. QA launch failures retain the
completed impl result and intended QA stage. Launch/delivery retries and
execution-recovery retries each have a separate two-retry budget per role,
retained across review rounds and restart. Only a verified-shape QA failure
consumes a review round; it cannot clear required verification.

V2 QA needs matching completion and verdict reports. The verdict includes
`verification: [{ id, status, evidence }]` for `scope`, `P1`, `P2`, `P3`,
`P4`, and `P6`; all must pass with evidence for a passing verdict.
Reports are worker evidence, not independently verified success.
Historical attempts and review results remain immutable.
`partial` or `blocked` QA without a valid fail verdict requires intervention
immediately and remains blocked from automatic retry after process closure
and restart. Invalid or missing verification cannot pass. Correcting an
invalid report permits reconciliation; a valid fail verdict still consumes
only a review round after safe release.

All mutating roles, including QA, serialize by canonical checkout. A
completed or idle worker retains its reservation until an exact
cooperative-release acknowledgement or engine-and-descendant closure.
Read-only concurrency requires fixture-enforced capability restrictions.
Pause records outcomes while preventing QA, recovery and all other new
dispatches. Unknown liveness or ambiguous submission requires intervention
without replaying a kickoff.
Already-admitted queued retries resume under the same attempt ID and budget,
including the last allowed retry. Dispatch rechecks current engine and
read-only enforcement capabilities. A never-dispatched queued intent
refreshes its launch host at the launch boundary after a reboot; after
`launching`, that host identity is immutable and no kickoff is replayed.
Terminal outcomes still accept adapter closure and additive descendant
accounting while reservations remain held. Process-death samples must
postdate dispatch/correlation and the identified process creation time.

Do not reset V2 counters, edit accepted runtime structure, force a
completion, or supply `role: operator` in a worker artifact. Those actions
do not grant authority. See `docs/runtime-state-reference.md` for the
fixture API, process evidence, bounded artifact format and private
checkout-reservation contract.

## Lifecycle

```
[pending]
   │
   │ depends_on met
   ▼
[running, review_stage=impl, review_iteration=1]
   │
   │ impl-complete.md appears
   ▼
spawn QA  ─►  [running, review_stage=qa, review_iteration=1]
   │
   │ qa-complete.md (or qa-verdict.json) appears
   ▼
parse verdict
   ├─ pass=true ───────► [completed]
   │
   ├─ pass=false, iter < max ─► spawn impl with prior failures
   │       └─► [running, review_stage=impl, review_iteration=2]
   │
   └─ pass=false, iter >= max ─► [failed]  (terminal output to operator)
```

`review_iteration` and `review_stage` are persisted in
`manifest-status.yaml` under `phases.<id>` so the orchestrator can be
killed and `--resume`d without losing track of which agent should be
running.

## QA verdict shape

The orchestrator reads QA's verdict from one of two artifacts (in
order of preference):

### 1. `qa-verdict.json` (V1.5 preferred shape)

A JSON object at `<phase_dir>/qa-verdict.json`:

```json
{
  "pass": false,
  "failures": [
    { "test": "row-3", "expected": "200 OK", "actual": "500 ISE" },
    { "test": "row-7", "expected": "no dirty tree", "actual": "M src/foo.js" }
  ]
}
```

Required fields:
- `pass` (boolean) — `true` if every QA scope row + playbook row
  passed; `false` otherwise.
- `failures` (array) — empty when `pass: true`. Each entry has
  free-form `test` / `expected` / `actual` strings the orchestrator
  inlines into the next impl dispatch's `previous_phase_briefing`.

Today the QA template (`qa-prompt.md`) does NOT yet emit this
artifact. Future Unit 11 work or a V1.5 dispatcher upgrade may extend
the template; until then the orchestrator falls back to mode 2.

### 2. `qa-complete.md` frontmatter (V1 fallback)

The orchestrator parses the frontmatter of `<phase_dir>/qa-complete.md`
and maps the `status` field to a verdict:

| `status` | `pass` |
|---|---|
| `complete` | `true` |
| `blocked` | `false` |
| `partial` | `false` |
| anything else | `false` |

The QA template's Output Contract specifies this mapping
("`complete` for ALL PASS, `blocked` for any FAIL, `partial` if you
were unable to verify any row"), so the V1 fallback respects the
template's existing contract — the failures array is empty because the
frontmatter does not carry structured failure detail.

## Iteration counter + max-iterations escalation

Default cap: `--review-loop-max-iterations 3` (per-phase override
available via `manifest.phases[i].review_loop.max_iterations`).

On the Nth iteration where N ≥ max:

1. The orchestrator marks the phase `failed` with reason
   `review_loop_exceeded:<N>`.
2. A structured `[problem / file / fix hint]` block prints to stderr.
3. The phase's `failed` status is persisted to manifest-status. The
   operator must intervene — either re-dispatch the phase manually
   after addressing the systemic blocker, or rewrite the manifest's
   `review_loop` config.

Per-iteration retry of crashed sessions does NOT consume the review
budget. Each iteration's impl/QA dispatch has its own `retry_count`
budget (default 3); the review iteration counter advances only when a
QA dispatch produces a non-pass verdict.

## How `previous_phase_briefing` propagates across iterations

When iteration 2+ dispatches impl after a QA failure, the orchestrator
synthesizes a `previous_phase_briefing` containing:

```
# Prior QA verdict (iteration N-1)

Status: <signalStatus>. The prior implementation did not pass review.
Address the failures below before signalling complete.

1. test=<...> expected=<...> actual=<...>
2. test=<...> expected=<...> actual=<...>
...
```

The block is rendered into the impl-prompt's `{{previous_phase_briefing}}`
slot via `generate-prompt`. The impl agent reads the block as the
authoritative list of issues to fix; if the block is empty (qa-verdict
fallback path with no structured failures), the agent falls back to
reading `qa-complete.md` directly per its own template's prose.

## Each QA cycle is a fresh spawn (not resume)

The orchestrator does NOT reuse the prior QA tab when iteration 2+
dispatches QA — every QA dispatch is a brand-new wt tab with its own
prompt, PID, and lifecycle. This matches the plan §"QA cycles" and
keeps the QA agent's context window from accumulating across
iterations.

## What the QA agent should write

Following the existing QA template (`qa-prompt.md` Output contract),
the agent writes:

- **`qa-complete.md`** — required. The standard completion signal with
  status frontmatter (`complete` / `blocked` / `partial`).
- **`qa-verdict.json`** — optional in V1, preferred in V1.5. The
  structured pass/failures shape above. When the orchestrator finds
  this file, it overrides the frontmatter-based fallback.

The agent does NOT need to know the orchestrator's review-loop
state — `review_iteration` lives only in manifest-status, not in the
agent's prompt context. The agent dispatches each iteration as a
fresh QA run.

## Operator escape hatches

- **Re-dispatch with cleared retry counters.** Edit
  `manifest-status.yaml` to set the phase's `retry_count` and
  `review_iteration` to 0, then run the orchestrator again — it
  re-dispatches as a fresh phase 1 iteration 1.
- **Skip the review loop.** Edit the manifest, set
  `review_loop.enabled: false`, restart the orchestrator. Subsequent
  ticks treat the phase as a single-role dispatch.
- **Force completion.** Edit `manifest-status.yaml` to set
  `phases.<id>.status: completed` directly. The orchestrator's next
  tick observes the completed status and advances downstream phases.
  Use sparingly — bypassing the review verdict is the operator's
  sole responsibility.
