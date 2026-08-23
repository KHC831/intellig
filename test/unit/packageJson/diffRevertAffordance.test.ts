/**
 * Spec for the per-hunk revert affordance in every diff IntelliG opens.
 *
 * VS Code's diff gutter menu marks exactly ONE hunk `showAlways` (the current
 * one) and leaves the rest at `opacity: 0` until the pointer enters the
 * gutter, so a file with several changed blocks shows a single revert arrow
 * and hides the others behind a hover. IntelliJ installs a persistent gutter
 * icon renderer per change instead — see `SimpleDiffChangeUi.createOperation`
 * in `platform/diff-impl` — so every block carries its own always-visible
 * affordance.
 *
 * `renderMarginRevertIcon` draws exactly that: an arrow on every changed
 * block, ungated by hover. It is suppressed while the gutter menu is on, so
 * the parity knob is turning the menu off. This is contributed as a DEFAULT,
 * not a forced value: a user who prefers the gutter menu sets it back and
 * their setting wins.
 *
 * `vscode.diff` forwards only `(left, right, title, TextDocumentShowOptions)`
 * and none of those carry diff-editor options, so there is no per-editor
 * route to this and the manifest is the only seam.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function loadDefaults(): Record<string, unknown> {
  const raw = fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw) as {
    contributes?: { configurationDefaults?: Record<string, unknown> };
  };
  const defaults = pkg.contributes?.configurationDefaults;
  assert.ok(defaults, 'contributes.configurationDefaults present');
  return defaults;
}

describe('package.json — diff revert affordance', () => {
  it('turns the gutter menu off so the revert arrow is drawn on every hunk', () => {
    const defaults = loadDefaults();
    assert.strictEqual(
      defaults['diffEditor.renderGutterMenu'],
      false,
      'the gutter menu hides every arrow but the current hunk behind a hover'
    );
  });

  it('leaves the margin revert icon on — it is what draws the per-hunk arrow', () => {
    const defaults = loadDefaults();
    // Both halves of the condition matter: the arrows render only when
    // renderMarginRevertIcon is on AND the gutter menu is off. Contributing
    // the second without pinning the first leaves the pair one upstream
    // default-flip away from silently rendering nothing at all.
    assert.notStrictEqual(
      defaults['diffEditor.renderMarginRevertIcon'],
      false,
      'switching this off removes the arrows the gutter-menu default exists to restore'
    );
  });
});
