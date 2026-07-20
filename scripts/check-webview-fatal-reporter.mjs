#!/usr/bin/env node
/*
 * check-webview-fatal-reporter.mjs — webview entries must report fatals.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a webview entry guards its synchronous boot in a
 *    try/catch and nothing else. A throw from an event listener, an observer
 *    callback, an editor mouse handler, a scheduled callback, or a rejected
 *    promise then escapes with NOTHING posted to the host: the panel goes
 *    inert mid-session and the user is left with a tab that can neither Apply
 *    nor Abort. The merge window shipped exactly that. The predecessor of this
 *    guard tried to fence each SCHEDULING call site; that shape could never
 *    cover the event-handler family or `.then()`, and it silently missed
 *    `window.setTimeout` and `el.addEventListener`. One global net at boot
 *    subsumes all of them, so this checks for the net instead.
 *
 * 2. Heuristic + how it scales: an entry is any file under a `webview`
 *    directory that calls `acquireVsCodeApi()`. Each must register BOTH
 *    `window.addEventListener('error', …)` and
 *    `window.addEventListener('unhandledrejection', …)`, and when the entry
 *    has a `boot()` function that registration must be the FIRST call in its
 *    body — a throw during DOM construction has to report too, which is what
 *    the failure message has always demanded. One structural fact per entry,
 *    so a new entry is covered the day it is written and no new throw site can
 *    outrun it.
 *
 * 3. Known false-positive cases: an entry that installs the pair through a
 *    shared helper imported from elsewhere — the call is then not literally in
 *    the file. Such an entry takes the escape hatch: a
 *    `// fatal-reporter-exempt: <reason>` comment naming the helper.
 *    `self.addEventListener('error', …)` is flagged even though `self` is a
 *    valid global in a webview: pinning one canonical form keeps the check
 *    simple, and switching to `window.` (or the hatch) covers a deliberate
 *    choice. The ordering check errs STRICT: it flags ANY call before the
 *    reporter, including a harmless `const cfg = readConfig();` — the
 *    justification being that anything can throw, and moving two lines up is
 *    cheaper than deciding which calls are safe. An entry whose boot this
 *    script cannot locate — neither a `function boot` declaration nor a
 *    `const/let/var boot =` arrow or function expression — is checked for
 *    presence only, since there is no body whose ordering can be read.
 *    The RESOLVER behind `isReporterCall` errs strict in two further ways,
 *    both of which fail the build rather than passing silently: a helper
 *    assigned from a call rather than a literal
 *    (`const installFatalReporter = wrap(() => {…})`) does not resolve, and
 *    resolution is FIRST-TEXTUAL-MATCH within the file rather than
 *    scope-aware, so a same-named inner function appearing earlier wins over
 *    the outer one the boot actually calls. Both are fixed by naming the
 *    helper distinctly or taking the hatch.
 *    Separately, the entries that PRE-DATE this guard are listed in
 *    scripts/check-webview-fatal-reporter-allowlist.txt: each needs a 'fatal'
 *    level in its own protocol and a host handler for it, which is a per-
 *    surface slice rather than a mechanical edit. That list is a visible,
 *    shrinking debt; a NEW entry may not join it.
 *
 * 4. Known false-negative cases, stated in full:
 *    - An entry that registers both listeners but whose handler bodies do not
 *      actually post to the host (an empty body satisfies the grep). The
 *      handler contents are each entry's own spec's job.
 *    - `stripComments` removes comments but NOT string literals, so a file
 *      whose only occurrence sits inside a string would pass. Contrived; it
 *      takes a deliberate act to write.
 *    - `registersBoth` greps the resolved helper's body, so a registration
 *      sitting in a nested function that is never called still counts. This is
 *      the same "checks the shape, not the fact" class the resolver fixes, one
 *      level deeper; chasing it needs real scope analysis rather than more
 *      grep, and the presence check still requires the listeners to exist in
 *      the file at all. Writing it takes deliberate dead code.
 *    - The reporter must report at a level the HOST acts on. This guard checks
 *      that the net exists, not what it decides: over-reporting (closing a
 *      live panel on a benign page error) is the entry's own spec's job.
 *    - The walk only enters directories literally named `webview`, so code
 *      BUNDLED INTO a webview from elsewhere (src/conflicts/merge-model,
 *      src/diff-engine) is out of scope. Latent today — those trees register
 *      no listeners and schedule nothing — but a throw there is caught by the
 *      importing entry's global net, which is why this is acceptable rather
 *      than merely unnoticed.
 *    - An entry reached by a bundler through a path this walk does not treat
 *      as an entry (no direct `acquireVsCodeApi()` call).
 *
 * 5. Retirement criteria: retire when every entry boots through a shared
 *    bootstrap that installs the reporter itself, so an entry without one
 *    cannot be constructed and the wrong code fails to compile.
 *
 * Usage:
 *   node scripts/check-webview-fatal-reporter.mjs
 *     — real mode: scans ./src.
 *   node scripts/check-webview-fatal-reporter.mjs <dir>
 *     — fixture mode (companion spec): scans the given directory.
 *
 * Exit: 0 clean, 1 when an entry lacks the global reporter.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const EXEMPT = 'fatal-reporter-exempt:';
const REQUIRED = ['error', 'unhandledrejection'];

/** Every .ts file under a directory literally named `webview`. */
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

