#!/usr/bin/env node
/**
 * Structural CI guard — every commit action that starts an interactive rebase
 * first checks the target is contained in the current branch.
 *
 * Maintenance contract (per ADR-007 section "Guard maintenance contract"):
 *
 * 1. Bug class
 *    The history-rewriting commit actions (squash / drop / edit message /
 *    interactive rebase) all rebase `oldest^..HEAD` — i.e. the CHECKED-OUT
 *    branch. Running one on a commit that lives on ANOTHER branch (HEAD does
 *    not contain it) silently fast-forwards or transplants the current branch
 *    instead of touching the target's branch, with a success toast and no
 *    squash/drop performed. IntelliJ blocks this in
 *    GitCommitEditingActionBase.checkCommitsCanBeEdited (commit must be in
 *    HEAD). The uniform fix is a perform-time gate — the shared
 *    `isOldestInCurrentBranch` helper — run BEFORE any stash/rebase. This
 *    guard stops a new (or refactored) rebase-starting handler from rejoining
 *    the code un-gated, in EITHER home: the dispatcher class or the extracted
 *    history-rewrite module.
 *
 * 2. Heuristic + how it scales + fail-closed
 *    Scope: every .ts file under src/commits/ — the dispatcher class
 *    (class-member methods, 2-space-indent headers) and the extracted action
 *    modules (0-indent module functions, export or private — each owns its
 *    body). Hybrid files (a class plus top-level functions) scan BOTH forms,
 *    each in its own region. Any function whose body STARTS a
 *    rebase (`startInteractiveRebase(` or `[._]openRebaseEditor(`) must also
 *    invoke the shared containment guard (`[._]isOldestInCurrentBranch(`) —
 *    UNION semantics: the guard must be in THAT function's own body, not merely
 *    present somewhere. The stems match both the class form (`this._x(`) and the
 *    module form (`ctx.x(`), so the guard stem is kept in the ctx member name.
 *    A function that legitimately needs no gate marks itself
 *    `rebase-containment-exempt: <reason>` in its body. FAIL-CLOSED: if zero
 *    rebase-start sites are found across the union, the guard FAILS — a path or
 *    regex drift that silences the scan can never read as "clean". O(lines).
 *
 * 3. Known false-positive cases
 *    A helper that forwards to `startInteractiveRebase` for a non-rewriting
 *    purpose would trip this; annotate `rebase-containment-exempt: <reason>`.
 *    None exist today.
 *
 * 4. Known false-negative cases
 *    A rebase started through an aliased service or a dynamically-composed
 *    method name slips the literal patterns; review is the backstop. A
 *    rebase-start inside an arrow-function class PROPERTY (`private f =
 *    async () => {...}`) is not a member header (no `(` after the
 *    identifier), so its body folds into the preceding method — no such
 *    property exists today; keep handlers as methods. Body
 *    boundaries are indent-anchored (next same-level header), reliable under
 *    prettier; a 0-indent `}` inside a template literal would end a module
 *    function's scope early (contrived, none exist).
 *
 * 5. Retirement criteria
 *    Retire when an eslint no-restricted-syntax rule enforces the gate, or when
 *    the rebase-editing flows carry the gate in a shared runner the type system
 *    makes un-bypassable.
 *
 * Usage:
 *   node scripts/check-rebase-containment-guarded.mjs
 *     — real mode: scans the class + the history-rewrite module (if present).
 *   node scripts/check-rebase-containment-guarded.mjs <dir|file>...
 *     — fixture mode (companion spec): scans the given dirs/files.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// A class member header: 2-space indent, optional modifiers, identifier then `(`.
// Field declarations (typed `:`/`?:` and untyped `= () =>` arrow properties)
// have no `(` directly after the identifier, so they are not headers — see
// section 4 for the arrow-property false negative this implies.
const HEADER_CLASS =
  /^ {2}(?:public |private |protected |static |readonly |abstract |get |set |async )*[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\(/;
// A module function header: 0-indent `(export) (async) function name(` —
// private module helpers own their bodies too, so a rebase-start inside one
// can never fold into the preceding export's (possibly gated) body.
const HEADER_MODULE = /^(?:export )?(?:async )?function [A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\(/;
// A class declaration opens a range in which 2-space members are headers.
const CLASS_START = /^(?:export )?(?:abstract )?class\s/;

// A call into the shared runner IS a rebase start for gating purposes: the
// runner body is exempt (it cannot know which commit is oldest), so the
// caller must carry the containment gate.
const REBASE_START = /startInteractiveRebase\(|[._]openRebaseEditor\(|runHistoryRewrite\(/;
const GUARD = /[._]isOldestInCurrentBranch\(/;
const EXEMPT = /rebase-containment-exempt:/;

function tsFilesUnder(p) {
  if (!existsSync(p)) return [];
  if (statSync(p).isFile()) return p.endsWith('.ts') ? [p] : [];
  const out = [];
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const abs = join(p, e.name);
    if (e.isDirectory()) out.push(...tsFilesUnder(abs));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

const args = process.argv.slice(2);
const files =
  args.length > 0 ? args.flatMap(tsFilesUnder) : tsFilesUnder(join(root, 'src', 'commits'));

const offenders = [];
let rebaseStartSites = 0;

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  // A file can be a HYBRID: a class plus top-level module functions (the real
  // dispatcher exports a factory below its class). Headers are therefore
  // detected per REGION: inside a class range the 2-space member form applies
  // (method bodies sit at 4+ indent, so 2-space control flow can't match);
  // outside, the 0-indent module-function form applies (2-space `if (` lines
  // never match a 0-indent regex).
  const classRanges = [];
  for (let i = 0; i < lines.length; i++) {
    if (!CLASS_START.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !/^\}\s*$/.test(lines[end])) end++;
    classRanges.push([i, end]);
    i = end;
  }
  const inClass = (i) => classRanges.some(([a, b]) => i > a && i < b);
  const headerIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (inClass(i) ? HEADER_CLASS.test(lines[i]) : HEADER_MODULE.test(lines[i])) headerIdx.push(i);
  }
  for (let h = 0; h < headerIdx.length; h++) {
    const start = headerIdx[h];
    let end = h + 1 < headerIdx.length ? headerIdx[h + 1] : lines.length;
    // A class member's body never extends past its class's closing brace —
    // without the cap, the LAST member would swallow the gap between the
    // class close and the first module function.
    const range = classRanges.find(([a, b]) => start > a && start < b);
    if (range && range[1] < end) end = range[1];
    const body = lines.slice(start, end).join('\n');
    if (!REBASE_START.test(body)) continue;
    rebaseStartSites++;
    if (EXEMPT.test(body) || GUARD.test(body)) continue;
    offenders.push({ file, line: start + 1, name: lines[start].trim().replace(/\s*\{?\s*$/, '') });
  }
}

if (rebaseStartSites === 0) {
  console.error(
    'check-rebase-containment-guarded: FAIL-CLOSED — zero rebase-start sites found across'
  );
  console.error(
    `  ${files.join('\n  ') || '(no files)'}\nThe scan matched nothing; a path/regex drift has`
  );
  console.error('silenced this guard. Restore the scanned files / patterns.');
  process.exit(1);
}

if (offenders.length > 0) {
  console.error('check-rebase-containment-guarded: a rebase-starting commit handler is missing');
  console.error('the HEAD-containment gate. Call `isOldestInCurrentBranch(repo, <oldest>)` before');
  console.error('any stash/rebase (a squash/drop/edit on another branch silently moves the');
  console.error('checked-out branch), or annotate `rebase-containment-exempt: <reason>`.');
  console.error('');
  for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.name}`);
  process.exit(1);
}

console.log(`check-rebase-containment-guarded: OK (${rebaseStartSites} rebase-start sites gated)`);
