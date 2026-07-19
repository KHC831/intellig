/**
 * Keybinding gating + gesture coherence (package.json is the source of truth).
 *
 * The `intellig.keymapPreset` default promises stock VS Code keybindings, so
 * every IntelliG chord is gated behind `keymapPreset == 'intellij'` — the ONE
 * exception is the log view's in-panel find (ctrl+f → jumpToHash), whose
 * when-clause already scopes it to our own webview so it can shadow nothing
 * outside it.
 *
 * Gesture pins (reference keymap XMLs, verified):
 * - ChangesView.Move = alt shift M ($default.xml:672) — not F6.
 * - Vcs.QuickListPopupAction mac = ctrl V (Mac OS X 10.5+.xml:340).
 * - ActivateCommitToolWindow mac = meta 0 (Mac OS X 10.5+.xml:230).
 * - IntelliJ ctrl+D is Diff.ShowDiff (show diff), NOT compare-with-branch —
 *   and branch.compareWithCurrent is a tree-item command a keybinding can
 *   never supply an argument to (guaranteed no-op), so ctrl+d binds the
 *   active file's diff instead.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const INTELLIJ_GATE = "config.intellig.keymapPreset == 'intellij'";
/** The one view-scoped binding that stays live under the default preset. */
const IN_VIEW_FIND = 'intellig.toolWindow.jumpToHash';

interface PackageKeybinding {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

function keybindings(): PackageKeybinding[] {
  const pj = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8')) as {
    contributes: { keybindings?: PackageKeybinding[] };
  };
  return pj.contributes.keybindings ?? [];
}

describe('keybinding gating (keymapPreset default = stock VS Code)', () => {
  it('gates every binding on the preset except the in-view find', () => {
    const ungated = keybindings().filter((kb) => !(kb.when ?? '').includes(INTELLIJ_GATE));
    assert.deepStrictEqual(
      ungated.map((kb) => kb.command).sort(),
      [IN_VIEW_FIND],
      `the default preset binds nothing outside our own views; ungated: ${JSON.stringify(
        ungated.map((kb) => `${kb.command} (${kb.key})`)
      )}`
    );
  });

  it('the in-view find is ungated AND stays scoped to our own log surface', () => {
    const find = keybindings().find((kb) => kb.command === IN_VIEW_FIND);
    assert.ok(find, 'jumpToHash binding must exist');
    assert.ok(
      !(find.when ?? '').includes(INTELLIJ_GATE),
      `the in-view find must not carry the preset gate; when="${find.when}"`
    );
    assert.ok(
      /focusedView|activeWebviewPanelId/.test(find.when ?? ''),
      `jumpToHash must remain view-scoped, got when="${find.when}"`
    );
  });

  it('gated bindings keep their non-preset guards (terminal/debug scoping intact)', () => {
    for (const kb of keybindings()) {
      if (kb.command === IN_VIEW_FIND) {
        continue;
      }
      assert.ok(
        (kb.when ?? '').includes(INTELLIJ_GATE),
        `${kb.command} must carry the preset gate; when="${kb.when}"`
      );
    }
  });
});

describe('keybinding gestures match the reference keymap', () => {
  it('Move to Another Changelist is alt+shift+m (ChangesView.Move), not F6', () => {
    const move = keybindings().find((kb) => kb.command === 'intellig.changelist.moveFilesTo');
    assert.ok(move, 'moveFilesTo binding must exist');
    assert.strictEqual(move.key, 'alt+shift+m');
  });

  it('VCS operations popup uses ctrl+v on mac (Vcs.QuickListPopupAction)', () => {
    const popup = keybindings().find((kb) => kb.command === 'intellig.vcsOperationsPopup');
    assert.ok(popup, 'vcsOperationsPopup binding must exist');
    assert.strictEqual(popup.mac, 'ctrl+v');
  });

  it('Commit tool window has the cmd+0 mac variant (ActivateCommitToolWindow meta 0)', () => {
    const ctw = keybindings().find((kb) => kb.command === 'intellig.showCommitToolWindow');
    assert.ok(ctw, 'showCommitToolWindow binding must exist');
    assert.strictEqual(ctw.mac, 'cmd+0');
  });

  it('ctrl+d binds the active file diff, not the un-invokable tree-item compare', () => {
    const byKey = keybindings().filter((kb) => kb.key === 'ctrl+d');
    assert.deepStrictEqual(
      byKey.map((kb) => kb.command),
      ['intellig.explorer.compareWithRepoVersion'],
      'ctrl+d must target the file-diff surface (IntelliJ Diff.ShowDiff class)'
    );
    assert.ok(
      !keybindings().some((kb) => kb.command === 'intellig.branch.compareWithCurrent'),
      'branch.compareWithCurrent must not be keyboard-bound (tree-item arg contract)'
    );
  });
});
