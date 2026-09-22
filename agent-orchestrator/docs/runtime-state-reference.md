# Runtime state and ownership

V2 supports Windows and Node >=20. Its Windows ownership tests run real
competing Node processes. Production worker dispatch remains disabled.
The lifecycle is exercised through an explicit programmatic fixture adapter;
there is no CLI flag that enables it.
Updated V1 and V2 controllers require Windows PowerShell, Git on PATH,
and access to the current user's LocalApplicationData directory for their
shared ownership primitive.

## Accepted configuration

`prepareV2Manifest(manifest, manifestPath)` validates the manifest and
resolves existing Git worktrees. It returns:

```js
{
  source_path, source_sha256, // absolute authoring path; hash of input JSON
  manifest,                 // validated manifest with effective defaults
  phases, execution_order,  // normalized phases; agents include workdir/workspace
  workspace, workdir
}
```

`workspace` is `{ identity_version: 1, kind: 'git-worktree', root, key }`.
Both `root` and `key` are the full native-realpath worktree root, with
Windows separators and lowercase comparison. The Git common directory is
not an ownership key. `workdir` is the canonical working directory, which
can be a subdirectory of that root. Stored identities remain readable when
a checkout is unavailable; startup must revalidate them before mutation.

## One-file state transaction

The canonical file is `statusPathFor(manifestPath)`: the sibling
`<manifest-basename>-status.yaml`. V2 writes JSON, which is also valid YAML.
The file contains the current run and immutable prior-run history. It is
bounded to 16 MiB; exceeding that limit fails publication.

```js
{
  schema_version: 2,
  revision: 1,
  run_id: '<uuid>',
  workspace,
  accepted: { revision: 1, ...acceptedConfiguration },
  operator: { paused: false },
  runtime_status: 'live_dispatch_disabled',
  live_dispatch_enabled: false,
  phases: {
    '<phase-id>': {
      status: 'pending',
      review_iteration: 0,
      review_stage: 'impl',
      roles: {
        impl: { current_attempt_id: null, attempts: [] }
      }
    }
  },
  command_results: {},
  outbox: [],
  next_event_sequence: 1,
  created_at, updated_at,
  history: [],
  legacy_history: []
}
```

Initialization also appends a `run_created` event. Review-enabled phases
include `impl` and `qa` role records even when one role was implicit in the
manifest. Lifecycle code fills the attempt arrays. Each attempt must have
`attempt_id`, `run_id`, `phase_id`, `role`, `review_iteration`, `engine`,
`access`, `workdir`, and `workspace`. Additional lifecycle fields belong
on that record; PID alone is not process identity. Without a fixture adapter,
the runner observes existing attempts but creates no new dispatches.

`createStateStore({ manifestPath, owner })` returns synchronous methods:

| Method | Contract |
|---|---|
| `read()` | Read and validate without writing; missing file returns `null`. |
| `initialize(accepted)` | Create a run, or return the existing V2 record unchanged. Completed V1 phases are copied into `legacy_history`. |
| `transact({ expectedRevision, command, mutate })` | Clone the current record, invoke a synchronous callback, and atomically publish state, command response, and events. |
| `transactInternal({ expectedRevision, mutate })` | Commit an owner-internal transition with the same revision and publication guarantees, without storing a command deduplication result. |
| `projectOutbox({ expectedRevision })` | Project committed events under live ownership, publish acknowledgements/status, and return the latest canonical state. |
| `rerun({ expectedRevision, accepted })` | Create a new run ID and retain the prior record, without recursively nesting history. Require drained, non-degraded projection, matching workspace, and resolved attempt ownership. |

Example owner-side transition:

```js
const response = store.transact({
  expectedRevision: state.revision,
  command: { id: 'pause-123', payload: { type: 'pause' } },
  mutate(draft) {
    draft.operator.paused = true;
    return {
      result: { ok: true },
      events: [{ type: 'paused', payload: {} }]
    };
  }
});
```

The response is `{ revision, result }`. `command_results[id]` stores
`{ fingerprint, response }`; the fingerprint uses canonical JSON with
sorted object keys. An identical command returns its original response
before checking the caller's now-stale revision. Reusing an ID with a
different payload fails. Deduplication is per run; old results remain in
history after rerun.

