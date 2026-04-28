/**
 * Unit 7 test suite. Uses node:test (built-in, Node >= 20).
 * Run: npm test   (from agent-orchestrator/scripts/)
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  generatePrompt,
  parseFrontmatter,
  interpolate,
  renderTemplate,
  checkTransitiveDrift,
  extractPlanUnit,
  buildPreviousPhaseBriefing,
  preserveOriginalPrompt,
  normalizeLineEndings,
  atomicWrite,
  VALID_ROLES,
  EMPTY_STATE_PLACEHOLDERS,
  PROTOCOL_HEADER_FILE,
  QA_PLAYBOOK_FILE,
} = require('./generate-prompt');

// Real templates dir — used by the integration / happy-path tests so
// drift between the catalog and the renderer surfaces as a CI failure.
const TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates');

// -------------------- Helpers --------------------

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function writeTemplateFiles(templatesDir, files) {
  fs.mkdirSync(templatesDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(templatesDir, name), content, 'utf8');
  }
}

function makeBaseOpts(overrides) {
  const phaseDir = overrides.phaseDir || mkTmp('gp-phase');
  return {
    role: 'impl',
    phaseId: 'phase-7',
    templatesDir: TEMPLATES_DIR,
    projectName: 'agent-orchestration',
    workdir: '/tmp/agent-orchestration',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
    priorPhaseSignals: [],
    heartbeatPath: path.join(phaseDir, 'heartbeat.jsonl'),
    suggestedCommitMessage: 'feat(phase-7): land prompt generator',
    planUnits: 'Synthetic plan excerpt for tests.\n\n- Build the thing.',
    outputPaths: '- scripts/generate-prompt.js\n- scripts/generate-prompt.test.js',
    previousPhaseBriefing: '',
    statusSummaryBlock: 'Status: Unit 7 in progress.',
    decisionsBlock: '',
    openQuestionsBlock: '',
    planReferenceBlock: 'docs/plans/2026-04-15-001-feat-agent-orchestration-plugin-plan.md',
    projectContextBlock:
      '- **Repo:** newton20/agent-orchestration\n- **Branch:** feat/unit-7-prompt-generator\n- **HEAD SHA:** 3fbdb20',
    gitDetailsBlock: '3fbdb20 docs(triage): post-PR-11',
    warningsBlock: '',
    artifactPointer: '/tmp/handoff.md',
    coordNextActions: 'Dispatch Unit 7 codex review.',
    prOrBranchUnderTest: 'feat/unit-7-prompt-generator',
    qaScopeRows: '1. Verify generate-prompt.js exports generatePrompt.',
    testCommandsBlock: '',
    qaPlaybookBlock: '',
    recoveryCheckpointPath: path.join(phaseDir, 'checkpoint.md'),
    crashTimestamp: '2026-04-28T16:30:00Z',
    lastHeartbeatTimestamp: '2026-04-28T16:25:00Z',
    priorSessionPid: '12345',
    completedCheckpointsBlock: '- Wrote generate-prompt.js',
    remainingWorkBlock: '- Add tests\n- Run codex',
    ...overrides,
  };
}

// =========================================================================
// A — parseFrontmatter
// =========================================================================

test('parseFrontmatter: valid frontmatter parses required + optional', () => {
  const text = '---\nrequired: [a, b]\noptional: [c]\n---\nbody\n';
  const { frontmatter, body } = parseFrontmatter(text);
  assert.deepStrictEqual(frontmatter, { required: ['a', 'b'], optional: ['c'] });
  assert.strictEqual(body, 'body\n');
});

test('parseFrontmatter: missing leading --- returns null frontmatter', () => {
  const text = 'no frontmatter here\n';
  const { frontmatter, body } = parseFrontmatter(text);
  assert.strictEqual(frontmatter, null);
  assert.strictEqual(body, text);
});

test('parseFrontmatter: malformed YAML throws', () => {
  const text = '---\n[unclosed\n---\nbody';
  assert.throws(() => parseFrontmatter(text), /frontmatter YAML parse error/);
});

test('parseFrontmatter: tolerates CRLF line endings', () => {
  const text = '---\r\nrequired: [x]\r\n---\r\nbody\r\n';
  const { frontmatter, body } = parseFrontmatter(text);
  assert.deepStrictEqual(frontmatter, { required: ['x'] });
  assert.ok(body.startsWith('body'));
});

// =========================================================================
// B — interpolate (function-form replace + one-pass)
// =========================================================================

test('interpolate: substitutes declared vars', () => {
  const out = interpolate('a {{x}} b {{y}} c', { x: '1', y: '2' });
  assert.strictEqual(out, 'a 1 b 2 c');
});

test('interpolate: function-form replace passes $& / $1 / $$ literal', () => {
  // The 2nd-arg form would interpret these as backreferences and
  // corrupt the output. Function-form is load-bearing — see PR #6
  // fix 9a1f927 and the Unit 7 dispatch's invariant A.
  const out = interpolate(
    '{{snippet}}',
    { snippet: '$& $1 $$ $\' $` $<name>' },
  );
  assert.strictEqual(out, '$& $1 $$ $\' $` $<name>');
});

test('interpolate: one-pass — nested {{var}} in value survives as text', () => {
  // Open Question #1: a code-fence example showing template syntax
  // must NOT get re-substituted on the next pass. One-pass scan is
  // what makes nested literals safe.
  const out = interpolate(
    '{{plan_units}}\nrole={{role}}',
    { plan_units: 'demo: `{{role}}` should appear literally', role: 'impl' },
  );
  assert.match(out, /demo: `\{\{role\}\}` should appear literally/);
  assert.match(out, /role=impl/);
});

test('interpolate: null / undefined value renders as empty string', () => {
  const out = interpolate('a={{a}} b={{b}} c={{c}}', { a: null, b: undefined, c: 'ok' });
  assert.strictEqual(out, 'a= b= c=ok');
});

test('interpolate: throws on undeclared body variable', () => {
  assert.throws(
    () => interpolate('{{ghost}}', {}),
    /unknown variable \{\{ghost\}\}/,
  );
});

// =========================================================================
// C — renderTemplate (validation)
// =========================================================================

test('renderTemplate: throws when frontmatter is missing', () => {
  assert.throws(
    () => renderTemplate('no frontmatter\nbody', {}, { templateName: 't.md' }),
    /missing YAML frontmatter/,
  );
});

test('renderTemplate: throws when body references undeclared var', () => {
  const tmpl = '---\nrequired: [a]\noptional: []\n---\n{{a}} {{ghost}}';
  assert.throws(
    () => renderTemplate(tmpl, { a: 'x' }, { templateName: 't.md' }),
    /body references \{\{ghost\}\}/,
  );
});

test('renderTemplate: throws when required var missing from context', () => {
  const tmpl = '---\nrequired: [a, b]\noptional: []\n---\n{{a}} {{b}}';
  assert.throws(
    () => renderTemplate(tmpl, { a: 'x' }, { templateName: 't.md' }),
    /required variable "b" is missing or empty/,
  );
});

test('renderTemplate: required empty string is rejected', () => {
  const tmpl = '---\nrequired: [a]\noptional: []\n---\n{{a}}';
  assert.throws(
    () => renderTemplate(tmpl, { a: '' }, { templateName: 't.md' }),
    /required variable "a" is missing or empty/,
  );
});

test('renderTemplate: optional missing renders empty', () => {
  const tmpl = '---\nrequired: [a]\noptional: [b]\n---\n[{{a}}][{{b}}]';
  const out = renderTemplate(tmpl, { a: 'X' }, { templateName: 't.md' });
  assert.strictEqual(out.text, '[X][]');
  assert.deepStrictEqual([...out.varsUsed].sort(), ['a', 'b']);
});

test('renderTemplate: declared but unused vars do not break render', () => {
  // The re-declaration convention requires templates that inline
  // qa_playbook_block to declare test_commands_block in their own
  // optional list, even though they do not reference {{test_commands_block}}
  // directly. Renderer must accept this.
  const tmpl = '---\nrequired: []\noptional: [a, b]\n---\n[{{a}}]';
  const out = renderTemplate(tmpl, { a: 'X', b: 'Y' }, { templateName: 't.md' });
  assert.strictEqual(out.text, '[X]');
});

// =========================================================================
// D — checkTransitiveDrift
// =========================================================================

test('checkTransitiveDrift: real qa-prompt.md + qa-playbook-prompt.md is in lockstep', () => {
  const qaPrompt = fs.readFileSync(path.join(TEMPLATES_DIR, 'qa-prompt.md'), 'utf8');
  const warnings = checkTransitiveDrift(qaPrompt, TEMPLATES_DIR, 'qa-prompt.md');
  assert.deepStrictEqual(warnings, []);
});

test('checkTransitiveDrift: real recovery-prompt.md is in lockstep with qa-playbook', () => {
  const recovery = fs.readFileSync(path.join(TEMPLATES_DIR, 'recovery-prompt.md'), 'utf8');
  const warnings = checkTransitiveDrift(recovery, TEMPLATES_DIR, 'recovery-prompt.md');
  assert.deepStrictEqual(warnings, []);
});

test('checkTransitiveDrift: synthetic template missing re-declared var → warning', () => {
  const tmpDir = mkTmp('gp-templates');
  writeTemplateFiles(tmpDir, {
    'qa-playbook-prompt.md':
      '---\nrequired: [shared_var]\noptional: [test_commands_block]\n---\n{{shared_var}} {{test_commands_block}}',
    'broken.md':
      '---\nrequired: [other]\noptional: []\n---\n{{other}}\n{{qa_playbook_block}}',
  });
  const broken = fs.readFileSync(path.join(tmpDir, 'broken.md'), 'utf8');
  const warnings = checkTransitiveDrift(broken, tmpDir, 'broken.md');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /transitive-drift: broken.md/);
  assert.match(warnings[0], /"shared_var"/);
  assert.match(warnings[0], /"test_commands_block"/);
});

test('checkTransitiveDrift: template that does not inline qa_playbook_block returns []', () => {
  const tmpl = '---\nrequired: []\noptional: []\n---\nhello world';
  const warnings = checkTransitiveDrift(tmpl, TEMPLATES_DIR, 't.md');
  assert.deepStrictEqual(warnings, []);
});

// =========================================================================
// E — extractPlanUnit
// =========================================================================

test('extractPlanUnit: finds matching unit and trims at next sibling', () => {
  const tmp = mkTmp('gp-plan');
  const planPath = path.join(tmp, 'plan.md');
  fs.writeFileSync(
    planPath,
    [
      '# Plan',
      '',
      '- [ ] **Unit 6: Templates**',
      '  body of unit 6',
      '  more lines',
      '',
      '- [ ] **Unit 7: Prompt generator**',
      '  body of unit 7',
      '  ```js',
      '  template.replace(/\\{\\{role\\}\\}/g, () => v ?? \'\')',
      '  ```',
      '  trailing line',
      '',
      '- [ ] **Unit 8: Health checker**',
      '  body of unit 8',
      '',
    ].join('\n'),
  );
  const excerpt = extractPlanUnit(planPath, '7');
  assert.match(excerpt, /^- \[ \] \*\*Unit 7: Prompt generator\*\*/);
  assert.match(excerpt, /trailing line/);
  assert.ok(!/Unit 8/.test(excerpt), 'must stop before next sibling');
});

