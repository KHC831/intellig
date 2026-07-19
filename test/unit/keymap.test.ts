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
import { resolveCommitSurface } from '../../src/commands/registration/commitRepoCoreCommands';

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

    it('Alt+Shift+M → intellig.changelist.moveFilesTo with preset gate (ChangesView.Move)', () => {
      const kb = findKb('intellig.changelist.moveFilesTo', 'alt+shift+m');
      assert.ok(kb, 'expected alt+shift+m → intellig.changelist.moveFilesTo keybinding');
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

/**
 * Whole-block coherence, pinned against the IntelliJ keymap XMLs so drift
 * fails the gate rather than surfacing on someone's keyboard.
 *
 * Authority (read, not inferred):
 *   CheckinProject          control K        platform/vcs-impl/resources/META-INF/VcsActions.xml:10-11
 *   Vcs.Push                control shift K  platform/dvcs-impl/resources/intellij.platform.vcs.dvcs.impl.xml:72-73
 *   Vcs.UpdateProject       control T        platform/vcs-impl/resources/META-INF/VcsActions.xml:48-49
 *   Compare.SameVersion     control D        platform/platform-resources/src/keymaps/$default.xml:538-539
 *   ChangesView.Move        alt shift M      $default.xml:672-673
 *                           meta shift M     "Mac OS X 10.5+.xml":297-298  (the ONLY mac override we mirror)
 *   Vcs.Log.FocusTextFilter control L        platform/vcs-log/impl/resources/intellij.platform.vcs.log.impl.xml:198-199
 *   ShowTabbedFileHistory   (no shortcut in any bundled keymap)
 *
 * The mac keymap overrides ChangesView.Move and nothing else in this set, so
 * every other action keeps its `control` chord on macOS. Binding them to `cmd`
 * both diverges from IntelliJ and, for cmd+k / cmd+d, eats a VS Code chord
 * prefix or a core editor command.
 */
describe('keybinding block coherence', () => {
  const PRESET_GATE = "config.intellig.keymapPreset == 'intellij'";

  /** VS Code mac chord PREFIXES — binding one as a whole chord kills the family. */
  const MAC_CHORD_PREFIXES = ['cmd+k', 'cmd+e', 'cmd+m'];

  /** command → expected mac chord, for the actions IntelliJ pins. */
  const EXPECTED_MAC: Record<string, string> = {
    'intellig.commit': 'ctrl+k',
    'intellig.push': 'ctrl+shift+k',
    'intellig.updateProject': 'ctrl+t',
    'intellig.explorer.compareWithRepoVersion': 'ctrl+d',
    'intellig.changelist.moveFilesTo': 'cmd+shift+m',
  };

  function keybindings(): Array<{ command: string; key: string; mac?: string; when?: string }> {
    return loadPackageJson().contributes?.keybindings ?? [];
  }

  for (const [command, mac] of Object.entries(EXPECTED_MAC)) {
    it(`${command} uses the IntelliJ mac chord ${mac}`, () => {
      const kb = keybindings().find((k) => k.command === command);
      assert.ok(kb, `expected a keybinding for ${command}`);
      assert.strictEqual(kb.mac, mac);
    });
  }

  it('binds no mac chord that is a VS Code chord prefix', () => {
    const offenders = keybindings()
      .filter((k) => k.mac && MAC_CHORD_PREFIXES.includes(k.mac))
      .map((k) => `${k.command} → ${k.mac}`);

    assert.deepStrictEqual(offenders, [], `mac chord prefixes swallowed: ${offenders.join(', ')}`);
  });

  it('gates every binding on the keymap preset except the in-view find', () => {
    // The in-log find is scoped to our own webview by its when-clause, so it
    // shadows nothing under the default preset and stays live there.
    const ungated = keybindings()
      .filter((k) => !k.when?.includes(PRESET_GATE))
      .map((k) => `${k.command} (${k.key})`);

    assert.deepStrictEqual(
      ungated,
      ['intellig.toolWindow.jumpToHash (ctrl+f)'],
      `unexpected ungated bindings: ${ungated.join(', ')}`
    );
  });

  it('binds nothing to intellig.showHistory (IntelliJ ships no default shortcut)', () => {
    const bound = keybindings().filter((k) => k.command === 'intellig.showHistory');

    assert.deepStrictEqual(bound, [], 'Ctrl+H shadows Find-and-Replace; Cmd+H is OS Hide');
  });

  it('focuses the log text filter on Ctrl+L, view-scoped', () => {
    const kb = keybindings().find((k) => k.command === 'intellig.toolWindow.focusTextFilter');

    assert.ok(kb, 'expected a focusTextFilter binding');
    assert.strictEqual(kb.key, 'ctrl+l');
    assert.strictEqual(kb.mac, 'ctrl+l');
    assert.ok(kb.when?.includes('focusedView'), 'must be scoped to the tool window');
  });

  it('keeps the terminalFocus exclusion on every non-view-scoped binding', () => {
    const missing = keybindings()
      .filter((k) => !k.when?.includes('focusedView') && !k.when?.includes('editorTextFocus'))
      .filter((k) => !k.when?.includes('!terminalFocus'))
      .map((k) => `${k.command} (${k.key})`);

    assert.deepStrictEqual(missing, [], `missing !terminalFocus: ${missing.join(', ')}`);
  });
});

/**
 * Alt+0 routing.
 *
 * The keybinding's when-clause now requires `config.intellig.useCommitToolWindow`,
 * but the command is also reachable from the palette with the flag off — where
 * revealing a view whose own when-clause is false is a silent no-op. The modal
 * commit dialog is the fallback surface in that state.
 */
describe('commit tool window routing', () => {
  it('shows the tool window when it exists and the flag is on', () => {
    assert.strictEqual(
      resolveCommitSurface({ hasToolWindow: true, flagEnabled: true }),
      'toolWindow'
    );
  });

  it('falls back to the modal dialog when the flag is off', () => {
    assert.strictEqual(
      resolveCommitSurface({ hasToolWindow: true, flagEnabled: false }),
      'dialog',
      'revealing a flag-gated view would be a silent no-op'
    );
  });

  it('falls back to the modal dialog when the flag is off and nothing was constructed', () => {
    assert.strictEqual(
      resolveCommitSurface({ hasToolWindow: false, flagEnabled: false }),
      'dialog'
    );
  });

  it('reveals the view when the flag is on but the instance is missing', () => {
    assert.strictEqual(resolveCommitSurface({ hasToolWindow: false, flagEnabled: true }), 'view');
  });
});