Internal transactions return the same `{ revision, result }` response but
do not accept commands. Health-sample and progress-only updates persist
without adding command results or domain events. Lifecycle transitions
still commit their pending events with the state change.

The callback cannot change canonical identities, previous runs, imported
history, command results, projection/outbox bookkeeping, or the accepted
snapshot. `projectOutbox` owns projection bookkeeping; structural acceptance
remains a separate future owner-validated operation. The callback
must return JSON data and an event array; it must not perform external
launch effects.

Events have `{ sequence, event_id, run_id, revision, type, payload }`.
`event_id` is `<run_id>:<sequence>`. Sequence numbers increase within a run;
the canonical revision increases across reruns and projection acknowledgements.
`projectOutbox` projects committed events to the run-scoped JSONL log.
File existence alone does not establish complete or acknowledged history.

Publication creates a unique same-directory temporary file, writes and
flushes it, checks live ownership and the unchanged previous record, then
renames it over the canonical file. Write, flush, and rename failures throw
without returning a successful command response. Readers see the previous
or new complete record. This is a process-crash publication contract, not
a guarantee against filesystem or device failure during machine power
loss. Invalid/newer records are rejected without repair or rewriting.
V1 `loadStatus` retains its compatibility normalization; V2 uses strict
validation, and V1 `runUpdate` refuses V2 even with cached V1 injection data.

## Event projection and reconnect

`store.projectOutbox({ expectedRevision })` validates the live owner and
revision before writing. It appends committed pending events, flushes them,
then publishes canonical acknowledgements. Replaying after a crash
deduplicates against the committed pending events. Generic transactions
cannot rewrite this bookkeeping, and unpublished commands never return
success.

Canonical `projection` records `status: healthy|degraded`,
`acknowledged_sequence`, `retained_through`, `updated_at`, and a nullable
diagnostic. `updated_at` changes only when projection state changes durably;
it is not a heartbeat or the time of an unchanged check. Projection
acknowledgements advance canonical revisions without creating new event
identities.

Projection storage failures persist an explicit degraded diagnostic where
canonical publication remains possible. Lifecycle observation continues
within persistence bounds, but new and already-queued dispatch are blocked
while projection is degraded. Outbox capacity is checked before launch
effects. Canonical storage/ownership failures remain errors, not successful
degraded operations.

`event-log.eventLogPath(state)` resolves:

```text
<workspace-root>\docs\orchestration\runs\<run-id>\logs\events.jsonl
```

`readEvents({ state, after = null, limit = 100 })` returns:

```js
{
  run_id, revision, events, cursor, latest_cursor, has_more, reset_required,
  history: { status, gaps, diagnostic }
}
```

Cursors are event IDs, not canonical revisions. Resume with the returned
`cursor`; `latest_cursor` identifies the latest committed event and may be
ahead of the projected log. Wrong-run, invalid, unavailable, or
missing-history cursors request snapshot fallback through `reset_required`.
History distinguishes pending projection, retention, and missing
acknowledged records. A drained outbox cannot reconstruct lost acknowledged
events.

Readers never repair logs. The owner repairs only interrupted tails that
can be proved replayable from canonical pending events; other corruption
is surfaced. Ordinary log-read failures produce history diagnostics while
readable canonical snapshots remain available. Artifact path-boundary
violations fail closed rather than becoming ordinary history gaps.

| Bound | Limit |
|---|---|
| Serialized event line | 16 KiB |
| Pending outbox | 256 events and 1 MiB |
| Log read | 4 MiB |
| Retained acknowledged history | Latest 512 events within 2 MiB |
| Read page | At most 256 events and 256 KiB of event lines |

Retention removes older acknowledged records without creating an automatic
archive. Its intent is persisted before removal, so gaps remain visible
across a crash. A trimming failure cannot revoke a published append
acknowledgement. At the hard log cap, a matching on-disk pending prefix is
flushed and acknowledged before compaction; remaining events drain in a
subsequent projection pass.