test('extractPlanUnit: missing unit throws with helpful message', () => {
  const tmp = mkTmp('gp-plan');
  const planPath = path.join(tmp, 'plan.md');
  fs.writeFileSync(planPath, '- [ ] **Unit 6: Templates**\n  body\n');
  assert.throws(
    () => extractPlanUnit(planPath, '99'),
    /no unit matching "99" found/,
  );
});

test('extractPlanUnit: nested {{var}} literals inside code fences survive', () => {
  // Caller passes the extracted text as planUnits to generatePrompt,
  // and one-pass interpolation guarantees the nested literals are
  // not double-substituted (Open Question #1 resolution).
  const tmp = mkTmp('gp-plan');
  const planPath = path.join(tmp, 'plan.md');
  fs.writeFileSync(
    planPath,
    [
      '- [ ] **Unit 7: Prompt generator**',
      '  ```text',
      '  Templates use {{role}} and {{phase_id}} placeholders.',
      '  ```',
      '',
      '- [ ] **Unit 8: Other**',
    ].join('\n'),
  );
  const excerpt = extractPlanUnit(planPath, '7');
  assert.match(excerpt, /\{\{role\}\}/);
  assert.match(excerpt, /\{\{phase_id\}\}/);
});

test('extractPlanUnit: tolerates Unit numbers with dots (Unit 4.5)', () => {
  const tmp = mkTmp('gp-plan');
  const planPath = path.join(tmp, 'plan.md');
  fs.writeFileSync(
    planPath,
    '- [ ] **Unit 4.5: Spike**\n  body\n\n- [ ] **Unit 5: Hook**\n  body\n',
  );
  const excerpt = extractPlanUnit(planPath, '4.5');
  assert.match(excerpt, /Unit 4\.5: Spike/);
  assert.ok(!/Unit 5/.test(excerpt));
});

