/**
 * Unit tests for the Log commit command set parity.
 *
 * Verifies:
 *  - Every `intellig.commit.*` / `intellig.rebase.interactiveFromHere`
 *    command surfaced by the webview commit-graph overlay is declared as a
 *    `contributes.commands` entry with the correct IntelliJ title.
 *  - All commit-action titles use the unicode ellipsis (U+2026), never
 *    three ASCII dots.
 *  - The `validateBranchName` helper accepts reasonable
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

interface IPackageJson {
  contributes: {
    commands: IPackageJsonCommand[];
  };
}

function loadPackageJson(): IPackageJson {
  const pkgPath = path.resolve(__dirname, '../../../../package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  return JSON.parse(raw) as IPackageJson;
}

describe('Log commit command parity', () => {
  let pkg: IPackageJson;
  let commandsById: Map<string, IPackageJsonCommand>;

  before(() => {
    pkg = loadPackageJson();
    commandsById = new Map();
    for (const c of pkg.contributes.commands) {
      commandsById.set(c.command, c);
    }
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
        assert.strictEqual(cmd.title, title, `${id} title must match IntelliJ label`);
      });
    }

    it('category is "IntelliG" for every log-commit command', () => {
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

    it('no log-commit command title contains three ASCII dots', () => {
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
        if (!t107Ids.has(cmd.command)) {
          continue;
        }
        assert.ok(
          !cmd.title?.includes('...'),
          `${cmd.command}: title "${cmd.title}" must use U+2026, not ASCII ...`
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
