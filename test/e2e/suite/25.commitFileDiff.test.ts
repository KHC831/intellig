/**
 * Tier-2 E2E — double-clicking a changed file in the Git tool window opens the
 * diff DIRECTLY, with no intermediate "Choose Repository" quick pick.
 *
 * Regression guard for the bug the user kept hitting: in a multi-repo
 * workspace, double-clicking a file in a commit's "Changed files" list popped a
 * repository selector quick pick from the top of the window — an unwanted extra
 * click before the diff appeared. The handler used to fall back to the
 * interactive `resolveRepo`; the fix (commit 4eac85d) routes through
 * `resolveRepoForCommitDiff`, which resolves the repo that actually CONTAINS the
 * commit non-interactively and encodes that root into the `intellig-git:` diff
 * URIs.
 *
 * This test drives the EXACT production path a real double-click triggers —
 * the webview posts `{ type: 'doubleClickFile', commitHash, path }`, which the
 * provider feeds to `_handleMessage` → `onDidRequestCommitDiff` → the
 * registerViews listener → `vscode.diff`. It runs in a genuine TWO-repo
 * workspace (the multi-repo shape that produced the picker) and asserts:
 *   1. a diff editor tab opens,
 *   2. NO quick pick is shown (a recorded `showQuickPick` call IS the bug),
 *   3. the diff resolves the file against the repo that owns the commit
 *      (left = parent content, right = commit content), and
 *   4. no error toast is surfaced.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace } from '../support/workspaceHelper';
import { setupNestedFixture } from '../support/nestedFixture';
import { getServices, getGitToolWindowProvider } from '../support/activatedExtension';

/** Count the currently-open diff editor tabs. */
function diffTabCount(): number {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputTextDiff).length;
}

/** Poll `predicate` until it is true or the deadline elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Resolve both panes of the most-recently-opened diff tab through the content
 * provider. `vscode.diff` opens the tab regardless of whether the provider can
 * resolve the revisions, so reading the panes is the assertion that actually
 * proves the diff is real (and points at the right repo).
 */
async function readLatestDiff(): Promise<{ original: string; modified: string }> {
  const diffTabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputTextDiff);
  assert.ok(diffTabs.length > 0, 'expected a diff tab to be open');
  const input = diffTabs[diffTabs.length - 1].input as vscode.TabInputTextDiff;
  const [original, modified] = await Promise.all([
    vscode.workspace.openTextDocument(input.original).then((d) => d.getText()),
    vscode.workspace.openTextDocument(input.modified).then((d) => d.getText()),
  ]);
  return { original, modified };
}

describe('e2e — commit changed-file double-click opens the diff directly (no repo picker)', function () {
  this.timeout(25_000);

  let repoA: Fixture;
  let repoB: Fixture;
  let stubs: PromptStubs;

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (stubs) {
      stubs.restore();
    }
    await clearWorkspace();
    if (repoA) {
      await repoA.cleanup();
    }
    if (repoB) {
      await repoB.cleanup();
    }
  });

  /**
   * Build a second fixture repo and register it with the GitService WITHOUT
   * clearing the first (so two repos are live at once — the multi-repo shape).
   * Relocated under the sentinel folder so it is a real, discoverable repo.
   */
  async function registerSecondRepo(): Promise<Fixture> {
    const sentinel = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(sentinel, 'launcher sentinel workspace folder must exist');
    const built = await createFixtureRepo({ commits: 2 });
    const builtBase = path.dirname(built.rootPath);
    const destBase = path.join(sentinel, path.basename(builtBase));
    fs.renameSync(builtBase, destBase);
    const rootPath = path.join(destBase, 'repo');
    const fix: Fixture = {
      ...built,
      rootPath,
      cleanup: async () => {
        try {
          fs.rmSync(destBase, { recursive: true, force: true, maxRetries: 3 });
        } catch {
          /* best-effort */
        }
        await built.cleanup();
      },
    };
    const services = getServices();
    assert.ok(services, 'ExtensionServices must be initialised');
    const repo = await services.gitService.getRepository(vscode.Uri.file(rootPath));
    assert.ok(repo, `second repo must be discovered at ${rootPath}`);
    return fix;
  }

  it('opens the diff immediately for a commit file — no "Choose Repository" prompt', async () => {
    // Two live repos. Build repoA via the shared nested-fixture builder (it
    // registers repoA + sets the workspace), then add repoB alongside it so the
    // GitService knows about BOTH — the multi-repo shape that produced the
    // picker.
    const nested = await setupNestedFixture({ commits: 2 });
    repoA = nested.fix;
    repoB = await registerSecondRepo();

    // Give repoB's HEAD commit a real modification to file0.txt so the diff has
    // content on BOTH sides (parent = "content-0", commit = "modified-0").
    fs.writeFileSync(path.join(repoB.rootPath, 'file0.txt'), 'modified-0\n');
    await execGit(repoB.rootPath, ['add', 'file0.txt']);
    await execGit(repoB.rootPath, ['commit', '-m', 'modify file0 in repoB']);
    const headB = (await execGit(repoB.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    // A quick pick here would be the bug: record (and dismiss) any that appears.
    stubs = stubPrompts({ quickPick: () => undefined });

    const provider = getGitToolWindowProvider();
    assert.ok(provider, 'git tool window provider must be activated');

    const before = diffTabCount();

    // Drive the exact message a real changed-file double-click posts.
    (provider as unknown as { _handleMessage: (m: unknown) => void })._handleMessage({
      type: 'doubleClickFile',
      commitHash: headB,
      path: 'file0.txt',
    });

    await waitFor(() => diffTabCount() > before);

    // 1. A diff tab opened.
    assert.ok(diffTabCount() > before, 'double-click must open a diff editor tab');

    // 2. NO repository picker — the diff must open directly. This is the core
    //    regression: the old interactive `resolveRepo` fallback prompted here.
    assert.strictEqual(
      stubs.quickPickCalls.length,
      0,
      'double-click must open the diff directly — no "Choose Repository" quick pick should appear'
    );

    // 3. The diff resolved against the repo that OWNS the commit (repoB), with
    //    the correct parent/commit content on each side.
    const { original, modified } = await readLatestDiff();
    assert.ok(
      original.includes('content-0'),
      `left (parent) pane should show repoB's pre-edit content; got: ${JSON.stringify(original)}`
    );
    assert.ok(
      modified.includes('modified-0'),
      `right (commit) pane should show repoB's committed content; got: ${JSON.stringify(modified)}`
    );

    // 4. No error toast.
    assert.deepStrictEqual(
      stubs.errorMessageCalls.map((c) => c.message),
      [],
      'opening the diff must not surface an error toast'
    );
  });
});