// =========================================================================
// F — buildPreviousPhaseBriefing
// =========================================================================

test('buildPreviousPhaseBriefing: no upstream signals returns empty briefing', () => {
  const r = buildPreviousPhaseBriefing([]);
  assert.strictEqual(r.briefing, '');
  assert.deepStrictEqual(r.warnings, []);
});

test('buildPreviousPhaseBriefing: single upstream signal inlined as-is', () => {
  const tmp = mkTmp('gp-signal');
  const sigPath = path.join(tmp, 'impl-complete.md');
  fs.writeFileSync(
    sigPath,
    '---\nschema_version: 1\ndispatcher_advisories: 0\n---\n## Summary\nDid the thing.\n',
  );
  const r = buildPreviousPhaseBriefing([sigPath]);
  assert.match(r.briefing, /## Summary\nDid the thing/);
  assert.deepStrictEqual(r.warnings, []);
});

test('buildPreviousPhaseBriefing: multiple signals concatenated with --- divider', () => {
  const tmp = mkTmp('gp-signal');
  const a = path.join(tmp, 'a.md');
  const b = path.join(tmp, 'b.md');
  fs.writeFileSync(a, '---\nschema_version: 1\n---\n## Summary\nA.\n');
  fs.writeFileSync(b, '---\nschema_version: 1\n---\n## Summary\nB.\n');
  const r = buildPreviousPhaseBriefing([a, b]);
  assert.match(r.briefing, /## Summary\nA\./);
  assert.match(r.briefing, /## Summary\nB\./);
  assert.match(r.briefing, /\n\n---\n\n/);
});

test('buildPreviousPhaseBriefing: dispatcher_advisories=0 produces no warning', () => {
  const tmp = mkTmp('gp-signal');
  const sigPath = path.join(tmp, 's.md');
  fs.writeFileSync(sigPath, '---\ndispatcher_advisories: 0\n---\nbody');
  const r = buildPreviousPhaseBriefing([sigPath]);
  assert.deepStrictEqual(r.warnings, []);
});

test('buildPreviousPhaseBriefing: dispatcher_advisories=2 surfaces a warning', () => {
  const tmp = mkTmp('gp-signal');
  const sigPath = path.join(tmp, 's.md');
  fs.writeFileSync(sigPath, '---\ndispatcher_advisories: 2\n---\nbody');
  const r = buildPreviousPhaseBriefing([sigPath]);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /dispatcher_advisories=2/);
});

test('buildPreviousPhaseBriefing: dispatcher_advisories non-integer warns', () => {
  // V1 schema is `dispatcher_advisories: <int>`. Anything else is
  // either a typo or pre-evolution to the structured-array form
  // (Open Question #5) — surface it so the orchestrator can route.
  const tmp = mkTmp('gp-signal');
  const sigPath = path.join(tmp, 's.md');
  fs.writeFileSync(sigPath, '---\ndispatcher_advisories: "bad"\n---\nbody');
  const r = buildPreviousPhaseBriefing([sigPath]);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /must be a non-negative integer/);
});

test('buildPreviousPhaseBriefing: missing signal file warns and continues', () => {
  const r = buildPreviousPhaseBriefing(['/nonexistent/path/sig.md']);
  assert.strictEqual(r.briefing, '');
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /cannot read upstream signal/);
});

