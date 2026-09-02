#!/usr/bin/env node
/*
 * check-ctw-button-menu-wired.mjs — every ctw-*-menu class is both styled
 * and constructed through createButtonMenuPanel.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: createButtonMenuPanel(className) closes the class of
 *    bug where a button-anchored panel is built without the
 *    `data-ctw-button-menu` stamp closeButtonMenus needs to find it, but
 *    only for panels that call it — the constructor closes the class by
 *    convention, not by construction. A third panel could still be built by
 *    hand (`el('div', { className: 'ctw-x-menu' })`) with a CSS rule but no
 *    constructor call, or a constructor call with no CSS rule (a panel that
 *    renders unstyled). Either half of the pairing can drift silently.
 *
 * 2. Heuristic + how it scales: with comments blanked out first, extract every
 *    `.ctw-*-menu` class name immediately followed — with no `;` or `}` in
 *    between — by a `{` that opens its rule body, checked via a lookahead so
 *    a class sharing a selector list with another (`.ctw-x-menu,
 *    .ctw-y-menu { … }`) isn't consumed by the first match, in
 *    commitToolWindowStyles.ts, and every string literal argument to a
 *    `createButtonMenuPanel(...)` call anywhere under the webview directory.
 *    The two sets must be equal. Scales with the panel count, which is small
 *    and bounded — a third panel is caught on whichever side it is missing
 *    from, and real mode requires at least two (see Anti-vacuity below).
 *
 * 3. Known false-positive cases: a `.ctw-*-menu` rule that lives in an
 *    imported partial (contextMenuStyles(), spliced into the returned
 *    template via `${...}`) rather than directly in
 *    commitToolWindowStyles.ts is invisible to the scan — the class reads as
 *    having no CSS rule, and the guard reports a genuinely-styled panel
 *    unstyled. No class uses that shape today; latent, not live. A CSS rule
 *    or a constructor call using a name outside the `ctw-*-menu` shape is out
 *    of scope by construction (the regexes only match that shape).
 *
 * 4. Known false-negative cases: a `createButtonMenuPanel` call whose
 *    argument is not a string literal (a computed class name) is invisible
 *    to the constructor-call regex — not a pattern used anywhere today.
 *
 * Anti-vacuity: real mode requires the styles file and webview directory to
 * exist (fails loudly rather than defaulting to an empty scan) and requires
 * at least 2 `.ctw-*-menu` CSS rules — today's real count — so the CSS regex
 * breaking reads as a failure, not a silent pass; fixture mode skips the
 * floor by default (a small fixture isn't held to the real tree's density)
 * unless its third argument is exactly `--check-floor`. Any other argument
 * count is rejected rather than falling through to real mode.
 *
 * 5. Retirement criteria: retire if button-anchored panels move to a
 *    component model that co-locates the class name, the stamp, and the
 *    stylesheet in one declaration.
 *
 * Usage:
 *   node scripts/check-ctw-button-menu-wired.mjs
 *     — real mode: scans the shipped styles file and webview directory.
 *   node scripts/check-ctw-button-menu-wired.mjs <stylesFile> <webviewDir> [--check-floor]
 *     — fixture mode (companion spec); the floor applies only with --check-floor.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_STYLES_FILE = path.join(repoRoot, 'src/commits/commitToolWindowStyles.ts');
const DEFAULT_WEBVIEW_DIR = path.join(repoRoot, 'src/commits/webview');
const MIN_CSS_CLASSES = 2;

const cliArgs = process.argv.slice(2);
if (![0, 2, 3].includes(cliArgs.length)) {
  console.error(
    `check-ctw-button-menu-wired: expected 0 arguments (real mode) or 2-3 ` +
      `(fixture mode: <stylesFile> <webviewDir> [--check-floor]), got ${cliArgs.length}.`
  );
  process.exit(1);
}
const fixtureMode = cliArgs.length >= 2;
const [argStylesFile, argWebviewDir, argCheckFloor] = cliArgs;
if (argCheckFloor !== undefined && argCheckFloor !== '--check-floor') {
  console.error(
    `check-ctw-button-menu-wired: unrecognised third argument '${argCheckFloor}', expected --check-floor.`
  );
  process.exit(1);
}
const stylesFile = fixtureMode ? path.resolve(argStylesFile) : DEFAULT_STYLES_FILE;
const webviewDir = fixtureMode ? path.resolve(argWebviewDir) : DEFAULT_WEBVIEW_DIR;
// Real mode always applies the floor; fixture mode is off by default (its
// small fixtures aren't held to the real tree's density) unless a spec case
// opts back in to prove the mechanism itself.
const applyFloor = !fixtureMode || argCheckFloor === '--check-floor';

if (!existsSync(stylesFile)) {
  console.error(`check-ctw-button-menu-wired: styles file does not exist: ${stylesFile}`);
  process.exit(1);
}
if (!existsSync(webviewDir)) {
  console.error(`check-ctw-button-menu-wired: webview directory does not exist: ${webviewDir}`);
  process.exit(1);
}

// Block comments (a CSS `/* … */` written inside the returned template
// literal, or a JS one outside it) and line comments (a JS `//` outside the
// template — CSS has none) are blanked to spaces, never removed, so a class
// name mentioned only in a comment can't stand in for a rule and every
// other match offset stays where it was in the real source.
function blankComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

