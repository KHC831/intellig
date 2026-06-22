/**
 * Tier-2 E2E — branch lifecycle commands that mutate real git state:
 * `intellig.branch.checkout`, `intellig.branch.rename`, `intellig.branch.delete`.
 *
 * These context-menu commands take a BranchTreeItem and run git directly (the
 * dialog-backed ones — new / merge — delegate to a webview and are covered by
 * their dialog tests). We pass a synthetic tree item carrying the target branch
 * and the fixture repo, stub the prompts, and assert REAL git state
 * (`git rev-parse --abbrev-ref HEAD`, `git branch --list`) — the git4idea
 * assertStatus discipline. A handler that resolves the wrong repo/path or
 * silently no-ops fails here.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

/** Build a synthetic BranchTreeItem for the named local branch. */
function branchItem(name: string, repo: IRepository): unknown {
  return {
    branch: { name, type: 'local', commit: '', isHead: false },
    repository: repo,
    getDetachedHeadSha: () => undefined,
  };
}

async function currentBranch(rootPath: string): Promise<string> {
  return (await execGit(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
}

async function branchExists(rootPath: string, name: string): Promise<boolean> {
  const out = (await execGit(rootPath, ['branch', '--list', name])).stdout.trim();
  return out.length > 0;
}

describe('e2e — branch lifecycle (real git state)', function () {
  this.timeout(30_000);

  let fix: Fixture;
  let repo: IRepository;
  let stubs: PromptStubs;

  async function setup(): Promise<void> {
    fix = await createFixtureRepo({ commits: 2 });
    await useFixtureWorkspace(fix.rootPath);
    const repos = getServices()!.gitService.getRepositories();
    assert.strictEqual(repos.length, 1, 'exactly one repo should be registered');
    repo = repos[0];
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

  it('intellig.branch.checkout — switches HEAD to the target branch', async () => {
    await setup();
    await execGit(fix.rootPath, ['branch', 'feature-x']);
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.branch.checkout', branchItem('feature-x', repo));

    assert.strictEqual(
      await currentBranch(fix.rootPath),
      'feature-x',
      `HEAD should be on feature-x; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.branch.rename — renames the branch', async () => {
    await setup();
    await execGit(fix.rootPath, ['branch', 'old-name']);
    stubs = stubPrompts({ inputBox: () => 'new-name' });

    await vscode.commands.executeCommand('intellig.branch.rename', branchItem('old-name', repo));

    assert.ok(await branchExists(fix.rootPath, 'new-name'), 'new-name should exist after rename');
    assert.ok(
      !(await branchExists(fix.rootPath, 'old-name')),
      `old-name should be gone; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.branch.delete — deletes the branch after confirmation', async () => {
    await setup();
    await execGit(fix.rootPath, ['branch', 'to-delete']);
    assert.ok(await branchExists(fix.rootPath, 'to-delete'), 'precondition: branch exists');
    stubs = stubPrompts({ warningMessage: () => 'Delete' });

    await vscode.commands.executeCommand('intellig.branch.delete', branchItem('to-delete', repo));

    assert.ok(
      !(await branchExists(fix.rootPath, 'to-delete')),
      `to-delete should be removed; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.branch.delete — cancelling the confirm leaves the branch', async () => {
    await setup();
    await execGit(fix.rootPath, ['branch', 'keep-me']);
    stubs = stubPrompts({ warningMessage: () => undefined }); // user dismisses

    await vscode.commands.executeCommand('intellig.branch.delete', branchItem('keep-me', repo));

    assert.ok(
      await branchExists(fix.rootPath, 'keep-me'),
      'cancelled delete must leave the branch intact'
    );
  });
});
