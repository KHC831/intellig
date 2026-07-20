#!/usr/bin/env node
/*
 * check-panel-dispose-seam.mjs — a BaseWebviewPanel subclass must not register
 * its own onDidDispose into the disposables the base drains.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a silent, permanent hang. BaseWebviewPanel's
 *    constructor registers `_panel.onDidDispose(() => this.dispose(), null,
 *    this._disposables)`, and `dispose()` drains `_disposables`. A subclass
 *    that later registers `this._panel.onDidDispose(cb, null,
 *    this._disposables)` has that subscription disposed DURING the same
 *    delivery — and VS Code's Emitter skips listeners disposed mid-delivery,
 *    so `cb` never runs. When `cb` is what settles a `prompt()` promise, the
 *    awaiting caller hangs forever with no error. Live instances:
 *    DefineRemoteDialog (hung runConfigureRemotesFlow) and
 *    CommitMessageDialog. The unit lane could not see this until the `vscode`
 *    mock's EventEmitter was corrected to match real delivery semantics.
 *
 * 2. Heuristic + how it scales: find files declaring `extends
 *    BaseWebviewPanel`, then reject any `.onDidDispose(` call in them whose
 *    argument list mentions `this._disposables` — ANY receiver, not just
 *    `this._panel`, so aliasing the panel to a local does not slip past. The
 *    call's parens are balanced, so single-line and multi-line registrations
 *    are treated identically. One file read per
 *    subclass; scales with subclass count, which is small. The defining file
 *    is excluded — its own registration is the legitimate one. Standalone panels
 *    that own their own `_panel` and are NOT BaseWebviewPanel subclasses
 *    (CommitDialog, RebaseEditor, RebaseProgressView) are out of scope: with
 *    no earlier draining listener there is nothing to be skipped by.
 *
 * 3. Known false-positive cases: a subclass registering an onDidDispose that
 *    deliberately does nothing on the close path (pure telemetry that may be
 *    dropped). Annotate the call with `// dispose-seam-exempt: <reason>`.
 *    Prefer overriding `dispose()` — that seam always runs.
 *
 * 4. Known false-negative cases, stated in full:
 *    (a) a two-statement registration (`const d = panel.onDidDispose(cb);
 *        this._disposables.push(d);`) is not matched — the sink is not an
 *        argument of the call.
 *    (b) a disposables array under a different name than `_disposables`.
 *    (c) only `onDidDispose` is checked. Other subscriptions registered into
 *        the drained array are correct to release there; the hazard is specific
 *        to a callback that must RUN at teardown.
 *    (d) a subclass whose base is imported under an alias
 *        (`import { BaseWebviewPanel as Base }`) is not linked to the base.
 *    (e) a regex literal is lexed as its own context and its body masked (see
 *        scripts/lib/source-scan.mjs), but one written directly after `)`, as
 *        in `if (x) /re/.test(y)`, is read as division and its body left as
 *        code. That over-scans rather than blanking real code, so the worst it
 *        can cost is a false positive, never a missed violation.
 *    NOT gaps — all covered and pinned in
 *    test/unit/scripts/checkPanelDisposeSeam.test.ts: single-line and
 *    multi-line registrations, panel aliasing, optional chaining, transitive
 *    subclasses, anonymous default-export classes, an annotation in a string
 *    literal, an annotation elsewhere in the file, prose naming the base class
 *    in a comment, a call shape inside a string literal, a registration below a
 *    quote-carrying regex literal, one sharing a line with a division, and one
 *    below a postfix `++` division. The lexer invariants those last three rest
 *    on are pinned directly in test/unit/scripts/sourceScan.test.ts.
 *
 * 5. Retirement criteria: retire when BaseWebviewPanel exposes a documented
 *    `onWillDispose` hook that subclasses override instead, so the wrong
 *    registration has no reason to be written.
 *
 *    Re-proving this guard: target the revision that actually CONTAINS the bug,
 *    i.e. the commit BEFORE "Settle dialog promises from dispose() instead of a
 *    drained onDidDispose". An arbitrary recent ancestor reads a false OK
 *    because the fix may already be in it. Extract the offending file with
 *    `git show <rev>:<path>` into a fixture root; never reach for the working
 *    tree or the stash.
 *
 * Usage:
 *   node scripts/check-panel-dispose-seam.mjs
 *     — real mode: scans src/.
 *   node scripts/check-panel-dispose-seam.mjs <srcRoot>
 *     — fixture mode (companion spec): scans an arbitrary root.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanSource, lineAt, lineText } from './lib/source-scan.mjs';

const SRC_ROOT = process.argv[2] ?? 'src';
const ESCAPE_HATCH = 'dispose-seam-exempt:';
const BASE_CLASS = 'BaseWebviewPanel';

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) {
    return out;
  }
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC_ROOT).map((path) => {
  const source = readFileSync(path, 'utf8');
  return { path, source, ...scanSource(source) };
});

/**
 * Class names that extend the base transitively. A subclass may sit behind an
 * intermediate (`class Mid extends BaseWebviewPanel`, `class Demo extends Mid`),
 * so seed with the base and widen to a fixed point across all files.
 */