// =========================================================================
// G — atomicWrite + normalizeLineEndings
// =========================================================================

test('normalizeLineEndings: CRLF and bare CR collapse to LF', () => {
  assert.strictEqual(normalizeLineEndings('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('atomicWrite: writes file and leaves no temp artifact behind', () => {
  const dir = mkTmp('gp-atomic');
  const target = path.join(dir, 'out.md');
  atomicWrite(target, 'hello');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'hello');
  const leftover = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith('.') && n.includes('gp-tmp-'));
  assert.deepStrictEqual(leftover, []);
});

test('atomicWrite: target dir is created if missing', () => {
  const root = mkTmp('gp-atomic-root');
  const nested = path.join(root, 'a', 'b', 'c');
  const target = path.join(nested, 'out.md');
  atomicWrite(target, 'hello');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'hello');
});

// =========================================================================
// H — preserveOriginalPrompt (idempotent)
// =========================================================================

test('preserveOriginalPrompt: first call copies live to .original', () => {
  const dir = mkTmp('gp-preserve');
  fs.writeFileSync(path.join(dir, 'impl-prompt.md'), 'live v1');
  const did = preserveOriginalPrompt(dir, 'impl');
  assert.strictEqual(did, true);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'impl-prompt.original.md'), 'utf8'), 'live v1');
});

test('preserveOriginalPrompt: second call is a no-op (.original already exists)', () => {
  const dir = mkTmp('gp-preserve');
  fs.writeFileSync(path.join(dir, 'impl-prompt.md'), 'live v1');
  preserveOriginalPrompt(dir, 'impl');
  // Simulate re-recovery: live prompt has been overwritten with v2
  // (a recovery prompt) and we're about to overwrite again with v3.
  fs.writeFileSync(path.join(dir, 'impl-prompt.md'), 'live v2 (recovery prompt)');
  const did = preserveOriginalPrompt(dir, 'impl');
  assert.strictEqual(did, false);
  // .original must STILL hold v1 — the FIRST non-recovery prompt.
  assert.strictEqual(fs.readFileSync(path.join(dir, 'impl-prompt.original.md'), 'utf8'), 'live v1');
});

test('preserveOriginalPrompt: live missing returns false (no-op)', () => {
  const dir = mkTmp('gp-preserve');
  const did = preserveOriginalPrompt(dir, 'impl');
  assert.strictEqual(did, false);
  assert.ok(!fs.existsSync(path.join(dir, 'impl-prompt.original.md')));
});

