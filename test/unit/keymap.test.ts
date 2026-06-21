/**
 * Unit tests for IntelliJ keymap parity.
 *
 * The tests load package.json and assert that each IntelliJ-preset
 * keybinding is present with the expected command + when clause. Also
 * verifies the stub commands (localChanges.openFile, toolWindow.jumpToHash)
 * are declared so the keybinding resolver doesn't fail at runtime.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface PackageJson {
  contributes?: {
    commands?: Array<{ command: string; title?: string; category?: string }>;
    keybindings?: Array<{ command: string; key: string; mac?: string; when?: string }>;
  };
}

function loadPackageJson(): PackageJson {
  // Resolve relative to the current working directory rather than
  // __dirname — ts-node runs the test file under ESM semantics where
  // __dirname isn't defined. `npm run test:unit` starts from the repo
  // root, so `./package.json` is the authoritative path.
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf-8');
  return JSON.parse(raw) as PackageJson;
}

describe('IntelliJ keymap parity', () => {
  let pkg: PackageJson;

  before(() => {
    pkg = loadPackageJson();
  });

  describe('commands contribution', () => {
    it('declares intellig.rebase.skip', () => {
      const cmds = pkg.contributes?.commands ?? [];
      assert.ok(cmds.find((c) => c.command === 'intellig.rebase.skip'));
    });

    // `intellig.localChanges.openFile` is no longer a "Coming soon" stub;
    // the handler resolves the target via `resolveLocalChangesOpenFileTarget`
    // and dispatches to `vscode.open`. The `package.json` contract here
    // is unchanged — the command id must still be declared so the F4
    // keybinding resolves.
    it('declares real intellig.localChanges.openFile handler', () => {
      const cmds = pkg.contributes?.commands ?? [];
      assert.ok(cmds.find((c) => c.command === 'intellig.localChanges.openFile'));
    });

    it('declares stub intellig.toolWindow.jumpToHash', () => {
      const cmds = pkg.contributes?.commands ?? [];
      assert.ok(cmds.find((c) => c.command === 'intellig.toolWindow.jumpToHash'));
    });
  });

  describe('keybindings gated on keymapPreset == intellij', () => {
    /** Find the first keybinding matching the command + key combo. */
    function findKb(
      command: string,
      key: string
    ): { command: string; key: string; mac?: string; when?: string } | undefined {
      const kbs = pkg.contributes?.keybindings ?? [];
      return kbs.find((k) => k.command === command && k.key === key);
    }

    it('Ctrl+Shift+U → intellig.showShelfList with preset gate', () => {
      const kb = findKb('intellig.showShelfList', 'ctrl+shift+u');
      assert.ok(kb, 'expected ctrl+shift+u → intellig.showShelfList keybinding');
      assert.strictEqual(kb.mac, 'cmd+shift+u');
      assert.ok(
        kb.when?.includes("config.intellig.keymapPreset == 'intellij'"),
        `when clause must gate on keymapPreset, got: ${kb.when}`
      );
    });

    it('F4 → intellig.localChanges.openFile with preset gate', () => {
      const kb = findKb('intellig.localChanges.openFile', 'f4');
      assert.ok(kb, 'expected f4 → intellig.localChanges.openFile keybinding');
      assert.ok(kb.when?.includes("config.intellig.keymapPreset == 'intellij'"));
    });

    it('F6 → intellig.changelist.moveFilesTo with preset gate', () => {
      const kb = findKb('intellig.changelist.moveFilesTo', 'f6');
      assert.ok(kb, 'expected f6 → intellig.changelist.moveFilesTo keybinding');
      assert.ok(kb.when?.includes("config.intellig.keymapPreset == 'intellij'"));
    });

    it('Ctrl+F (graph-focused) → intellig.toolWindow.jumpToHash', () => {
      // declared a preset-gated stub; /06 added a universal
      // binding for the real Jump-to-Commit feature (useful regardless of
      // keymap preset). Both satisfy the parity goal — either must exist
      // and be focused-view-scoped so we don't hijack VS Code's global
      // Ctrl+F. Any ctrl+f → jumpToHash with a focusedView clause is ok.
      const kbs = (pkg.contributes?.keybindings ?? []).filter(
        (k) => k.command === 'intellig.toolWindow.jumpToHash' && k.key === 'ctrl+f'
      );
      assert.ok(
        kbs.length >= 1,
        'expected at least one ctrl+f → intellig.toolWindow.jumpToHash keybinding'
      );
      const scoped = kbs.find((k) => k.when?.includes('focusedView'));
      assert.ok(
        scoped,
        'ctrl+f must be scoped by a focusedView clause so it does not hijack the global Ctrl+F'
      );
      assert.strictEqual(scoped.mac, 'cmd+f');
    });
  });

  describe('existing silent shelve/unshelve shortcuts are still bound', () => {
    it('Ctrl+Shift+H → intellig.shelve.silent', () => {
      const kbs = pkg.contributes?.keybindings ?? [];
      const kb = kbs.find(
        (k) => k.command === 'intellig.shelve.silent' && k.key === 'ctrl+shift+h'
      );
      assert.ok(kb, 'shelve.silent shortcut ctrl+shift+h must still be present');
    });

    it('Ctrl+Alt+U → intellig.unshelve.silent', () => {
      const kbs = pkg.contributes?.keybindings ?? [];
      const kb = kbs.find(
        (k) => k.command === 'intellig.unshelve.silent' && k.key === 'ctrl+alt+u'
      );
      assert.ok(kb, 'unshelve.silent shortcut ctrl+alt+u must still be present');
    });
  });
});
