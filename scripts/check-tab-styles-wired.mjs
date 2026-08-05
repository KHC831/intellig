#!/usr/bin/env node
/*
 * check-tab-styles-wired.mjs — structural guard for tool-window tab CSS.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a tab renderer that emits classed markup but ships no
 *    styles function, or ships one nobody wires into the provider's
 *    `extraStyles` concat. Either way the tab renders as unstyled run-together
 *    text while every sibling tab looks right, and nothing fails — the classes
 *    simply match no rule. The Incoming tab shipped in exactly that state.
 *
 * 2. Heuristic + how it scales: for every `src/git-core/gitToolWindow/html/*.ts`
 *    module that emits `class="…"` markup, require (a) an exported
 *    `…Styles()` function in that module, and (b) that export's name to appear
 *    in provider/documentShell.ts, which owns the concat. Two greps per tab
 *    module; scales with the tab count, which is small and bounded.
 *
 * 3. Known false-positive cases: a sub-renderer whose markup is styled by a
 *    PARENT tab's stylesheet (it emits classes but legitimately owns no
 *    stylesheet of its own). Add it to scripts/tab-styles-allowlist.txt with a
 *    one-line justification naming the owning stylesheet.
 *
 * 4. Known false-negative cases: a styles function that is exported AND
 *    mentioned in the provider but not actually concatenated into the emitted
 *    CSS (e.g. referenced only in a comment), and a rule set that exists but
 *    doesn't cover every class the renderer emits. Class-by-class coverage is
 *    out of scope — the unit specs pin the specific selectors.
 *
 * 5. Retirement criteria: retire when tab bodies move to a component model that
 *    co-locates markup and CSS so the two cannot separate.
 *
 * Usage:
 *   node scripts/check-tab-styles-wired.mjs
 *     — real mode: scans the tool-window html dir, allowlist applied.
 *   node scripts/check-tab-styles-wired.mjs <htmlDir> <providerFile>
 *     — fixture mode (companion spec): allowlist is NOT applied.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_HTML_DIR = path.join(repoRoot, 'src/git-core/gitToolWindow/html');
const DEFAULT_PROVIDER = path.join(repoRoot, 'src/git-core/gitToolWindow/provider/documentShell.ts');
const ALLOWLIST = path.join(repoRoot, 'scripts/tab-styles-allowlist.txt');

const [argHtmlDir, argProvider] = process.argv.slice(2);
const fixtureMode = argHtmlDir !== undefined && argProvider !== undefined;
const htmlDir = fixtureMode ? path.resolve(argHtmlDir) : DEFAULT_HTML_DIR;
const providerFile = fixtureMode ? path.resolve(argProvider) : DEFAULT_PROVIDER;

/** Renderer modules exempt from owning a stylesheet, with justification. */
function readAllowlist() {
  if (fixtureMode || !existsSync(ALLOWLIST)) {
    return new Set();
  }
  return new Set(
    readFileSync(ALLOWLIST, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => line.split(/\s+/)[0])
  );
}

const allowlist = readAllowlist();
const providerSource = existsSync(providerFile) ? readFileSync(providerFile, 'utf8') : '';

const EMITS_CLASSED_MARKUP = /class="/;
const STYLES_EXPORT = /export function (\w*Styles)\s*\(/g;

const failures = [];

for (const entry of readdirSync(htmlDir).sort()) {
  if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) {
    continue;
  }
  if (allowlist.has(entry)) {
    continue;
  }
  const source = readFileSync(path.join(htmlDir, entry), 'utf8');
  if (!EMITS_CLASSED_MARKUP.test(source)) {
    continue;
  }

  const exports = [...source.matchAll(STYLES_EXPORT)].map((m) => m[1]);
  if (exports.length === 0) {
    failures.push(
      `${entry}: emits classed markup but exports no \`…Styles()\` function. ` +
        `Add one (or allowlist the module in scripts/tab-styles-allowlist.txt ` +
        `naming the stylesheet that covers it).`
    );
    continue;
  }

  const wired = exports.filter((name) => providerSource.includes(name));
  if (wired.length === 0) {
    failures.push(
      `${entry}: exports ${exports.map((n) => `\`${n}()\``).join(', ')} but ` +
        `${path.basename(providerFile)} never references it — the tab renders unstyled. ` +
        `Wire it into the extraStyles concat.`
    );
  }
}

if (failures.length > 0) {
  console.error('check-tab-styles-wired: tab renderers missing wired CSS\n');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error('');
  process.exit(1);
}

console.log('check-tab-styles-wired: OK');
