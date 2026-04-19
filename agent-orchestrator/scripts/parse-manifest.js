#!/usr/bin/env node
/**
 * parse-manifest.js — validate an agent-orchestrator manifest and emit a
 * normalized JSON representation the orchestrator process consumes.
 *
 * Also supports `--update` mode: mutates the sibling manifest-status.yaml
 * file to record runtime state (PID, status, timestamps). The manifest
 * itself is NEVER modified — the split keeps user-edit and orchestrator-
 * write paths on disjoint files.
 *
 * Exits 0 on success (valid manifest / successful update), 1 on error.
 *
 * CLI:
 *   parse-manifest.js <manifest.yaml>
 *       Validate and emit JSON on stdout.
 *
 *   parse-manifest.js <manifest.yaml> --update <phase-id> key=value [...]
 *       Set one or more fields on the phase's entry in manifest-status.yaml.
 *       Keys: status, pid, started_at, completed_at, error, retry_count.
 *       Values are stored as-is (integers auto-detected, everything else
 *       as string). manifest-status.yaml is created if missing.
 *
 *   parse-manifest.js -h | --help
 */

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const KNOWN_SHELLS = ['powershell', 'cmd'];
const KNOWN_STATUS = ['pending', 'running', 'completed', 'failed', 'blocked'];
const KNOWN_UPDATE_FIELDS = [
  'status',
  'pid',
  'started_at',
  'completed_at',
  'error',
  'retry_count',
];
const KNOWN_TOP_LEVEL = new Set([
  'name',
  'workdir',
  'launcher',
  'defaults',
  'phases',
]);
const KNOWN_LAUNCHER = new Set([
  'shell',
  'binary',
  'auto_mode_flag',
  'shell_args',
  'passthrough_flags',
]);
const KNOWN_DEFAULTS = new Set([
  'model',
  'phase_timeout_minutes',
  'heartbeat_timeout_minutes',
  'permission_mode',
  'notifications',
]);
const KNOWN_PHASE = new Set([
  'id',
  'title',
  'timeout_minutes',
  'depends_on',
  'parallel_with',
  'review_loop',
  'agent',
  'agents',
  'completion_signal',
]);

// -------------------- CLI entry --------------------

function printHelp() {
  console.log(
    [
      'Usage:',
      '  parse-manifest.js <manifest.yaml>',
      '      Validate and emit normalized JSON on stdout.',
      '',
      '  parse-manifest.js <manifest.yaml> --update <phase-id> key=value [...]',
      '      Update manifest-status.yaml (sibling file). Keys:',
      `      ${KNOWN_UPDATE_FIELDS.join(', ')}`,
      '',
      'Exit codes: 0 = success, 1 = validation/update error.',
    ].join('\n')
  );
}

function parseCliArgs(argv) {
  const out = { manifest: null, update: null, updates: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (a === '--update') {
      out.update = argv[++i];
      if (!out.update) fail('--update requires a phase id');
      while (i + 1 < argv.length && argv[i + 1].includes('=')) {
        const raw = argv[++i];
        const eq = raw.indexOf('=');
        const key = raw.slice(0, eq);
        const value = raw.slice(eq + 1);
        if (!KNOWN_UPDATE_FIELDS.includes(key))
          fail(
            `unknown update field "${key}" — known: ${KNOWN_UPDATE_FIELDS.join(', ')}`
          );
        out.updates[key] = coerceValue(value);
      }
      if (Object.keys(out.updates).length === 0)
        fail('--update requires at least one key=value');
    } else if (!a.startsWith('-') && out.manifest === null) {
      out.manifest = a;
    } else {
      fail(`unknown argument: ${a}`);
    }
  }
  if (!out.manifest) fail('manifest path required (see --help)');
  return out;
}

function coerceValue(raw) {
  // Integer autodetect. Everything else stays a string. Intentional.
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  return raw;
}

function fail(msg, code = 1) {
  process.stderr.write(`parse-manifest: ${msg}\n`);
  process.exit(code);
}

// -------------------- Manifest loading + validation --------------------

