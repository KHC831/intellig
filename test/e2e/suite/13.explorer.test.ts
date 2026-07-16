/**
 * Tier-2 E2E — file-explorer context-menu Git commands (`intellig.explorer.*`).
 *
 * These commands shipped with ZERO real-git coverage and a latent defect: the
 * handlers derived the git path with `vscode.workspace.asRelativePath(fileUri)`,
 * which returns a path relative to the WORKSPACE FOLDER — prefixed with the
 * folder name in a multi-root workspace, and wrong entirely when the repo root
 * differs from the workspace folder (a nested repo / submodule). The git ops
 * run with `cwd = repo.rootUri.fsPath`, so they need a REPO-root-relative path;
 * the workspace-relative path makes `git add -- <folder>/<file>` fail with
 * "pathspec did not match any files" and the file is never staged.
 *
 * To reproduce that faithfully these tests create the fixture repo INSIDE the
 * launcher's sentinel workspace folder (a nested repo whose root differs from
 * the workspace-folder root — exactly the intellij-community / submodule
 * shape). `asRelativePath` then yields a multi-segment path that is NOT
 * repo-root-relative, which is precisely what tripped the handlers. Each test
 * invokes the command with the real `vscode.Uri` argument the context menu
 * passes and asserts REAL GIT STATE via `git status --porcelain` (the
 * git4idea `assertStatus` discipline), not mock interactions.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, execGit } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace } from '../support/workspaceHelper';
import { assertStaged, assertUnstaged, assertReverted } from '../support/gitStatusAssertions';
import { setupNestedFixture } from '../support/nestedFixture';

/** Count the currently-open diff editor tabs. */
function diffTabCount(): number {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputTextDiff).length;
}

/**
 * Read the LEFT (original) pane content of the most-recently-opened diff tab by
 * resolving its `intellig-git:` URI through the content provider. This is the
 * assertion that actually catches a broken provider: `vscode.diff` opens the
 * tab regardless of whether the provider can resolve the revision, and a
 * provider failure lands in the editor pane — never in `showErrorMessage` — so
 * `diffTabCount` alone is fault-blind.
 */
async function readLatestDiffOriginal(): Promise<string> {
  const diffTabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputTextDiff);
  assert.ok(diffTabs.length > 0, 'expected a diff tab to be open');
  const input = diffTabs[diffTabs.length - 1].input as vscode.TabInputTextDiff;
  const doc = await vscode.workspace.openTextDocument(input.original);
  return doc.getText();
}

