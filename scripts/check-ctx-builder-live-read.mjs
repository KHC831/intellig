#!/usr/bin/env node
/*
 * check-ctx-builder-live-read.mjs — setter-wired deps must be read LIVE by a
 * ctx builder, never snapshotted.
 *
 * ADR-007 "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: an extract-method refactor moves a handler into a module
 *    behind a per-call `_xContext()` builder. If the builder SNAPSHOTS a
 *    setter-wired dependency (`dep: this._dep`) instead of exposing a call-time
 *    lambda (`dep: () => this._dep`), the dep is captured at handler entry. The
 *    original body read it LIVE — often after an await — so any wiring that
 *    lands between handler entry and the read is silently lost (e.g. undo's
 *    changelist chooser vanished when the service was wired mid-await). The
 *    body-only byte-identical diff is BLIND to this: `ctx.dep` is token-
 *    identical whether the builder snapshots or lambdas. This guard makes the
 *    builder side machine-checked.
 *
 * 2. Heuristic + how it scales + which spec case pins which arm: walk
 *    <scanRoot>/**\/*.ts. Per file, (a) collect backing fields assigned inside
 *    `set<Name>(...)` methods (the setter-wired set); (b) find `_*Context(...)`
 *    builder methods; (c) inside each builder, flag any `<key>: this._<field>`
 *    snapshot whose field is setter-wired — the compliant form `() => this._x`
 *    puts `this._x` after `=>`, so the `:\s*this\._` snapshot pattern never
 *    matches it. O(files). Companion spec
 *    (test/unit/scripts/checkCtxBuilderLiveRead.test.ts) pins: the 'snapshot'
 *    fixture -> the violation arm; the 'lambda' fixture -> the compliant arm;
 *    the 'non-setter' fixture -> the constructor-stable-is-fine arm; the
 *    'exempt' fixture -> the justification escape hatch.
 *
 * 3. Known false-positive cases (today's exempts): a setter-wired field read
 *    BEFORE the first await in the moved body is safe to snapshot (snapshot ==
 *    live there), but the guard cannot see the consuming body's await timing, so
 *    it conservatively requires a lambda for ALL setter-wired fields — a lambda
 *    is never wrong. Opt a provably-safe snapshot out with a trailing
 *    `// live-read-exempt: <reason>` on the offending line.
 *
 * 4. Known false-negative cases: a field mutated post-construction by a method
 *    NOT named `set*` (e.g. a one-time `register()` init) is not collected, so a
 *    snapshot of it is not flagged — acceptable because one-time inits are
 *    effectively constructor-stable; genuine setters use the `set*` convention.
 *    A builder that hands the dep to a helper by another means than `key:
 *    this._field` is out of scope.
 *
 * 5. Retirement criteria: retire when a typed effect-system or lint rule
 *    enforces call-time capture of mutable deps natively, or when no
 *    `_*Context()` builders remain.
 *
 * Usage:
 *   node scripts/check-ctx-builder-live-read.mjs
 *     — real mode: scans ./src.
 *   node scripts/check-ctx-builder-live-read.mjs <scanRoot>
 *     — fixture mode (companion spec): scans <scanRoot>.
 */

import { readFileSync, readdirSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [argScanRoot] = process.argv.slice(2);
const scanRoot = argScanRoot !== undefined ? path.resolve(argScanRoot) : path.join(repoRoot, 'src');

function collectTsFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return out;
}

/** Body line ranges [start, end) of class methods whose signature matches sigRe. */
function methodBodies(lines, sigRe) {
  const bodies = [];
  for (let i = 0; i < lines.length; i++) {
    if (!sigRe.test(lines[i])) continue;
    let j = i;
    while (j < lines.length && !/\{\s*$/.test(lines[j])) j++;
    let k = j + 1;
    while (k < lines.length && !/^ {2}\}\s*$/.test(lines[k])) k++;
    bodies.push([j + 1, k]);
  }
  return bodies;
}

const SETTER_SIG = /^\s*(public |private )?set[A-Z]\w*\(/;
const BUILDER_SIG = /^\s*(private |public )?_\w*Context\(/;

const problems = [];
for (const rel of collectTsFiles(scanRoot)) {
  const lines = readFileSync(path.join(scanRoot, rel), 'utf8').split('\n');

  const setterFields = new Set();
  for (const [s, e] of methodBodies(lines, SETTER_SIG)) {
    for (let i = s; i < e; i++) {
      const m = lines[i].match(/this\._(\w+)\s*=(?!=)/);
      if (m) setterFields.add(m[1]);
    }
  }
  if (setterFields.size === 0) continue;

  for (const [s, e] of methodBodies(lines, BUILDER_SIG)) {
    for (let i = s; i < e; i++) {
      const line = lines[i];
      if (/\/\/\s*live-read-exempt:/.test(line)) continue;
      const m = line.match(/:\s*this\._(\w+)\b/);
      if (m && setterFields.has(m[1])) {
        problems.push(
          `${rel}:${i + 1}: ctx builder snapshots setter-wired field this._${m[1]} — ` +
            `expose it as a call-time lambda (${m[1]}: () => this._${m[1]}) so it is read live, ` +
            `not captured at handler entry. If a pre-first-await snapshot is provably safe, ` +
            `annotate the line '// live-read-exempt: <reason>'.`
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error('check-ctx-builder-live-read: setter-wired dep snapshotted in a ctx builder\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('');
  process.exit(1);
}
console.log('check-ctx-builder-live-read: OK');
