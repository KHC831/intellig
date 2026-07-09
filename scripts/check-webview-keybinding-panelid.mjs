#!/usr/bin/env node
/**
 * Structural CI guard — every `activeWebviewPanelId == '<id>'` keybinding
 * targets a webview panel that actually exists.
 *
 * Maintenance contract (per ADR-007 section "Guard maintenance contract"):
 *
 * 1. Bug class
 *    A keybinding gated on `when: activeWebviewPanelId == '<id>'` only ever
 *    fires while a webview PANEL whose viewType is exactly `<id>` is focused.
 *    That viewType is a string literal passed to a webview registration in the
 *    extension source. When the panel is deleted or renamed (e.g. the custom
 *    3-pane `intellig.mergeView` webview replaced by VS Code's native merge
 *    editor) the keybinding is left behind pointing at an id that no code
 *    creates — a key chord that can NEVER activate, and usually a command
 *    that is itself now a dead no-op. package.json and the source live in
 *    different files with nothing tying the panel id to a real viewType, so
 *    the dead keybinding rots silently.
 *
 * 2. Heuristic + how it scales
 *    Parse every `contributes.keybindings[].when` for an
 *    `activeWebviewPanelId == '<id>'` (or `"<id>"`) comparison. Each `<id>`
 *    must match a REAL webview viewType, resolved from the registration
 *    call-sites (not a blind whole-src substring). A viewType is real when it
 *    is the string-literal argument of `createWebviewPanel(...)`,
 *    `registerWebviewViewProvider(...)`, `registerWebviewPanelSerializer(...)`,
 *    or the `super(...)` of the BaseWebviewPanel/BaseWebviewView family, OR the
 *    value of a `*VIEW_TYPE` / `*VIEW_ID` / `viewType` constant/property (those
 *    constants are what the registration calls pass by reference). Source is
 *    scanned with comments stripped, so a mere mention in a comment never
 *    counts. Adding a keybinding for a real panel is automatically covered; no
 *    per-keybinding edit is needed.
 *
 * 3. Residual limitations (honest)
 *    - A viewType assembled at runtime from fragments (`'intellig.' + verb`)
 *      cannot be resolved; the house convention passes every viewType as a
 *      whole-string literal (verified: 0 such ids today), so none exist.
 *    - A viewType stored in a constant that is NOT named `*VIEW_TYPE` /
 *      `*VIEW_ID` / `viewType` and passed only by reference would not be
 *      recognized and would false-FAIL (over-strict, never a false-pass); the
 *      house convention names every such constant accordingly, so no real id
 *      is missed today.
 *    The earlier "whole-src substring" heuristic had a false-NEGATIVE hole: a
 *    dead panel id that merely appeared in a comment, or collided with an
 *    unrelated `intellig.*` id (a tree-view id like `intellig.branchTree`, a
 *    context key), false-PASSED — the exact rot this guard exists to catch.
 *    Resolving real viewTypes from registration call-sites closes both.
 *
 * 4. Retirement criteria
 *    Retire when webview keybindings are generated from the same typed table
 *    that declares panel viewTypes, making the id a shared source of truth.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ID = 'intellig\\.[A-Za-z][A-Za-z0-9.]*';
const ID_ONLY_RE = new RegExp(`^intellig\\.[A-Za-z][A-Za-z0-9.]*$`);
// A viewType is stored in a `*VIEW_TYPE` / `*VIEW_ID` constant or a `viewType`
// property; those references are what the registration calls receive.
const CONST_ASSIGN_RE = new RegExp(
  `(?:\\w*(?:VIEW_TYPE|VIEW_ID)|viewType)\\s*[:=]\\s*(['"])(${ID})\\1`,
  'g'
);
const REG_TOKEN_RE =
  /\b(?:createWebviewPanel|registerWebviewViewProvider|registerWebviewPanelSerializer|super)\s*\(/g;

function collectTsFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectTsFiles(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Remove `//` line comments and block comments while preserving string and
 * template-literal contents, so a viewType mentioned only in a comment does
 * not read as a real registration.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // code | line | block | squote | dquote | tmpl
  let state = 'code';
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'line';
        i += 2;
      } else if (c === '/' && c2 === '*') {
        state = 'block';
        i += 2;
      } else if (c === "'") {
        state = 'squote';
        out += c;
        i++;
      } else if (c === '"') {
        state = 'dquote';
        out += c;
        i++;
      } else if (c === '`') {
        state = 'tmpl';
        out += c;
        i++;
      } else {
        out += c;
        i++;
      }
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code';
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    // string / template states: copy through, honour escapes, exit on quote.
    const quote = state === 'squote' ? "'" : state === 'dquote' ? '"' : '`';
    if (c === '\\') {
      out += c + (c2 ?? '');
      i += 2;
      continue;
    }
    out += c;
    if (c === quote) {
      state = 'code';
    }
    i++;
  }
  return out;
}

/**
 * Collect the `intellig.*` string literals that appear as direct arguments of
 * a webview registration call. Scans balanced parens while skipping string /
 * template contents so nested `(` inside a title template don't unbalance it.
 */
function collectRegistrationArgLiterals(code, out) {
  let m;
  while ((m = REG_TOKEN_RE.exec(code)) !== null) {
    let i = m.index + m[0].length; // just past the opening '('
    let depth = 1;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        let j = i + 1;
        let lit = '';
        while (j < code.length && code[j] !== ch) {
          if (code[j] === '\\') {
            lit += code[j + 1] ?? '';
            j += 2;
            continue;
          }
          lit += code[j];
          j++;
        }
        if (ID_ONLY_RE.test(lit)) out.add(lit);
        i = j + 1;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
  }
}

/** Build the set of real webview viewTypes from the source tree. */
function collectRealViewTypes(srcDir) {
  const real = new Set();
  for (const file of collectTsFiles(srcDir)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const am of code.matchAll(CONST_ASSIGN_RE)) real.add(am[2]);
    collectRegistrationArgLiterals(code, real);
  }
  return real;
}

function main() {
  const pkgPath = process.argv[2] ?? join(root, 'package.json');
  const srcDir = process.argv[3] ?? join(root, 'src');

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const realViewTypes = collectRealViewTypes(srcDir);

  const panelIdRe = /activeWebviewPanelId\s*==\s*(['"])([^'"]+)\1/g;
  const dead = [];
  for (const kb of pkg.contributes?.keybindings ?? []) {
    const when = typeof kb.when === 'string' ? kb.when : '';
    let m;
    while ((m = panelIdRe.exec(when)) !== null) {
      const id = m[2];
      if (!realViewTypes.has(id)) {
        dead.push({ command: kb.command, id });
      }
    }
  }

  if (dead.length > 0) {
    console.error(
      'check-webview-keybinding-panelid: keybindings gated on a webview panel id\n' +
        'that no source registers — the chord can never fire. Create the panel with\n' +
        'that viewType, or remove the dead keybinding:\n'
    );
    for (const d of dead) {
      console.error(
        `  ${d.command}: when references activeWebviewPanelId == '${d.id}' (no such webview viewType in src/)`
      );
    }
    process.exit(1);
  }

  console.log(
    'check-webview-keybinding-panelid: OK (every activeWebviewPanelId keybinding targets a real webview panel)'
  );
}

main();