// =========================================================================
// I — generatePrompt validation surface
// =========================================================================

test('generatePrompt: invalid role throws', () => {
  assert.throws(
    () => generatePrompt(makeBaseOpts({ role: 'sysadmin' })),
    /role must be one of/,
  );
});

test('generatePrompt: invalid phaseId fails VALID_ID_RE', () => {
  // VALID_ID_RE rejects anything outside [A-Za-z0-9._-]+
  assert.throws(
    () => generatePrompt(makeBaseOpts({ phaseId: '../escape' })),
    /must match VALID_ID_RE/,
  );
});

test('generatePrompt: empty phaseId throws', () => {
  assert.throws(
    () => generatePrompt(makeBaseOpts({ phaseId: '' })),
    /must match VALID_ID_RE/,
  );
});

test('generatePrompt: missing templatesDir throws', () => {
  assert.throws(
    () => generatePrompt(makeBaseOpts({ templatesDir: '' })),
    /templatesDir is required/,
  );
});

test('generatePrompt: missing phaseDir throws', () => {
  assert.throws(
    () => generatePrompt(makeBaseOpts({ phaseDir: '' })),
    /phaseDir is required/,
  );
});

test('generatePrompt: recovery without recoveryRole throws', () => {
  assert.throws(
    () => generatePrompt(makeBaseOpts({ role: 'recovery', recoveryRole: null })),
    /recoveryRole must be one of/,
  );
});

// =========================================================================
// J — generatePrompt happy paths (real templates)
// =========================================================================

test('generatePrompt: impl happy path renders header + impl-prompt with all vars substituted', () => {
  const phaseDir = mkTmp('gp-impl');
  const opts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
  });
  const result = generatePrompt(opts);
  assert.strictEqual(result.promptPath, path.join(phaseDir, 'impl-prompt.md'));
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // Header content present
  assert.match(text, /Orchestration Protocol Header/);
  // Role substitution worked
  assert.match(text, /You are a \*\*impl\*\* agent/);
  assert.match(text, /phase \*\*phase-7\*\*/);
  // Plan units interpolated
  assert.match(text, /Synthetic plan excerpt for tests/);
  // No orphan {{var}} placeholders (one-pass leaves nested in code
  // fences, but the synthetic planUnits in this test has none)
  assert.ok(!/\{\{[a-z_]+\}\}/.test(text), 'no orphan {{...}} placeholders');
});

test('generatePrompt: impl with empty optional previousPhaseBriefing renders cleanly', () => {
  const phaseDir = mkTmp('gp-impl-empty');
  const opts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    previousPhaseBriefing: '',
    priorPhaseSignals: [],
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /Previous phase context/);
  // Empty optional renders as empty string. The surrounding prose
  // says "If this section is empty, this phase has no upstream
  // dependencies — you may start directly from the plan excerpt below."
  assert.match(text, /If this section is empty/);
});

test('generatePrompt: qa happy path two-pass renders playbook into qa-prompt', () => {
  const phaseDir = mkTmp('gp-qa');
  const opts = makeBaseOpts({
    role: 'qa',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'qa-complete.md'),
    qaPlaybookBlock: '', // force in-generator render
    testCommandsBlock: '`npm test --workspaces`',
  });
  const result = generatePrompt(opts);
  assert.strictEqual(result.promptPath, path.join(phaseDir, 'qa-prompt.md'));
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // Header
  assert.match(text, /You are a \*\*qa\*\* agent/);
  // Playbook content inlined
  assert.match(text, /P1 — Test suite, every workspace/);
  // test_commands_block override visible inside the inlined playbook
  assert.match(text, /npm test --workspaces/);
  assert.ok(!/\{\{qa_playbook_block\}\}/.test(text), 'playbook variable substituted');
});

test('generatePrompt: qa with empty test_commands_block falls back to playbook prose', () => {
  const phaseDir = mkTmp('gp-qa-empty');
  const opts = makeBaseOpts({
    role: 'qa',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'qa-complete.md'),
    qaPlaybookBlock: '',
    testCommandsBlock: '',
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // The playbook's "Test commands (project-specific)" section ends
  // with the prose: "If this section is empty, fall back to `npm
  // test` per-workspace as described in P1."
  assert.match(text, /If this section is empty, fall back to `npm test`/);
});

test('generatePrompt: coord happy path renders coordinator-briefing as coord-prompt.md', () => {
  const phaseDir = mkTmp('gp-coord');
  const opts = makeBaseOpts({
    role: 'coord',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'coord-complete.md'),
  });
  const result = generatePrompt(opts);
  // Output path uses role-name form, NOT the template filename.
  assert.strictEqual(result.promptPath, path.join(phaseDir, 'coord-prompt.md'));
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /Coordinator briefing — phase phase-7/);
  assert.match(text, /Status: Unit 7 in progress\./);
});

