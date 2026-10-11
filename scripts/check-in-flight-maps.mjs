#!/usr/bin/env node
/*
 * check-in-flight-maps.mjs — coalesce in-flight work through FreshCoalescer.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a hand-rolled map of in-flight promises that answers a
 *    new caller with the run already going. For a read whose caller acts on
 *    the answer, a caller asking right after a change then gets a result read
 *    before it: getStatus and the changelist reconcile both did this, and a
 *    file written just before a reconcile landed in no changelist.
 *
 * 2. Heuristic + how it scales: in src/, a `Map<…, Promise<…>>` type (a field,
 *    a variable or a `new Map<…>()`) fails, read through the shared lexer's
 *    code view so a mention in a comment or a string is not one. Coalescing
 *    goes through src/utils/freshCoalescer.ts, which answers a caller arriving
 *    mid-run with a follow-up run. One pass over src/. Pinning case
 *    (companion spec): "fails a hand-rolled map of in-flight promises".
 *
 * 3. Known false-positive cases: a promise map that is not a read cache — a
 *    serial queue's tail, a registry drained at teardown. Mark it with
 *    `// in-flight-map-exempt: <reason>` on the line or the line above.
 *
 * 4. Known false-negative cases: an in-flight slot typed through an alias,
 *    held in a plain object or a single field (`let inFlight: Promise<T>`), or
 *    a Map whose key type itself holds a `<` or `,`. Review is the backstop.
 *
 * 5. Retirement criteria: retire when every in-flight slot goes through
 *    FreshCoalescer and a lint rule forbids Promise-valued Maps.
 *
 * Usage:
 *   node scripts/check-in-flight-maps.mjs        — scans ./src
 *   node scripts/check-in-flight-maps.mjs <dir>  — fixture mode (companion spec)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource, lineAt } from './lib/source-scan.mjs';
import { posixRelative } from './lib/posix-path.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[2] ?? join(repoRoot, 'src');

const PROMISE_MAP = /\bMap<\s*[^<>,]+,\s*Promise</g;
const EXEMPT = /\/\/\s*in-flight-map-exempt:\s*\S/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(root);
if (files.length === 0) {
  console.error('check-in-flight-maps: scanned zero files; the scan is vacuous');
  process.exit(1);
}

const failures = [];
let exempt = 0;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  if (!source.includes('Promise')) {
    continue;
  }
  const lines = source.split('\n');
  const { code } = scanSource(source);
  for (const m of code.matchAll(PROMISE_MAP)) {
    const line = lineAt(source, m.index);
    if (EXEMPT.test(lines[line - 1] ?? '') || EXEMPT.test(lines[line - 2] ?? '')) {
      exempt++;
      continue;
    }
    failures.push(`${posixRelative(root, file)}:${line}: ${(lines[line - 1] ?? '').trim()}`);
  }
}

if (failures.length > 0) {
  console.error(
    'check-in-flight-maps: a hand-rolled map of in-flight promises can answer a caller with a run that started before it asked.'
  );
  console.error(
    'Coalesce through FreshCoalescer (src/utils/freshCoalescer.ts), or justify with `// in-flight-map-exempt: <reason>`.'
  );
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}
console.log(`check-in-flight-maps: OK (${files.length} files, ${exempt} exempt)`);