## Read-only progress snapshots

`read-model` exports `SNAPSHOT_SCHEMA_VERSION = 1` and
`createSnapshot({ manifestPath, runId = null, controller = null, now })`.
`now` defaults to the reader's current ISO-8601 timestamp.
The immutable allowlisted result has status `ready`, `legacy`, or `no_run`.
An unknown selected run throws instead of silently selecting the current
run. Legacy state is read-only and uncorrelated.

Phase and role arrays preserve dependencies, review history, blockers,
current-attempt progress, historical attempts, and accepted artifact
provenance. Worker-reported completion and QA evidence remain distinct
from unknown independent verification. Snapshots expose collection limits
and truncation metadata; raw prompts, command responses, credentials, PIDs,
and arbitrary worker diagnostic text are excluded.

The snapshot's `event_cursor` is the latest committed event identity,
which can lead projection. Consumers must inspect `projection` and
`history` and handle event-read snapshot fallback without silently skipping
unavailable events.

`updated_at` is canonical state time; `reader_observed_at` records the
reader's successful read. A supplied controller observation must include
`run_id`, `status`, and a non-future `observed_at`. Controller status is
unknown without matching evidence. A responsive reader does not establish
controller or worker liveness.

Concrete snapshot fixtures are in `scripts\read-model.test.js`; event and
cursor fixtures are in `scripts\event-log.test.js`. The U4 cases in
`scripts\orchestrate.test.js` exercise fixture lifecycle, canonical
transaction, projection, and snapshot together. These contracts do not
define the later dashboard's HTTP/SSE/authentication interface or establish
live engine acceptance.

## Kernel ownership and discovery

`acquireWorkspaceOwner(workspace, options)` binds a Windows named-pipe
listener whose name contains the namespace and SHA-256 of the full key.
The default namespace is `controller`; writable-checkout reservations use
this same namespace, so a primary V1 controller and a V2 attempt cannot
own competing claims on the checkout. Other namespaces remain available
for companion services.
The returned handle stays live until `await owner.release()` or process
death. A bind failure is contention or a permissions error. Metadata is
never used to steal the claim.

`assertOwnership(owner, workspace, namespace = 'controller')` checks the
actual locally registered listener handle. A copied or fabricated object,
a released handle, or a handle for another workspace/namespace cannot
authorize a state-store mutation. Revision fencing alone grants no
ownership. Namespace choice must be consistent among all participants in
a claim class; a dashboard claim does not reserve a writable checkout.

Each owner has its own directory beneath the Windows
LocalApplicationData special folder:

```text
agent-orchestrator\runtime\<workspace-hash>\<namespace>\<service-id>\
  owner.json
  operator-capability.json
```

The instance directory grants filesystem access only to the current user.
Records stay outside the project. The operator capability is random,
private, and absent from readiness responses and worker inputs. No IPC
mutation handler consumes it yet.

Discovery retains the full workspace key, namespace, service ID, pipe
name, user SID, and process identity. Full-key/name mismatches fail closed.
Process identity includes PID, hostname, OS creation time, and host boot
identity. Failed OS observations remain explicitly unknown. An old handle
only cleans up its own matching discovery record and never a successor's.
Stale process-death discovery records may remain; they confer no ownership.

`queryOwner(workspace, { namespace })` sends a bounded readiness query.
Its response contains `{ ok, status, workspace_key, namespace, service_id,
process }`. Unsupported/mutation requests and mismatched keys are rejected.
This endpoint is an inspection surface, not operator-command authorization.

Updated V1 and V2 runners share the controller pipe claim. Before
activation, the owner inspects legacy lock records at the manifest protocol
directory, declared workdir protocol directories, and canonical
worktree protocol directory. Additional writable checkouts check their
root and every declared agent workdir. Live or uncertain owners block activation.
These refusals return `lock_contention` with exit code 2; corrupt lock
records remain preflight failures with exit code 1.
Confirmed process absence, reliable creation-time mismatch, or a changed
known host boot identity permits draining matching stale records. Legacy
`startedAt` alone is insufficient for PID-reuse proof because older writers
could store a wall-clock fallback.
Updated V1 lock writers also persist explicit OS `creation_time` and
`host_boot_id` when known, reusing the owner's captured evidence. Unknown
evidence stays null; a fallback `startedAt` is never promoted to creation
evidence. Existing lock candidates are deduplicated by native realpath and
Windows case normalization before draining, with a byte-for-byte recheck.