// =========================================================================
// K — generatePrompt empty-state placeholder ownership (Open Q #4)
// =========================================================================

test('generatePrompt: coord empty decisionsBlock renders "(no decisions captured)"', () => {
  const phaseDir = mkTmp('gp-coord-empty-d');
  const opts = makeBaseOpts({
    role: 'coord',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'coord-complete.md'),
    decisionsBlock: '',
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /\(no decisions captured\)/);
});

test('generatePrompt: coord empty openQuestionsBlock renders "(no open questions)"', () => {
  const phaseDir = mkTmp('gp-coord-empty-q');
  const opts = makeBaseOpts({
    role: 'coord',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'coord-complete.md'),
    openQuestionsBlock: '',
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /\(no open questions\)/);
});

test('generatePrompt: coord empty warningsBlock renders "(no warnings)"', () => {
  const phaseDir = mkTmp('gp-coord-empty-w');
  const opts = makeBaseOpts({
    role: 'coord',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'coord-complete.md'),
    warningsBlock: '',
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /\(no warnings\)/);
});

test('generatePrompt: coord undefined decisionsBlock also renders the placeholder', () => {
  const phaseDir = mkTmp('gp-coord-undef-d');
  const base = makeBaseOpts({
    role: 'coord',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'coord-complete.md'),
  });
  delete base.decisionsBlock;
  const result = generatePrompt(base);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /\(no decisions captured\)/);
});

test('generatePrompt: caller-supplied non-empty decisionsBlock passes through unchanged', () => {
  const phaseDir = mkTmp('gp-coord-nonempty-d');
  const opts = makeBaseOpts({
    role: 'coord',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'coord-complete.md'),
    decisionsBlock: '- Picked Option B for V1.',
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // The supplied value renders right after the `## Decisions` heading.
  // The placeholder string `(no decisions captured)` ALSO appears
  // verbatim in the surrounding prose paragraph (the template
  // explains the empty-state contract to readers, with backticks
  // around the literal). Anchor the negative assertion to the
  // substitution position (preceded by a blank line, followed by a
  // newline, no surrounding backticks) so it does not false-trigger
  // on the prose mention.
  assert.match(text, /## Decisions\n\n- Picked Option B for V1\.\n/);
  assert.ok(
    !/\n\n\(no decisions captured\)\n/.test(text),
    'placeholder must not be injected at the substitution position when the caller supplied a value',
  );
});

// =========================================================================
// L — generatePrompt recovery dispatches
// =========================================================================

test('generatePrompt: recovery (impl) writes impl-prompt.md, role var = impl', () => {
  const phaseDir = mkTmp('gp-rec-impl');
  const opts = makeBaseOpts({
    role: 'recovery',
    recoveryRole: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
  });
  const result = generatePrompt(opts);
  // Output filename uses effectiveRole, not 'recovery'.
  assert.strictEqual(result.promptPath, path.join(phaseDir, 'impl-prompt.md'));
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // {{role}} substitutes to 'impl', not 'recovery'
  assert.match(text, /You are a \*\*impl\*\* agent/);
  // recovery-prompt.md content present
  assert.match(text, /recovery \/ resume/);
  assert.match(text, /Crash context/);
});

test('generatePrompt: recovery (qa) two-pass renders playbook into recovery-prompt', () => {
  const phaseDir = mkTmp('gp-rec-qa');
  const opts = makeBaseOpts({
    role: 'recovery',
    recoveryRole: 'qa',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'qa-complete.md'),
    qaPlaybookBlock: '', // force two-pass
    testCommandsBlock: '`npm test --workspaces`',
  });
  const result = generatePrompt(opts);
  assert.strictEqual(result.promptPath, path.join(phaseDir, 'qa-prompt.md'));
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // Recovery template's qa-recovery branch should have a populated
  // {{qa_playbook_block}} (the playbook is inlined into the
  // recovery prompt so the respawned QA gets the same playbook the
  // crashed predecessor ran).
  assert.match(text, /P1 — Test suite, every workspace/);
  assert.match(text, /npm test --workspaces/);
});

test('generatePrompt: recovery (coord) does not run two-pass; qa_playbook_block stays empty', () => {
  const phaseDir = mkTmp('gp-rec-coord');
  const opts = makeBaseOpts({
    role: 'recovery',
    recoveryRole: 'coord',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'coord-complete.md'),
  });
  const result = generatePrompt(opts);
  assert.strictEqual(result.promptPath, path.join(phaseDir, 'coord-prompt.md'));
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // {{qa_playbook_block}} substituted to empty — no playbook content.
  assert.ok(!/P1 — Test suite, every workspace/.test(text), 'playbook content must be absent');
});