const subclassNames = new Set([BASE_CLASS]);
for (let changed = true; changed; ) {
  changed = false;
  for (const { code } of files) {
    for (const m of code.matchAll(/class\s+([A-Za-z0-9_$]+)[^{]*?\bextends\s+([A-Za-z0-9_$]+)/g)) {
      if (subclassNames.has(m[2]) && !subclassNames.has(m[1])) {
        subclassNames.add(m[1]);
        changed = true;
      }
    }
  }
}

/** True when this file declares a class extending the base (named or anonymous). */
function declaresSubclass(code) {
  // Anonymous default export: `export default class extends BaseWebviewPanel`.
  if (new RegExp(`class\\s+extends\\s+(?:${[...subclassNames].join('|')})\\b`).test(code)) {
    return true;
  }
  for (const m of code.matchAll(/class\s+([A-Za-z0-9_$]+)[^{]*?\bextends\s+([A-Za-z0-9_$]+)/g)) {
    if (subclassNames.has(m[2])) {
      return true;
    }
  }
  return false;
}

/** True when this file DEFINES the base class itself. */
function definesBase(code) {
  return new RegExp(`class\\s+${BASE_CLASS}\\b`).test(code);
}

const failures = [];

for (const { path, source, code, comments } of files) {
  // Tested against the CODE view: prose naming the base class in a comment or
  // a string must not disable the guard for the whole file.
  if (definesBase(code) || !declaresSubclass(code)) {
    continue;
  }

  // `?.` is the same registration.
  const re = /\b[A-Za-z_$][A-Za-z0-9_$.]*\??\.onDidDispose\(/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = open;
    while (end < code.length) {
      if (code[end] === '(') {
        depth++;
      } else if (code[end] === ')') {
        depth--;
        if (depth === 0) {
          break;
        }
      }
      end++;
    }
    if (!code.slice(open + 1, end).includes('this._disposables')) {
      continue;
    }

    // The annotation must be a real COMMENT on the call line or the one above.
    const line = lineAt(code, match.index);
    const annotated =
      lineText(comments, line).includes(ESCAPE_HATCH) ||
      lineText(comments, line - 1).includes(ESCAPE_HATCH);
    if (annotated) {
      continue;
    }

    failures.push(
      `${path}:${line}: registers onDidDispose into this._disposables.\n` +
        `    ${BASE_CLASS} already registered a listener that drains them, so this\n` +
        `    one is disposed mid-delivery and never fires. Override dispose() instead,\n` +
        `    or annotate with '// ${ESCAPE_HATCH} <reason>'.`
    );
  }
  void source;
}

if (failures.length > 0) {
  console.error('check-panel-dispose-seam: onDidDispose registered into drained disposables\n');
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}

console.log(`check-panel-dispose-seam: OK (scanned ${resolve(SRC_ROOT)})`);