V1 also accepts an existing non-Git workdir. `resolveWorkspace(workdir,
{ allowNonGit: true })` returns a `kind: 'directory'` identity only after
Git reports that it is not a repository and an ancestor check finds no
Git metadata. Git errors, missing tools, permissions failures, and
unresolved metadata are not permission to fall back. Git-backed V1 uses
the same worktree key as V2; V2 remains Git-only. An initially invalid V1
manifest fails before ownership acquisition rather than guessing which
workspace to claim.

Operators must stop using pre-upgrade binaries for that workspace. An old
binary launched after the drain check is outside this upgrade guarantee.
Deleting lock metadata does not release a live named pipe.

## Integration boundaries

`startV2Foundation(options)` acquires ownership, initializes/resumes state,
projects pending events before lifecycle reservation cleanup, reacquires
prior checkout reservations, creates run-scoped directories, and projects
cleanup transitions. It returns
`{ owner, store, state, lifecycle, authoring, summary }`.
The returned `state` is the latest persisted snapshot after startup
reservation reconciliation and projection, including its current revision
on zero-tick runs.
Both resume and rerun make one bounded follow-up projection pass before
lifecycle construction when pending events remain. Hard-cap compaction can
make physical progress without draining the outbox or changing its revision.
Persistent degradation does not force an unbounded retry or prevent
monitoring when bounded persistence still permits cleanup.
Callers must `await lifecycle.close()` and then `await owner.release()`
in `finally`. Closing a lifecycle releases additional kernel handles but
does not erase unresolved reservations. Close cannot overlap a tick.
`runOrchestrator` reconciles on every V2 tick and holds the handles until
shutdown or its tick limit; it never enters the V1 dispatcher for V2.
Each V2 tick projects before and after lifecycle reconciliation. The runner
reports `event projection degraded`, `event history gap`, and
`outbox backpressure` diagnostics without enabling production dispatch.

