#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// check-keybindings-coherence.mjs — keybinding gating + arg-contract guard.
//
// Maintenance contract (per ADR-007 section "Guard maintenance contract"):
//
// 1. Bug class (two arms, one keybinding fence)
//    a) SHADOW GATING: `intellig.keymapPreset` defaults to `default`, whose
//       description promises stock VS Code keybindings. An ungated
//       contributes.keybindings entry overrides VS Code defaults for every
//       user regardless of the preset (ctrl+shift+k ate Delete Line, ctrl+k
//       ate the chord leader). Every binding must carry the preset gate in
//       its `when` UNLESS the when-clause scopes it to an intellig view or
//       webview panel (focusedView / activeWebviewPanelId on an intellig id)
//       — a binding that only fires inside our own surface cannot shadow a
//       VS Code default anywhere else, and IS the sanctioned shape for
//       in-view gestures (the log view's ctrl+f find).
//    b) CORE EDITOR CHORDS: extension keybindings outrank VS Code's core
//       editor defaults, so binding a core chord steals it from the user
//       WHILE TYPING (mac ctrl+k/ctrl+t/ctrl+d took kill-line, transpose and
//       forward-delete). A binding on a core chord must yield inside text
//       inputs via a `!textInputFocus` / `!editorTextFocus` carve-out.
//    c) ARG CONTRACT: a command registered through `registerTreeItemCommand`
//       resolves its target from the CLICKED TREE ITEM; a keybinding invokes
//       with no argument, so the handler silently returns — a guaranteed
//       dead gesture (ctrl+d → branch.compareWithCurrent never did anything
//       from the keyboard).
//
// 2. Heuristic + how it scales
//    a) Parse contributes.keybindings; every entry's `when` must contain
//       `keymapPreset == 'intellij'` OR an intellig view/panel scope
//       (`focusedView == 'intellig.…'` / `activeWebviewPanelId ==
//       'intellig.…'`). The next scoped in-view binding is legal by
//       construction; the next global ungated one fails at introduction.
//    b) Each entry's EFFECTIVE chord per platform (`mac`/`win`/`linux`,
//       falling back to `key`) is looked up in CORE_EDITOR_CHORDS below — a
//       maintained table of the core VS Code editor bindings that fire while
//       a text input has focus. A hit without a text-input carve-out fails,
//       so the next binding that lands on a core chord fails at introduction.
//       View-scoped bindings are exempt: they only fire when one of our own
//       views has focus, so no editor can be receiving the keystroke.
//    c) Collect every keybinding command id; scan production source for
//       `registerTreeItemCommand` call blocks and the `id: '<cmd>'` they
//       register. A keybinding whose command id is registered that way fails.
//
// 3. Known false-positive cases
//    A tree-item command that ALSO registers a keyboard-friendly wrapper
//    under the same id would false-fail — the codebase has none (ids are
//    registered exactly once; check-command-coverage pins that elsewhere).
//
// 4. Known false-negative cases
//    (a) the view-scope check is textual: a when-clause that NAMES an
//    intellig view inside an `||` whose other arm is global would pass while
//    still firing globally — keymapGating.test.ts pins the exact ungated set
//    so such a clause is reviewed there. (b) only catches the tree-item
//    contract; a selection command that dead-ends for other reasons needs
//    its own test.
//
// 5. Retirement criteria
//    Retire when keybindings are generated from the KeymapService tables
//    (single typed source), making an ungated or contract-breaking binding
//    unrepresentable.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

const GATE = "keymapPreset == 'intellij'";

/**
 * Core VS Code editor chords that fire while a text input has focus, per
 * platform. Binding one of these without a carve-out steals it mid-typing.
 * Maintenance: add a chord when VS Code core takes one over; the value is the
 * core command, quoted in the failure message so the cost is visible.
 */