/** Strip line and block comments so prose cannot satisfy (or trip) the checks. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Body of the `{ … }` whose opening brace is at or after `from`. */
function blockAt(source, from) {
  const start = source.indexOf('{', from);
  if (start < 0) {
    return null;
  }
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
    } else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start + 1, i);
      }
    }
  }
  return null;
}

/**
 * The body of the entry's boot, whether declared or assigned. Both
 * `function boot()` and `const boot = () => {}` are boots; matching only the
 * former let an arrow-assigned entry skip the ordering check entirely.
 */
function bootBody(source) {
  const declared = /function\s+boot\s*\([^)]*\)\s*(?::\s*\w+\s*)?\{/.exec(source);
  if (declared) {
    return blockAt(source, declared.index);
  }
  const assigned =
    /(?:const|let|var)\s+boot\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*\w+\s*)?=>\s*\{/.exec(
      source
    ) ??
    /(?:const|let|var)\s+boot\s*(?::[^=]+)?=\s*(?:async\s*)?function\s*\([^)]*\)\s*\{/.exec(source);
  return assigned ? blockAt(source, assigned.index + assigned[0].length - 1) : null;
}

/** Does this block register both listeners directly? */
function registersBoth(block) {
  return REQUIRED.every((event) =>
    new RegExp(`window\\s*\\.\\s*addEventListener\\s*\\(\\s*['"\`]${event}['"\`]`).test(block)
  );
}

/**
 * Whether `callee` IS the reporter. A name-shaped match (`/^install[A-Z]/`)
 * is not enough — `installTheme()` satisfied that while installing nothing.
 * The same class as the `guardless` hole in the sibling guard: match on what
 * the name REFERS TO, by resolving it to a function in this file and checking
 * that its body registers both listeners.
 */
function isReporterCall(callee, source) {
  if (/^window\.addEventListener$/.test(callee)) {
    return true;
  }
  if (!/^[\w$]+$/.test(callee)) {
    return false;
  }
  const declared = new RegExp(`function\\s+${callee}\\s*\\([^)]*\\)\\s*(?::\\s*\\w+\\s*)?\\{`).exec(
    source
  );
  if (declared) {
    const body = blockAt(source, declared.index);
    return body !== null && registersBoth(body);
  }
  const assigned = new RegExp(
    `(?:const|let|var)\\s+${callee}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\([^)]*\\)|\\w+)\\s*(?::\\s*\\w+\\s*)?=>\\s*\\{`
  ).exec(source);
  if (assigned) {
    const body = blockAt(source, assigned.index + assigned[0].length - 1);
    return body !== null && registersBoth(body);
  }
  return false;
}

