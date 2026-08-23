#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// check-name-keyed-maps.mjs — data-keyed lookups may not inherit Object.prototype.
//
// Maintenance contract (per ADR-007 section "Guard maintenance contract"):
//
// 1. Bug class
//    An object literal is used as a lookup keyed by a name that comes from
//    OUTSIDE the program — a git ref, a JSON key, a persisted field. Every
//    Object.prototype member is then a phantom entry. Three shapes shipped:
//    a branch named `constructor` never entered the Log filter's tree (missing
//    from the popup AND from the leaf count the all/subset state derives from);
//    a segment named `__proto__` walked into the inherited value and threw
//    mid-render, blanking the whole popup; and `out[k] = v` with k = `__proto__`
//    from JSON.parse hits the prototype SETTER, so the ADR-003 forward-compat
//    field is silently dropped by the code that exists to preserve it.
//
// 2. Heuristic + how it scales
//    Flag a declaration that types a value as a string-keyed record AT THE
//    CONSTRUCTION SITE and initialises it with an empty object literal:
//      `: Record<string, T> = {}`  /  `: { [key: string]: T } = {}`
//      `= {} as Record<string, T>`
//    That is the shape the ADR-003 accumulator bug had. The two branch-filter
//    bugs did NOT have it — see section 4. `new Map()` /
//    `new Set()` / `Object.create(null)` are all invisible to it, which is the
//    point: the guard only sees the wrong one. Scales for free — a new record
//    accumulator anywhere under src/ is caught with no per-site edit.
//    What detects regex DRIFT is the companion spec's per-shape teeth cases,
//    not the floor below: zero hits is this guard's goal state, so the floor
//    can only catch the tree becoming unreadable, never a pattern going stale.
//
// 3. Known false-positive cases
//    A record whose keys AND whose LOOKUP keys are program-owned (a config
//    table read by literal) is safe, and annotates with
//    `// name-keyed-map-exempt: <reason>` on the line or the line above.
//    Both halves are required. Literal keys alone are NOT enough: a table of
//    literal command ids indexed by an untrusted webview string is exactly the
//    hazardous case (`constructor` returns a truthy function), and a criterion
//    naming only the keys would sanction it.
//
// 4. Known false-negative cases
//    A record whose key type is declared on an INTERFACE MEMBER rather than at
//    the construction site is invisible: `interface N { children: Record<string,
//    N> }` built as `{ children: {}, … }` has no annotation to match, and that
//    is exactly the shape of two of the three shipped bugs (the branch named
//    `constructor`, the `__proto__` folder segment). Reintroducing that shape
//    would not be caught here; those sites are Maps now, and the ref-rendering
//    suites are what cover them.
//    The READ shape is not fenced: this guard sees where a record is BUILT, not
//    where it is indexed, so `table[untrustedKey]` on a record declared
//    elsewhere (or inline, as an object literal argument) is invisible. The
//    three shipped bugs were accumulators, which is why the write shape is the
//    scope; the branch filter's third failure mode was a read, so this is a
//    real gap, closed today by review rather than by the guard.
//    An untyped `const m = {}` later used as a map is invisible (no annotation
//    to key on), as is a record built by spread rather than assignment. Both
//    stay on review. The guard reads text, not types, so a record aliased
//    through a type alias (`type Bag = Record<string, X>; const b: Bag = {}`)
//    is not seen either.
//
// 5. Retirement criteria
//    Retire when a lint rule enforces Map/Set for index signatures, or when
//    every such accumulator is expressed as a Map.
//
// Modes: DEFAULT (no args) scans ./src. EXPLICIT PATH (companion spec):
// `node check-name-keyed-maps.mjs <srcDir>`.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

const RECORD_LITERAL_RES = [
  /:\s*Record<\s*string\s*,[^=;]*>\s*=\s*\{\s*\}/g,
  /:\s*\{\s*\[[A-Za-z_$][\w$]*\s*:\s*string\s*\][^=;]*\}\s*=\s*\{\s*\}/g,
  /=\s*\{\s*\}\s+as\s+Record<\s*string\s*,/g,
];
const EXEMPT_RE = /\/\/\s*name-keyed-map-exempt:/;

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
      } else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
        files.push(path.join(dir, e.name));
      }
    }
  }
  return files;
}

function lineContext(text, offset) {
  const before = text.slice(0, offset);
  const lineNo = before.split('\n').length;
  const lines = text.split('\n');
  return { lineNo, line: lines[lineNo - 1] ?? '', prevLine: lines[lineNo - 2] ?? '' };
}

function main() {
  const srcDir = process.argv[2] ?? 'src';
  const files = listSourceFiles(srcDir);
  if (files.length === 0) {
    console.error(
      'check-name-keyed-maps FAILED — scanned zero files. The scan is vacuous; the tree layout changed.'
    );
    process.exit(1);
  }

  const hits = [];
  let exempt = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of RECORD_LITERAL_RES) {
      for (const m of text.matchAll(re)) {
        const { lineNo, line, prevLine } = lineContext(text, m.index);
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (EXEMPT_RE.test(line) || EXEMPT_RE.test(prevLine)) {
          exempt++;
          continue;
        }
        hits.push({ file: f, lineNo, text: trimmed.slice(0, 90) });
      }
    }
  }

  if (hits.length > 0) {
    console.error(
      `check-name-keyed-maps FAILED — ${hits.length} string-keyed record(s) initialised as an object literal:`
    );
    for (const h of hits) console.error(`  ${h.file}:${h.lineNo}  ${h.text}`);
    console.error(
      'An object literal inherits every Object.prototype member, so a key that comes from a git ref, ' +
        'a JSON field or persisted data (`constructor`, `toString`, `__proto__`) reads as already present ' +
        'and can be dropped, throw, or hit the prototype setter. Use `new Map()`, `new Set()`, or ' +
        '`Object.create(null)` when the value must stay a JSON-serialisable object. ' +
        'A record keyed only by literals this codebase owns annotates with `// name-keyed-map-exempt: <reason>`.'
    );
    process.exit(1);
  }

  console.log(
    `check-name-keyed-maps OK — ${files.length} file(s) scanned, no string-keyed record built from an object literal (${exempt} exempt).`
  );
}

main();
