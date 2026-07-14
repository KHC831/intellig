#!/usr/bin/env node
/**
 * Structural CI guard — VS Code context keys stay a single typed source of
 * truth, and code-side keys agree with package.json when-clauses both ways.
 *
 * Maintenance contract (per ADR-007 section "Guard maintenance contract"):
 *
 * 1. Bug class
 *    A context key is a bare string set in the extension via
 *    `executeCommand('setContext', '<key>', v)` and read in package.json
 *    `when` clauses. Nothing ties the two sides together: a typo, a rename, or
 *    a key set but never consumed (or consumed but never set) fails silently —
 *    a menu item that never appears, or dead ceremony that looks live. The
 *    typed `CONTEXT_KEYS` map in src/utils/contextKeys.ts is the intended
 *    single source; this guard keeps setContext funneled through the helper and
 *    the map coherent with the manifest.
 *
 * 2. Heuristic + how it scales
 *    Rule A (ban): every `.ts` under srcDir (except *.test.ts and the helper
 *    module itself) is read as one string and scanned for
 *    `executeCommand(<ws>'setContext'` — content-based so a call split across
 *    lines is caught. A match fails unless a `// context-key-exempt: <reason>`
 *    comment sits within the four lines above it. Rule B extracts the code-side
 *    key set from the `CONTEXT_KEYS` object literal and the when-clause key set
 *    by structural parse (a token is a key unless it is the RHS of a
 *    view/viewItem/activeWebviewPanelId/focusedView comparison — those are
 *    view-ids / tree-item contextValues). Rule C fails on any code key with no
 *    consumer and any when-clause key absent from the map. Adding a key +
 *    consumer is covered automatically; no per-key edit here.
 *
 * 3. Known false-positive cases
 *    A `setContext` string assembled from fragments would evade Rule A; the
 *    house convention passes it whole (none exist today). A context key whose
 *    name collides with a real view-id used on the LHS of a comparison would be
 *    mis-excluded; the inventory confirms no such collision.
 *
 * 4. Known false-negative cases
 *    None known: the content-based scan defeats the line-split evasion that a
 *    per-line grep misses, and the bidirectional coherence closes both drift
 *    directions.
 *
 * 5. Retirement criteria
 *    Retire when context keys and their when-clauses are generated from one
 *    typed table, making the key a shared literal with no second side to drift.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const HELPER_REL = join('utils', 'contextKeys.ts');
const RHS_LHS = ['view', 'viewItem', 'activeWebviewPanelId', 'focusedView'];

function collectTsFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectTsFiles(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Rule A — raw setContext outside the helper (content-based, cross-line). */
function findRawSetContext(srcDir) {
  const violations = [];
  const rawRe = /executeCommand\(\s*['"]setContext['"]/g;
  for (const file of collectTsFiles(srcDir)) {
    if (file.endsWith('.test.ts')) continue;
    if (relative(srcDir, file) === HELPER_REL) continue;
    const content = readFileSync(file, 'utf8');
    let m;
    while ((m = rawRe.exec(content)) !== null) {
      const before = content.slice(0, m.index);
      const line = before.split('\n').length;
      const lines = content.split('\n');
      const windowAbove = lines.slice(Math.max(0, line - 1 - 4), line - 1).join('\n');
      if (!windowAbove.includes('context-key-exempt:')) {
        violations.push({ file: relative(root, file), line });
      }
    }
  }
  return violations;
}

/** Rule B (code side) — string-literal values inside the CONTEXT_KEYS object. */
function readCodeKeys(srcDir) {
  const helperPath = join(srcDir, HELPER_REL);
  if (!existsSync(helperPath)) {
    console.error(`check-context-keys: helper module not found at ${helperPath}.`);
    process.exit(1);
  }
  const src = readFileSync(helperPath, 'utf8');
  const objMatch = src.match(/CONTEXT_KEYS\s*=\s*\{([\s\S]*?)\}/);
  const body = objMatch ? objMatch[1] : '';
  const keys = new Set();
  for (const m of body.matchAll(/:\s*'(intellig\.[^']+)'/g)) keys.add(m[1]);
  return keys;
}

/** Recursively collect every `when` string in the manifest. */
function collectWhenClauses(node, out) {
  if (Array.isArray(node)) {
    for (const el of node) collectWhenClauses(el, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'when' && typeof v === 'string') out.push(v);
      else collectWhenClauses(v, out);
    }
  }
}

/** Rule B (pkg side) — context keys consumed by when-clauses, RHS excluded. */
function readWhenClauseKeys(pkgPath) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const clauses = [];
  collectWhenClauses(pkg.contributes, clauses);
  const keys = new Set();
  const tokenRe = /(?<![\w.])intellig\.[A-Za-z0-9_.]+/g;
  const rhsRe = new RegExp(
    `(?:${RHS_LHS.join('|')})\\s*(?:==|!=|=~)\\s*'?(intellig\\.[A-Za-z0-9_.]+)'?`,
    'g'
  );
  for (const when of clauses) {
    const exclude = new Set();
    for (const m of when.matchAll(rhsRe)) exclude.add(m[1]);
    for (const m of when.matchAll(tokenRe)) {
      if (!exclude.has(m[0])) keys.add(m[0]);
    }
  }
  return keys;
}

function main() {
  const pkgPath = process.argv[2] ?? join(root, 'package.json');
  const srcDir = process.argv[3] ?? join(root, 'src');

  const failures = [];

  for (const v of findRawSetContext(srcDir)) {
    failures.push(
      `check-context-keys: raw setContext outside the helper at ${v.file}:${v.line}.\n` +
        'Call setContextKey() from src/utils/contextKeys.ts, or justify with a\n' +
        '`// context-key-exempt: <reason>` comment within the four lines above.'
    );
  }

  const codeKeys = readCodeKeys(srcDir);
  const whenKeys = readWhenClauseKeys(pkgPath);

  for (const key of codeKeys) {
    if (!whenKeys.has(key)) {
      failures.push(
        `check-context-keys: '${key}' is in CONTEXT_KEYS but no package.json when-clause\n` +
          'consumes it. Add a when-clause or remove the key.'
      );
    }
  }
  for (const key of whenKeys) {
    if (!codeKeys.has(key)) {
      failures.push(
        `check-context-keys: when-clause key '${key}' is not in CONTEXT_KEYS\n` +
          '(src/utils/contextKeys.ts). Add it, or fix the spelling in package.json.'
      );
    }
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(f);
    process.exit(1);
  }

  console.log(
    'check-context-keys: OK (setContext funneled through the helper; CONTEXT_KEYS and when-clauses agree both ways)'
  );
}

main();
