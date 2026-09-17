# Runtime state and ownership

The V2 foundation supports Windows and Node >=20. Its Windows ownership
tests run real competing Node processes. Worker dispatch remains disabled
until engine adapters pass their acceptance checks.

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
on that record; PID alone is not process identity. No attempt is created or
dispatched by the foundation.

`createStateStore({ manifestPath, owner })` returns synchronous methods:

| Method | Contract |
|---|---|
| `read()` | Read and validate without writing; missing file returns `null`. |
| `initialize(accepted)` | Create a run, or return the existing V2 record unchanged. Completed V1 phases are copied into `legacy_history`. |
| `transact({ expectedRevision, command, mutate })` | Clone the current record, invoke a synchronous callback, and atomically publish state, command response, and events. |
| `rerun({ expectedRevision, accepted })` | Create a new run ID and retain the prior record, without recursively nesting history. Reject different workspaces and attempts needing closure reconciliation. |

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

The callback cannot change canonical identities, previous runs, imported
history, command results, outbox bookkeeping, or the accepted snapshot.
Structural acceptance and outbox draining need dedicated owned
transactions in their respective feature implementations. The callback
must return JSON data and an event array; it must not perform external
launch effects.

Events have `{ sequence, event_id, run_id, revision, type, payload }`.
`event_id` is `<run_id>:<sequence>`. Sequence numbers increase within a run;
the canonical revision increases across reruns. JSONL projection is not
implemented by the foundation. An existing JSONL file is preserved, but
its presence does not prove that any canonical event was projected.

Publication creates a unique same-directory temporary file, writes and
flushes it, checks live ownership and the unchanged previous record, then
renames it over the canonical file. Write, flush, and rename failures throw
without returning a successful command response. Readers see the previous
or new complete record. This is a process-crash publication contract, not
a guarantee against filesystem or device failure during machine power
loss. Invalid/newer records are rejected without repair or rewriting.
V1 `loadStatus` retains its compatibility normalization; V2 uses strict
validation, and V1 `runUpdate` refuses V2 even with cached V1 injection data.

## Kernel ownership and discovery

`acquireWorkspaceOwner(workspace, options)` binds a Windows named-pipe
listener whose name contains the namespace and SHA-256 of the full key.
The default namespace is `controller`; the same primitive accepts other
namespaces for companion services and future writable-checkout claims.
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
directory, declared primary workdir protocol directory, and canonical
worktree protocol directory. Live or uncertain owners block activation.
Confirmed process absence, reliable creation-time mismatch, or a changed
known host boot identity permits draining matching stale records. Legacy
`startedAt` alone is insufficient for PID-reuse proof because older writers
could store a wall-clock fallback.

Operators must stop using pre-upgrade binaries for that workspace. An old
binary launched after the drain check is outside this upgrade guarantee.
Deleting lock metadata does not release a live named pipe.

## Integration boundaries

`startV2Foundation(options)` acquires ownership, initializes/resumes state,
creates run-scoped directories, and returns
`{ owner, store, state, authoring, summary }`. Its caller must release the
owner in `finally`. `runOrchestrator` holds that handle until shutdown or
its tick limit; it never enters the V1 dispatcher for V2.

Artifacts are scoped beneath
`<workspace-root>\docs\orchestration\runs\<run-id>\`.
Scaffolding requires the persisted accepted snapshot and a live owner;
dry-run preview needs an accepted snapshot and a run ID but writes nothing.
Ordinary restarts preserve artifacts, events, paused state, and the
accepted snapshot. Authoring validation errors/drift are reported
separately, without replacing the run.

Lifecycle implementation must establish attempt and descendant closure,
retain uncertain reservations, and use kernel claims for every writable
checkout before enabling new dispatch. State remains keyed by manifest
path while ownership is keyed by worktree: switching to a different
manifest is not proof that old workers have stopped. Live engine
acceptance, event projection, authenticated operator mutations, and
dashboard services are separate integrations.
