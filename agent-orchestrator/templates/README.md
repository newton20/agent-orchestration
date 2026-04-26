# Templates

Prompt templates the orchestrator renders into role-specific prompts
for every spawned Claude Code session. **This README is the
authoritative variable catalog** that Unit 7's
`scripts/generate-prompt.js` validates templates against.

## Template index

| File | Role | Purpose |
|---|---|---|
| `protocol-header.md` | universal | Prepended to every other template. Establishes role, file protocol, completion-signal format, heartbeat cadence, git discipline, scope boundary. Do not duplicate its content in role templates. |
| `impl-prompt.md` | impl | Implementation-session assignment. Layers plan excerpt, previous-phase context, and output contract on top of the header. |
| `qa-prompt.md` | qa | QA-session assignment. Cites the branch under test, per-PR scope rows, and the inlined playbook. |
| `qa-playbook-prompt.md` | qa (fragment) | Reusable playbook rows that apply to every PR. Inlined into `qa-prompt.md` via `{{qa_playbook_block}}` — not dispatched standalone. |
| `coordinator-briefing.md` | coord | Read-only briefing for a coordinator session. Shape-compatible with `~/.claude/skills/session-handoff` `brief coord` output. |
| `recovery-prompt.md` | impl / qa / coord | Respawn prompt after a crash. Wraps the original role with crash context, completed checkpoints, and remaining-work markers. |

## Interpolation contract

Templates are pure text with `{{variable_name}}` holes. Unit 7 fills
them with a single simple-string replace:

```js
function fill(template, vars) {
  return Object.entries(vars).reduce(
    (out, [k, v]) => out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), () => v ?? ''),
    template,
  );
}
```

