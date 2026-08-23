#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// check-dispatch-targets.mjs — executeCommand ↔ registration guard.
//
// Maintenance contract (per ADR-007 section "Guard maintenance contract"):
//
// 1. Bug class
//    Production code dispatches `executeCommand('intellig.X', …)` where
//    `intellig.X` is registered nowhere — VS Code rejects the execution and
//    the user's click is a silent no-op (webview relays swallow the
//    rejection). The Commit Tool Window's file context menu shipped two of
//    these (`intellig.localChanges.showDiff`, `intellig.annotate`) after an
//    instance-only fix of the same class (`intellig.addToVcs`). Unit tests
//    stubbing `executeCommand` pin whatever id the sender posts, so a dead
//    id sails through the mock-only suites.
//
// 2. Heuristic + how it scales
//    Collect every `executeCommand('intellig.*')` string-literal dispatch
//    in production source (srcDir, test subtrees excluded; multiline call
//    shapes covered). Each dispatched id must resolve to a registration:
//    a `registerCommand`/`registerLoggedCommand`/`registerTextEditorCommand`
//    literal, a command-spec `id:` literal (the spine's registration shape),
//    or a `contributes.commands` entry in package.json. New commands and new
//    dispatch sites are covered automatically; no per-command edit needed.
//
// 3. Known false-positive cases
//    An id dispatched as a literal but registered from a computed string
//    would false-fail; the house convention registers every id as a whole
//    literal (check-command-reachability.mjs section 3), so none exist.
//    A dispatch that is intentionally conditional on a command another
//    extension contributes can annotate the dispatch line (or the line
//    above) with `// dispatch-exempt: <reason>`.
//
// 4. Known false-negative cases
//    Ids assembled at runtime (`'intellig.' + verb`) are invisible to BOTH
//    scans: the literal arm reads only the first quoted token, and the
//    computed arm skips anything starting with a quote. Argument-contract
//    mismatches (right id, wrong payload shape) are invisible too — those stay
//    on unit/e2e coverage. The computed arm is also anchored on `commands.`,
//    so an aliased or destructured `executeCommand(` with a computed id
//    escapes it while a literal one would still be caught by the literal arm.
//    The anchor is deliberate (the merge model has its own unrelated
//    `undoManager.executeCommand`) and the asymmetry is the price. A registration that
//    exists but is never reached at runtime is check-command-reachability's
//    territory, not this guard's.
//
// 5. Retirement criteria
//    Retire when command dispatch goes through a typed wrapper whose id
//    parameter is a union of registered ids, making an unregistered
//    dispatch a compile error.
//
// Modes: DEFAULT (no args) runs over the real tree (src + package.json).
// EXPLICIT PATHS (companion spec): `node check-dispatch-targets.mjs
// <srcDir> <pkgPath>` scans the given fixture tree.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