// Matches the class as a CSS selector token wherever it occurs — a bare
// rule, chained with a modifier (`.ctw-x-menu.open`), grouped with others
// (`.ctw-x-menu, .ctw-y-menu { … }`), or in a descendant selector — but only
// when a rule body actually follows: the tail up to the next `{` must
// contain no `;` or `}`. The body check is a LOOKAHEAD, not a consuming
// match, so it doesn't swallow the next class in a grouped selector — a
// consuming `[^{};]*\{` tail would skip straight past it to the shared `{`.
const CSS_RULE = /\.(ctw-[\w-]*-menu)(?![\w-])(?=[^{};]*\{)/g;
const CONSTRUCTOR_CALL = /createButtonMenuPanel\(\s*['"]((?:ctw-[\w-]*-menu))['"]/g;

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const stylesSource = readFileSync(stylesFile, 'utf8');
const cssClasses = new Set(
  [...blankComments(stylesSource).matchAll(CSS_RULE)].map((m) => m[1])
);

if (applyFloor && cssClasses.size < MIN_CSS_CLASSES) {
  console.error(
    `check-ctw-button-menu-wired: only ${cssClasses.size} .ctw-*-menu CSS rule(s) found in ` +
      `${path.basename(stylesFile)}, expected at least ${MIN_CSS_CLASSES} — CSS_RULE ` +
      'probably stopped matching (a selector-shape or file-format change), not that the panels went away.'
  );
  process.exit(1);
}

const constructedClasses = new Set();
for (const file of listFilesRecursive(webviewDir)) {
  const source = readFileSync(file, 'utf8');
  for (const m of source.matchAll(CONSTRUCTOR_CALL)) {
    constructedClasses.add(m[1]);
  }
}

const failures = [];

for (const cls of cssClasses) {
  if (!constructedClasses.has(cls)) {
    failures.push(
      `.${cls} has a CSS rule in ${path.basename(stylesFile)} but no createButtonMenuPanel('${cls}') call — a panel with this class either doesn't exist or was built without the constructor, so closeButtonMenus cannot find it.`
    );
  }
}

for (const cls of constructedClasses) {
  if (!cssClasses.has(cls)) {
    failures.push(
      `createButtonMenuPanel('${cls}') is called but ${cls} has no \`.ctw-*-menu\` CSS rule in ${path.basename(stylesFile)} — the panel renders unstyled.`
    );
  }
}

if (failures.length > 0) {
  console.error('check-ctw-button-menu-wired: CSS/constructor pairing broken\n');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error('');
  process.exit(1);
}

console.log('check-ctw-button-menu-wired: OK');
