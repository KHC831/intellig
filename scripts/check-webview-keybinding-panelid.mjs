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
 *    That viewType is a string literal passed to `createWebviewPanel` in the
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
 *    must appear as a string literal somewhere under src/ — the only place a
 *    webview panel viewType can be created. An id referenced by a keybinding
 *    but absent from the source is a dead panel id and fails the guard.
 *    Adding a keybinding for a real panel is automatically covered (its
 *    viewType literal is in the source); no per-keybinding edit is needed.
 *
 * 3. Known false-positive cases
 *    None structural. The only correct states are: make the id real (create
 *    the panel with that viewType in src) or remove the dead keybinding —
 *    which is exactly the fix the guard forces. An id assembled at runtime
 *    from fragments would false-fail, but the house convention is to pass
 *    every viewType as a whole-string literal (verified: 0 such ids today).
 *
 * 4. Retirement criteria
 *    Retire when webview keybindings are generated from the same typed table
 *    that declares panel viewTypes, making the id a shared source of truth.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function collectTsFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectTsFiles(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const srcBlob = collectTsFiles(join(root, 'src'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

const panelIdRe = /activeWebviewPanelId\s*==\s*(['"])([^'"]+)\1/g;
const dead = [];
for (const kb of pkg.contributes?.keybindings ?? []) {
  const when = typeof kb.when === 'string' ? kb.when : '';
  let m;
  while ((m = panelIdRe.exec(when)) !== null) {
    const id = m[2];
    const isRealViewType = srcBlob.includes(`'${id}'`) || srcBlob.includes(`"${id}"`);
    if (!isRealViewType) {
      dead.push({ command: kb.command, id });
    }
  }
}

if (dead.length > 0) {
  console.error(
    'check-webview-keybinding-panelid: keybindings gated on a webview panel id\n' +
      'that no source creates — the chord can never fire. Create the panel with\n' +
      'that viewType, or remove the dead keybinding:\n'
  );
  for (const d of dead) {
    console.error(`  ${d.command}: when references activeWebviewPanelId == '${d.id}' (no such viewType in src/)`);
  }
  process.exit(1);
}

console.log('check-webview-keybinding-panelid: OK (every activeWebviewPanelId keybinding targets a real webview panel)');
