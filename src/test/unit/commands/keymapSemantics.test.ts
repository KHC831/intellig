/**
 * Workstream C, Item 1 — keymap conflict / semantics regression coverage.
 *
 * The full-parity audit (§C "Gaps") flagged four keymap defects in
 * `package.json`:
 *
 *   1. `ctrl+alt+z` double-bound — `intellig.unstageSelected` (global) AND
 *      `intellig.revertFile` (IntelliJ-gated) both claimed it, so in the
 *      IntelliJ preset both fired for one chord.
 *   2. `ctrl+t` mapped to a bare pull instead of IntelliJ's Update Project
 *      (`Vcs.UpdateProject`).
 *   3. No `ctrl+alt+k` Commit-and-Push.
 *   4. `alt+`` conflated the VCS Operations Popup with the branch popup.
 *
 * These tests pin the fixed shape against the shipped `package.json` so a
 * future additive edit that re-introduces any of the four defects fails in
 * the same unit suite. The "no two bindings share a chord within an
 * overlapping `when` context" guard is the general invariant that catches the
 * #1 class for ALL future keybindings, not just the one the audit found.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, 'package.json');

interface PackageKeybinding {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

interface PackageJson {
  contributes: { keybindings?: PackageKeybinding[] };
}

function keybindings(): PackageKeybinding[] {
  const pj = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as PackageJson;
  return pj.contributes.keybindings ?? [];
}

/**
 * Two `when` clauses "overlap" if neither is the negation of the other and
 * they aren't trivially mutually exclusive on the keymap preset gate. We treat
 * a binding with `keymapPreset == 'intellij'` as overlapping with an ungated
 * binding (the gated one is active *in addition to* the global one when the
 * preset is on). Bindings gated to disjoint webview/preset contexts do not
 * overlap.
 */
function mayOverlap(a: PackageKeybinding, b: PackageKeybinding): boolean {
  const wa = a.when ?? '';
  const wb = b.when ?? '';
  // Distinct merge-view / webview contexts never overlap with editor/global.
  const ctx = (w: string): string | undefined => {
    const m = /activeWebviewPanelId == '([^']+)'/.exec(w);
    return m ? m[1] : undefined;
  };
  const ca = ctx(wa);
  const cb = ctx(wb);
  if (ca && cb && ca !== cb) {
    return false;
  }
  if ((ca && !cb) || (!ca && cb)) {
    // one is a webview-panel context, the other is not → no overlap
    return false;
  }
  return true;
}

describe('Workstream C Item 1 — keymap conflict / semantics fixes', () => {
  it('no two keybindings share the same chord within an overlapping when-context (ctrl+alt+z fix)', () => {
    const kbs = keybindings();
    const conflicts: string[] = [];

    for (let i = 0; i < kbs.length; i++) {
      for (let j = i + 1; j < kbs.length; j++) {
        const a = kbs[i];
        const b = kbs[j];
        if (a.command === b.command) {
          continue; // same command on different keys is fine
        }
        if (a.key === b.key && mayOverlap(a, b)) {
          conflicts.push(
            `${a.key}: ${a.command} (when: ${a.when ?? '-'}) vs ${b.command} (when: ${b.when ?? '-'})`
          );
        }
      }
    }

    assert.deepStrictEqual(
      conflicts,
      [],
      `Conflicting keybindings share a chord in an overlapping context:\n  ${conflicts.join('\n  ')}`
    );
  });

  it('ctrl+t maps to Update Project (Vcs.UpdateProject), not a bare pull', () => {
    const ctrlT = keybindings().filter((kb) => kb.key === 'ctrl+t');
    assert.strictEqual(ctrlT.length, 1, 'exactly one ctrl+t binding');
    assert.strictEqual(ctrlT[0].command, 'intellig.updateProject');
    assert.ok(
      !keybindings().some((kb) => kb.key === 'ctrl+t' && kb.command === 'intellig.pull'),
      'ctrl+t must no longer trigger intellig.pull'
    );
  });

  it('ctrl+alt+k triggers Commit and Push (IntelliJ-gated)', () => {
    const binding = keybindings().find((kb) => kb.key === 'ctrl+alt+k');
    assert.ok(binding, 'a ctrl+alt+k binding exists');
    assert.strictEqual(binding.command, 'intellig.commitAndPush');
    assert.ok(
      (binding.when ?? '').includes("keymapPreset == 'intellij'"),
      'Commit and Push is gated to the IntelliJ preset'
    );
  });

  it('alt+` is the VCS Operations Popup, distinct from the branch popup chord', () => {
    const altBacktick = keybindings().filter((kb) => kb.key === 'alt+`');
    assert.strictEqual(altBacktick.length, 1, 'exactly one alt+` binding');
    assert.strictEqual(altBacktick[0].command, 'intellig.vcsOperationsPopup');

    // The branch popup keeps its own dedicated chord.
    const branchPopup = keybindings().filter((kb) => kb.command === 'intellig.showBranchPopup');
    assert.ok(
      branchPopup.some((kb) => kb.key === 'ctrl+shift+`'),
      'branch popup keeps ctrl+shift+`'
    );
    assert.ok(
      !branchPopup.some((kb) => kb.key === 'alt+`'),
      'branch popup must no longer claim alt+`'
    );
  });

  it('unstage moved off ctrl+alt+z to avoid the revert double-binding', () => {
    const unstage = keybindings().find((kb) => kb.command === 'intellig.unstageSelected');
    assert.ok(unstage);
    assert.notStrictEqual(unstage.key, 'ctrl+alt+z', 'unstage must not use the revert chord');
    assert.strictEqual(unstage.key, 'ctrl+alt+shift+z');

    // revert keeps ctrl+alt+z (IntelliJ Rollback semantics).
    const revert = keybindings().find((kb) => kb.command === 'intellig.revertFile');
    assert.ok(revert);
    assert.strictEqual(revert.key, 'ctrl+alt+z');
  });
});