function loadManifest(manifestPath) {
  const abs = path.resolve(manifestPath);
  if (!fs.existsSync(abs))
    return { ok: false, error: `manifest not found: ${abs}` };
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { ok: false, error: `cannot read ${abs}: ${e.message}` };
  }
  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (e) {
    // js-yaml errors include a .mark with line / column when available.
    const where = e.mark
      ? ` (line ${e.mark.line + 1}, column ${e.mark.column + 1})`
      : '';
    return { ok: false, error: `YAML parse error${where}: ${e.reason || e.message}` };
  }
  if (parsed === null || parsed === undefined)
    return { ok: false, error: 'manifest is empty' };
  if (typeof parsed !== 'object' || Array.isArray(parsed))
    return { ok: false, error: 'manifest must be a YAML object at the top level' };
  return { ok: true, manifest: parsed, path: abs };
}

function validate(manifest) {
  const errors = [];
  const warnings = [];

  const push = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  // ---- top-level
  for (const k of Object.keys(manifest)) {
    if (!KNOWN_TOP_LEVEL.has(k))
      warn(k, `unknown top-level field "${k}" — ignored (forward-compat)`);
  }

  if (!Array.isArray(manifest.phases) || manifest.phases.length === 0) {
    push('phases', 'must be a non-empty array');
    // Without phases, nothing else is useful to validate structurally.
    return { valid: false, errors, warnings };
  }

  // ---- workdir
  if (manifest.workdir !== undefined && typeof manifest.workdir !== 'string')
    push('workdir', 'must be a string (absolute path or path relative to the manifest)');

  // ---- launcher
  if (manifest.launcher !== undefined) {
    if (typeof manifest.launcher !== 'object' || Array.isArray(manifest.launcher))
      push('launcher', 'must be an object');
    else {
      const L = manifest.launcher;
      for (const k of Object.keys(L)) {
        if (!KNOWN_LAUNCHER.has(k))
          warn(`launcher.${k}`, `unknown launcher field "${k}"`);
      }
      if (L.shell !== undefined && !KNOWN_SHELLS.includes(L.shell))
        push(
          'launcher.shell',
          `must be one of ${KNOWN_SHELLS.join(' | ')}, got ${JSON.stringify(L.shell)}`
        );
      if (L.binary !== undefined) {
        if (typeof L.binary !== 'string' || L.binary.trim() === '')
          push('launcher.binary', 'must be a non-empty string');
      }
      if (L.auto_mode_flag !== undefined && typeof L.auto_mode_flag !== 'string')
        push('launcher.auto_mode_flag', 'must be a string (empty string to omit)');
      if (L.shell_args !== undefined && typeof L.shell_args !== 'string')
        push('launcher.shell_args', 'must be a string');
      if (L.passthrough_flags !== undefined) {
        if (!Array.isArray(L.passthrough_flags))
          push('launcher.passthrough_flags', 'must be an array of strings');
        else
          L.passthrough_flags.forEach((v, i) => {
            if (typeof v !== 'string')
              push(`launcher.passthrough_flags[${i}]`, 'must be a string');
          });
      }
    }
  }

  // ---- defaults
  if (manifest.defaults !== undefined) {
    if (typeof manifest.defaults !== 'object' || Array.isArray(manifest.defaults))
      push('defaults', 'must be an object');
    else {
      const D = manifest.defaults;
      for (const k of Object.keys(D)) {
        if (!KNOWN_DEFAULTS.has(k))
          warn(`defaults.${k}`, `unknown defaults field "${k}"`);
      }
      if (D.phase_timeout_minutes !== undefined)
        expectPositiveInt(D.phase_timeout_minutes, 'defaults.phase_timeout_minutes', push);
      if (D.heartbeat_timeout_minutes !== undefined)
        expectPositiveInt(
          D.heartbeat_timeout_minutes,
          'defaults.heartbeat_timeout_minutes',
          push
        );
      if (D.model !== undefined && typeof D.model !== 'string')
        push('defaults.model', 'must be a string');
      if (D.permission_mode !== undefined && typeof D.permission_mode !== 'string')
        push('defaults.permission_mode', 'must be a string');
      if (D.notifications !== undefined) {
        if (typeof D.notifications !== 'object' || Array.isArray(D.notifications))
          push('defaults.notifications', 'must be an object');
        else {
          if (
            D.notifications.enabled !== undefined &&
            typeof D.notifications.enabled !== 'boolean'
          )
            push('defaults.notifications.enabled', 'must be a boolean');
          if (
            D.notifications.email !== undefined &&
            typeof D.notifications.email !== 'string'
          )
            push('defaults.notifications.email', 'must be a string');
        }
      }
    }
  }

  // ---- phases
  const seenIds = new Set();
  manifest.phases.forEach((p, i) => {
    const p_ = `phases[${i}]`;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      push(p_, 'must be an object');
      return;
    }
    for (const k of Object.keys(p)) {
      if (!KNOWN_PHASE.has(k)) warn(`${p_}.${k}`, `unknown phase field "${k}"`);
    }
    if (!p.id || typeof p.id !== 'string' || p.id.trim() === '')
      push(`${p_}.id`, 'missing required field `id` (non-empty string)');
    else if (seenIds.has(p.id)) push(`${p_}.id`, `duplicate phase id "${p.id}"`);
    else seenIds.add(p.id);

    if (!p.completion_signal || typeof p.completion_signal !== 'string')
      push(`${p_}.completion_signal`, 'missing required field `completion_signal` (path string)');

    if (p.title !== undefined && typeof p.title !== 'string')
      push(`${p_}.title`, 'must be a string');

    if (p.timeout_minutes !== undefined)
      expectPositiveInt(p.timeout_minutes, `${p_}.timeout_minutes`, push);

    if (p.depends_on !== undefined) {
      if (!Array.isArray(p.depends_on))
        push(`${p_}.depends_on`, 'must be an array of phase ids');
      else
        p.depends_on.forEach((d, j) => {
          if (typeof d !== 'string')
            push(`${p_}.depends_on[${j}]`, 'must be a string (phase id)');
        });
    }
    if (p.parallel_with !== undefined) {
      if (!Array.isArray(p.parallel_with))
        push(`${p_}.parallel_with`, 'must be an array of phase ids');
      else
        p.parallel_with.forEach((d, j) => {
          if (typeof d !== 'string')
            push(`${p_}.parallel_with[${j}]`, 'must be a string (phase id)');
        });
    }

    if (p.review_loop !== undefined) {
      if (typeof p.review_loop !== 'object' || Array.isArray(p.review_loop))
        push(`${p_}.review_loop`, 'must be an object');
      else {
        if (
          p.review_loop.enabled !== undefined &&
          typeof p.review_loop.enabled !== 'boolean'
        )
          push(`${p_}.review_loop.enabled`, 'must be a boolean');
        if (p.review_loop.max_iterations !== undefined)
          expectPositiveInt(
            p.review_loop.max_iterations,
            `${p_}.review_loop.max_iterations`,
            push
          );
      }
    }

    // agent (prototype shorthand) vs agents[] (V1). Both are valid; exactly
    // one is required.
    const hasAgent = p.agent !== undefined;
    const hasAgents = p.agents !== undefined;
    if (!hasAgent && !hasAgents)
      push(`${p_}`, 'must define either `agent` (shorthand) or `agents` (list)');
    else if (hasAgent && hasAgents)
      warn(
        `${p_}`,
        'both `agent` and `agents` defined — `agents` takes precedence, `agent` ignored'
      );
    if (hasAgent) validateAgent(p.agent, `${p_}.agent`, push);
    if (hasAgents) {
      if (!Array.isArray(p.agents) || p.agents.length === 0)
        push(`${p_}.agents`, 'must be a non-empty array');
      else p.agents.forEach((a, j) => validateAgent(a, `${p_}.agents[${j}]`, push));
    }
  });

  // ---- dependency graph
  if (errors.length === 0) {
    const { cycle, order } = analyzeDeps(manifest.phases);
    if (cycle) {
      push('phases', `circular dependency: ${cycle.join(' -> ')}`);
    }
    // execution_order is computed later on the normalized phases so defaults
    // are folded. Return order here so the caller can use it.
    return { valid: errors.length === 0, errors, warnings, executionOrder: order };
  }

  return { valid: false, errors, warnings };
}

