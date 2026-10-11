#!/usr/bin/env node
/*
 * check-script-host-paths.mjs — guards read host paths through the shared helpers.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a guard that only works on POSIX paths. On Windows a
 *    shell guard splitting `grep -n` output at the first colon took the drive
 *    letter of `D:\a\repo\src/x.ts:12:text` for the file, so its fixture specs
 *    failed or passed for the wrong reason; and a Node guard comparing
 *    `path.relative(...)` against a `/`-spelled pattern matched nothing, so
 *    check-host-revalidates passed the real tree without checking an entry.
 *
 * 2. Heuristic + how it scales: under scripts/, a shell script's `${var%%:*}`
 *    (outside a `#` comment) fails; splits go through split_grep_hit in
 *    scripts/lib/grep-hit.sh. A Node script's `relative(` call, read through
 *    the shared lexer's code view, fails; relative paths go through
 *    posixRelative in scripts/lib/posix-path.mjs. One pass over scripts/.
 *    Pinning cases (companion spec): "fails a hand-rolled grep-hit split" and
 *    "fails a bare relative() call".
 *
 * 3. Known false-positive cases: a `%%:*` that splits something other than a
 *    grep hit (a `path:name` entry of the script's own list, a `grep -n` run
 *    on one file, which prints no file), and the two shared helpers
 *    themselves. Mark the line with `script-path-exempt: <reason>` on the line
 *    or the line above.
 *
 * 4. Known false-negative cases: a split spelled another way (`cut -d:`,
 *    `IFS=: read`, awk -F:), and a host-separator path built with `join` and
 *    then compared to a `/` literal. Review is the backstop.
 *
 * 5. Retirement criteria: retire when the guards stop parsing grep output in
 *    shell, or CI runs check:all on Windows.
 *
 * Usage:
 *   node scripts/check-script-host-paths.mjs        — scans ./scripts
 *   node scripts/check-script-host-paths.mjs <dir>  — fixture mode (companion spec)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource, lineAt } from './lib/source-scan.mjs';
import { posixRelative } from './lib/posix-path.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[2] ?? join(repoRoot, 'scripts');

const SHELL_SPLIT = /\$\{\w+%%:\*\}/;
const NODE_RELATIVE = /\brelative\(/g;
const EXEMPT = /script-path-exempt:\s*\S/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(sh|mjs|js)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(root);
if (files.length === 0) {
  console.error('check-script-host-paths: scanned zero files; the scan is vacuous');
  process.exit(1);
}

const failures = [];
let exempt = 0;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const hits = [];
  if (file.endsWith('.sh')) {
    lines.forEach((text, i) => {
      if (!text.trimStart().startsWith('#') && SHELL_SPLIT.test(text)) {
        hits.push(i + 1);
      }
    });
  } else {
    const { code } = scanSource(source);
    for (const m of code.matchAll(NODE_RELATIVE)) {
      hits.push(lineAt(source, m.index));
    }
  }
  for (const line of hits) {
    if (EXEMPT.test(lines[line - 1] ?? '') || EXEMPT.test(lines[line - 2] ?? '')) {
      exempt++;
      continue;
    }
    failures.push(`${posixRelative(root, file)}:${line}: ${(lines[line - 1] ?? '').trim()}`);
  }
}

if (failures.length > 0) {
  console.error('check-script-host-paths: a guard reading a host path in a POSIX-only way.');
  console.error(
    'Split grep hits with split_grep_hit (scripts/lib/grep-hit.sh) and build relative paths with\n' +
      'posixRelative (scripts/lib/posix-path.mjs), or justify with `script-path-exempt: <reason>`.'
  );
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}
console.log(`check-script-host-paths: OK (${files.length} files, ${exempt} exempt)`);