/**
 * The reporter must run before anything else in boot, UNCONDITIONALLY: a
 * throw during DOM construction has to report too, and a registration nested
 * in an `if` may never happen at all. Returns the offending first call (or a
 * description of why the first one does not count), else null.
 */
function callBeforeReporter(body, source) {
  const call = /(?:^|[^.\w$])((?:\w[\w$]*\s*\.\s*)*\w[\w$]*)\s*\(/g;
  let depth = 0;
  let index = 0;
  let m;
  while ((m = call.exec(body)) !== null) {
    // Brace depth at this call: anything nested sits inside a conditional or
    // block, so it is not unconditionally first.
    for (; index < m.index; index++) {
      if (body[index] === '{') {
        depth++;
      } else if (body[index] === '}') {
        depth--;
      }
    }
    const callee = m[1].replace(/\s+/g, '');
    if (/^(?:if|for|while|switch|catch|return|typeof|new)$/.test(callee)) {
      continue;
    }
    if (!isReporterCall(callee, source)) {
      return `${callee}()`;
    }
    return depth > 0 ? `${callee}() only conditionally` : null;
  }
  return null;
}

const root = process.argv[2] ?? 'src';
// Fixture mode (an explicit root) never applies the allowlist, so the
// companion spec always sees the guard's real behaviour.
const allowlist = new Set();
if (process.argv[2] === undefined) {
  const listPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'check-webview-fatal-reporter-allowlist.txt'
  );
  if (existsSync(listPath)) {
    for (const line of readFileSync(listPath, 'utf8').split('\n')) {
      const entry = line.trim();
      if (entry !== '' && !entry.startsWith('#')) {
        allowlist.add(entry);
      }
    }
  }
}

const violations = [];
let entryCount = 0;
let deferred = 0;

for (const file of webviewFiles(root)) {
  const raw = readFileSync(file, 'utf8');
  if (raw.includes(EXEMPT)) {
    continue;
  }
  const source = stripComments(raw);
  // An entry is a file that takes the host API handle for itself.
  if (!/acquireVsCodeApi\s*\(\s*\)/.test(source)) {
    continue;
  }
  entryCount++;
  if (allowlist.has(file.split(path.sep).join('/'))) {
    deferred++;
    continue;
  }
  const missing = REQUIRED.filter(
    (event) =>
      !new RegExp(`window\\s*\\.\\s*addEventListener\\s*\\(\\s*['"\`]${event}['"\`]`).test(source)
  );
  if (missing.length > 0) {
    violations.push(
      `${file}: no window.addEventListener(${missing.map((m) => `'${m}'`).join(' / ')}, …)`
    );
    continue;
  }
  const body = bootBody(source);
  if (body !== null) {
    const early = callBeforeReporter(body, source);
    if (early !== null) {
      violations.push(
        `${file}: boot() reaches ${early} before installing the reporter — a throw there reports nothing`
      );
    }
  }
}

if (violations.length > 0) {
  console.error('Webview entries without a global fatal reporter:\n');
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  console.error(
    '\nA throw from an event listener, observer, scheduled callback or rejected\n' +
      'promise otherwise escapes with nothing posted, leaving a tab the user can\n' +
      "neither Apply nor Abort. Install both listeners at the top of the entry's\n" +
      'boot and post a fatal-level log, or annotate the file with\n' +
      '`// fatal-reporter-exempt: <reason>` naming the shared helper that does.'
  );
  process.exit(1);
}

const suffix = deferred > 0 ? `, ${deferred} awaiting migration (see the allowlist)` : '';
console.log(
  `check:webview-fatal-reporter — clean (${entryCount - deferred}/${entryCount} entries${suffix})`
);