Artifacts are scoped beneath
`<workspace-root>\docs\orchestration\runs\<run-id>\`.
Scaffolding requires the persisted accepted snapshot and a live owner;
dry-run preview needs an accepted snapshot and a run ID but writes nothing.
`artifact-path.assertArtifactPath(root, file)` checks containment and rejects
redirected path components. Scaffolding validates every target before
creating any directory or event file; attempt reads and prompt publication
use the same guard.
Ordinary restarts preserve artifacts, events, paused state, and the
accepted snapshot. Authoring validation errors/drift are reported
separately, without replacing the run.

Live engine acceptance and authenticated workflow mutations remain separate
integrations. The read-only dashboard below adds neither capability.

## Read-only dashboard companion

`dashboard-server.js` provides
`<start|serve|status|stop|access> <manifest-path>`. The companion holds only
the `dashboard` namespace claim and its private service-control capability.
It cannot acquire scheduler mutation authority, project outbox records,
rewrite canonical state, or launch workers.

`start` runs a detached process and waits for readiness; `serve` remains in
the foreground. Discovery binds a canonical workspace, manifest path, and
live service ID to an OS-selected `127.0.0.1` port. A stored port or PID
alone cannot authorize status or stop. Repeated starts for the same manifest
reuse the live service; another manifest in that workspace conflicts.
`status`, `stop`, and `access` support `--workspace <original-directory>`
when authoring/state reads are unavailable. An optional exact service ID
after the manifest further scopes `stop`.

`access` displays a one-use bootstrap code only to a human interactive
terminal. Codes expire after 60 seconds; at most eight unexpired codes may
exist. The private `CODE_LIMIT` diagnostic is not a browser HTTP response.
The browser submits the code to `POST /api/bootstrap` with same-origin
JSON. Success returns 204 and a service-specific `HttpOnly`,
`SameSite=Strict`, `Path=/` cookie. Sessions expire after 900 seconds; codes
and sessions are memory-only and invalidated at service restart. No
credential belongs in a URL.

The server validates its exact Host and any supplied Origin, requires Origin
for bootstrap, grants no CORS access, and marks responses `no-store`.
Browser cookies grant read-only inspection, not service stop or workflow
commands. This is not a hostile-local-process sandbox: cookies are
host-scoped, not isolated by loopback port.

The versioned contract and sanitized fixtures are
`scripts\test-support\dashboard-contract.json`. The HTTP wrappers add
`schema_version` and `service_id`; U4 snapshots remain unchanged.

| Route | Contract |
|---|---|
| `GET /api/session` | Authenticated session expiry and read-only identity; expired/absent sessions require access again. |
| `GET /api/snapshot` | Optional `run_id`; returns snapshot, separate controller-service observation, and `stream.after: null`. |
| `GET /api/events` | Required `run_id`, optional delivered `after` cursor and bounded `limit`; preserve `reset_required` and history diagnostics. |
| `GET /api/stream` | SSE for one selected run; `Last-Event-ID` takes precedence over `after` on reconnect. |
| `GET /api/artifact` | Exact run/phase/role/iteration/attempt identity and allowlisted kind; returns untrusted text and current/accepted hashes, never an arbitrary path or prompt. |

An SSE `observation` has no event ID and is emitted once per second even
without canonical changes. Its `current_run_id` lets a current-run view
notice rerun. Refresh the snapshot when revision/current-run changes.
An `events` frame uses the last actually delivered event ID; deduplicate
timeline records by run and event ID without using events as progress
reducers. A `reset` clears EventSource's last ID and requests a fresh
snapshot plus replay from null. Snapshot/latest cursors may lead projection
and must not replace the delivered cursor.

SSE `error` frames have no event ID. `STATE_UNAVAILABLE` is recoverable on
later observation; `AUTH_EXPIRED` closes the stream and requires a new access
flow. Slow clients are disconnected rather than queued without bounds.
Reader observation time advances only after a successful read. Workspace
service readiness remains separate from run-correlated controller health.

Limits include 2 MiB snapshots, 64 KiB artifacts, 256 KiB static files,
1 KiB request bodies, eight streams, and 64 browser sessions. Event pages
retain U4's 256-event/256-KiB bounds. Errors use fixed redacted messages,
not raw filesystem exceptions, state, prompts, or credentials.

Only `dashboard\index.html`, `dashboard\app.js`, and `dashboard\styles.css`
are served as static assets. Packaging requires all three and includes them
in the SHA-256 inventory; it excludes frontend tests and fixtures.
Their absence returns `UI_UNAVAILABLE`, not a successful placeholder.
The UI follows the current run unless the operator pins historical state.
Canonical snapshots determine progress; the bounded timeline and inert
artifact text supply context without upgrading worker reports to independent
verification. Reader freshness, run-correlated controller evidence, and
workspace service observations remain separate.

Initial redirected/aliased static roots are rejected. Actual TCP
backpressure/stop-flush behavior and near-limit polling cost remain platform
acceptance concerns; known transient stop/discovery failures require retry
rather than guessing ownership.

## Attempt lifecycle

`attempt-lifecycle.js` exports `createAttemptLifecycle`, `artifactPaths`,
`identityOf`, `readAttemptArtifact`, the retry limits and the bounded-history
constants. `createAttemptLifecycle({ owner, store, manifestPath, ... })`
returns `{ tick({ sample }?), close() }`. Ticks cannot overlap.

Each attempt has `lifecycle_version: 1` and the following additional fields:

```js
{
  intended_review_stage, retry_category, previous_attempt_id,
  status, created_at, started_at, launch_host, process_sample_watermark,
  intent: {
    launch_token, session_name, timeout_minutes, required_verification,
    prompt_options, prompt_text, prompt_sha256, prompt_warnings
  },
  artifacts: { directory, prompt, completion, heartbeat, verdict, checkpoint, release },
  reservation: { state: 'pending' /* held | released */, closure },
  reservation_cleared,
  launch_process, engine_process, session_id, submission,
  observations, descendants, descendant_tracking_complete,
  evidence, evidence_history, diagnostics, health, outcome
}
```

Optional observations and outcomes are absent until established. The
queued intent includes the rendered prompt bytes and their hash before
any prompt publication or launch. The launcher process, correlated engine
session, and acknowledged submission are separate observations. A shell
or session-name match does not establish submission.

Dispatch order is: publish queued intent, acquire and durably record the
checkout reservation, publish the prompt, publish `launching`, then call
the fixture adapter once. Restart may continue a queued intent under its
original attempt ID. Once `launching` is durable, missing acknowledgement
requires reconciliation and never automatic replay. A thrown adapter call
leaves its durable intent and reservations available for the next tick.
An already-admitted queued retry retains its spent allowance and can
resume at the budget limit. Dispatch checks the adapter's engine and
read-only capabilities again, including on queued resumption. A queued
intent may refresh its launch-host identity before dispatch; the identity
is immutable after launch begins.

The state store rejects changes to historical identities, dispatch intent,
recorded process/session/submission identities, outcomes, evidence history,
or released reservations. Retry counters must agree with recorded attempts.
Histories are bounded to 64 attempts per role, 64 observations, 64 terminal
artifact versions per attempt, and 64 tracked descendants. Heartbeat and
checkpoint evidence keeps only its latest accepted provenance. Existing
history may retain up to 64 legacy progress entries separately from the
terminal-artifact limit.
Reaching a bound fails explicitly; history is not silently discarded.
The canonical 16 MiB state limit still applies.

## Fixture adapter contract

Only the `_fixtureAdapter` programmatic option enables lifecycle dispatch:

```js
{
  kind: 'fixture',
  capabilities: {
    engines: ['agency-copilot'],
    read_only_enforced: false,
    tracks_descendants: true
  },
  async launch(attempt, { observe }) { /* fixture effects only */ },
  async reconcile(attempt, { observe }) { /* optional, observation only */ }
}
```

This injection is trusted test code, not a worker-accessible capability or
a production adapter. It cannot be selected in a manifest or on the CLI.
Read-only declarations require `read_only_enforced: true`; QA otherwise
reserves the checkout as a writer. `tracks_descendants` means the fixture
can account for the engine's entire mutating descendant lifetime, including
children that outlive the engine. Missing tracking capability prevents
process-only release; matching cooperative release or reboot can still
establish closure.

`observe` requires `id`, `kind`, and the exact
`{ run_id, phase_id, role, review_iteration, attempt_id }` tuple. Supported
kinds are:

| Kind | Required evidence |
|---|---|
| `launch_process` | `process: { pid, creation_time, hostname, host_boot_id }` |
| `session` | `session_id` and the engine `process` identity |
| `submission` | `acknowledged: true` |
| `descendants` | `processes: [processIdentity]`, `complete: true` |
| `launch_failed` | `no_external_effect: true`, nonempty `reason`, and no previously observed external process/session/submission |
| `closure` | `launch_settled: true`, `engine_closed: true`, `descendants_closed: true`; rejected if the current OS sample proves a tracked process live |

Observation IDs deduplicate by payload fingerprint. Reusing an ID with
different evidence fails. Late callbacks after the adapter call has
returned are rejected. `reconcile` may supply late acknowledgements for
the same attempt, or supported closure evidence for an unidentified
launch, without resubmitting work. It must not perform launch effects.
Dispatched attempts remain eligible for closure reconciliation after an
outcome until their reservation is released, including attempts superseded
by later review iterations. Historical terminal attempts accept only
release artifacts and process/adapter closure evidence; their other worker
reports cannot change phase progression. Current attempts alone determine
review progression, outcomes, and retry eligibility. Additive descendant/closure
observations cannot rewrite that outcome or its process/submission identity.
No observation or artifact-provided role label grants operator authority.

## Attempt artifacts and review

`artifactPaths(primaryWorkspace, identity)` returns paths under:

```text
<primary-root>\docs\orchestration\runs\<run_id>\phases\<phase_id>\
  <role>\<review_iteration>\<attempt_id>\
    <role>-prompt.md
    completion.json
    heartbeat.json
    verdict.json
    checkpoint.json
    release.json
