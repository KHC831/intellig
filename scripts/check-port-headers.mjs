#!/usr/bin/env node
/*
 * check-port-headers.mjs — code translated from IntelliJ keeps its Apache-2.0 attribution.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a file translated from JetBrains IntelliJ Community
 *    (Apache-2.0) shipping without the upstream copyright line. Apache-2.0
 *    requires derivative works to keep the original attribution; the graph
 *    layout engine and the squash-message rules were ported without it.
 *
 * 2. Heuristic + how it scales: scripts/ported-files.json lists every ported
 *    file and its upstream source. Three rules over src/ and test/:
 *    (a) every listed file exists and its first lines name JetBrains s.r.o.
 *        and the Apache 2.0 license;
 *    (b) every file whose first lines name JetBrains s.r.o. is listed, so the
 *        manifest stays the full inventory;
 *    (c) every file whose top comment says it is a port of IntelliJ or
 *        git4idea code is listed, or carries `intellij-reference-only:
 *        <reason>` near the top (a design that follows IntelliJ without
 *        translating its code).
 *    One read of the first lines of each file. Pinning cases (companion
 *    spec): "fails a listed file without the header", "fails a declared
 *    port missing from the manifest".
 *
 * 3. Known false-positive cases: a top comment that uses "port" for
 *    something other than a translation (porting a policy or a design). Mark
 *    it `intellij-reference-only: <reason>`.
 *
 * 4. Known false-negative cases: translated code whose comments never say
 *    so, and a port of a single function inside an otherwise original file
 *    whose top comment does not mention it. Review is the backstop.
 *
 * 5. Retirement criteria: none while ported code ships.
 *
 * Usage:
 *   node scripts/check-port-headers.mjs          — checks this repository
 *   node scripts/check-port-headers.mjs <root>   — fixture mode (companion spec): <root> holds
 *                                                  scripts/ported-files.json, src/ and test/
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { posixRelative } from './lib/posix-path.mjs';

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADER_LINES = 10;
const TOP_LINES = 25;
const DECLARED_PORT =
  /\b(port(ed)?\s+(of|from)|verbatim\s+port|faithful\s+(typescript\s+)?port|translated\s+from)\b[^\n]{0,120}\b(IntelliJ|git4idea|intellij-community|JetBrains)\b/i;
const REFERENCE_ONLY = /intellij-reference-only:\s*\S/;

const manifestPath = join(root, 'scripts', 'ported-files.json');
const listed = Object.keys(JSON.parse(readFileSync(manifestPath, 'utf8')).files ?? {});
if (listed.length === 0) {
  console.error(
    'check-port-headers: scripts/ported-files.json lists no files; the check is vacuous'
  );
  process.exit(1);
}

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

/** The comment lines among a file's first `n` lines; code (a string holding a header) is not attribution. */
const firstLines = (file, n) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .slice(0, n)
    .filter((line) => /^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
const hasHeader = (text) => /JetBrains s\.r\.o\./.test(text) && /Apache 2\.0/.test(text);

const failures = [];
const listedSet = new Set(listed);

for (const rel of listed) {
  const file = join(root, rel);
  if (!existsSync(file)) {
    failures.push(`${rel}: listed in scripts/ported-files.json but missing`);
  } else if (!hasHeader(firstLines(file, HEADER_LINES).replace(/\s+/g, ' '))) {
    failures.push(`${rel}: ported file without the JetBrains copyright and Apache 2.0 line`);
  }
}

for (const file of [...walk(join(root, 'src')), ...walk(join(root, 'test'))]) {
  const rel = posixRelative(root, file);
  if (listedSet.has(rel)) {
    continue;
  }
  if (/JetBrains s\.r\.o\./.test(firstLines(file, HEADER_LINES))) {
    failures.push(`${rel}: carries the JetBrains line but is not in scripts/ported-files.json`);
    continue;
  }
  const top = firstLines(file, TOP_LINES);
  if (DECLARED_PORT.test(top.replace(/\s*\n\s*(\*|\/\/)?\s*/g, ' ')) && !REFERENCE_ONLY.test(top)) {
    failures.push(
      `${rel}: says it is a port of IntelliJ code but is not in scripts/ported-files.json`
    );
  }
}

if (failures.length > 0) {
  console.error(
    'check-port-headers: code translated from IntelliJ must keep its Apache-2.0 attribution.'
  );
  console.error(
    'Add the JetBrains copyright line and list the file in scripts/ported-files.json, or mark a design\n' +
      'that only follows IntelliJ with `intellij-reference-only: <reason>` near the top.'
  );
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}
console.log(`check-port-headers: OK (${listed.length} ported files)`);