function validateAgent(a, p_, push) {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) {
    push(p_, 'must be an object');
    return;
  }
  if (a.role !== undefined && typeof a.role !== 'string')
    push(`${p_}.role`, 'must be a string');
  if (a.model !== undefined && typeof a.model !== 'string')
    push(`${p_}.model`, 'must be a string');
  if (a.prompt_file !== undefined && typeof a.prompt_file !== 'string')
    push(`${p_}.prompt_file`, 'must be a string (path)');
  if (a.plugin_dir !== undefined && typeof a.plugin_dir !== 'string')
    push(`${p_}.plugin_dir`, 'must be a string (path)');
}

function expectPositiveInt(v, p_, push) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0)
    push(p_, `must be a positive integer, got ${JSON.stringify(v)}`);
}

// -------------------- Dependency graph --------------------

/**
 * Kahn's algorithm: topological sort + cycle detection in one pass.
 * Returns { order: string[] | null, cycle: string[] | null }. On cycle,
 * `cycle` is the list of ids that could not be sorted (the cycle residue).
 */
function analyzeDeps(phases) {
  const ids = phases.map((p) => p.id);
  const idSet = new Set(ids);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const edges = new Map(ids.map((id) => [id, []]));

  for (const p of phases) {
    const deps = Array.isArray(p.depends_on) ? p.depends_on : [];
    for (const d of deps) {
      if (!idSet.has(d)) {
        // Surfaced as an error separately by validate(), but also affects
        // graph construction — skip the edge here.
        continue;
      }
      edges.get(d).push(p.id);
      indeg.set(p.id, indeg.get(p.id) + 1);
    }
  }

  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const next of edges.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== ids.length) {
    const residue = ids.filter((id) => indeg.get(id) > 0);
    return { order: null, cycle: residue };
  }
  return { order, cycle: null };
}

