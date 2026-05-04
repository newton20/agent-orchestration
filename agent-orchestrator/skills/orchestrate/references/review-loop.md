# Review loop — impl ↔ QA cycle (Unit 11)

When a phase declares `review_loop.enabled: true`, the orchestrator
advances it through a per-iteration impl→QA cycle. This document
specifies the contract.

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
