#!/usr/bin/env node
/*
 * check-god-files.mjs — the god-file ratchet: large files may only shrink.
 *
 * ADR-007 "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a source file grows without bound (a "god file"), or a
 *    brand-new one is born large, and nothing in the gate notices. GitService
 *    was split once and regrew to ~2,900 lines under documented-intent-only
 *    discipline — documented intent does not hold, the gate does. This guard
 *    freezes every current large file at its measured size and caps every other
 *    file, so past this point a file can only ever get SMALLER.
 *
 * 2. Heuristic + how it scales + which spec case pins which arm: walk
 *    <scanRoot>/**\/*.ts (excluding *.d.ts), count newlines per file, and
 *    require lines <= budget, where budget is god-file-budgets.json's per-file
 *    entry when listed, else the flat `cap` (800). Two stale-entry arms keep the
 *    ratchet honest as splits land: an entry for a deleted file, and an entry
 *    for a file that has shrunk back within the cap, both fail so the split
 *    commit is forced to drop the entry. O(files); scales with the tree for
 *    free. Companion spec (test/unit/scripts/checkGodFiles.test.ts) pins each
 *    arm and proves it flips: the 'cap' case -> the un-ratcheted-over-cap arm;
 *    the 'budget' case -> the over-frozen-budget arm; the 'missing' case -> the
 *    deleted-file stale arm; the 'within-cap' case -> the shrunk-back stale arm.
 *
 * 3. Known false-positive cases (today's exempts): none. Every entry is a real
 *    file frozen at its real size; a file near the cap is listed with an exact
 *    budget, never exempted. If a ported upstream suite (diff-engine) must grow
 *    to track upstream, lower is not possible — raise ONLY that one budget in
 *    the same commit and justify it in review (see section 4).
 *
 * 4. Known false-negative cases: the "may only DECREASE" half of the ratchet is
 *    not machine-checked here (that needs git history); a contributor could
 *    RAISE a budget to license growth. Caught by review — every budget change in
 *    a diff must lower a number or remove an entry, never raise one. The newline
 *    heuristic counts a file with no trailing newline as one line short of an
 *    editor's count; budgets are measured the same way (`wc -l`), so the
 *    comparison stays self-consistent.
 *
 * 5. Retirement criteria: retire when every listed file is under the cap (the
 *    breakup is finished and the flat cap alone holds the line), or when a
 *    bundler / module-size lint enforces per-file budgets natively.
 *
 * Usage:
 *   node scripts/check-god-files.mjs
 *     — real mode: scans ./src against ./scripts/god-file-budgets.json.
 *   node scripts/check-god-files.mjs <scanRoot> <budgetsJson>
 *     — fixture mode (companion spec): scans <scanRoot> against <budgetsJson>.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const [argScanRoot, argBudgets] = process.argv.slice(2);
const scanRoot = argScanRoot !== undefined ? path.resolve(argScanRoot) : path.join(repoRoot, 'src');
const budgetsPath =
  argBudgets !== undefined
    ? path.resolve(argBudgets)
    : path.join(repoRoot, 'scripts/god-file-budgets.json');

const config = JSON.parse(readFileSync(budgetsPath, 'utf8'));
const cap = config.cap;
const budgets = config.budgets ?? {};

/** Line count matching `wc -l`: the number of newline characters. */
function lineCount(absFile) {
  const matches = readFileSync(absFile, 'utf8').match(/\n/g);
  return matches ? matches.length : 0;
}

/** Every *.ts (not *.d.ts) under root, as paths relative to root with / separators. */
function collectTsFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return out;
}

const problems = [];
const files = collectTsFiles(scanRoot);

// R1 — every file within its budget (listed) or the flat cap (un-ratcheted).
for (const rel of files) {
  const n = lineCount(path.join(scanRoot, rel));
  if (rel in budgets) {
    if (n > budgets[rel]) {
      problems.push(
        `${rel}: ${n} lines exceeds its frozen budget of ${budgets[rel]} — split it (a split must not regrow the file).`
      );
    }
  } else if (n > cap) {
    problems.push(
      `${rel}: ${n} lines exceeds the ${cap}-line cap for un-ratcheted files — split it before it lands.`
    );
  }
}

// R2 + R3 — keep the ratchet honest: no stale entry survives a split.
for (const rel of Object.keys(budgets)) {
  const abs = path.join(scanRoot, rel);
  if (!existsSync(abs)) {
    problems.push(
      `ratchet entry ${rel} names a file that no longer exists — remove it from ${path.basename(budgetsPath)}.`
    );
    continue;
  }
  if (lineCount(abs) <= cap) {
    problems.push(
      `ratchet entry ${rel} is back within the ${cap}-line cap — remove it from ${path.basename(budgetsPath)} (the cap covers it now).`
    );
  }
}

if (problems.length > 0) {
  console.error('check-god-files: the god-file ratchet is violated\n');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error('');
  process.exit(1);
}

console.log(
  `check-god-files: OK (${files.length} files scanned, ${Object.keys(budgets).length} ratcheted, cap ${cap})`
);
