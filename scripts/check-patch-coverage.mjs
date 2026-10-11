#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// check-patch-coverage.mjs — new/changed source lines must be tested.
//
// Maintenance contract:
//
// 1. Bug class
//    A PR can add or change executable source while the GLOBAL coverage %
//    barely moves, so untested new logic (an error branch, a guard, a wrong
//    repo/path) slips in unnoticed. Chasing the global number tempts
//    low-value tests on trivial code; what actually de-risks a change is
//    covering the lines THAT change. This guard enforces exactly that.
//
// 2. What it does
//    - Reads a c8/istanbul coverage report (coverage/coverage-final.json by
//      default; override with COVERAGE_FILE). Produce it with `npm run
//      coverage` first.
//    - Diffs the working branch against a base (PATCH_COVERAGE_BASE, default
//      `main`) and collects the ADDED/changed line numbers in `src/**/*.ts`.
//    - For each changed line that is EXECUTABLE (appears in the coverage
//      statement map), checks whether it was hit by the test run.
//    - patch coverage = covered changed-exec-lines / total changed-exec-lines.
//      Fails if below PATCH_COVERAGE_MIN (default 80).
//
// 3. Keeping it honest
//    - The coverage report is from the UNIT lane. Code exercised only by the
//      e2e / ext-host lanes (activation wiring, webview Views) would read as
//      "uncovered" here, so those paths are listed in
//      scripts/patch-coverage-ignore.json and excluded from the denominator.
//      Keep that list tight — every entry is coverage debt that the unit lane
//      does not see. A file genuinely unit-testable must NOT be added there.
//    - Type-only / comment / blank changed lines are non-executable, so they
//      never appear in the statement map and are excluded automatically.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { posixRelative } from './lib/posix-path.mjs';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COVERAGE_FILE = process.env.COVERAGE_FILE
  ? path.resolve(root, process.env.COVERAGE_FILE)
  : path.join(root, 'coverage', 'coverage-final.json');
const BASE = process.env.PATCH_COVERAGE_BASE || 'main';
const MIN = Number(process.env.PATCH_COVERAGE_MIN || '80');
const IGNORE_FILE = path.join(root, 'scripts', 'patch-coverage-ignore.json');

function fail(msg) {
  console.error(`[check:patch-coverage] FAIL — ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(COVERAGE_FILE)) {
  fail(`coverage report not found at ${posixRelative(root, COVERAGE_FILE)}. Run \`npm run coverage\` first.`);
}

const ignoreGlobs = fs.existsSync(IGNORE_FILE)
  ? JSON.parse(fs.readFileSync(IGNORE_FILE, 'utf8')).ignore ?? []
  : [];

// Minimal glob → RegExp (supports ** and *). Anchored to the repo-relative path.
function globToRe(g) {
  const re = g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*');
  return new RegExp('^' + re + '$');
}
const ignoreRes = ignoreGlobs.map(globToRe);
const isIgnored = (rel) => ignoreRes.some((re) => re.test(rel));

// A changed `.ts` file that transpiles to zero executable JS is type-only
// (interfaces, type aliases, `import type`, compile-time tie asserts). Such a
// file never appears in the coverage report and can never be unit-covered, so
// it must be treated as "no executable lines changed" — not a coverage gap.
// Transpiling (no type-check) is the ground truth: a file with any runtime
// statement emits it and is NOT skipped, so a genuinely untested code file
// still fails.
function hasNoExecutableCode(rel) {
  let src;
  try {
    src = fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return false;
  }
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: rel,
  }).outputText;
  const stripped = out
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/["']use strict["'];?/g, '')
    .replace(/export\s*\{\s*\}\s*;?/g, '')
    .replace(/\s+/g, '');
  return stripped.length === 0;
}