// -------------------- Dangling dep check (runs before graph) --------------------

function findDanglingDeps(phases) {
  const ids = new Set(phases.map((p) => p.id).filter(Boolean));
  const dangling = [];
  phases.forEach((p, i) => {
    if (Array.isArray(p.depends_on)) {
      p.depends_on.forEach((d, j) => {
        if (typeof d === 'string' && !ids.has(d))
          dangling.push({
            path: `phases[${i}].depends_on[${j}]`,
            message: `references unknown phase "${d}"`,
          });
      });
    }
    if (Array.isArray(p.parallel_with)) {
      p.parallel_with.forEach((d, j) => {
        if (typeof d === 'string' && !ids.has(d))
          dangling.push({
            path: `phases[${i}].parallel_with[${j}]`,
            message: `references unknown phase "${d}"`,
          });
      });
    }
  });
  return dangling;
}

// -------------------- Normalize: fold defaults into phases --------------------

function normalizePhases(manifest) {
  const D = manifest.defaults || {};
  return manifest.phases.map((p) => {
    const timeoutMin =
      p.timeout_minutes !== undefined
        ? p.timeout_minutes
        : D.phase_timeout_minutes !== undefined
          ? D.phase_timeout_minutes
          : null;
    const agents = p.agents
      ? p.agents.map((a) => normalizeAgent(a, D))
      : p.agent
        ? [normalizeAgent(p.agent, D)]
        : [];
    return {
      id: p.id,
      title: p.title || null,
      timeout_minutes: timeoutMin,
      depends_on: Array.isArray(p.depends_on) ? p.depends_on : [],
      parallel_with: Array.isArray(p.parallel_with) ? p.parallel_with : [],
      review_loop: p.review_loop
        ? {
            enabled: p.review_loop.enabled === true,
            max_iterations: p.review_loop.max_iterations || 3,
          }
        : { enabled: false, max_iterations: 3 },
      agents,
      completion_signal: p.completion_signal,
    };
  });
}

