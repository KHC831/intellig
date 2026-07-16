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
//    Ids assembled at runtime (`'intellig.' + verb`) are invisible to the
//    literal scan, as are argument-contract mismatches (right id, wrong
//    payload shape) — those stay on unit/e2e coverage. A registration that
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

  console.log(
    `dispatch-targets guard OK — all intellig.* executeCommand dispatches resolve to registered ids (${registered.size} registered id(s) known).`
  );
}

main();
