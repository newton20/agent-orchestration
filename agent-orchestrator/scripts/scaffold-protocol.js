#!/usr/bin/env node
/**
 * scaffold-protocol.js — create the file-drop protocol directory tree
 * that orchestrated agents read and write.
 *
 * Given a validated manifest (see parse-manifest.js), create:
 *   <workdir>/docs/orchestration/
 *       phases/<phase-id>/          # one per phase in execution_order
 *       logs/
 *       logs/events.jsonl           # empty file if missing
 *       templates/                  # copy of the plugin's templates/
 *
 * Idempotent. Running twice never clobbers existing phase artifacts,
 * completion signals, the accumulated events.jsonl, or user-edited
 * template copies. A missing piece is created; an existing piece is
 * left alone.
 *
 * CLI:
 *   scaffold-protocol.js <manifest.yaml> [--plugin-dir <path>] [--dry-run]
 *
 *   --plugin-dir <path>  Where to read templates from. Defaults to
 *                        the agent-orchestrator/ directory that
 *                        contains this script.
 *   --dry-run            Print what would be created without writing.
 *
 * Exits 0 on success, 1 on validation or IO error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  loadManifest,
  validate,
  findDanglingDeps,
  normalizePhases,
} = require('./parse-manifest');

// -------------------- CLI entry --------------------

function printHelp() {
  console.log(
    [
      'Usage:',
      '  scaffold-protocol.js <manifest.yaml> [--plugin-dir <path>] [--dry-run]',
      '',
      '  --plugin-dir <path>  Where to read templates from. Defaults to the',
      '                       agent-orchestrator/ directory containing this script.',
      '  --dry-run            Print actions without writing anything.',
      '',
      'Exit codes: 0 = success, 1 = validation/IO error.',
    ].join('\n')
  );
}

function parseCliArgs(argv) {
  const out = { manifest: null, pluginDir: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--plugin-dir') {
      out.pluginDir = argv[++i];
      if (!out.pluginDir) fail('--plugin-dir requires a path');
    } else if (!a.startsWith('-') && out.manifest === null) {
      out.manifest = a;
    } else {
      fail(`unknown argument: ${a}`);
    }
  }
  if (!out.manifest) fail('manifest path required (see --help)');
  return out;
}

function fail(msg, code = 1) {
  process.stderr.write(`scaffold-protocol: ${msg}\n`);
  process.exit(code);
}

// -------------------- Core --------------------

/**
 * Testable scaffolder. Returns { ok: true, protoDir, actions } on
 * success, { ok: false, error } or { ok: false, errors: [...] } on
 * failure. Never calls process.exit — callers (CLI main) do that.
 *
 * @param {object} opts
 * @param {string} opts.manifestPath  Path to the manifest YAML.
 * @param {string} [opts.pluginDir]   Directory containing templates/.
 *                                    Defaults to the parent of this script.
 * @param {boolean} [opts.dryRun]     If true, do not write anything.
 * @returns {object}
 */
function scaffoldProtocol({ manifestPath, pluginDir, dryRun = false }) {
  const loaded = loadManifest(manifestPath);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const dangling = findDanglingDeps(
    Array.isArray(loaded.manifest.phases) ? loaded.manifest.phases : []
  );
  const vresult = validate(loaded.manifest);
  if (dangling.length > 0 || !vresult.valid) {
    return { ok: false, errors: [...dangling, ...vresult.errors] };
  }

  const phases = normalizePhases(loaded.manifest);
  const manifestDir = path.dirname(path.resolve(manifestPath));
  // Manifest paths (including protocol artifacts) resolve relative to
  // the manifest's directory, not launcher.workdir. This matches how
  // parse-manifest.js and the prototype treat path fields.
  const protoDir = path.join(manifestDir, 'docs', 'orchestration');
  const phasesDir = path.join(protoDir, 'phases');
  const logsDir = path.join(protoDir, 'logs');
  const eventsLog = path.join(logsDir, 'events.jsonl');
  const templatesDir = path.join(protoDir, 'templates');

  const actions = [];
  for (const phase of phases) {
    actions.push({ type: 'mkdir', path: path.join(phasesDir, phase.id) });
  }
  actions.push({ type: 'mkdir', path: logsDir });
  actions.push({ type: 'touch', path: eventsLog });

  const resolvedPluginDir =
    pluginDir !== null && pluginDir !== undefined
      ? path.resolve(pluginDir)
      : path.resolve(__dirname, '..');
  const srcTemplatesDir = path.join(resolvedPluginDir, 'templates');
  if (fs.existsSync(srcTemplatesDir) && fs.statSync(srcTemplatesDir).isDirectory()) {
    actions.push({ type: 'mkdir', path: templatesDir });
    const templateFiles = fs
      .readdirSync(srcTemplatesDir)
      .filter((f) => f.endsWith('.md'))
      .sort();
    for (const f of templateFiles) {
      actions.push({
        type: 'copy',
        src: path.join(srcTemplatesDir, f),
        dst: path.join(templatesDir, f),
        skipIfExists: true,
      });
    }
  } else {
    actions.push({
      type: 'warning',
      message: `templates directory not found at ${srcTemplatesDir} — skipping template copy`,
    });
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      protoDir,
      phases: phases.map((p) => p.id),
      actions,
    };
  }

  const executed = [];
  for (const a of actions) {
    try {
      if (a.type === 'mkdir') {
        fs.mkdirSync(a.path, { recursive: true });
        executed.push({ ...a });
      } else if (a.type === 'touch') {
        if (!fs.existsSync(a.path)) {
          fs.writeFileSync(a.path, '');
          executed.push({ ...a, created: true });
        } else {
          executed.push({ ...a, preserved: true });
        }
      } else if (a.type === 'copy') {
        if (a.skipIfExists && fs.existsSync(a.dst)) {
          executed.push({ ...a, skipped: true });
          continue;
        }
        fs.copyFileSync(a.src, a.dst);
        executed.push({ ...a, copied: true });
      } else if (a.type === 'warning') {
        executed.push({ ...a });
      }
    } catch (e) {
      return {
        ok: false,
        error: `failed at action ${JSON.stringify(a)}: ${e.message}`,
        executed,
      };
    }
  }

  const templatesCopied = executed.filter(
    (a) => a.type === 'copy' && a.copied
  ).length;
  const templatesSkipped = executed.filter(
    (a) => a.type === 'copy' && a.skipped
  ).length;
  const warnings = executed.filter((a) => a.type === 'warning').map((a) => a.message);

  return {
    ok: true,
    protoDir,
    phases_created: phases.map((p) => p.id),
    events_log: eventsLog,
    events_log_preserved: executed.some(
      (a) => a.type === 'touch' && a.preserved
    ),
    templates_dir: fs.existsSync(templatesDir) ? templatesDir : null,
    templates_copied: templatesCopied,
    templates_skipped: templatesSkipped,
    warnings,
  };
}

// -------------------- Entry --------------------

function main() {
  const args = parseCliArgs(process.argv);
  const result = scaffoldProtocol({
    manifestPath: args.manifest,
    pluginDir: args.pluginDir,
    dryRun: args.dryRun,
  });
  if (!result.ok) {
    if (result.errors) {
      process.stdout.write(
        JSON.stringify({ ok: false, errors: result.errors }, null, 2) + '\n'
      );
    } else {
      process.stderr.write(`scaffold-protocol: ${result.error}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { scaffoldProtocol };
