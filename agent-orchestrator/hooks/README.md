# hooks/ — Unit 5 SessionStart hook

Reads the oldest-fresh `.pending-<id>` flag file under
`$CLAUDE_PROJECT_DIR/docs/orchestration/` on every Claude session start
and injects its contents as the initial `additionalContext`. No flag
file → no-op.

The flag-file fallback mechanism is the only viable design: the Unit 4.5
spike ([`../spikes/launcher-compat-findings.md`](../spikes/launcher-compat-findings.md))
established that `--name` is never exposed to SessionStart hooks under
any tested launcher (direct `claude` from cmd or PowerShell, `agency
claude` from PowerShell). Name-based detection is dead.

## Files

- `hooks.json` — SessionStart hook registration (matcher:
  `startup|clear|compact`, forward-slash path to the `.cmd` wrapper).
- `run-hook.cmd` — Windows wrapper. Claude Code on Windows executes hook
  commands through Git Bash, but bash can exec `.cmd` files, so the
  wrapper is the safest invocation across both shells.
- `session-start.js` — hook body. Pure Node, no Windows-specific APIs.
- `session-start.test.js` — node:test suite.
- `package.json` — `npm test` wiring.

## Contract

1. Read `CLAUDE_PROJECT_DIR`. Unset / empty / non-absolute → output `{}`,
   exit 0.
2. Scan `docs/orchestration/` for `/^\.pending-[A-Za-z0-9._-]+$/`
   entries. Missing dir → `{}`. Stat each match; filter to files younger
   than 60s (TTL). No fresh matches → `{}`.
3. Sort fresh by `mtimeMs` ascending. Atomically rename the oldest to
   `.consuming-<id>-<pid>-<ms>-<i>` (sibling path, does NOT start with
   `.pending-` so leftovers are never re-matched). If the rename races
   (ENOENT), fall through to the next candidate and keep trying — there
   is no arbitrary retry cap. The candidate list is bounded by
   `readdirSync`, and an N-way concurrent spawn needs up to N attempts
   to guarantee every hook consumes a flag.
4. Size guard: reject content > 256 KB (output `{}`, clean up the
   `.consuming-*` tmpfile).
5. Read the renamed file as UTF-8. Content IS the prompt text (plain
   markdown — no YAML framing).
6. Delete the `.consuming-*` file (best-effort).
7. Output `JSON.stringify({ additionalContext: content })`, exit 0.

**Any IO error at any step → stderr log (`[unit-5-hook] <reason>`) +
output `{}`.** The hook never throws and never exits nonzero. A
misbehaving hook that blocks session start is worse than no hook at all.

## Contract invariants

- `FLAG_NAME_RE` (`session-start.js`) and `VALID_ID_RE`
  (`../scripts/parse-manifest.js`) share an ID character class. Change
  both or neither — see `docs/todos/006`.
- Stale `.pending-*` files are unlinked best-effort once their age
  exceeds `STALE_HARD_TTL_MS` (10 × `FLAG_TTL_MS` = 10 minutes). Files
  in `[FLAG_TTL_MS, STALE_HARD_TTL_MS)` stay on disk as a debug window
  for failed spawns.

## Manual end-to-end test (Windows)

1. Scaffold an orchestration tree (Unit 3):

   ```cmd
   node ..\scripts\scaffold-protocol.js --manifest manifest.yaml --plugin-dir ..
   ```

2. Drop a flag file:

   ```cmd
   echo Start this session by reading plan.md and summarising it. > docs\orchestration\.pending-demo-1
   ```

3. Start a Claude session from the same dir with the plugin active. The
   session's first agent message should reflect the injected text.

4. Verify the flag was consumed:

   ```cmd
   dir /b docs\orchestration\.pending-* 2>nul
   dir /b docs\orchestration\.consuming-* 2>nul
   ```

   Both commands should return nothing.

**Cleanup**: any `.pending-*` or `.consuming-*` files are safe to delete
manually. The scaffolder does not write them; only Unit 11 (once it
ships) or a manual tester does.

## Plugin activation caveat (spike finding)

The Unit 4.5 spike found that `--plugin-dir <path>` hook activation was
unreliable on the test machine. Until the marketplace install path
crystallises in Unit 11, a working fallback is to register the hook in
`<repo>/.claude/settings.json` directly. Forward-slash paths are
mandatory; Claude Code on Windows invokes hook commands through Git
Bash, which interprets backslashes as C-escapes.
