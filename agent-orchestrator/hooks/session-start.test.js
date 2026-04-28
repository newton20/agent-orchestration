/**
 * Unit 5 test suite. Uses node:test (built-in).
 * Run: npm test   (from agent-orchestrator/hooks/)
 *
 * Two execution modes:
 *   - In-process `runHook(opts)` calls — fast, deterministic, allow
 *     injected fsLib for race + IO-error simulation.
 *   - `spawnSync('node', [hookPath])` — true black-box verification of
 *     the CLI entrypoint, env handling, exit code, and stdout/stderr
 *     split.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  runHook,
  FLAG_TTL_MS,
  STALE_HARD_TTL_MS,
  MAX_FLAG_BYTES,
  FLAG_NAME_RE,
} = require('./session-start');

const HOOK_PATH = path.join(__dirname, 'session-start.js');

// -------------------- fixture helpers --------------------

function mkProjectDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unit5-hook-'));
  return root;
}

function mkOrchDir(projectDir) {
  const dir = path.join(projectDir, 'docs', 'orchestration');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFlag(orchDir, id, content, { mtimeMs } = {}) {
  const p = path.join(orchDir, `.pending-${id}`);
  fs.writeFileSync(p, content);
  if (typeof mtimeMs === 'number') {
    const t = new Date(mtimeMs);
    fs.utimesSync(p, t, t);
  }
  return p;
}

function listPendingFiles(orchDir) {
  if (!fs.existsSync(orchDir)) return [];
  return fs.readdirSync(orchDir).filter((n) => /^\.pending-/.test(n)).sort();
}

function listConsumingFiles(orchDir) {
  if (!fs.existsSync(orchDir)) return [];
  return fs.readdirSync(orchDir).filter((n) => /\.consuming-/.test(n)).sort();
}

function runCli(env) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    env,
    encoding: 'utf8',
  });
}

function cliEnv(overrides) {
  const env = Object.assign({}, process.env);
  delete env.CLAUDE_PROJECT_DIR;  // start from a clean slate
  return Object.assign(env, overrides || {});
}

// -------------------- 1. env unset → {} via CLI --------------------

test('CLI: CLAUDE_PROJECT_DIR unset → stdout is {} and exit 0', () => {
  const res = runCli(cliEnv());
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '{}');
  assert.deepStrictEqual(JSON.parse(res.stdout), {});
});

// -------------------- 2. env empty string → {} via CLI --------------------

test('CLI: CLAUDE_PROJECT_DIR empty string → {} exit 0', () => {
  const res = runCli(cliEnv({ CLAUDE_PROJECT_DIR: '' }));
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '{}');
});

// -------------------- 3. env points to non-existent dir → {} --------------------

test('env points to non-existent dir → {}', () => {
  const bogus = path.join(os.tmpdir(), 'unit5-hook-does-not-exist-' + Date.now());
  assert.strictEqual(fs.existsSync(bogus), false);
  const out = runHook({ projectDir: bogus });
  assert.strictEqual(out, '{}');
  assert.deepStrictEqual(JSON.parse(out), {});
});

// -------------------- 4. no docs/orchestration subtree → {} --------------------

test('no docs/orchestration subtree → {}', () => {
  const root = mkProjectDir();
  // Intentionally do NOT create docs/orchestration.
  const out = runHook({ projectDir: root });
  assert.strictEqual(out, '{}');
});

// -------------------- 5. subtree exists, no flag files → {} --------------------

test('subtree exists, no .pending-* files → {}', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  // Some unrelated files in the directory — shouldn't match.
  fs.writeFileSync(path.join(orch, 'events.jsonl'), '');
  fs.writeFileSync(path.join(orch, 'README.md'), '# notes');
  const out = runHook({ projectDir: root });
  assert.strictEqual(out, '{}');
});

// -------------------- 6. single fresh flag → content injected, file deleted --------------------

test('single fresh .pending-<id> → additionalContext + file deleted', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  const prompt = '# Initial briefing\n\nDo the thing.\n';
  writeFlag(orch, 'demo-1', prompt);

  const out = runHook({ projectDir: root });
  const parsed = JSON.parse(out);
  assert.deepStrictEqual(parsed, { additionalContext: prompt });

  assert.deepStrictEqual(listPendingFiles(orch), []);
  assert.deepStrictEqual(listConsumingFiles(orch), []);
});

// -------------------- 7. single stale flag → {} + preserved --------------------

test('single stale .pending-<id> (older than TTL, within hard TTL) → {} and file preserved', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  const stalePath = writeFlag(orch, 'stale', 'old content', {
    mtimeMs: Date.now() - FLAG_TTL_MS - 10_000,
  });

  const out = runHook({ projectDir: root });
  assert.strictEqual(out, '{}');
  assert.strictEqual(fs.existsSync(stalePath), true);
  assert.strictEqual(fs.readFileSync(stalePath, 'utf8'), 'old content');
});

// -------------------- 7a. two-tier TTL — todo 005 --------------------

test('STALE_HARD_TTL_MS is exported and is 10 × FLAG_TTL_MS', () => {
  assert.strictEqual(STALE_HARD_TTL_MS, 10 * FLAG_TTL_MS);
});

test('flag older than hard TTL → unlinked best-effort (todo 005 Option B)', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  const now = Date.now();
  // Hard-stale flag (≥ 10 min) — must be GC'd.
  const hardStale = writeFlag(orch, 'ancient', 'forgotten', {
    mtimeMs: now - STALE_HARD_TTL_MS - 30_000,
  });
  // Soft-stale flag (between soft and hard) — must be preserved.
  const softStale = writeFlag(orch, 'recent-stale', 'still useful', {
    mtimeMs: now - FLAG_TTL_MS - 10_000,
  });

  const out = runHook({ projectDir: root, now });
  assert.strictEqual(out, '{}');
  assert.strictEqual(fs.existsSync(hardStale), false, 'hard-stale flag should be unlinked');
  assert.strictEqual(fs.existsSync(softStale), true, 'soft-stale flag should be preserved');
});

test('hard-TTL unlink ignores ENOENT race (todo 005)', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  const now = Date.now();
  writeFlag(orch, 'racing-gc', 'gone', {
    mtimeMs: now - STALE_HARD_TTL_MS - 1_000,
  });

  // Simulate a concurrent unlink: our unlinkSync sees ENOENT. Hook must
  // not throw and must still return {}.
  const fsLib = Object.create(fs);
  fsLib.unlinkSync = () => {
    const err = new Error('ENOENT');
    err.code = 'ENOENT';
    throw err;
  };

  const out = runHook({ projectDir: root, now, fsLib });
  assert.strictEqual(out, '{}');
});

// -------------------- 8. multiple fresh → oldest wins, others preserved --------------------

test('multiple fresh flags → oldest mtime wins, others preserved', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  const now = Date.now();
  const oldestPath = writeFlag(orch, 'alpha', 'oldest prompt', { mtimeMs: now - 30_000 });
  const midPath = writeFlag(orch, 'bravo', 'middle prompt', { mtimeMs: now - 20_000 });
  const newestPath = writeFlag(orch, 'charlie', 'newest prompt', { mtimeMs: now - 10_000 });

  const out = runHook({ projectDir: root, now });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.additionalContext, 'oldest prompt');

  assert.strictEqual(fs.existsSync(oldestPath), false);
  assert.strictEqual(fs.existsSync(midPath), true);
  assert.strictEqual(fs.existsSync(newestPath), true);
  assert.deepStrictEqual(listConsumingFiles(orch), []);
});

// -------------------- 9. fresh + stale mix → oldest fresh wins, stale preserved --------------------

test('fresh + stale mix → oldest fresh wins; stale preserved regardless of mtime ordering', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  const now = Date.now();
  // Stale with the OLDEST mtime overall — must NOT be selected.
  const stalePath = writeFlag(orch, 'ancient', 'ancient', { mtimeMs: now - FLAG_TTL_MS - 30_000 });
  // Fresh candidates — oldest fresh wins.
  const oldFreshPath = writeFlag(orch, 'old-fresh', 'old fresh', { mtimeMs: now - 30_000 });
  const newFreshPath = writeFlag(orch, 'new-fresh', 'new fresh', { mtimeMs: now - 1_000 });

  const out = runHook({ projectDir: root, now });
  assert.strictEqual(JSON.parse(out).additionalContext, 'old fresh');

  assert.strictEqual(fs.existsSync(stalePath), true);     // stale preserved
  assert.strictEqual(fs.existsSync(oldFreshPath), false); // oldest fresh consumed
  assert.strictEqual(fs.existsSync(newFreshPath), true);  // newer fresh preserved
});

// -------------------- 10. race simulation: rename throws ENOENT, falls through --------------------

test('race: rename throws ENOENT on first candidate → falls through to next', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  const now = Date.now();
  const firstPath = writeFlag(orch, 'raced', 'raced content', { mtimeMs: now - 2_000 });
  writeFlag(orch, 'winner', 'winner content', { mtimeMs: now - 1_000 });

  // Wrap fs so the first rename attempt (on the oldest candidate)
  // throws ENOENT — as if another hook consumed it between readdir and
  // rename. Subsequent renames proceed normally.
  let racedOnce = false;
  const fsLib = Object.create(fs);
  fsLib.renameSync = (from, to) => {
    if (!racedOnce && from === firstPath) {
      racedOnce = true;
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return fs.renameSync(from, to);
  };

  const out = runHook({ projectDir: root, now, fsLib });
  assert.strictEqual(JSON.parse(out).additionalContext, 'winner content');
  assert.strictEqual(racedOnce, true);

  // The "raced" file was never actually renamed in the sim, so it sits
  // on disk. The "winner" file WAS consumed.
  assert.strictEqual(fs.existsSync(firstPath), true);
  assert.strictEqual(fs.existsSync(path.join(orch, '.pending-winner')), false);
});

test('race: every candidate loses → {} (no arbitrary cap, bounded by readdir)', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  const now = Date.now();
  // Four candidates, all "lose" the race — hook tries each, then gives
  // up once the list is exhausted.
  writeFlag(orch, 'a', 'a', { mtimeMs: now - 40_000 });
  writeFlag(orch, 'b', 'b', { mtimeMs: now - 30_000 });
  writeFlag(orch, 'c', 'c', { mtimeMs: now - 20_000 });
  writeFlag(orch, 'd', 'd', { mtimeMs: now - 10_000 });

  let renameAttempts = 0;
  const fsLib = Object.create(fs);
  fsLib.renameSync = () => {
    renameAttempts++;
    const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
  };

  const out = runHook({ projectDir: root, now, fsLib });
  assert.strictEqual(out, '{}');
  // All four candidates attempted — no artificial cap at 3.
  assert.strictEqual(renameAttempts, 4);
});

test('race: N-1 candidates lose, last wins (no arbitrary cap)', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  const now = Date.now();
  const pathA = writeFlag(orch, 'a', 'a-content', { mtimeMs: now - 40_000 });
  const pathB = writeFlag(orch, 'b', 'b-content', { mtimeMs: now - 30_000 });
  const pathC = writeFlag(orch, 'c', 'c-content', { mtimeMs: now - 20_000 });
  const pathD = writeFlag(orch, 'd', 'd-content', { mtimeMs: now - 10_000 });

  const losers = new Set([pathA, pathB, pathC]);  // first 3 race-lose
  const fsLib = Object.create(fs);
  fsLib.renameSync = (from, to) => {
    if (losers.has(from)) {
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    }
    return fs.renameSync(from, to);
  };

  const out = runHook({ projectDir: root, now, fsLib });
  // The 4th candidate wins — this is the concurrent-spawn scenario that
  // a 3-attempt cap would have silently dropped.
  assert.strictEqual(JSON.parse(out).additionalContext, 'd-content');
  assert.strictEqual(fs.existsSync(pathD), false);
});

// -------------------- 11. path-traversal / invalid filename → rejected --------------------

test('weird filename chars rejected by FLAG_NAME_RE; file preserved', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  // Filesystems don't allow "/" in names so we can't literally write
  // `.pending-../escape`, but we can write a name that violates the
  // allow-list (space char, `$`). Both should be rejected.
  const weird1 = path.join(orch, '.pending-has space');
  const weird2 = path.join(orch, '.pending-$hell');
  fs.writeFileSync(weird1, 'nope');
  fs.writeFileSync(weird2, 'nope');

  const out = runHook({ projectDir: root });
  assert.strictEqual(out, '{}');
  assert.strictEqual(fs.existsSync(weird1), true);
  assert.strictEqual(fs.existsSync(weird2), true);
});

test('FLAG_NAME_RE allow-list matches VALID_ID shape', () => {
  assert.match('.pending-phase-0-impl', FLAG_NAME_RE);
  assert.match('.pending-A.B_C-1', FLAG_NAME_RE);
  assert.doesNotMatch('.pending-', FLAG_NAME_RE);
  assert.doesNotMatch('.pending-../escape', FLAG_NAME_RE);
  assert.doesNotMatch('.pending-has space', FLAG_NAME_RE);
  assert.doesNotMatch('pending-no-dot', FLAG_NAME_RE);
});

// -------------------- 12. oversize content → {} + cleanup --------------------

test('flag content > MAX_FLAG_BYTES → {} and .consuming-* cleaned up', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  const big = 'x'.repeat(MAX_FLAG_BYTES + 1);
  writeFlag(orch, 'oversize', big);

  const out = runHook({ projectDir: root });
  assert.strictEqual(out, '{}');
  assert.deepStrictEqual(listConsumingFiles(orch), []);
  // The original flag was renamed to .consuming-* then deleted — so no
  // .pending-oversize either.
  assert.deepStrictEqual(listPendingFiles(orch), []);
});

// -------------------- 13. 0-byte flag → empty additionalContext --------------------

test('0-byte flag → stdout {"additionalContext":""}', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  writeFlag(orch, 'empty', '');

  const out = runHook({ projectDir: root });
  assert.deepStrictEqual(JSON.parse(out), { additionalContext: '' });
});

// -------------------- 14. IO error mid-read → {} + cleanup, stderr --------------------

test('readFileSync throws mid-read → {} and .consuming-* cleaned up', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  writeFlag(orch, 'broken', 'doesnt matter');

  const fsLib = Object.create(fs);
  fsLib.readFileSync = () => { const e = new Error('EIO simulated'); e.code = 'EIO'; throw e; };

  const out = runHook({ projectDir: root, fsLib });
  assert.strictEqual(out, '{}');
  // The renamed .consuming-* file should have been unlinked via tryUnlink.
  assert.deepStrictEqual(listConsumingFiles(orch), []);
});

// -------------------- 15. output is valid JSON (every happy path above already asserts this) --------------------

test('happy-path stdout parses via JSON.parse', () => {
  const root = mkProjectDir();
  mkOrchDir(root);
  writeFlag(path.join(root, 'docs', 'orchestration'), 'json-check', 'content with "quotes" and \\ backslash');
  const out = runHook({ projectDir: root });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.additionalContext, 'content with "quotes" and \\ backslash');
});

// -------------------- 16. exit status is always 0 (CLI, across happy + error) --------------------

test('CLI always exits 0 — happy path', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  writeFlag(orch, 'cli-happy', 'hi');
  const res = runCli(cliEnv({ CLAUDE_PROJECT_DIR: root }));
  assert.strictEqual(res.status, 0);
  assert.deepStrictEqual(JSON.parse(res.stdout), { additionalContext: 'hi' });
});

test('CLI always exits 0 — relative path rejected', () => {
  const res = runCli(cliEnv({ CLAUDE_PROJECT_DIR: 'not/an/absolute/path' }));
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '{}');
  assert.match(res.stderr, /not absolute/);
});

test('CLI always exits 0 — oversize', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  writeFlag(orch, 'huge', 'y'.repeat(MAX_FLAG_BYTES + 1));
  const res = runCli(cliEnv({ CLAUDE_PROJECT_DIR: root }));
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '{}');
  assert.match(res.stderr, /exceeds/);
});

// -------------------- 17. directory entries whose name matches the regex are skipped --------------------

test('directory entries matching .pending-* are skipped (isFile() guard)', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  const dirPath = path.join(orch, '.pending-iamadir');
  fs.mkdirSync(dirPath);
  writeFlag(orch, 'realfile', 'real content');

  const out = runHook({ projectDir: root });
  assert.strictEqual(JSON.parse(out).additionalContext, 'real content');
  // Directory preserved.
  assert.strictEqual(fs.existsSync(dirPath), true);
});

// -------------------- 18. in-flight .consuming-* files are not picked up --------------------

test('.consuming-* orphan files are ignored (no .pending- prefix)', () => {
  const root = mkProjectDir();
  const orch = mkOrchDir(root);
  // Simulate a leftover from a crashed hook mid-consume. These files
  // live in the same dir but their name deliberately does NOT start
  // with `.pending-`, so the regex filter skips them.
  const orphan = path.join(orch, '.consuming-x-9999-1-0');
  fs.writeFileSync(orphan, 'in-flight');
  writeFlag(orch, 'legit', 'legit content');

  const out = runHook({ projectDir: root });
  assert.strictEqual(JSON.parse(out).additionalContext, 'legit content');
  // The orphan must not be renamed/deleted by this hook.
  assert.strictEqual(fs.existsSync(orphan), true);
  assert.strictEqual(fs.readFileSync(orphan, 'utf8'), 'in-flight');
});

test('FLAG_NAME_RE does not match .consuming-* leftovers', () => {
  assert.doesNotMatch('.consuming-demo-1234-5678-0', FLAG_NAME_RE);
  assert.doesNotMatch('.consuming-phase-0-impl-1-2-3', FLAG_NAME_RE);
});
