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
 *    require its first argument to be a call to a guard helper (a function
 *    whose name matches /guard/i) rather than a bare `()` / `function` /
 *    `async` callback literal. Scales for free: new webview entries and new
 *    scheduling sites are covered the moment they are written.
 *
 * 3. Known false-positive cases: a scheduled callback whose body genuinely
 *    cannot throw (a one-line flag flip), and a call passing an already-guarded
 *    named function reference. Both take the escape hatch: a
 *    `// async-guard-exempt: <reason>` comment on the line above.
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
 * The callback argument is guarded when it is produced by a helper whose name
 * contains "guard" — `queueMicrotask(guardContinuation('render', () => …))`.
 * A bare arrow/function literal is not.
 */
function isGuarded(afterOpenParen) {
  // Anchored at the start of the identifier: a substring match let
  // `guardless(() => …)` satisfy the guard.
  return /^\s*guard[A-Z][\w$]*\s*\(/.test(afterOpenParen);
}

const root = process.argv[2] ?? 'src';
const violations = [];

for (const file of webviewFiles(root)) {
  const lines = readFileSync(file, 'utf8').split('\n');
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
      if (!isGuarded(arg)) {
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