// ── 1. changed lines per src file (added side of the diff) ──────────────────
function changedLines() {
  let out;
  try {
    out = execFileSync(
      'git',
      ['diff', '--unified=0', '--no-color', `${BASE}...HEAD`, '--', 'src'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (e) {
    fail(`git diff against base '${BASE}' failed: ${e.message}`);
  }
  const files = new Map(); // rel → Set<lineNo>
  let current = null;
  let newLine = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ b/')) {
      const rel = line.slice(6).trim();
      if (rel.endsWith('.ts') && !rel.endsWith('.d.ts')) {
        current = rel;
        if (!files.has(rel)) files.set(rel, new Set());
      } else {
        current = null;
      }
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      files.get(current).add(newLine);
      newLine++;
    } else if (!line.startsWith('-') && !line.startsWith('\\')) {
      newLine++;
    }
  }
  return files;
}

// ── 2. executable-line hit map per file from the coverage report ────────────
function coverageByFile() {
  const data = JSON.parse(fs.readFileSync(COVERAGE_FILE, 'utf8'));
  const byFile = new Map(); // rel → Map<lineNo, hit:boolean>
  for (const [abs, c] of Object.entries(data)) {
    if (!c.statementMap || !c.s) continue;
    const rel = posixRelative(root, abs);
    const lines = new Map();
    for (const [id, loc] of Object.entries(c.statementMap)) {
      const hit = (c.s[id] || 0) > 0;
      for (let ln = loc.start.line; ln <= loc.end.line; ln++) {
        lines.set(ln, (lines.get(ln) || false) || hit);
      }
    }
    byFile.set(rel, lines);
  }
  return byFile;
}

// ── 3. compute patch coverage ───────────────────────────────────────────────
const changed = changedLines();
const cov = coverageByFile();

let totalExec = 0;
let totalCovered = 0;
const fileReports = [];
const ignored = [];
const typeOnly = [];

for (const [rel, lineSet] of changed) {
  if (isIgnored(rel)) {
    ignored.push(rel);
    continue;
  }
  const lines = cov.get(rel);
  if (!lines) {
    // No coverage entry at all. A type-only file (erases to no executable JS)
    // can never appear and needs no test; a real code file never loaded by the
    // unit lane is a genuine gap. Transpile to tell them apart.
    if (hasNoExecutableCode(rel)) {
      typeOnly.push(rel);
    } else {
      fileReports.push({ rel, exec: 0, covered: 0, noEntry: true, uncovered: [] });
    }
    continue;
  }
  let exec = 0;
  let covered = 0;
  const uncovered = [];
  for (const ln of lineSet) {
    if (!lines.has(ln)) continue; // non-executable changed line
    exec++;
    if (lines.get(ln)) covered++;
    else uncovered.push(ln);
  }
  totalExec += exec;
  totalCovered += covered;
  if (exec > 0) fileReports.push({ rel, exec, covered, uncovered });
}

// ── 4. report + verdict ─────────────────────────────────────────────────────
console.log(`[check:patch-coverage] base=${BASE}  min=${MIN}%`);
if (ignored.length) {
  console.log(`  ignored (e2e/ext-host-covered per manifest): ${ignored.join(', ')}`);
}
if (typeOnly.length) {
  console.log(`  skipped (type-only, no executable JS): ${typeOnly.join(', ')}`);
}
const noEntry = fileReports.filter((r) => r.noEntry);
if (noEntry.length) {
  console.error(
    `  changed source files with NO unit coverage at all:\n` +
      noEntry.map((r) => `    - ${r.rel}`).join('\n')
  );
}
for (const r of fileReports.filter((r) => !r.noEntry)) {
  const pct = r.exec ? ((r.covered / r.exec) * 100).toFixed(0) : '100';
  const tail = r.uncovered.length ? `  uncovered lines: ${r.uncovered.join(', ')}` : '';
  console.log(`  ${String(pct).padStart(3)}%  ${r.rel}  (${r.covered}/${r.exec})${tail}`);
}

if (noEntry.length) {
  fail(
    `${noEntry.length} changed file(s) have no unit coverage. Add a unit test, or add the path to scripts/patch-coverage-ignore.json if it is covered only by the e2e/ext-host lanes.`
  );
}

if (totalExec === 0) {
  console.log('[check:patch-coverage] OK — no executable source lines changed.');
  process.exit(0);
}

const pct = (totalCovered / totalExec) * 100;
console.log(
  `[check:patch-coverage] patch coverage = ${pct.toFixed(1)}% (${totalCovered}/${totalExec} changed executable lines)`
);
if (pct + 1e-9 < MIN) {
  fail(`patch coverage ${pct.toFixed(1)}% is below the ${MIN}% minimum.`);
}
console.log('[check:patch-coverage] OK');
