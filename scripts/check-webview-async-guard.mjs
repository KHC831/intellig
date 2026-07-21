#!/usr/bin/env node
/*
 * check-webview-async-guard.mjs — webview async continuations must report.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a webview entry wraps its synchronous boot in a
 *    try/catch that posts a log message to the host, and then schedules the
 *    rest of its work with queueMicrotask/setTimeout/requestAnimationFrame.
 *    A throw inside one of those callbacks escapes the boot try/catch
 *    entirely: nothing is posted, the host logs nothing, and the panel goes
 *    inert mid-session with a half-built skeleton the user cannot Apply or
 *    Abort. The merge window shipped exactly that — its queued render called
 *    mustGet('banner'), which throws once that element is gone.
 *
 *    NOTE: this guard is now a SECOND line of defence. The primary net is
 *    check:webview-fatal-reporter, which requires a global error /
 *    unhandledrejection reporter per entry and therefore covers the
 *    event-handler and `.then()` families this one structurally cannot see.
 *    This guard survives only because naming the failing operation at the
 *    scheduling site produces a better message than a bare stack.
 *
 * 2. Heuristic + how it scales: scan every `src/**\/webview/*.ts`, find each
 *    `queueMicrotask(` / `setTimeout(` / `requestAnimationFrame(` call, and
 *    require its first argument to be a call to a guard helper — a `guardX(`
 *    whose declaration IN THIS FILE has a try/catch body — rather than a bare
 *    `()` / `function` / `async` callback literal. The name shape alone is not
 *    enough: a decoy `guardNothing(fn) { return fn; }` matches `^guard[A-Z]`
 *    while guarding nothing, so the name is resolved to what it refers to and
 *    the body is read, the same discipline the sibling
 *    check:webview-fatal-reporter uses for its reporter. Declaration lookup and
 *    the brace-match (the shared `blockAt`) run over the scripts/lib/source-scan
 *    CODE view (comments AND string bodies blanked), so a `}` in a string cannot
 *    close the body early and a `try`/`catch` in a log message cannot pose as
 *    control flow. Scales for free: new webview entries and new scheduling sites
 *    are covered when written.
 *
 *    Pinning cases per arm (companion spec, ADR-007 mechanism-flip discipline):
 *    the bare-callback arm flips on "fails on a synthetic webview entry that
 *    schedules a bare callback"; the name-resolves-to-try/catch arm flips on
 *    "fails on a same-named DECOY helper that does not try/catch"; the code-view
 *    resolution flips on "accepts a real guard helper whose body carries a brace
 *    inside a string" and "fails on a decoy whose only try/catch is inside a
 *    string literal".
 *
 * 3. Known false-positive cases: a scheduled callback whose body genuinely
 *    cannot throw (a one-line flag flip), a call passing an already-guarded
 *    named function reference, a guard helper IMPORTED from another module (its
 *    body cannot be resolved in this file, so the call reads as unguarded), a
 *    guard whose first `{` after its declaration is a destructured or
 *    object-default PARAMETER rather than its body (brace-match reads the param
 *    block), and a scheduler whose callback is separated from its `(` by a blank
 *    line (only the immediately-following line is inspected). All take the
 *    escape hatch: a `// async-guard-exempt: <reason>` comment on the line
 *    above. The single-guard-helper tree today (`guardContinuation`) hits none.
 *
 * 4. Known false-negative cases: a callback passed through a variable that was
 *    built unguarded elsewhere, a scheduler reached via an alias
 *    (`const q = queueMicrotask; q(cb)`), and promise `.then()` continuations.
 *    The alias form defeats a name-based grep by construction; code review
 *    covers it, and `.then()` at least surfaces as an unhandled rejection
 *    rather than pure silence. The `window.`/`globalThis.`/`self.` prefixed
 *    forms ARE in scope — they are the same global function. The whole
 *    EVENT-LISTENER family (`window.addEventListener('resize', …)`,
 *    `el.addEventListener('click', …)`), observer callbacks, and Monaco's
 *    onMouseDown are ALSO invisible here by construction — a scheduling-call
 *    grep cannot see them. They are covered by check:webview-fatal-reporter,
 *    not by this guard. Finally, the walk only enters directories literally
 *    named `webview`, so code bundled into a webview from elsewhere
 *    (merge-model, diff-engine) is out of scope; zero schedulers live there
 *    today, and the global reporter catches such a throw anyway.
 *
 * 5. Retirement criteria: retire when webview entries schedule only through a
 *    shared typed scheduler that cannot be handed an unguarded callback, which
 *    makes the wrong code fail to compile instead of failing this grep.
 *
 * Usage:
 *   node scripts/check-webview-async-guard.mjs
 *     — real mode: scans ./src.
 *   node scripts/check-webview-async-guard.mjs <dir>
 *     — fixture mode (companion spec): scans the given directory.
 *
 * Exit: 0 clean, 1 when an unguarded continuation is found.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import { scanSource, blockAt } from './lib/source-scan.mjs';

const SCHEDULERS = ['queueMicrotask', 'setTimeout', 'setInterval', 'requestAnimationFrame'];
const EXEMPT = 'async-guard-exempt:';

/** Every .ts file under a `webview` directory in the tree. */
function webviewFiles(root) {
  const out = [];
  const walk = (dir, inWebview) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, inWebview || entry === 'webview');
      } else if (inWebview && entry.endsWith('.ts')) {
        out.push(full);
      }
    }
  };
  walk(root, false);
  return out.sort();
}

