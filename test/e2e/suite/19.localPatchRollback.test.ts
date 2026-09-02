/**
 * Tier-2 E2E — single-repo local-change commands:
 * `intellig.patch.createFromLocal` (clipboard target) and
 * `intellig.rollbackChanges`.
 *
 * Both run git directly against the resolved repo. Assert real effects: the
 * generated patch text on the clipboard, and the working tree reverted to its
 * committed state.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';

describe('e2e — local patch / rollback (real git)', function () {
  this.timeout(30_000);

  let fix: Fixture;
  let stubs: PromptStubs;

  async function setup(): Promise<void> {
    fix = await createFixtureRepo({ commits: 2 });
    await useFixtureWorkspace(fix.rootPath);
  }

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (stubs) {
      stubs.restore();
    }
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  it('intellig.patch.createFromLocal — copies a unified diff of local changes to the clipboard', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'locally modified\n');
    await vscode.env.clipboard.writeText('SENTINEL-NOT-A-PATCH');
    stubs = stubPrompts({
      // The target pick is a multi-select (destinations + Reverse); answer
      // with just the clipboard row checked.
      quickPick: (items) => (items as Array<{ id?: string }>).filter((i) => i.id === 'clipboard'),
    });

    await vscode.commands.executeCommand('intellig.patch.createFromLocal');

    const clip = await vscode.env.clipboard.readText();
    assert.ok(
      clip.includes('file0.txt') && /^(diff --git|---|\+\+\+|@@)/m.test(clip),
      `clipboard should hold a unified diff of the local change; got "${clip.slice(0, 120)}". ` +
        `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.patch.createFromLocal — Reverse pick produces a -R diff that undoes the change', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'locally modified\n');
    await vscode.env.clipboard.writeText('SENTINEL-NOT-A-PATCH');
    stubs = stubPrompts({
      quickPick: (items) =>
        (items as Array<{ id?: string }>).filter((i) => i.id === 'clipboard' || i.id === 'reverse'),
    });

    await vscode.commands.executeCommand('intellig.patch.createFromLocal');

    const clip = await vscode.env.clipboard.readText();
    // A reverse diff removes the local line and restores the committed one.
    assert.ok(
      /^-locally modified$/m.test(clip) && /^\+content-0$/m.test(clip),
      `clipboard should hold the REVERSE diff; got "${clip.slice(0, 200)}". ` +
        `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
    // And applying it (git apply) undoes the local modification.
    const patchPath = path.join(fix.rootPath, '..', 'reverse.patch');
    fs.writeFileSync(patchPath, clip);
    await execGit(fix.rootPath, ['apply', patchPath]);
    assert.strictEqual(
      fs.readFileSync(path.join(fix.rootPath, 'file0.txt'), 'utf8'),
      'content-0\n',
      'applying the reverse patch must restore the committed content'
    );
  });

  it('intellig.patch.createFromLocal — refuses an options-only pick (no destination)', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'locally modified\n');
    await vscode.env.clipboard.writeText('SENTINEL-NOT-A-PATCH');
    stubs = stubPrompts({
      quickPick: (items) => (items as Array<{ id?: string }>).filter((i) => i.id === 'reverse'),
    });

    await vscode.commands.executeCommand('intellig.patch.createFromLocal');

    assert.ok(
      stubs.informationMessageCalls.some((c) =>
        String(c.message).includes('at least one destination')
      ),
      `expected the destination refusal toast; info=${JSON.stringify(stubs.informationMessageCalls)}`
    );
    assert.strictEqual(
      await vscode.env.clipboard.readText(),
      'SENTINEL-NOT-A-PATCH',
      'no patch must be produced without a destination'
    );
  });

  it('intellig.rollbackChanges — reverts the selected file to its committed state', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'locally modified\n');
    // Precondition: the working tree is dirty.
    const dirty = (
      await execGit(fix.rootPath, ['status', '--porcelain', 'file0.txt'])
    ).stdout.trim();
    assert.ok(dirty.length > 0, 'precondition: file0.txt should be modified');
    stubs = stubPrompts({ warningMessage: () => 'Rollback' });

    await vscode.commands.executeCommand('intellig.rollbackChanges', [
      { path: 'file0.txt', status: 'modified' },
    ]);

    const clean = (
      await execGit(fix.rootPath, ['status', '--porcelain', 'file0.txt'])
    ).stdout.trim();
    assert.strictEqual(
      clean,
      '',
      `file0.txt should be reverted (clean status); err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
    assert.strictEqual(
      fs.readFileSync(path.join(fix.rootPath, 'file0.txt'), 'utf8'),
      'content-0\n',
      'file content should match the committed version'
    );
  });

  it('intellig.rollbackChanges — an empty selection refuses rather than reverting the tree', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'locally modified 0\n');
    fs.writeFileSync(path.join(fix.rootPath, 'file1.txt'), 'locally modified 1\n');
    const dirtyBefore = (await execGit(fix.rootPath, ['status', '--porcelain'])).stdout.trim();
    assert.ok(dirtyBefore.length > 0, 'precondition: the working tree must be dirty');

    // An empty arg array narrows to `undefined` (no explicit selection), so
    // the command falls through to its own interactive picker; answering it
    // with zero picks is what "nothing selected" looks like end to end. The
    // destructive confirm must never even be reached.
    let quickPickShown = false;
    stubs = stubPrompts({
      quickPick: (): unknown[] => {
        quickPickShown = true;
        return [];
      },
      warningMessage: () => 'Rollback',
    });

    await vscode.commands.executeCommand('intellig.rollbackChanges', []);

    assert.ok(
      quickPickShown,
      'an empty selection must fall through to the interactive file picker, not act silently'
    );
    assert.strictEqual(
      stubs.warningMessageCalls.length,
      0,
      'the destructive rollback confirm must never be reached when nothing was picked'
    );

    const dirtyAfter = (await execGit(fix.rootPath, ['status', '--porcelain'])).stdout.trim();
    assert.strictEqual(
      dirtyAfter,
      dirtyBefore,
      'nothing selected must leave the working tree fully untouched, not reverted'
    );
    assert.strictEqual(
      fs.readFileSync(path.join(fix.rootPath, 'file0.txt'), 'utf8'),
      'locally modified 0\n'
    );
    assert.strictEqual(
      fs.readFileSync(path.join(fix.rootPath, 'file1.txt'), 'utf8'),
      'locally modified 1\n'
    );
  });
});
