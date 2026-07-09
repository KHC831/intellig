/**
 * Regression: the per-hunk merge commands are GONE.
 *
 * `intellig.merge.acceptCurrent/acceptIncoming/acceptBoth/acceptAllCurrent/
 * acceptAllIncoming/nextConflict/previousConflict` routed to `MergeView`
 * methods that became empty no-ops once MergeView started delegating to VS
 * Code's native merge editor (hunk-level resolution lives inside that editor).
 * They shipped as palette-visible entries and (five of them) as keybindings
 * gated on `activeWebviewPanelId == 'intellig.mergeView'` — a panel id no
 * source creates. All were silent dead affordances and must not come back:
 * no registration, no `contributes.commands` entry, no keybinding.
 *
 * KEPT (real): intellig.merge.openMergeView, intellig.merge.markResolved.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerRebaseConflictCommands } from '../../../src/commands/registration/rebaseConflictCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';

const DEAD_MERGE_COMMANDS = [
  'intellig.merge.acceptCurrent',
  'intellig.merge.acceptIncoming',
  'intellig.merge.acceptBoth',
  'intellig.merge.acceptAllCurrent',
  'intellig.merge.acceptAllIncoming',
  'intellig.merge.nextConflict',
  'intellig.merge.previousConflict',
];

interface PackageJson {
  contributes?: {
    commands?: Array<{ command: string }>;
    keybindings?: Array<{ command: string }>;
  };
}

function readPackageJson(): PackageJson {
  const pkgPath = path.resolve(__dirname, '../../../package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
}

describe('dead per-hunk merge commands are removed', () => {
  describe('command registration', () => {
    const registered: string[] = [];
    const original = vscode.commands.registerCommand;

    before(() => {
      (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = (
        id: string
      ): { dispose: () => void } => {
        registered.push(id);
        return { dispose: (): void => {} };
      };
      registerRebaseConflictCommands({
        services: undefined,
        mergeView: undefined,
      } as unknown as ICommandContext);
    });

    after(() => {
      (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = original;
    });

    for (const id of DEAD_MERGE_COMMANDS) {
      it(`does not register ${id}`, () => {
        assert.ok(
          !registered.includes(id),
          `${id} is a dead no-op — it must no longer be registered`
        );
      });
    }

    it('still registers the real merge commands', () => {
      assert.ok(registered.includes('intellig.merge.openMergeView'));
      assert.ok(registered.includes('intellig.merge.markResolved'));
    });
  });

  describe('package.json contributions', () => {
    const pkg = readPackageJson();
    const commandIds = new Set((pkg.contributes?.commands ?? []).map((c) => c.command));
    const keybindingIds = new Set((pkg.contributes?.keybindings ?? []).map((k) => k.command));

    for (const id of DEAD_MERGE_COMMANDS) {
      it(`declares no command entry for ${id}`, () => {
        assert.ok(!commandIds.has(id), `${id} must be removed from contributes.commands`);
      });

      it(`declares no keybinding for ${id}`, () => {
        assert.ok(!keybindingIds.has(id), `${id} must be removed from contributes.keybindings`);
      });
    }
  });
});
