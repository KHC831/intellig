/**
 * Tier-2 E2E — clicking a Local Changes row fills the Commit window's inline
 * diff preview, for a fully-staged tracked file exactly as it does for an
 * unstaged one.
 *
 * Regression guard: a user reported that clicking one modified file showed
 * its diff below, but clicking another (same kind of row — ordinary modified,
 * tracked) showed none. Path depth turned out not to be the axis: the file
 * that came up blank was fully STAGED (`git add`, no further working-tree
 * edit), so `git diff` (unstaged) against it is empty even though the file
 * genuinely differs from HEAD. `_handleSelectFile` always requested the
 * unstaged diff regardless of the row's own staged flag — this fixture keeps
 * a staged ROOT file next to an unstaged NESTED one so a depth-based "fix"
 * cannot pass it by accident.
 *
 * Drives the exact production path a real click posts —
 * `{ type: 'selectFile', path }` into `_handleWebviewMessage` — against a
 * real git fixture, so a wiring bug reachable only through the real
 * `git diff` process (as opposed to a mocked `getDiff`) shows up here.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';
import { getCommitToolWindow } from '../support/activatedExtension';
import { injectRecordingView, pollUntil } from '../support/ctwLiveHarness';

interface IRecordedDiffPreview {
  type?: string;
  path?: string;
  diff?: { hunks?: unknown[] };
  error?: string;
}

interface ICommitToolWindowTestSurface {
  _handleWebviewMessage: (message: unknown) => Promise<void>;
  _reloadState: () => Promise<void>;
}

describe('e2e — Commit window Local Changes diff preview', function () {
  this.timeout(20_000);

  let fix: Fixture;

  afterEach(async () => {
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  it('fills the diff preview for a fully-staged root file, same as an unstaged nested one', async () => {
    fix = await createFixtureRepo({ commits: 1 });

    const readmePath = path.join(fix.rootPath, 'README');
    fs.writeFileSync(readmePath, 'hello\n');
    const nestedDir = path.join(fix.rootPath, 'src', 'main', 'java');
    fs.mkdirSync(nestedDir, { recursive: true });
    const nestedFile = path.join(nestedDir, 'Service.java');
    fs.writeFileSync(nestedFile, 'class Service {}\n');
    await execGit(fix.rootPath, ['add', 'README', 'src/main/java/Service.java']);
    await execGit(fix.rootPath, ['commit', '-m', 'add README and nested Service.java']);

    // README: modified AND staged — the index already carries the change, and
    // nothing further changed in the working tree ("M " porcelain status).
    fs.writeFileSync(readmePath, 'hello world\n');
    await execGit(fix.rootPath, ['add', 'README']);

    // Service.java: modified, left unstaged (" M" porcelain status) — the
    // control that already worked before this fix.
    fs.writeFileSync(nestedFile, 'class Service { void x() {} }\n');

    await useFixtureWorkspace(fix.rootPath);

    const ctw = getCommitToolWindow();
    assert.ok(ctw, 'commit tool window singleton not initialised');
    const rec = injectRecordingView(ctw);
    const surface = ctw as unknown as ICommitToolWindowTestSurface;

    try {
      // A real click only fires once the webview has resolved and loaded its
      // changelist state (which carries each file's `staged` flag); this
      // Electron host never opens the CTW panel, so load it explicitly.
      await surface._reloadState();

      const previewFor = async (filePath: string): Promise<IRecordedDiffPreview> => {
        const before = rec.posted.length;
        await surface._handleWebviewMessage({ type: 'selectFile', path: filePath });
        await pollUntil(
          () => rec.posted.slice(before).some((p) => p.type === 'updateDiffPreview'),
          8_000,
          `no updateDiffPreview posted for ${filePath}`
        );
        return rec.posted
          .slice(before)
          .find((p) => p.type === 'updateDiffPreview') as unknown as IRecordedDiffPreview;
      };

      const nestedPreview = await previewFor('src/main/java/Service.java');
      assert.strictEqual(
        nestedPreview.error,
        undefined,
        'unstaged nested file diff must not error'
      );
      assert.ok(
        nestedPreview.diff?.hunks && nestedPreview.diff.hunks.length > 0,
        `unstaged nested file diff should carry at least one hunk; got: ${JSON.stringify(nestedPreview)}`
      );

      const readmePreview = await previewFor('README');
      assert.strictEqual(readmePreview.error, undefined, 'staged root file diff must not error');
      assert.ok(
        readmePreview.diff?.hunks && readmePreview.diff.hunks.length > 0,
        `staged root file diff should carry at least one hunk, same as the unstaged nested file; got: ${JSON.stringify(readmePreview)}`
      );
    } finally {
      rec.restore();
    }
  });
});