const DISPATCH_RE = /executeCommand(?:<[^>]*>)?\(\s*['"`](intellig\.[^'"`]+)['"`]/g;
const REGISTRATION_RES = [
  /(?:registerCommand|registerLoggedCommand|registerTextEditorCommand)\(\s*['"`](intellig\.[^'"`]+)['"`]/g,
  /id:\s*['"`](intellig\.[^'"`]+)['"`]/g,
];
const EXEMPT_RE = /\/\/\s*dispatch-exempt:/;
// Every `commands.executeCommand(` call plus the text that follows it, so the
// first argument can be classified in code rather than by a lookahead — a
// greedy `\s*` backtracks to zero width and reads a WRAPPED literal (the id on
// the next line) as computed. Anchored on `commands.` so the merge model's own
// `undoManager.executeCommand` (a different method entirely) stays out of scope.
// The trailing text is captured through a LOOKAHEAD so the match stays
// zero-width past the paren: consuming it would advance matchAll's cursor over
// the next call and silently skip it.
const ANY_DISPATCH_RE = /commands\.executeCommand(?:<[^>]*>)?\((?=([\s\S]{0,120}))/g;

function listSourceFiles(srcDir) {
  const files = [];
  const stack = [srcDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === 'test' || e.name === 'node_modules') continue;
        stack.push(path.join(dir, e.name));
      } else if (/\.ts$/.test(e.name)) {
        files.push(path.join(dir, e.name));
      }
    }
  }
  return files;
}

function declaredCommands(pkgPath) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return [];
  }
  const commands = pkg?.contributes?.commands ?? [];
  return commands.map((c) => c?.command).filter((id) => typeof id === 'string');
}

/** Line number (1-based) of a character offset, plus that line's text and the previous line's. */
function lineContext(text, offset) {
  const before = text.slice(0, offset);
  const lineNo = before.split('\n').length;
  const lines = text.split('\n');
  return {
    lineNo,
    line: lines[lineNo - 1] ?? '',
    prevLine: lines[lineNo - 2] ?? '',
  };
}

function main() {
  const srcDir = process.argv[2] ?? 'src';
  const pkgPath = process.argv[3] ?? 'package.json';

  const registered = new Set(declaredCommands(pkgPath));
  const files = listSourceFiles(srcDir);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of REGISTRATION_RES) {
      for (const m of text.matchAll(re)) registered.add(m[1]);
    }
  }

  // Anti-vacuity: a computed first argument (a ternary, a variable, a template)
  // matches DISPATCH_RE nowhere, so the id it dispatches silently leaves this
  // guard's inventory — a rename would then pass green. A ternary over two
  // intellig ids did exactly that and emptied the inventory for both. Dynamic
  // dispatch is legitimate in menu plumbing, so it annotates instead.
  const nonLiteral = [];
  let annotatedComputed = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(ANY_DISPATCH_RE)) {
      // A literal first argument (on this line or wrapped onto the next) is what
      // DISPATCH_RE already covers. A CONCATENATED id ('intellig.' + verb) also
      // starts with a quote, so it is skipped here and stays invisible to both
      // arms — see section 4.
      if (/^['"`]/.test(m[1].replace(/^\s+/, ''))) continue;
      const { lineNo, line, prevLine } = lineContext(text, m.index);
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      if (EXEMPT_RE.test(line) || EXEMPT_RE.test(prevLine)) {
        annotatedComputed++;
        continue;
      }
      nonLiteral.push({ file: f, lineNo });
    }
  }

  const unresolved = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(DISPATCH_RE)) {
      const id = m[1];
      if (registered.has(id)) continue;
      const { lineNo, line, prevLine } = lineContext(text, m.index);
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      if (EXEMPT_RE.test(line) || EXEMPT_RE.test(prevLine)) continue;
      unresolved.push({ id, file: f, lineNo });
    }
  }

  if (unresolved.length > 0) {
    console.error(
      `dispatch-targets guard FAILED — ${unresolved.length} executeCommand dispatch(es) target no registered command id:`
    );
    for (const u of unresolved) console.error(`  ${u.file}:${u.lineNo}  ${u.id}`);
    console.error(
      'Every executeCommand(\'intellig.*\') literal must resolve to a registered command ' +
        '(registration module or package.json contributes.commands), or the dispatch is a silent no-op. ' +
        'Annotate a sanctioned exception with `// dispatch-exempt: <reason>`.'
    );
    process.exit(1);
  }

  if (nonLiteral.length > 0) {
    console.error(
      `dispatch-targets guard FAILED — ${nonLiteral.length} commands.executeCommand call(s) pass a computed id, which this guard cannot see:`
    );
    for (const u of nonLiteral) console.error(`  ${u.file}:${u.lineNo}`);
    console.error(
      'A computed first argument removes that id from the guard\'s inventory, so a rename would pass green. ' +
        'Prefer a literal per branch (if/else over a ternary). Genuine dynamic dispatch annotates with ' +
        '`// dispatch-exempt: <reason>`.'
    );
    process.exit(1);
  }

  // Fail-closed floor: a refactor that renames the dispatch helper would leave
  // both scans matching nothing and this guard reporting OK over an empty
  // inventory. The tree has dozens of literal dispatches; zero means the
  // heuristic stopped seeing the code, not that the code stopped dispatching.
  let literalDispatches = 0;
  for (const f of files) {
    literalDispatches += [...fs.readFileSync(f, 'utf8').matchAll(DISPATCH_RE)].length;
  }
  if (literalDispatches === 0) {
    console.error(
      'dispatch-targets guard FAILED — matched zero intellig.* executeCommand dispatches. ' +
        'The scan is vacuous; the dispatch shape changed and DISPATCH_RE needs updating.'
    );
    process.exit(1);
  }

  console.log(
    `dispatch-targets guard OK — ${literalDispatches} intellig.* executeCommand dispatch(es) resolve to registered ids ` +
      `(${registered.size} registered id(s) known); ${annotatedComputed} computed dispatch(es) annotated.`
  );
}

main();
