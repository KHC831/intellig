#!/usr/bin/env node
/**
 * Structural CI guard — every history-rewrite flow rides the single
 * `runHistoryRewrite` runner, and that runner keeps its pre-flight gates.
 *
 * (This is the mjs port of checks (b) + (c) of the former
 * check-rebase-conflict-flow.sh; check (a), the glob-wide abort-scope rule,
 * stays in the shell script — its globs already cover the extracted module.)
 *
 * Maintenance contract (per ADR-007 section "Guard maintenance contract"):
 *
 * 1. Bug class
 *    The rebase-editing flows (single/multi drop, squash/fixup, reword,
 *    interactive) each hand-rolled their own start → execute → outcome
 *    skeleton and drifted on the conflict arm (auto-abort, or an untruthful
 *    resolve dialog). They were collapsed onto one `runHistoryRewrite` runner
 *    whose single outcome switch owns the pause-never-abort contract and both
 *    pre-flight refusals. This guard keeps that shape: no `.executeRebase(`
 *    outside a runner scope (no fifth skeleton), and no runner missing a gate.
 *
 * 2. Heuristic + how it scales + fail-closed
 *    Scope: src/commits/*.ts (the dispatcher class and the extracted
 *    history-rewrite module). A runner scope is a `_runHistoryRewrite`
 *    method (class, `private async _runHistoryRewrite(` at 2-space) OR a
 *    `runHistoryRewrite` export (module, `export async function
 *    runHistoryRewrite(` at 0-indent), from its header to the closing brace at
 *    the header's OWN indent (indent anchor, not brace counting — braces in
 *    strings have no lexer here). (b) `.executeRebase(` may appear only inside
 *    a runner scope, else `// history-rewrite-exempt: <reason>`. (c) every
 *    runner scope contains BOTH `[._]isRangeMergeFree(` and
 *    `[._]isNotOnProtectedBranch(` (stems match the class `this._x(` and module
 *    `ctx.x(` forms), else `// runner-gate-exempt: <reason>` on the header or
 *    preceding line. FAIL-CLOSED across the union: >= 1 runner scope AND >= 1
 *    executeRebase site must be found, or the guard fails — a path/regex drift
 *    that silences the scan can never read as clean. O(lines).
 *
 * 3. Known false-positive cases
 *    A comment spelling `.executeRebase(` with the paren would match (none
 *    exist; comments use the bare name) — mark it history-rewrite-exempt.
 *
 * 4. Known false-negative cases
 *    An execute reached through an aliased service or dynamic name slips the
 *    literal pattern; review is the backstop. A `}` at the runner's indent
 *    inside a template literal ends the scope early (contrived, none exist).
 *
 * 5. Retirement criteria
 *    Retire when the rebase-editing flows live in a module whose only export is
 *    the runner (the fifth skeleton becomes untypeable), or an eslint rule
 *    subsumes both checks.
 *
 * Usage:
 *   node scripts/check-rebase-runner-scope.mjs
 *     — real mode: scans src/commits/*.ts.
 *   node scripts/check-rebase-runner-scope.mjs <dir|file>...
 *     — fixture mode (companion spec): scans the given dirs/files.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const RUNNER =
  /^(\s*)(?:private async _runHistoryRewrite|export async function runHistoryRewrite)\(/;
const EXECUTE = /\.executeRebase\(/;
const MERGE_GATE = /[._]isRangeMergeFree\(/;
const PROT_GATE = /[._]isNotOnProtectedBranch\(/;
const exemptAt = (lines, i, marker) =>
  lines[i].includes(marker) || (i > 0 && lines[i - 1].includes(marker));

function tsFiles(p) {
  if (!existsSync(p)) return [];
  if (statSync(p).isFile()) return p.endsWith('.ts') ? [p] : [];
  const out = [];
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const abs = join(p, e.name);
    if (e.isDirectory()) out.push(...tsFiles(abs));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

/** Runner scopes in one file as [start, end] inclusive line indices. */
function runnerScopes(lines) {
  const scopes = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(RUNNER);
    if (!m) continue;
    const closeRe = new RegExp('^' + ' '.repeat(m[1].length) + '\\}');
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) j++;
    scopes.push([i, j]);
  }
  return scopes;
}

const args = process.argv.slice(2);
let files;
if (args.length > 0) {
  files = args.flatMap(tsFiles);
} else {
  const dir = join(root, 'src', 'commits');
  files = readdirSync(dir)
    .filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts'))
    .map((n) => join(dir, n));
}

const problems = [];
let totalRunners = 0;
let totalExecutes = 0;

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const scopes = runnerScopes(lines);
  totalRunners += scopes.length;
  const inScope = (i) => scopes.some(([s, e]) => i >= s && i <= e);

  // (b) executeRebase only inside a runner scope.
  for (let i = 0; i < lines.length; i++) {
    if (!EXECUTE.test(lines[i])) continue;
    totalExecutes++;
    if (inScope(i) || exemptAt(lines, i, 'history-rewrite-exempt:')) continue;
    problems.push(
      `${file}:${i + 1}: .executeRebase( outside a runHistoryRewrite scope — ride the shared ` +
        `runner (one skeleton, N thin bodies) or annotate '// history-rewrite-exempt: <reason>'.`
    );
  }

  // (c) each runner scope keeps both pre-flight gates.
  for (const [s, e] of scopes) {
    if (exemptAt(lines, s, 'runner-gate-exempt:')) continue;
    const body = lines.slice(s, e + 1).join('\n');
    const missing = [];
    if (!MERGE_GATE.test(body)) missing.push('isRangeMergeFree(');
    if (!PROT_GATE.test(body)) missing.push('isNotOnProtectedBranch(');
    if (missing.length > 0) {
      problems.push(
        `${file}:${s + 1}: runHistoryRewrite missing pre-flight gate(s): ${missing.join(', ')} — ` +
          `the runner owns the merge-flattening and protected-branch refusals, or annotate ` +
          `'// runner-gate-exempt: <reason>'.`
      );
    }
  }
}

// Fail-closed: the scan must actually find the runner and an execute site.
if (totalRunners === 0 || totalExecutes === 0) {
  console.error(
    `check-rebase-runner-scope: FAIL-CLOSED — found ${totalRunners} runner scope(s) and ` +
      `${totalExecutes} executeRebase site(s) across ${files.length} file(s). A path/regex drift`
  );
  console.error('has silenced this guard; restore the scanned files / patterns.');
  process.exit(1);
}

if (problems.length > 0) {
  console.error('check-rebase-runner-scope: the history-rewrite runner contract is violated\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('');
  process.exit(1);
}

console.log(
  `check-rebase-runner-scope: OK (${totalRunners} runner scope(s), ${totalExecutes} execute site(s))`
);