The function-form replacement is load-bearing: passing `v` directly as
the second argument to `String.replace` causes JavaScript to interpret
`$$`, `$&`, `$'`, `` $` ``, and `$<name>` as backreferences. Real
values like `plan_units` or `previous_phase_briefing` may legitimately
contain those sequences (shell snippets, regex examples, jq filters);
the `() => v ?? ''` form passes the value through verbatim.

**No conditionals. No loops. No Handlebars.** If a template wants
"render this section only when previous_phase_briefing is non-empty",
the render is the template author's responsibility: accept that the
template renders a section with an empty body when the variable is
empty. That is the agreed V1 trade-off.

### Prepending the protocol header

For `impl-prompt.md`, `qa-prompt.md`, and `recovery-prompt.md`, Unit 7
concatenates `protocol-header.md` + role template (with variable
substitution on both) into a single prompt file. `coordinator-briefing.md`
also prepends the header, even though its primary purpose is a read
artifact — this keeps the role-preamble invariant intact. The
`qa-playbook-prompt.md` file is inlined as a variable value, not
prepended separately; it is rendered to text and passed as
`{{qa_playbook_block}}` to `qa-prompt.md`.

### Frontmatter contract

Every template (including this one's headings convention, and
including `qa-playbook-prompt.md` even though it is a fragment) begins
with YAML frontmatter listing the variables it references:

```yaml
---
required: [role, phase_id, plan_units]
optional: [previous_phase_briefing]
---
```

- **required** — Unit 7 must raise an error if any of these is absent
  from the interpolation context. Rendering a template with a
  `{{role}}` placeholder still visible is worse than failing loudly.
- **optional** — Unit 7 substitutes the empty string when the variable
  is absent. This is acceptable because templates above have been
  written to read correctly with empty optional sections.
- Any `{{var}}` that appears in the template body but is not listed
  in either block is a lint error — Unit 7 should warn and refuse to
  render until the catalog is updated.

## Variable catalog (authoritative)

Every variable used across any template is documented here. **Unit 7's
validator reads this list** (or a machine-readable mirror derived from
it; see the open question at the end) — if a template references a
variable that is not in the list below, the render must fail.

### Universal variables (header + role templates)

| Name | Type | Purpose |
|---|---|---|
| `role` | string enum | `impl` \| `qa` \| `coord` \| `recovery`. Value is the agent's dispatched role. `recovery` is reserved for the V1.5 recovery-analyst agent; V1 `recovery-prompt.md` renders with the original role (`impl`, `qa`, or `coord`) because a respawned session takes on the same role. |
| `phase_id` | string | Phase identifier matching `VALID_ID_RE` (`[A-Za-z0-9._-]+`). |
| `project_name` | string | Repo slug or user-facing project name. Displayed in the role preamble. |
| `workdir` | absolute path | The spawned session's `cwd`. Every protocol file path is anchored here. |
| `phase_dir` | absolute path | `${workdir}/docs/orchestration/phases/${phase_id}`. All inputs/outputs for this phase live under it. |
| `completion_signal_path` | absolute path | Where the agent writes its completion signal. Unit 7 derives this as `${phase_dir}/${role}-complete.md` unless the manifest overrides it. |
| `prior_phase_dirs` | block (newline-joined absolute paths) | Completion-signal paths from `depends_on` phases. Empty if no upstream deps. |
| `heartbeat_path` | absolute path | `${phase_dir}/heartbeat.jsonl`. Optional — the role prompt may disable heartbeats by passing an empty value. |
| `suggested_commit_message` | string | A commit-message seed drawn from the manifest's phase entry. The agent is free to override it. |

### Impl-specific

| Name | Type | Purpose |
|---|---|---|
| `plan_units` | block | The plan excerpt for this phase. Multi-paragraph markdown extracted from the plan file by Unit 7. |
| `previous_phase_briefing` | block | Concatenated completion signals from upstream phases, inlined for reading. Empty if no upstream deps. |
| `output_paths` | block (newline-joined relative paths) | Expected artifacts this role must produce, beyond the completion signal. |

### QA-specific

| Name | Type | Purpose |
|---|---|---|
| `pr_or_branch_under_test` | string | The branch name or PR number the QA agent will checkout before running rows. |
| `qa_scope_rows` | block | The per-PR numbered scope rows. Generated by Unit 7 from the impl phase's output contract plus manifest-declared verifications. |
| `qa_playbook_block` | block | The fully-rendered text of `qa-playbook-prompt.md`, inlined into `qa-prompt.md`. Rendered recursively by Unit 7 before interpolating `qa-prompt.md`. |
| `test_commands_block` | block | Project-specific test-command overrides, rendered into `qa-playbook-prompt.md`. Empty falls back to the playbook's default `npm test` per-workspace behavior. |

### Coord-specific

| Name | Type | Purpose |
|---|---|---|
| `status_summary_block` | block | One-paragraph status summary. Imperative present tense. |
| `decisions_block` | block | Session decisions, each tagged `[inferred from session]` when derived rather than user-stated. Always renders; empty state is `(no decisions captured)` literal. |
| `open_questions_block` | block | Unresolved items for the coord to triage. Same inference tagging and empty-state rule as decisions. |
| `plan_reference_block` | block | Repo-relative path(s) to every active plan this briefing touches. |
| `project_context_block` | block | Repo slug, branch, HEAD SHA, worktree clean/dirty flag, latest checkpoint path. |
| `git_details_block` | block | Last N commits and a short status or diff stat. |
| `warnings_block` | block | Every `[warning: source -- reason -- omitted]` line from the briefing generation surface. Always renders; empty state is `(no warnings)` literal. |
| `artifact_pointer` | string | Absolute path to the full briefing on disk, usually under `~/.claude/handoffs/<slug>/`. |
| `coord_next_actions` | block | The specific action the coord should take next. |

### Recovery-specific

| Name | Type | Purpose |
|---|---|---|
| `recovery_checkpoint_path` | absolute path | The orchestrator's snapshot of the prior session's state. May point at an empty file, a partial completion signal, or a full `status: partial` signal. |
| `crash_timestamp` | ISO 8601 UTC string | Orchestrator-observed moment the prior session was declared dead. |
| `last_heartbeat_timestamp` | ISO 8601 UTC string \| `null` | Timestamp of the prior session's last heartbeat entry, or `null` if none was emitted. |
| `prior_session_pid` | string | The crashed session's PID, for log correlation. `unknown` if the orchestrator never captured it. |
| `completed_checkpoints_block` | block | Checkpoints reconstructed from prior-session artifacts; each entry is a one-line bullet with a verified-on-disk pointer. |
| `remaining_work_block` | block | The plan excerpt for this phase with completed items marked `[x - done by prior session]` and the rest marked `[ ]`. |

## Empty-state rendering

When an optional variable is empty, Unit 7 substitutes the empty
string. The surrounding template has been written to read correctly in
that case — headings remain, and prose like "If this section is empty,
…" explains the absence. Authors adding new optional variables should
match this convention: write a sentence under the heading that handles
the empty case, rather than relying on the heading alone to convey
meaning.

Three coord-specific blocks (`decisions_block`, `open_questions_block`,
`warnings_block`) render an explicit literal placeholder rather than
empty prose — `(no decisions captured)`, `(no open questions)`, `(no
warnings)`. This matches the session-handoff skill's contract: the
reader must distinguish "we looked and found nothing" from "we forgot
to look." Unit 7 implements this by substituting the placeholder when
the caller passes an empty block, not by leaving the variable blank.

## Unit 7 integration notes

`scripts/generate-prompt.js` (Unit 7) will implement:

1. **Catalog ingestion.** Parse this README's variable-catalog tables
   into a machine-readable map. The initial implementation can regex
   the tables; a later version may parse a mirror JSON file (see open
   question below).
2. **Template validation.** For every template it loads: parse the
   frontmatter, confirm every `required` + `optional` variable appears
   in the catalog, and confirm every `{{var}}` in the body appears in
   the frontmatter.
3. **Interpolation.** Render with the simple `replace` loop above.
   Missing required variable → throw. Missing optional variable →
   substitute empty string.
4. **Concatenation.** For role templates that need the header
   (`impl`, `qa`, `recovery`, and `coord`), concatenate after
   rendering: `protocol-header.md` first, then the role template,
   joined by a blank line. For `qa-prompt.md`, render
   `qa-playbook-prompt.md` first and pass its output as
   `{{qa_playbook_block}}`.

## Open questions for Unit 7

These are the interpolation edge cases the template author expects
Unit 7 to handle — they are not decided yet, and should be surfaced in
the Unit 7 design doc:

1. **Plan-excerpt literals.** If `{{plan_units}}` contains a markdown
   fenced code block that itself has `{{…}}` literals (e.g., a code
   sample showing template syntax), the simple regex replace will
   double-substitute on re-render. Unit 7 should either (a) document
   that interpolation is one-pass (so nested `{{…}}` survives as
   literal text) or (b) escape nested literals during extraction. Recommend (a).
2. **Newline normalization.** Templates are committed with LF endings;
   the generated prompts go through a shell path that may convert to
   CRLF on Windows. Unit 7 should normalize to LF on write regardless
   of platform to keep diffs stable.
3. **Catalog sync.** Should the variable catalog live only in this
   README (Unit 7 parses the tables), or also in a machine-readable
   mirror (`templates/variables.json`) that Unit 7 reads and the README
   links to? README-only is simpler for V1; the JSON mirror pays for
   itself once >~15 variables or once a second consumer exists.
   Recommend README-only until a second consumer exists.
4. **Empty-state placeholder owner.** Does Unit 7 inject the literal
   placeholders (`(no decisions captured)` etc.) when the caller
   passes an empty block, or does the caller inject them before
   interpolating? The catalog assumes Unit 7 does it (so the caller
   can pass `""` indifferently) — document this in the Unit 7 design
   so callers do not duplicate the logic.

If Unit 7's implementation surfaces additional edge cases, fold them
back into this README rather than letting them live only in code
comments.

## Changing a template

1. Update the template file.
2. If you add a `{{new_variable}}`, add it to the table above.
3. If you remove a variable, remove it from the template frontmatter
   and from the table.
4. Run the Unit 7 lint / validator (once it exists) to confirm the
   template still renders cleanly with a representative fixture.
5. Ship the change in a single PR — templates and catalog must not
   drift.
