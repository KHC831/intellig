/**
 * Unit tests for T1-07 Log commit right-click menu parity.
 *
 * Verifies:
 *  - Every command referenced by `view/item/context` with
 *    `viewItem == intellig.logCommit` is also declared as a
 *    `contributes.commands` entry with a user-visible title.
 *  - All T1-07 titles use the unicode ellipsis (U+2026), never
 *    three ASCII dots.
 *  - The menu ordering matches the Cluster B design (group labels
 *    `1_copy@1`, `2_create@1`, ... , `9_patch@1`).
 *  - The T1-07 `validateBranchName` helper accepts reasonable
 *    names and rejects empty / invalid-char inputs.
 *
 * No extension activation required — these are pure package.json
 * and helper-function assertions.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { validateBranchName } from '../../../extension';

interface IPackageJsonCommand {
  command: string;
  title?: string;
  category?: string;
}

interface IPackageJsonMenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

interface IPackageJson {
  contributes: {
    commands: IPackageJsonCommand[];
    menus: {
      'view/item/context': IPackageJsonMenuEntry[];
    };
  };
}

function loadPackageJson(): IPackageJson {
  const pkgPath = path.resolve(__dirname, '../../../../package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  return JSON.parse(raw) as IPackageJson;
}

describe('T1-07 Log commit menu parity', () => {
  let pkg: IPackageJson;
  let commandsById: Map<string, IPackageJsonCommand>;
  let logCommitMenu: IPackageJsonMenuEntry[];

  before(() => {
    pkg = loadPackageJson();
    commandsById = new Map();
    for (const c of pkg.contributes.commands) {
      commandsById.set(c.command, c);
    }
    logCommitMenu = pkg.contributes.menus['view/item/context'].filter(
      (m) => m.when === 'viewItem == intellig.logCommit'
    );
  });

  describe('command registration', () => {
    const expected: { id: string; title: string }[] = [
      { id: 'intellig.commit.copyHash', title: 'Copy Revision Number' },
      { id: 'intellig.commit.newBranch', title: 'New Branch…' },
      { id: 'intellig.commit.newTag', title: 'New Tag…' },
      { id: 'intellig.commit.checkoutRevision', title: 'Checkout Revision' },
      { id: 'intellig.commit.resetToHere', title: 'Reset Current Branch to Here…' },
      { id: 'intellig.commit.revert', title: 'Revert Commit…' },
      { id: 'intellig.commit.cherryPick', title: 'Cherry-Pick' },
      { id: 'intellig.commit.showDiff', title: 'Show Diff' },
      { id: 'intellig.commit.compareWithHead', title: 'Compare with HEAD' },
      { id: 'intellig.commit.compareWith', title: 'Compare with…' },
      { id: 'intellig.commit.showFileInRevision', title: 'Show File in Revision' },
      { id: 'intellig.commit.fileHistoryFromHere', title: 'File History from Here' },
      { id: 'intellig.rebase.interactiveFromHere', title: 'Interactively Rebase from Here…' },
      { id: 'intellig.commit.createPatch', title: 'Create Patch…' },
    ];

    for (const { id, title } of expected) {
      it(`declares ${id} with title "${title}"`, () => {
        const cmd = commandsById.get(id);
        assert.ok(cmd, `${id} must appear in contributes.commands`);
        assert.strictEqual(cmd!.title, title, `${id} title must match IntelliJ label`);
      });
    }

    it('category is "IntelliG" for every T1-07 command', () => {
      for (const { id } of expected) {
        const cmd = commandsById.get(id);
        assert.strictEqual(cmd!.category, 'IntelliG', `${id} must be in IntelliG category`);
      }
    });
  });

  describe('title format — unicode ellipsis only', () => {
    const newTitles = [
      'New Branch…',
      'New Tag…',
      'Reset Current Branch to Here…',
      'Compare with…',
      'Interactively Rebase from Here…',
      'Create Patch…',
    ];

    for (const title of newTitles) {
      it(`"${title}" uses U+2026 (…), not three ASCII dots`, () => {
        assert.ok(title.includes('…'), `${title} contains U+2026`);
        assert.ok(!title.includes('...'), `${title} must not contain three ASCII dots`);
      });
    }

    it('no T1-07 command title contains three ASCII dots', () => {
      const t107Ids = new Set([
        'intellig.commit.copyHash',
        'intellig.commit.newBranch',
        'intellig.commit.newTag',
        'intellig.commit.checkoutRevision',
        'intellig.commit.resetToHere',
        'intellig.commit.revert',
        'intellig.commit.cherryPick',
        'intellig.commit.showDiff',
        'intellig.commit.compareWithHead',
        'intellig.commit.compareWith',
        'intellig.commit.showFileInRevision',
        'intellig.commit.fileHistoryFromHere',
        'intellig.rebase.interactiveFromHere',
        'intellig.commit.createPatch',
      ]);
      for (const cmd of pkg.contributes.commands) {
        if (!t107Ids.has(cmd.command)) continue;
        assert.ok(
          !cmd.title?.includes('...'),
          `${cmd.command}: title "${cmd.title}" must use U+2026, not ASCII ...`
        );
      }
    });
  });

  describe('view/item/context menu wiring', () => {
    it('every T1-07 log-commit menu entry references a registered command', () => {
      for (const entry of logCommitMenu) {
        assert.ok(entry.command, 'entry must have a command');
        assert.ok(
          commandsById.has(entry.command!),
          `${entry.command} must be registered in contributes.commands`
        );
      }
    });

    it('menu contains all 19 log-commit entries (T1-07 + T2-05 + T2-04 + T3-09)', () => {
      // T1-07 shipped 14 entries. T2-05 added 3 (cherryPickWithoutCommit,
      // applySelectedChanges, applyFilesToBranch). T2-04 added 1
      // (dropSelectedChanges). T3-09 added 1 (openOnHost at 10_external@1).
      // Groups: 1_copy (1) + 2_create (2) + 3_checkout (1) + 4_reset (1)
      // + 5_modify (6) + 6_view (3) + 7_files (2) + 8_rebase (1) + 9_patch (1)
      // + 10_external (1) = 19
      assert.strictEqual(logCommitMenu.length, 19, 'exactly 19 log-commit entries');
    });

    const expectedGroups: { command: string; group: string }[] = [
      { command: 'intellig.commit.copyHash', group: '1_copy@1' },
      { command: 'intellig.commit.newBranch', group: '2_create@1' },
      { command: 'intellig.commit.newTag', group: '2_create@2' },
      { command: 'intellig.commit.checkoutRevision', group: '3_checkout@1' },
      { command: 'intellig.commit.resetToHere', group: '4_reset@1' },
      { command: 'intellig.commit.revert', group: '5_modify@1' },
      { command: 'intellig.commit.cherryPick', group: '5_modify@2' },
      // T2-05 additions:
      { command: 'intellig.commit.cherryPickWithoutCommit', group: '5_modify@3' },
      { command: 'intellig.commit.applySelectedChanges', group: '5_modify@4' },
      { command: 'intellig.commit.applyFilesToBranch', group: '5_modify@5' },
      { command: 'intellig.commit.dropSelectedChanges', group: '5_modify@6' },
      { command: 'intellig.commit.showDiff', group: '6_view@1' },
      { command: 'intellig.commit.compareWithHead', group: '6_view@2' },
      { command: 'intellig.commit.compareWith', group: '6_view@3' },
      { command: 'intellig.commit.showFileInRevision', group: '7_files@1' },
      { command: 'intellig.commit.fileHistoryFromHere', group: '7_files@2' },
      { command: 'intellig.rebase.interactiveFromHere', group: '8_rebase@1' },
      { command: 'intellig.commit.createPatch', group: '9_patch@1' },
      // T3-09 addition:
      { command: 'intellig.commit.openOnHost', group: '10_external@1' },
    ];

    for (const { command, group } of expectedGroups) {
      it(`${command} is placed in group ${group}`, () => {
        const entry = logCommitMenu.find((m) => m.command === command);
        assert.ok(entry, `${command} must be in the log-commit menu`);
        assert.strictEqual(entry!.group, group);
      });
    }

    it('numeric prefix groups sort strictly ascending (1_copy < 2_create < ...)', () => {
      const groupPrefixes = logCommitMenu
        .map((m) => m.group)
        .filter((g): g is string => typeof g === 'string')
        .map((g) => {
          const m = g.match(/^(\d+)_/);
          return m ? Number(m[1]) : -1;
        });
      // Every entry should have a numbered prefix. T3-09 extended the
      // range to 10 (10_external@1 for Open on Host).
      for (const n of groupPrefixes) {
        assert.ok(n >= 1 && n <= 10, 'group prefix in range 1..10');
      }
      // Groups themselves should appear in order (order in package.json
      // mirrors the design doc §T1-07).
      for (let i = 1; i < groupPrefixes.length; i++) {
        assert.ok(
          groupPrefixes[i] >= groupPrefixes[i - 1],
          `group order must be monotonically non-decreasing at index ${i}`
        );
      }
    });
  });

  describe('validateBranchName helper', () => {
    it('accepts a typical branch name', () => {
      assert.strictEqual(validateBranchName('feature/my-branch'), undefined);
    });

    it('accepts dotted names (e.g., release.v1.2)', () => {
      assert.strictEqual(validateBranchName('release.v1.2'), undefined);
    });

    it('accepts underscores and hyphens', () => {
      assert.strictEqual(validateBranchName('wip_for_fun-2'), undefined);
    });

    it('rejects empty string', () => {
      const err = validateBranchName('');
      assert.ok(err && err.includes('empty'));
    });

    it('rejects whitespace-only', () => {
      const err = validateBranchName('   ');
      assert.ok(err && err.includes('empty'));
    });

    it('rejects names with spaces', () => {
      const err = validateBranchName('my branch');
      assert.ok(err && err.includes('invalid'));
    });

    it('rejects names with forbidden characters', () => {
      const err = validateBranchName('weird~name');
      assert.ok(err && err.includes('invalid'));
    });
  });
});