function normalizeAgent(a, defaults) {
  return {
    role: a.role || 'impl',
    model: a.model || defaults.model || null,
    prompt_file: a.prompt_file || null,
    plugin_dir: a.plugin_dir || null,
  };
}

// -------------------- Validate mode --------------------

function runValidate(manifestPath) {
  const loaded = loadManifest(manifestPath);
  if (!loaded.ok) {
    emit({ valid: false, errors: [{ path: '', message: loaded.error }], warnings: [] });
    process.exit(1);
  }

  const { manifest } = loaded;

  // Dangling deps are checked before graph analysis so the caller gets a
  // specific error instead of a generic "cycle" message for a missing node.
  const dangling = findDanglingDeps(manifest.phases || []);
  const result = validate(manifest);
  result.errors = [...dangling, ...result.errors];
  result.valid = result.errors.length === 0;

  if (!result.valid) {
    emit({ valid: false, errors: result.errors, warnings: result.warnings });
    process.exit(1);
  }

  const phasesResolved = normalizePhases(manifest);
  emit({
    valid: true,
    manifest,
    phases_resolved: phasesResolved,
    execution_order: result.executionOrder,
    warnings: result.warnings,
  });
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// -------------------- Update mode --------------------

function statusPathFor(manifestPath) {
  const dir = path.dirname(manifestPath);
  const base = path.basename(manifestPath, path.extname(manifestPath));
  return path.join(dir, `${base}-status.yaml`);
}

function runUpdate(manifestPath, phaseId, updates) {
  const loaded = loadManifest(manifestPath);
  if (!loaded.ok) fail(loaded.error);
  const ids = new Set((loaded.manifest.phases || []).map((p) => p.id));
  if (!ids.has(phaseId))
    fail(`phase "${phaseId}" not found in ${manifestPath}`);

  if (
    updates.status !== undefined &&
    !KNOWN_STATUS.includes(String(updates.status))
  )
    fail(
      `status must be one of ${KNOWN_STATUS.join(' | ')}, got ${JSON.stringify(updates.status)}`
    );
  if (updates.pid !== undefined && !Number.isInteger(updates.pid))
    fail(`pid must be an integer, got ${JSON.stringify(updates.pid)}`);
  if (
    updates.retry_count !== undefined &&
    !Number.isInteger(updates.retry_count)
  )
    fail(`retry_count must be an integer, got ${JSON.stringify(updates.retry_count)}`);

  const statusPath = statusPathFor(path.resolve(manifestPath));
  let status = { phases: {} };
  if (fs.existsSync(statusPath)) {
    const raw = fs.readFileSync(statusPath, 'utf8');
    try {
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        status = parsed;
    } catch (e) {
      fail(`corrupt status file at ${statusPath}: ${e.message}`);
    }
    if (!status.phases || typeof status.phases !== 'object') status.phases = {};
  }

  const existing = status.phases[phaseId] || {};
  status.phases[phaseId] = { ...existing, ...updates };
  status.updated_at = new Date().toISOString();

  const header =
    '# auto-generated by parse-manifest.js --update; do not hand-edit\n' +
    '# runtime state for the orchestrator; the user-owned manifest is the sibling file\n';
  fs.writeFileSync(statusPath, header + yaml.dump(status));
  process.stdout.write(
    JSON.stringify(
      { ok: true, status_file: statusPath, phase: phaseId, updates },
      null,
      2
    ) + '\n'
  );
}

// -------------------- Entry --------------------

function main() {
  const args = parseCliArgs(process.argv);
  if (args.update) runUpdate(args.manifest, args.update, args.updates);
  else runValidate(args.manifest);
}

// Run only when invoked as a script. Under `node --test` or `require`d,
// the functions stay testable.
if (require.main === module) main();

module.exports = {
  loadManifest,
  validate,
  findDanglingDeps,
  analyzeDeps,
  normalizePhases,
  statusPathFor,
};