const CORE_EDITOR_CHORDS = {
  mac: {
    'ctrl+a': 'cursorHome',
    'ctrl+b': 'cursorLeft',
    'ctrl+d': 'deleteRight',
    'ctrl+e': 'cursorEnd',
    'ctrl+f': 'cursorRight',
    'ctrl+h': 'deleteLeft',
    'ctrl+k': 'deleteAllRight',
    'ctrl+n': 'cursorDown',
    'ctrl+o': 'lineBreakInsert',
    'ctrl+p': 'cursorUp',
    'ctrl+t': 'transposeLetters',
  },
  win: {
    'ctrl+backspace': 'deleteWordLeft',
    'ctrl+d': 'addSelectionToNextFindMatch',
    'ctrl+delete': 'deleteWordRight',
    'ctrl+enter': 'insertLineAfter',
    'ctrl+k': 'chord leader (ctrl+k …)',
    'ctrl+l': 'expandLineSelection',
    'ctrl+shift+enter': 'insertLineBefore',
    'ctrl+shift+k': 'deleteLines',
  },
};
CORE_EDITOR_CHORDS.linux = CORE_EDITOR_CHORDS.win;

/** A binding yields to the editor only by negating a text-focus context key. */
const TEXT_INPUT_CARVE_OUT_RE = /!\s*(textInputFocus|editorTextFocus)/;

/** The chord this entry actually binds on `platform` (platform key or `key`). */
function chordFor(kb, platform) {
  const chord = kb?.[platform] ?? kb?.key;
  return typeof chord === 'string' ? chord.trim().toLowerCase() : undefined;
}

/**
 * An ungated binding is sanctioned only when its `when` scopes it to one of
 * our own views/webview panels — it then cannot shadow a VS Code default
 * outside intellig UI.
 */
const INTELLIG_VIEW_SCOPE_RE =
  /(focusedView|activeWebviewPanelId)\s*==\s*'intellig\./;

function main() {
  const pkgPath = process.argv[2] ?? 'package.json';
  const srcDir = process.argv[3] ?? 'src';
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const keybindings = pkg?.contributes?.keybindings ?? [];

  const failures = [];

  // Arm (a): preset gating (or an intellig view/panel scope).
  let scopedUngated = 0;
  for (const kb of keybindings) {
    const when = kb?.when ?? '';
    if (when.includes(GATE)) continue;
    if (INTELLIG_VIEW_SCOPE_RE.test(when)) {
      scopedUngated++;
      continue;
    }
    failures.push(
      `${kb.command} (${kb.key}) is neither gated behind ${GATE} nor scoped to an intellig view/panel by its when-clause`
    );
  }

  // Arm (b): core editor chords must yield inside text inputs.
  for (const kb of keybindings) {
    const when = kb?.when ?? '';
    if (INTELLIG_VIEW_SCOPE_RE.test(when)) continue;
    if (TEXT_INPUT_CARVE_OUT_RE.test(when)) continue;
    for (const platform of ['mac', 'win', 'linux']) {
      const chord = chordFor(kb, platform);
      const core = chord !== undefined ? CORE_EDITOR_CHORDS[platform][chord] : undefined;
      if (core === undefined) continue;
      failures.push(
        `${kb.command} binds ${platform} ${chord}, which VS Code core uses for ${core} — add a !textInputFocus carve-out so it yields while typing`
      );
    }
  }

  // Arm (c): tree-item arg contract.
  const treeItemIds = collectTreeItemCommandIds(srcDir);
  for (const kb of keybindings) {
    if (treeItemIds.has(kb.command)) {
      failures.push(
        `${kb.command} (${kb.key}) is registered via registerTreeItemCommand — a keybinding passes no tree item, so the gesture is a guaranteed no-op`
      );
    }
  }

  if (failures.length > 0) {
    console.error(`keybindings-coherence guard FAILED — ${failures.length} problem(s):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(
    `keybindings-coherence guard OK — ${keybindings.length} binding(s) checked (${scopedUngated} view-scoped ungated).`
  );
}

/** Every `id: 'intellig.…'` inside a registerTreeItemCommand call block. */
function collectTreeItemCommandIds(srcDir) {
  const ids = new Set();
  const stack = [srcDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === 'test' || e.name === 'node_modules') continue;
        stack.push(path.join(dir, e.name));
      } else if (/\.ts$/.test(e.name)) {
        const text = fs.readFileSync(path.join(dir, e.name), 'utf8');
        if (!text.includes('registerTreeItemCommand')) continue;
        // Each call site is followed (within its spec literal) by an
        // `id: '<cmd>'` — take the first id after each call token.
        const parts = text.split('registerTreeItemCommand');
        for (const part of parts.slice(1)) {
          const m = part.match(/id:\s*'(intellig\.[a-zA-Z0-9.]+)'/);
          if (m) ids.add(m[1]);
        }
      }
    }
  }
  return ids;
}

main();