test('generatePrompt: recovery preserves the prior live prompt to .original.md (idempotent)', () => {
  const phaseDir = mkTmp('gp-rec-preserve');

  // First dispatch (non-recovery): writes the original impl prompt.
  const baseOpts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
    planUnits: 'ORIGINAL plan excerpt v1',
  });
  generatePrompt(baseOpts);
  const originalText = fs.readFileSync(path.join(phaseDir, 'impl-prompt.md'), 'utf8');
  assert.match(originalText, /ORIGINAL plan excerpt v1/);

  // First recovery: should preserve original to .original.md and overwrite live.
  const recOpts = makeBaseOpts({
    role: 'recovery',
    recoveryRole: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
  });
  generatePrompt(recOpts);
  const original1 = fs.readFileSync(path.join(phaseDir, 'impl-prompt.original.md'), 'utf8');
  assert.match(original1, /ORIGINAL plan excerpt v1/);
  const live1 = fs.readFileSync(path.join(phaseDir, 'impl-prompt.md'), 'utf8');
  assert.match(live1, /recovery \/ resume/);

  // Second recovery (re-recovery): MUST NOT overwrite .original.md.
  generatePrompt(recOpts);
  const original2 = fs.readFileSync(path.join(phaseDir, 'impl-prompt.original.md'), 'utf8');
  assert.strictEqual(
    original2,
    original1,
    '.original.md must hold the FIRST non-recovery prompt across the entire crash chain',
  );
});

// =========================================================================
// M — function-form replace + LF normalization integration
// =========================================================================

test('generatePrompt: planUnits with backreference-like sequences pass through verbatim', () => {
  const phaseDir = mkTmp('gp-funcform');
  const opts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
    planUnits: 'A regex example: /(\\w+)/ replaced via $&-substitution and $1 captures.',
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  assert.match(text, /\$&-substitution/);
  assert.match(text, /\$1 captures/);
});

test('generatePrompt: nested {{role}} inside planUnits code fence survives one-pass', () => {
  const phaseDir = mkTmp('gp-nested');
  const opts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
    planUnits: '```text\nUse {{role}} and {{phase_id}} verbatim.\n```',
  });
  const result = generatePrompt(opts);
  const text = fs.readFileSync(result.promptPath, 'utf8');
  // Nested literals INSIDE the planUnits value survive (one-pass).
  assert.match(text, /Use \{\{role\}\} and \{\{phase_id\}\} verbatim/);
  // The header's own {{role}} is still substituted at top-of-file.
  assert.match(text, /You are a \*\*impl\*\* agent/);
});

test('generatePrompt: output is LF only on disk (no CRLF) regardless of input templates', () => {
  // Synthesize a template dir whose files use CRLF line endings.
  // Unit 7 must normalize on write so the rendered prompt matches
  // the cross-platform convention (Open Question #2).
  const tmpTpl = mkTmp('gp-lf-tpl');
  const realHeader = fs.readFileSync(path.join(TEMPLATES_DIR, PROTOCOL_HEADER_FILE), 'utf8');
  const realImpl = fs.readFileSync(path.join(TEMPLATES_DIR, 'impl-prompt.md'), 'utf8');
  fs.writeFileSync(
    path.join(tmpTpl, PROTOCOL_HEADER_FILE),
    realHeader.replace(/\n/g, '\r\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(tmpTpl, 'impl-prompt.md'),
    realImpl.replace(/\n/g, '\r\n'),
    'utf8',
  );
  // qa-playbook required even though impl doesn't use it (some
  // checkTransitiveDrift codepath may try to read it; copy real one).
  fs.copyFileSync(
    path.join(TEMPLATES_DIR, QA_PLAYBOOK_FILE),
    path.join(tmpTpl, QA_PLAYBOOK_FILE),
  );

  const phaseDir = mkTmp('gp-lf-out');
  const opts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    templatesDir: tmpTpl,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
  });
  const result = generatePrompt(opts);
  const buf = fs.readFileSync(result.promptPath);
  assert.ok(!buf.includes(0x0d), 'rendered prompt must contain no CR (0x0d) bytes');
});

// =========================================================================
// N — determinism
// =========================================================================

