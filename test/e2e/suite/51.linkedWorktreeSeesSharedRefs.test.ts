/**
 * Tier-2 E2E — a window open on a LINKED worktree sees changes made from
 * another worktree of the same repository.
 *
 * Every worktree shares one set of refs, packed-refs, config and stash; only
 * HEAD, the index and in-progress markers are per worktree. A commit, a new
 * branch or a deleted branch made in the main worktree changes the shared
 * refs, and the linked worktree's graph must follow without a manual reload.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture, revParse } from '../support/gitFixture';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getGitToolWindowProvider } from '../support/activatedExtension';
import type { GitToolWindowProvider } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';

describe('e2e — a linked worktree sees refs changed from another worktree', function () {
  this.timeout(60_000);

  let fix: Fixture;
  let provider: GitToolWindowProvider;

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await clearWorkspace();
    await fix?.cleanup();
  });

  const poll = async (cond: () => boolean, what: () => string): Promise<void> => {
    for (let i = 0; i < 60 && !cond(); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(cond(), `timed out waiting for ${what()}`);
  };

  const branchNames = (): string[] =>
    [...provider.log.state.branchMap.values()].flat().map((ref) => ref.name);

  const loadedHashes = (): Set<string> =>
    new Set(provider.log.state.commitNodes.map((n) => n.commit.hash));

  it('shows a commit, a new branch and a deleted branch made in the main worktree', async () => {
    fix = await createFixtureRepo({ commits: 2 });
    const linked = path.join(path.dirname(fix.rootPath), 'linked');
    await execGit(fix.rootPath, ['worktree', 'add', '-b', 'side', linked, 'HEAD']);
    await useFixtureWorkspace(linked);
    provider = getGitToolWindowProvider()!;
    assert.ok(provider, 'the tool window provider must be live');
    await poll(
      () => provider.log.state.commitNodes.length >= 2,
      () => `the linked worktree's first load (${provider.log.state.commitNodes.length})`
    );
    // Let the initial load's own refreshes settle.
    await new Promise((r) => setTimeout(r, 1500));

    // From the MAIN worktree: commit on its branch, and add a branch elsewhere.
    fs.writeFileSync(path.join(fix.rootPath, 'from-main.txt'), 'x\n');
    await execGit(fix.rootPath, ['add', 'from-main.txt']);
    await execGit(fix.rootPath, ['commit', '-q', '-m', 'made in the main worktree']);
    const made = await revParse(fix.rootPath, 'HEAD');

    await poll(
      () => loadedHashes().has(made),
      () => `the linked worktree's graph to show ${made.slice(0, 8)}`
    );

    await execGit(fix.rootPath, ['branch', 'made-elsewhere', 'HEAD~1']);
    await poll(
      () => branchNames().includes('made-elsewhere'),
      () => `the new branch on the linked worktree's graph (${branchNames().join(', ')})`
    );

    await execGit(fix.rootPath, ['branch', '-D', 'made-elsewhere']);
    await poll(
      () => !branchNames().includes('made-elsewhere'),
      () => `the deleted branch to leave the graph (${branchNames().join(', ')})`
    );
  });
});