describe('e2e — explorer context-menu commands (nested repo, real git state)', function () {
  this.timeout(20_000);

  let fix: Fixture;
  let stubs: PromptStubs;

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

  /**
   * Build the nested-repo fixture (root differs from the workspace folder —
   * the shape that makes `asRelativePath(fileUri)` return a path that is NOT
   * repo-root-relative) via the shared {@link setupNestedFixture} builder.
   */
  async function setup(opts: Parameters<typeof setupNestedFixture>[0] = {}): Promise<void> {
    const nested = await setupNestedFixture(opts);
    fix = nested.fix;
  }

  function uriFor(rel: string): vscode.Uri {
    return vscode.Uri.file(path.join(fix.rootPath, rel));
  }

  it('intellig.explorer.stage — stages the working-tree change (repo-relative path)', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'modified\n');
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.explorer.stage', uriFor('file0.txt'));

    await assertStaged(fix.rootPath, 'file0.txt');
  });

  it('intellig.explorer.unstage — resets the staged change back to the working tree', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'modified\n');
    await execGit(fix.rootPath, ['add', 'file0.txt']);
    await assertStaged(fix.rootPath, 'file0.txt'); // precondition
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.explorer.unstage', uriFor('file0.txt'));

    await assertUnstaged(fix.rootPath, 'file0.txt');
  });

  it('intellig.explorer.revert — discards the working-tree change after confirmation', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'modified\n');
    stubs = stubPrompts({ warningMessage: () => 'Revert' });

    await vscode.commands.executeCommand('intellig.explorer.revert', uriFor('file0.txt'));

    await assertReverted(fix.rootPath, 'file0.txt');
  });

  it('intellig.explorer.revert — leaves the file untouched when the user cancels', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'modified\n');
    stubs = stubPrompts({ warningMessage: () => undefined }); // user dismisses confirm

    await vscode.commands.executeCommand('intellig.explorer.revert', uriFor('file0.txt'));

    // Still dirty — cancel must not revert.
    await assertUnstaged(fix.rootPath, 'file0.txt');
  });

  it('intellig.explorer.addToVcs — stages an untracked file (git add)', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'fresh.txt'), 'brand new\n');
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.explorer.addToVcs', uriFor('fresh.txt'));

    await assertStaged(fix.rootPath, 'fresh.txt');
  });

  it('intellig.explorer.addToGitignore — appends the repo-root-relative pattern', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'fresh.txt'), 'brand new\n');
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.explorer.addToGitignore', uriFor('fresh.txt'));

    const gitignore = fs.readFileSync(path.join(fix.rootPath, '.gitignore'), 'utf8');
    assert.ok(
      gitignore.split('\n').includes('/fresh.txt'),
      `.gitignore should contain "/fresh.txt", got:\n${gitignore}`
    );
  });

  it('intellig.explorer.commitFile — opens the scoped commit dialog without pre-staging', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'modified\n');
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.explorer.commitFile', uriFor('file0.txt'));

    // The Commit Dialog owns staging at commit time (only the checked
    // files) — the command must NOT stage up front, or already-staged
    // bystanders would ride along with the commit.
    await assertUnstaged(fix.rootPath, 'file0.txt');
    assert.deepStrictEqual(
      stubs.errorMessageCalls.map((c) => c.message),
      [],
      'commitFile must not surface an error toast on the happy path'
    );

    // Close the dialog's webview panel so it doesn't leak into later tests.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('intellig.explorer.showHistory — finds commits for the file and offers the picker', async () => {
    await setup();
    // The tabbed tool window (default on) routes history to the History TAB;
    // the picker under test here is the fallback. Opt into it explicitly so
    // the assertion pins the path this test exists for: a correct
    // repo-relative `git log -- file0.txt`.
    const cfg = vscode.workspace.getConfiguration('intellig');
    await cfg.update('useTabbedGitToolWindow', false, vscode.ConfigurationTarget.Global);
    try {
      stubs = stubPrompts({ quickPick: () => undefined }); // open the picker, pick nothing

      await vscode.commands.executeCommand('intellig.explorer.showHistory', uriFor('file0.txt'));

      // With a correct repo-relative path `git log -- file0.txt` returns the
      // seed commit and the history picker is shown. The buggy workspace-relative
      // path yields an empty log and a "No history found" info toast instead.
      assert.strictEqual(
        stubs.quickPickCalls.length,
        1,
        `history picker should be shown once; info toasts=${JSON.stringify(
          stubs.informationMessageCalls.map((c) => c.message)
        )}`
      );
    } finally {
      await cfg.update('useTabbedGitToolWindow', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('intellig.explorer.createPatchFromFile — copies a non-empty patch to the clipboard', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'patch me\n');
    // First quickpick = patch target; choose "Copy to clipboard".
    stubs = stubPrompts({
      quickPick: (items) => (items as Array<{ id: string }>).find((i) => i.id === 'clipboard'),
    });

    await vscode.commands.executeCommand(
      'intellig.explorer.createPatchFromFile',
      uriFor('file0.txt')
    );

    const info = stubs.informationMessageCalls.map((c) => c.message);
    assert.ok(
      info.some((m) => /clipboard/i.test(m)),
      `expected a "copied to clipboard" confirmation; got info=${JSON.stringify(
        info
      )} err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.explorer.showDiff — opens a diff against HEAD without error', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'modified\n');
    stubs = stubPrompts({});

    const before = diffTabCount();
    await vscode.commands.executeCommand('intellig.explorer.showDiff', uriFor('file0.txt'));

    assert.ok(diffTabCount() > before, 'showDiff should open a diff editor tab');
    // The left pane must resolve to the committed HEAD content. If the
    // provider can't find the repo (repo-relative path + ancestor workspace
    // folder), the pane is empty/errored.
    const left = await readLatestDiffOriginal();
    assert.ok(
      left.includes('content-0'),
      `showDiff left pane should show HEAD content; got: ${JSON.stringify(left)}`
    );
    assert.deepStrictEqual(
      stubs.errorMessageCalls.map((c) => c.message),
      [],
      'showDiff must not surface an error toast'
    );
  });

  it('intellig.explorer.compareWithRepoVersion — opens a HEAD diff without error', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'modified\n');
    stubs = stubPrompts({});

    const before = diffTabCount();
    await vscode.commands.executeCommand(
      'intellig.explorer.compareWithRepoVersion',
      uriFor('file0.txt')
    );

    assert.ok(diffTabCount() > before, 'compareWithRepoVersion should open a diff editor tab');
    const left = await readLatestDiffOriginal();
    assert.ok(
      left.includes('content-0'),
      `compareWithRepoVersion left pane should show HEAD content; got: ${JSON.stringify(left)}`
    );
    assert.deepStrictEqual(
      stubs.errorMessageCalls.map((c) => c.message),
      [],
      'compareWithRepoVersion must not surface an error toast'
    );
  });

  it('intellig.explorer.compareWithBranch — opens a diff against the chosen branch', async () => {
    await setup({ branches: [{ name: 'feature', fromCommit: 0 }] });
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'modified\n');
    // Branch picker returns the 'feature' branch entry.
    stubs = stubPrompts({
      quickPick: (items) =>
        (items as Array<{ label: string }>).find((i) => i.label === 'feature') ??
        (items as Array<{ label: string }>)[0],
    });

    const before = diffTabCount();
    await vscode.commands.executeCommand(
      'intellig.explorer.compareWithBranch',
      uriFor('file0.txt')
    );

    assert.strictEqual(stubs.quickPickCalls.length, 1, 'branch picker should be shown');
    assert.ok(diffTabCount() > before, 'compareWithBranch should open a diff editor tab');
    // The 'feature' branch sits at commit 0, where file0.txt is "content-0".
    const left = await readLatestDiffOriginal();
    assert.ok(
      left.includes('content-0'),
      `compareWithBranch left pane should show the branch revision; got: ${JSON.stringify(left)}`
    );
  });
});
