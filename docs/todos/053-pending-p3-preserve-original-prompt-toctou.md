---
status: pending
priority: p3
issue_id: "053"
tags: [code-review, post-pr-13, ce-review, scripts, security, race-condition]
dependencies: []
---

# `preserveOriginalPrompt` has a TOCTOU window between `existsSync` and `atomicWrite`

PR #13 ce:review's security-sentinel flagged that
`preserveOriginalPrompt` does an `existsSync` check followed by an
`atomicWrite` to the same path. Two concurrent recovery dispatches
for the same role can both pass the existsSync, both read
livePath, and both write to origPath — breaking the documented
"first non-recovery prompt across the entire crash chain"
invariant.

## Problem Statement

`agent-orchestrator/scripts/generate-prompt.js:486-494`:

```js
function preserveOriginalPrompt(outputDir, effectiveRole) {
  const livePath = path.join(outputDir, `${effectiveRole}-prompt.md`);
  const origPath = path.join(outputDir, `${effectiveRole}-prompt.original.md`);
  if (!fs.existsSync(livePath)) return false;
  if (fs.existsSync(origPath)) return false;
  const live = fs.readFileSync(livePath, 'utf8');
  atomicWrite(origPath, live);
  return true;
}
```

The `if (fs.existsSync(origPath)) return false;` check at line 490
is the idempotency gate — re-recovery dispatches see the
`.original.md` slot is taken and skip the copy. Between this check
(t0) and `atomicWrite(origPath, live)` (t1) there is a TOCTOU
window where another writer can land at origPath.

Concretely: two concurrent recovery dispatches A and B both call
`preserveOriginalPrompt` at near-identical times.

1. A: `existsSync(origPath)` → false. Pass.
2. B: `existsSync(origPath)` → false. Pass.
3. A: `readFileSync(livePath)` → live_A.
4. B: `readFileSync(livePath)` → live_B (== live_A, since live
   hasn't been overwritten yet).
5. A: `atomicWrite(origPath, live_A)`. Slot now contains live_A.
6. B: `atomicWrite(origPath, live_B)`. Slot now contains live_B.

If live_A == live_B (the common case — both reads happened before
either writer wrote to livePath), the bytes are identical and the
race is harmless. If a third writer (the actual recovery prompt
write at line 787) interleaves between A's livePath read and B's
livePath read, the loser's copy may be the wrong content,
breaking the documented invariant that `.original.md` holds the
FIRST non-recovery prompt across the entire crash chain.

## Findings

PR #13 ce:review security-sentinel P3:

> "`generate-prompt.js:486-494` — preserveOriginalPrompt does
> existsSync(origPath) then atomicWrite(origPath, live), a TOCTOU
> window between check and write. Two concurrent recovery
> dispatches can both pass the existsSync, both read livePath,
> both rename onto origPath. If livePath is unchanged between
> reads, writes are bit-identical (harmless); if a third writer
> interleaves, the loser clobbers the winner."

## Proposed Solutions

### Option A — Use exclusive create (`fs.openSync(origPath, 'wx')`)

Replace the check-then-write with an atomic exclusive create. The
first writer succeeds; subsequent writers get `EEXIST` and return
`false`. No TOCTOU window. Subsumes the existsSync-on-origPath
check.

```js
function preserveOriginalPrompt(outputDir, effectiveRole) {
  const livePath = path.join(outputDir, `${effectiveRole}-prompt.md`);
  const origPath = path.join(outputDir, `${effectiveRole}-prompt.original.md`);
  if (!fs.existsSync(livePath)) return false;
  const live = fs.readFileSync(livePath, 'utf8');
  let fd;
  try {
    fd = fs.openSync(origPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeFileSync(fd, live);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}
```

- **Pros:** Eliminates the TOCTOU window. First-writer-wins is
  enforced by the kernel, not by JS-side check ordering. Behavior
  identical for the single-dispatch case. Note: this trades the
  current `atomicWrite` (write to `.tmp`, rename) for a direct
  `wx` open — losing the partial-write atomicity. Could be
  retained by writing to `${origPath}.tmp` with `wx` then
  rename, but rename overwrites by default; would need
  `fs.linkSync` + unlink dance for full atomicity. Acceptable
  tradeoff because preservation is a one-time, small write
  (the live prompt file) and a partial write of the
  `.original.md` will be re-written on the next recovery, since
  the first-writer-wins is now a property of the rename target.
- **Cons:** Slight complexity increase (try/catch around the
  open). Loses `atomicWrite`'s tmp+rename pattern unless
  combined with `link`+`unlink`.
- **Effort:** Small.
- **Risk:** Low. Existing tests for single-dispatch preservation
  unchanged.

### Option B — Accept (orchestrator design forbids concurrent dispatches)

Document at the function declaration that it is the orchestrator's
responsibility to never invoke two recovery dispatches for the same
phaseDir + role concurrently. Treat the TOCTOU window as
out-of-contract.

- **Pros:** Zero code change. Reflects the actual operational
  constraint.
- **Cons:** Pushes a safety property onto an undocumented
  caller-side invariant. A future Unit 11 implementer parallelizing
  recovery across phases (legal) might accidentally race the same
  phase + role (illegal but undefended).
- **Effort:** Trivial (JSDoc paragraph).
- **Risk:** Low while orchestrator is single-threaded;
  speculative beyond.

### Option C — Defer

No real concurrent-recovery scenario exists in V1.

- **Pros:** Zero churn.
- **Cons:** Latent until Unit 11 enables concurrency.
- **Effort:** Zero.
- **Risk:** Low.

## Recommended Action

Coord triage pending. Recommend Option A if/when this lands in the
post-Unit-7 doc cleanup PR — the `wx` open is a small, idiomatic
fix that eliminates the window. If Option A is rejected for
atomic-write-pattern reasons, Option B's JSDoc note is the cheap
fallback.

## Technical Details

- Affected file: `agent-orchestrator/scripts/generate-prompt.js`
- Lines: 486-494 (function body).
- `atomicWrite` (currently used) writes to `${path}.tmp` then
  renames; Option A replaces this with `fs.openSync(origPath,
  'wx')` + `fs.writeFileSync(fd, ...)`.
- Test impact: existing single-dispatch preservation tests
  unchanged. New test could simulate two concurrent calls and
  assert exactly one returns true.

## Acceptance Criteria

- [ ] Triage captures chosen Option.
- [ ] If A: `preserveOriginalPrompt` uses `fs.openSync(origPath,
  'wx')` (or equivalent O_EXCL primitive) to gate the write.
- [ ] If A: re-recovery dispatch (origPath already exists) still
  returns false without overwriting.
- [ ] If A: first-dispatch (origPath does not exist) writes the
  live contents to origPath.
- [ ] Tests still green.

## Work Log

- **2026-04-29 — todo created** — Surfaced by PR #13 ce:review
  (security-sentinel P3). Coord triage pending.

## Resources

- PR #13: https://github.com/newton20/agent-orchestration/pull/13
- `agent-orchestrator/scripts/generate-prompt.js:486-494` —
  function body.
- `agent-orchestrator/templates/README.md` §5 — invariant
  documentation: ".original.md slot holds the FIRST non-recovery
  prompt across the entire crash chain".
- Todo 017 — recovery preservation behavior (closed).