test('generatePrompt: same inputs produce byte-identical output (modulo .tmp- filename)', () => {
  const phaseDirA = mkTmp('gp-det-a');
  const phaseDirB = mkTmp('gp-det-b');
  const optsA = makeBaseOpts({
    role: 'impl',
    phaseDir: phaseDirA,
    outputDir: phaseDirA,
    completionSignalPath: path.join(phaseDirA, 'impl-complete.md'),
    heartbeatPath: '/abs/path/heartbeat.jsonl',
  });
  const optsB = makeBaseOpts({
    role: 'impl',
    phaseDir: phaseDirA, // same paths so substituted strings match
    outputDir: phaseDirB,
    completionSignalPath: path.join(phaseDirA, 'impl-complete.md'),
    heartbeatPath: '/abs/path/heartbeat.jsonl',
  });
  const ra = generatePrompt(optsA);
  const rb = generatePrompt(optsB);
  const a = fs.readFileSync(ra.promptPath, 'utf8');
  const b = fs.readFileSync(rb.promptPath, 'utf8');
  assert.strictEqual(a, b, 'byte-identical output for byte-identical context');
});

// =========================================================================
// O — return value shape
// =========================================================================

test('generatePrompt: return value carries promptPath, charCount, varsUsed, warnings', () => {
  const phaseDir = mkTmp('gp-ret');
  const result = generatePrompt(
    makeBaseOpts({
      role: 'impl',
      phaseDir,
      outputDir: phaseDir,
      completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
    }),
  );
  assert.strictEqual(typeof result.promptPath, 'string');
  assert.ok(result.charCount > 0);
  // varsUsed is the union of body-referenced vars in header + role
  // template (deduplicated, sorted for determinism).
  assert.ok(Array.isArray(result.varsUsed));
  assert.ok(result.varsUsed.includes('role'));
  assert.ok(result.varsUsed.includes('phase_id'));
  assert.ok(result.varsUsed.includes('plan_units'));
  // varsUsed is sorted — a determinism guarantee we expose to callers.
  const sorted = [...result.varsUsed].sort();
  assert.deepStrictEqual(result.varsUsed, sorted);
  assert.ok(Array.isArray(result.warnings));
});

test('generatePrompt: dispatcher_advisories>0 in upstream signal surfaces in warnings', () => {
  const sigDir = mkTmp('gp-adv-sig');
  const sigPath = path.join(sigDir, 'impl-complete.md');
  fs.writeFileSync(
    sigPath,
    '---\nschema_version: 1\ndispatcher_advisories: 3\n---\n## Summary\nUpstream had 3 advisories.\n',
  );
  const phaseDir = mkTmp('gp-adv');
  const opts = makeBaseOpts({
    role: 'impl',
    phaseDir,
    outputDir: phaseDir,
    completionSignalPath: path.join(phaseDir, 'impl-complete.md'),
    priorPhaseSignals: [sigPath],
    previousPhaseBriefing: undefined, // force in-generator briefing build
  });
  const result = generatePrompt(opts);
  const advisoryWarnings = result.warnings.filter((w) => /dispatcher_advisories=3/.test(w));
  assert.strictEqual(advisoryWarnings.length, 1);
});

// =========================================================================
// P — Real-template lockstep (regression guard)
// =========================================================================

test('VALID_ROLES enumerates the four documented dispatch roles', () => {
  // Cross-checks the public constant against the dispatch contract
  // ("role ∈ {impl, qa, coord, recovery}") — drift here is a
  // contract change worth a coord triage.
  assert.deepStrictEqual([...VALID_ROLES].sort(), ['coord', 'impl', 'qa', 'recovery']);
});

test('EMPTY_STATE_PLACEHOLDERS matches templates/README.md "Empty-state rendering"', () => {
  // The three coord-specific blocks rendered with explicit literal
  // placeholders. Drift between this constant and the README's
  // documented strings would silently change agent-facing prose.
  assert.deepStrictEqual(EMPTY_STATE_PLACEHOLDERS, {
    decisions_block: '(no decisions captured)',
    open_questions_block: '(no open questions)',
    warnings_block: '(no warnings)',
  });
});

test('every real template parses + has valid required/optional shape', () => {
  const files = ['protocol-header.md', 'impl-prompt.md', 'qa-prompt.md', 'qa-playbook-prompt.md', 'coordinator-briefing.md', 'recovery-prompt.md'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8');
    const { frontmatter, body } = parseFrontmatter(text);
    assert.ok(frontmatter, `${f} must have frontmatter`);
    assert.ok(Array.isArray(frontmatter.required) || frontmatter.required === undefined, `${f}: required must be array or absent`);
    assert.ok(Array.isArray(frontmatter.optional) || frontmatter.optional === undefined, `${f}: optional must be array or absent`);
    // Every body {{var}} must be in declared union.
    const declared = new Set([
      ...(frontmatter.required || []),
      ...(frontmatter.optional || []),
    ]);
    const referenced = new Set();
    body.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_m, name) => {
      referenced.add(name);
      return '';
    });
    for (const name of referenced) {
      assert.ok(
        declared.has(name),
        `${f} body references {{${name}}} but frontmatter does not declare it`,
      );
    }
  }
});