```

Artifact reads require an ordinary file, reject redirected path components,
and read at most 256 KiB. JSON or YAML-frontmatter reports must include
`schema_version: 2`, the exact identity tuple, `kind`, and `observed_at`.
Old-run, old-attempt, sibling-role and wrong-iteration reports are rejected.
Conventional V1 paths and mtimes are never V2 completion authority.
Accepted evidence records retain the path, SHA-256, full identity, and
`source: worker_report`. This is reported completion, not independent
verification.

Malformed, oversized, incomplete, or invalidly shaped worker reports
produce per-attempt diagnostics and require intervention while other
attempts remain observable. Corrected reports can be reconciled later.
Infrastructure read failures still fail explicitly; they are not treated
as missing or invalid worker reports.

Completion requires `status: complete`. Blocked or partial work requires
intervention. QA also requires an attempt-bound verdict containing
`verdict: pass|fail` and `verification: [{ id, status, evidence }]`.
Required rows are `scope`, `P1`, `P2`, `P3`, `P4`, and `P6`. A pass needs
exactly one passing entry with nonempty evidence for every required row.
Skipped or missing verification cannot pass. With an enabled review loop,
valid QA failures advance the review iteration only after safe release.
Without a review loop, a valid negative verdict fails the phase, including
QA-only and mixed-role phases, without charging launch or execution retries.
Terminal outcomes retain their evidence and continue reconciling closure.
Successful and failed review
rounds retain their evidence in `review_history`.
An incomplete QA report without a valid fail verdict remains an
intervention condition even after process closure; it does not spend an
execution retry or bypass missing verification.

Review iterations are zero-based. `review_loop.max_iterations` bounds QA
rounds. Each role separately has two launch/delivery retries and two
execution-recovery retries for the run; those counts do not reset between
review rounds. QA launch failure preserves the completed impl attempt,
QA stage, and review iteration. Each role has its own process identity and
start clock, and all role observations are reconciled before scheduling.
Dependency-only blockers are recomputed after upstream completion;
operator/configuration blockers are preserved.

Persisted pause continues to accept reports and reconcile closure while
suppressing every new dispatch, including QA, retries and recovery.
Recovery prompts retain immutable prior prompt references and point all
new writes to the new attempt. They do not copy or replay an old kickoff.
V2 recovery uses the explicit historical prompt for context audits and the
controller's closure decision, not V1's local `.original.md` or heartbeat
PID instructions. V1 recovery retains those legacy instructions.
Every role, including coordinator, receives accepted upstream artifact
identities, paths, and hashes in its rendered prompt.

## Process evidence and durable checkout reservations

`spawn-session.observeProcessTable()` returns
`{ sample_id, observed_at, complete, hostname, host_boot_id, processes, error? }`.
Each process row has `pid`, `creation_time`, and `parent_pid`. The full
Windows CIM query is unfiltered; the existing V1 name lookup still returns
a numeric PID or null. `check-health.observeProcessIdentity(identity, sample)`
returns `{ state: 'live'|'dead'|'unknown', reason }`.
Both successful and failed probes use Node's host name; host-name
comparisons are case-insensitive.
Creation-time identity uses the shared precision-aware `creationTimeKey`:
equivalent timestamp formats deduplicate, submillisecond differences remain
distinct, and missing creation evidence never matches known creation evidence.

Complete, successful tables prove an identified engine dead when its PID
is absent or its creation time differs. Missing creation/boot evidence,
failed or incomplete tables, and unacknowledged session-name misses remain
unknown. Changed known boot identity proves the old local processes dead.
PID reuse never authorizes targeting the replacement process. This module
does not issue process cancellation.

`process_sample_watermark` stores the sample ID and observation time at
dispatch or later process correlation. Termination evidence must be newer
than that watermark and cannot predate the identified process's creation.
Reusing an empty pre-launch table never proves that a newly launched
worker is dead. The watermark survives controller restart.

Health records retain sample ID and observation time; duplicate or older
samples do not increase unknown counts. Failed probes persist
`process_diagnostic`, set `runtime_status: process_observation_failed`,
and are logged by the runner. Storage failures throw without successful
acknowledgement or dispatch.
The next healthy sample removes that diagnostic. Fresh health-only updates
may advance the revision but add no outbox events or command results;
an identical repeated sample produces no new revision.

Engine termination and checkout release are distinct. Tracked descendants,
including children first observed when their parent disappears, retain the
reservation until they also close. A matching `release` report with
`released: true` and `no_further_writes: true` permits handoff while keeping
the interactive terminal available for inspection. It promises that the
worker and its descendants will perform no further project writes without
a new assignment. Completion and idle state alone do not provide this
promise. Cooperative release uses the trusted-worker model; it does not
revoke OS permissions.

Process closure retains its decisive health sample in the immutable
`reservation.closure.process_evidence` record, including confirmation that
descendants are closed. Later health observations or repaired completion
reports do not invalidate that proof when deciding whether to rerun.
A conclusive reboot can use correlated launcher boot evidence even when
the engine session was never identified; same-boot launcher disappearance
alone remains insufficient.

Process-only closure requires an eligible complete descendant scan, not a
skipped scan interpreted as an empty result. A correlated engine's known
boot identity takes precedence over launcher and dispatch boot evidence
on the same host, so late correlation cannot disable descendant tracking.
Same-boot engine termination still requires its creation identity.
The controller's own boot evidence is not a substitute. Without trustworthy
scan association, the reservation stays held until explicit closure or
cooperative release; a complete observation of a changed known host boot
can independently establish reboot closure. Dispatch/correlation watermarks
still fence all negative process evidence.

There is one durable private record per reserved checkout:

```text
<LocalApplicationData>\agent-orchestrator\runtime\<workspace-hash>\
  controller\reservation.json
