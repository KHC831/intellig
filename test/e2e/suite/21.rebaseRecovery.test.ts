/**
 * Tier-2 E2E — rebase recovery commands `intellig.rebase.abort` and
 * `intellig.rebase.continue`, exercised against a REAL in-progress (conflicted)
 * rebase.
 *
 * Both resolve the repo via resolveRepo and gate on the repository being in the
 * 'rebasing' state, then run git directly. We create a genuine conflict, pause
 * the rebase, reload so the cached repo reports 'rebasing', then assert real git
 * (the rebase metadata is gone afterwards; abort restores the branch tip,
 * continue completes the rebase).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';

describe('e2e — rebase recovery (real in-progress rebase)', function () {
  this.timeout(40_000);

  let fix: Fixture;
  let stubs: PromptStubs;

  const file0 = (): string => path.join(fix.rootPath, 'file0.txt');
  const rebaseInProgress = (): boolean =>
    fs.existsSync(path.join(fix.rootPath, '.git', 'rebase-merge')) ||
    fs.existsSync(path.join(fix.rootPath, '.git', 'rebase-apply'));
  const currentBranch = async (): Promise<string> =>
    (await execGit(fix.rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();

  /** Build a conflicted, paused rebase and reload so the repo reports 'rebasing'. */
  async function startConflictingRebase(): Promise<void> {
    const base = await currentBranch();
    await execGit(fix.rootPath, ['checkout', '-b', 'feature']);
    fs.writeFileSync(file0(), 'feature side\n');
    await execGit(fix.rootPath, ['add', 'file0.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'feature change']);
    await execGit(fix.rootPath, ['checkout', base]);
    fs.writeFileSync(file0(), 'main side\n');
    await execGit(fix.rootPath, ['add', 'file0.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'main change']);
    await execGit(fix.rootPath, ['checkout', 'feature']);
    try {
      await execGit(fix.rootPath, ['rebase', base]); // conflicts → non-zero
    } catch {
      // expected: the rebase pauses on the conflict
    }
    assert.ok(rebaseInProgress(), 'fixture: rebase should be paused on a conflict');
    const gitService = getServices()!.gitService;
    await gitService.reloadRepository(gitService.getRepositories()[0]);
  }

  beforeEach(async () => {
    fix = await createFixtureRepo({ commits: 2 });
    await useFixtureWorkspace(fix.rootPath);
  });

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

  it('intellig.rebase.abort — restores the pre-rebase branch state', async () => {
    await startConflictingRebase();
    stubs = stubPrompts({ warningMessage: () => 'Abort' });

    await vscode.commands.executeCommand('intellig.rebase.abort');

    assert.ok(
      !rebaseInProgress(),
      `rebase metadata should be gone; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
    assert.strictEqual(await currentBranch(), 'feature', 'abort should restore the feature branch');
  });

  it('intellig.rebase.continue — completes the rebase after the conflict is resolved', async () => {
    await startConflictingRebase();
    // Resolve the conflict and stage it.
    fs.writeFileSync(file0(), 'resolved\n');
    await execGit(fix.rootPath, ['add', 'file0.txt']);
    // `git rebase --continue` may open the commit-message editor; make it a no-op.
    const prevEditor = process.env.GIT_EDITOR;
    process.env.GIT_EDITOR = 'true';
    stubs = stubPrompts({});

    try {
      await vscode.commands.executeCommand('intellig.rebase.continue');
    } finally {
      if (prevEditor === undefined) {
        delete process.env.GIT_EDITOR;
      } else {
        process.env.GIT_EDITOR = prevEditor;
      }
    }

    assert.ok(
      !rebaseInProgress(),
      `rebase should be complete; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
    assert.strictEqual(
      fs.readFileSync(file0(), 'utf8'),
      'resolved\n',
      'the resolved content should be committed'
    );
  });
});
