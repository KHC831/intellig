/**
 * Smoke test 4 — toggle feature flags.
 *
 * Flips the two experimental flags that gate the Tier-1 parity UI on and off
 * through `vscode.workspace.getConfiguration().update(…)`:
 *
 *   - `intellig.useCommitToolWindow` (gates the Commit tool window view slot)
 *   - `intellig.useTabbedGitToolWindow` (gates the tabbed Log UI)
 *
 * Each flag is toggled off → on → off. After every transition we:
 *   (a) assert no exception propagated from `update()`,
 *   (b) verify the configuration read-back reflects the new value,
 *   (c) ensure a subsequent `vscode.commands.executeCommand('intellig.openGitToolWindow')`
 *       does not throw — i.e. live rebinding of the tool window works.
 *
 * This catches regressions where flag-toggle code path throws or corrupts
 * view registration state (the failure mode TL-16 is meant to prevent).
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXT_ID = 'intellig-vscode.intellig';
const FLAGS = ['useCommitToolWindow', 'useTabbedGitToolWindow'] as const;

describe('ext-host smoke — 4. toggle feature flag', function () {
  this.timeout(30_000);

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext);
    await ext!.activate();
  });

  // Restore each flag's original (user-scope) value after every test so we
  // don't leak state into test 5 / the user's profile.
  const originals = new Map<string, unknown>();

  before(() => {
    const cfg = vscode.workspace.getConfiguration('intellig');
    for (const flag of FLAGS) {
      originals.set(flag, cfg.get(flag));
    }
  });

  after(async () => {
    const cfg = vscode.workspace.getConfiguration('intellig');
    for (const flag of FLAGS) {
      const original = originals.get(flag);
      // Use ConfigurationTarget.Global so we match the update scope in the
      // test body. Passing `undefined` clears the setting.
      await cfg.update(flag, original, vscode.ConfigurationTarget.Global);
    }
  });

  for (const flag of FLAGS) {
    it(`toggles intellig.${flag} off → on → off without throwing`, async () => {
      const cfg = () => vscode.workspace.getConfiguration('intellig');

      // off
      await cfg().update(flag, false, vscode.ConfigurationTarget.Global);
      assert.strictEqual(cfg().get<boolean>(flag), false, `${flag} not false after update`);

      // on
      await cfg().update(flag, true, vscode.ConfigurationTarget.Global);
      assert.strictEqual(cfg().get<boolean>(flag), true, `${flag} not true after update`);

      // live rebind probe — the tool window must still focus without throwing
      await vscode.commands.executeCommand('intellig.openGitToolWindow');

      // back off
      await cfg().update(flag, false, vscode.ConfigurationTarget.Global);
      assert.strictEqual(cfg().get<boolean>(flag), false, `${flag} not false after second update`);

      // one more probe — handlers must not have corrupted state
      await vscode.commands.executeCommand('intellig.openGitToolWindow');
    });
  }
});