/**
 * Whether `name` resolves to a helper that ACTUALLY guards: its body wraps the
 * work in try/catch. A name-shaped match is not enough — `guardNothing(fn) {
 * return fn; }` satisfied `^guard[A-Z]` while guarding nothing. Same class as
 * the `installTheme` decoy the sibling check:webview-fatal-reporter closes;
 * resolve the name to a declaration in THIS file and read what its body does.
 *
 * `code` is the source-scan code view (comments AND string bodies blanked), so
 * a `{`/`}` inside a string cannot close the body early and the words
 * `try`/`catch` inside a log message cannot pose as control flow.
 */
function guardBodyCatches(name, code) {
  const declared =
    new RegExp(`function\\s+${name}\\s*\\(`).exec(code) ??
    new RegExp(
      `(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function|\\()`
    ).exec(code);
  if (!declared) {
    return false;
  }
  const body = blockAt(code, declared.index);
  if (body === null) {
    return false;
  }
  return /\btry\b/.test(body) && /\bcatch\b/.test(body);
}

/**
 * The callback argument is guarded when it is produced by a helper whose name
 * matches `/^guard[A-Z]/` AND whose body try/catches —
 * `queueMicrotask(guardContinuation('render', () => …))`. A bare arrow /
 * function literal is not, and neither is a same-named decoy that does nothing.
 */
function isGuarded(afterOpenParen, code) {
  // Anchored at the start of the identifier: a substring match let
  // `guardless(() => …)` satisfy the guard.
  const m = /^\s*(guard[A-Z][\w$]*)\s*\(/.exec(afterOpenParen);
  return m !== null && guardBodyCatches(m[1], code);
}

const root = process.argv[2] ?? 'src';
const violations = [];

for (const file of webviewFiles(root)) {
  const source = readFileSync(file, 'utf8');
  // Resolve guard declarations over the code view (comments and string bodies
  // blanked, offsets preserved) so literals cannot spoof the try/catch body.
  const { code } = scanSource(source);
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // Comment lines describing the pattern must not trip the guard.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      return;
    }
    if (i > 0 && lines[i - 1].includes(EXEMPT)) {
      return;
    }
    for (const scheduler of SCHEDULERS) {
      const at = line.indexOf(`${scheduler}(`);
      if (at < 0) {
        continue;
      }
      // `window.setTimeout(` / `globalThis.queueMicrotask(` are the same global
      // reached through its object and stay in scope; any other receiver
      // (`this.setTimeout(`) is a different function, and a longer identifier
      // that merely ends in the scheduler name is not it at all.
      const before = line.slice(0, at);
      if (/[\w$]$/.test(before)) {
        continue;
      }
      if (before.endsWith('.') && !/(^|[^\w$])(window|globalThis|self)\.$/.test(before)) {
        continue;
      }
      const rest = line.slice(at + scheduler.length + 1);
      // A call broken across lines carries its callback on the next line.
      const arg = rest.trim() === '' ? (lines[i + 1] ?? '') : rest;
      if (!isGuarded(arg, code)) {
        violations.push(`${file}:${i + 1}: ${scheduler} callback is not wrapped in a guard helper`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error('Unguarded async continuations in webview entries:\n');
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  console.error(
    '\nA throw inside a scheduled callback escapes the boot try/catch and leaves the\n' +
      "panel inert with nothing reported to the host. Wrap the callback in the entry's\n" +
      'guard helper, or annotate the line above with `// async-guard-exempt: <reason>`.'
  );
  process.exit(1);
}

console.log(`check:webview-async-guard — clean (${webviewFiles(root).length} webview files)`);
