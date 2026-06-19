/**
 * Tier-2 E2E — editor / command-palette Git commands that derive their git
 * pathspec from the ACTIVE EDITOR (`intellig.stageSelected`,
 * `intellig.unstageSelected`, `intellig.revertFile`, `intellig.showHistory`,
 * `intellig.editor.showLineHistory`, `intellig.editor.copyCommitHash`,
 * `intellig.editor.showCommit`).
 *
 * Same latent defect the explorer suite (13) caught, in seven sibling
 * handlers the explorer fix never propagated to: each derived the git path
 * with `vscode.workspace.asRelativePath(activeEditor.document.uri)` — a
 * WORKSPACE-FOLDER-relative path. The git ops run with `cwd =
 * repo.rootUri.fsPath`, so they need a REPO-root-relative path; in a nested
 * repo / submodule (or a multi-root workspace where the folder name prefixes
 * every path) the workspace-relative path is wrong:
 *   - mutating ops (`stage`/`unstage`/`revertFile`) hit `git <op> -- <folder>/<file>`
 *     → "pathspec did not match any files" → the index/working tree is untouched;
 *   - read ops (`showHistory`/`showLineHistory`/`copyCommitHash`/`showCommit`)
 *     resolve an empty `git log`/`git blame` for the bogus path → a false
 *     "no history" / "not committed yet" with no picker or clipboard write.
 *
 * Unlike the explorer commands (which receive a `vscode.Uri` argument), these
 * read `vscode.window.activeTextEditor`, so each test OPENS the fixture file in
 * an editor first, then invokes the command with no argument — exactly the
 * palette / editor-context-menu invocation. Assertions check REAL GIT STATE
 * (`git status --porcelain`, the git4idea `assertStatus` discipline) for the
 * mutating ops and the real history/blame/commit resolution for the read ops.
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

const HEX40 = /^[0-9a-f]{40}$/;

describe('e2e — editor/palette commands (nested repo, real git state)', function () {
  this.timeout(20_000);

  let fix: Fixture;
  let uriFor: (rel: string) => vscode.Uri;
  let stubs: PromptStubs;
  let restoreTabbedConfig: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (restoreTabbedConfig) {
      await restoreTabbedConfig();
      restoreTabbedConfig = undefined;
    }
    if (stubs) {
      stubs.restore();
    }
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  async function setup(opts: Parameters<typeof setupNestedFixture>[0] = {}): Promise<void> {
    const nested = await setupNestedFixture(opts);
    fix = nested.fix;
    uriFor = nested.uriFor;
  }

  /**
   * Open `rel` in a real text editor and confirm it became the active editor —
   * the precondition for every command under test (they read
   * `vscode.window.activeTextEditor`). The cursor stays at line 0, so the
   * blame commands resolve line 1 (the file's first, committed line).
   */
  async function openInEditor(rel: string): Promise<void> {
    const uri = uriFor(rel);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      uri.fsPath,
      'precondition: the fixture file must be the active editor'
    );
  }

  /**
   * Force the legacy single-panel Show History route (QuickPick) by opting out
   * of the tabbed Git tool window for the duration of one test. The tabbed
   * route (the default) hands the path to `loadFileHistory` on the provider
   * webview, which has no observable QuickPick to assert on; the legacy route
   * calls `getFileHistory` directly and shows the picker, so a correct vs.
   * empty history is directly observable.
   */
  async function disableTabbedToolWindow(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('intellig');
    await cfg.update('useTabbedGitToolWindow', false, vscode.ConfigurationTarget.Global);
    restoreTabbedConfig = async () => {
      await vscode.workspace
        .getConfiguration('intellig')
        .update('useTabbedGitToolWindow', undefined, vscode.ConfigurationTarget.Global);
    };
  }

  // ── Mutating ops — assert real index / working-tree state ────────────────

  it('intellig.stageSelected — stages the active editor file (repo-relative path)', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'modified\n');
    await openInEditor('file0.txt');
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.stageSelected');

    await assertStaged(fix.rootPath, 'file0.txt');
  });

  it('intellig.unstageSelected — unstages the active editor file (repo-relative path)', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'modified\n');
    await execGit(fix.rootPath, ['add', 'file0.txt']);
    await assertStaged(fix.rootPath, 'file0.txt'); // precondition
    await openInEditor('file0.txt');
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.unstageSelected');

    await assertUnstaged(fix.rootPath, 'file0.txt');
  });

  it('intellig.revertFile — discards the working-tree change after confirmation', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'modified\n');
    await openInEditor('file0.txt');
    stubs = stubPrompts({ warningMessage: () => 'Revert' });

    await vscode.commands.executeCommand('intellig.revertFile');

    await assertReverted(fix.rootPath, 'file0.txt');
  });

  it('intellig.revertFile — leaves the file dirty when the user cancels', async () => {
    await setup();
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'modified\n');
    await openInEditor('file0.txt');
    stubs = stubPrompts({ warningMessage: () => undefined }); // user dismisses confirm

    await vscode.commands.executeCommand('intellig.revertFile');

    await assertUnstaged(fix.rootPath, 'file0.txt'); // still dirty
  });

  // ── Read ops — assert the correct history/blame/commit resolves ──────────

  it('intellig.showHistory — finds the file history and offers the picker', async () => {
    await setup();
    await disableTabbedToolWindow();
    await openInEditor('file0.txt');
    stubs = stubPrompts({ quickPick: () => undefined }); // open picker, pick nothing

    await vscode.commands.executeCommand('intellig.showHistory');

    // A correct repo-relative path makes `git log -- file0.txt` return the seed
    // commit and the picker is shown. The buggy workspace-relative path yields
    // an empty log and a "No history found" info toast instead.
    assert.strictEqual(
      stubs.quickPickCalls.length,
      1,
      `history picker should be shown once; info toasts=${JSON.stringify(
        stubs.informationMessageCalls.map((c) => c.message)
      )} err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.editor.showLineHistory — resolves the line blame and shows the picker', async () => {
    await setup();
    await openInEditor('file0.txt');
    stubs = stubPrompts({ quickPick: () => undefined });

    await vscode.commands.executeCommand('intellig.editor.showLineHistory');

    // Correct path → `git blame file0.txt` resolves the committed line → file
    // history picker. Buggy path → blame fails / "not committed yet" → no picker.
    assert.strictEqual(
      stubs.quickPickCalls.length,
      1,
      `line-history picker should be shown once; info=${JSON.stringify(
        stubs.informationMessageCalls.map((c) => c.message)
      )} err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.editor.copyCommitHash — copies the blamed commit hash to the clipboard', async () => {
    await setup();
    await openInEditor('file0.txt');
    // Poison the clipboard so a no-op handler is distinguishable from success.
    await vscode.env.clipboard.writeText('SENTINEL-NOT-A-HASH');
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.editor.copyCommitHash');

    const copied = await vscode.env.clipboard.readText();
    assert.ok(
      HEX40.test(copied),
      `clipboard should hold the 40-char blamed commit hash; got "${copied}". info=${JSON.stringify(
        stubs.informationMessageCalls.map((c) => c.message)
      )} err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.editor.showCommit — resolves the blamed commit and shows the picker', async () => {
    await setup();
    await openInEditor('file0.txt');
    stubs = stubPrompts({ quickPick: () => undefined });

    await vscode.commands.executeCommand('intellig.editor.showCommit');

    // Correct path → blame resolves a real commit → getCommit + getCommitDiff →
    // the details picker. Buggy path → blame fails → no picker.
    assert.strictEqual(
      stubs.quickPickCalls.length,
      1,
      `commit picker should be shown once; info=${JSON.stringify(
        stubs.informationMessageCalls.map((c) => c.message)
      )} err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });
});