```

Its fields are `{ schema_version: 1, workspace_key, manifest_path, run_id,
phase_id, role, review_iteration, attempt_id }`. The containing directory
has the current-user-only ACL. Publication uses a flushed temporary file
and atomic rename while holding the checkout's `controller` kernel claim.
`readCheckoutReservation`, `reserveCheckout`, and `releaseCheckout` require
the actual live owner handle. Metadata cannot substitute for that handle.
Manifest paths use the same absolute, case-normalized comparison during
acquisition and reservation updates on Windows, including existing
mixed-case records.

The canonical manifest-sibling status file is not a workspace registry.
The private record survives controller exit and blocks unrelated V1/V2
controllers even after the pipe is gone. Only the recorded manifest and
run may reacquire its claim; that run must find the exact attempt in
canonical state before doing work. Every additional writable checkout
uses the same kernel claim and private record, not just an in-memory map.
Conflicting ownership is refused rather than stolen.

Closure is committed in canonical state before the private reservation is
removed. A crash between those operations is reconciled on restart.
`reservation_cleared` acknowledges removal only after it succeeds; until
then startup reacquires even a released attempt's additional checkout.
Unresolved records are retained on storage errors or shutdown. Additional
checkout handles are conservatively retained until lifecycle close.
Explicit rerun can replace an untouched, undispatched run. Otherwise every
started phase must be completed or failed, and every historical attempt must have a
supported terminal lifecycle outcome and concrete cooperative, adapter,
no-external-effect, or process closure evidence. Mutating attempts also need
confirmed private reservation cleanup. Never-started pending or
dependency-blocked phases have no worker ownership to drain and do not
prevent rerun. Live, unknown, queued, or
uncleared work cannot be discarded through rerun.

Rerun startup first checks canonical closure eligibility, projects pending
events, then synchronizes reservations under the **old run ID**, without
invoking its fixture adapter. Cleanup transitions are projected before
`store.rerun`; rerun requires a drained, non-degraded projection.
Only after cleanup succeeds does `store.rerun` publish the new ID and retain
the complete prior run in immutable history. Imported V1 history remains
available in the current `legacy_history` array as well. Additional old-run checkout
handles are closed before the replacement lifecycle is constructed. Failed
cleanup or publication never authorizes dispatch under a new identity.
