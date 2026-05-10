/**
 * Tier-2 E2E — remote-facing commands against a local `file://` origin.
 *
 * Covers:
 *   - `intellig.fetch`       — `git fetch --all --prune` via the tool-window
 *                              command.
 *
 * All tests use a bare repo next to the working tree as `origin`, pushed at
 * fixture-creation time, so we have a plausible remote state to diff against
 * without any network.
 *
 * Note: `intellig.pull` is intentionally excluded — the extension's pull
 * surface is the PullDialog (webview), which is Tier-3 scope.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture, revParse } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';

describe('e2e — remote commands (against file:// origin)', function () {
  this.timeout(20_000);

  let fix: Fixture;
  let stubs: PromptStubs;

  afterEach(async () => {
    if (stubs) {
      stubs.restore();
    }
    clearWorkspace();
    if (fix) {
      fix.cleanup();
    }
  });

  it('intellig.fetch — detects a new commit on the remote after push', async () => {
    fix = await createFixtureRepo({ commits: 2, withRemote: true });
    if (!fix.remotePath) {
      assert.fail('fixture: expected remotePath');
    }

    // Simulate another developer landing a commit on the remote. We do this
    // via a helper working-tree clone so we can commit-and-push without
    // polluting the fixture repo itself.
    //
    // Strategy: clone the bare remote into a throwaway dir, add a commit,
    // push, delete the throwaway.
    const helperPath = `${fix.remotePath}-helper`;
    await execGit(fix.rootPath, ['clone', `file://${fix.remotePath}`, helperPath]);
    await execGit(helperPath, ['config', 'user.name', 'IntelliG E2E']);
    await execGit(helperPath, ['config', 'user.email', 'e2e@intellig.test']);
    // Add a file + push.
    const fs = await import('fs');
    const path = await import('path');
    fs.writeFileSync(path.join(helperPath, 'remote-only.txt'), 'from remote\n');
    await execGit(helperPath, ['add', 'remote-only.txt']);
    await execGit(helperPath, ['commit', '-m', 'remote-only commit']);
    await execGit(helperPath, ['push', 'origin', fix.defaultBranch]);

    // Pre-fetch sanity: the fixture's remote-tracking ref should NOT yet
    // know about the new commit.
    const beforeLocalRemoteRef = await revParse(
      fix.rootPath,
      `refs/remotes/origin/${fix.defaultBranch}`
    );
    const newRemoteHead = (await execGit(helperPath, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.notStrictEqual(
      beforeLocalRemoteRef,
      newRemoteHead,
      'sanity: fixture should not have the new remote commit yet'
    );

    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.fetch');

    const afterLocalRemoteRef = await revParse(
      fix.rootPath,
      `refs/remotes/origin/${fix.defaultBranch}`
    );
    assert.strictEqual(
      afterLocalRemoteRef,
      newRemoteHead,
      'after intellig.fetch, origin/<default> should track the new remote head'
    );
  });

  it('intellig.fetch — on an up-to-date repo, the remote-tracking ref is unchanged', async () => {
    fix = await createFixtureRepo({ commits: 2, withRemote: true });
    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    const before = await revParse(fix.rootPath, `refs/remotes/origin/${fix.defaultBranch}`);
    await vscode.commands.executeCommand('intellig.fetch');
    const after = await revParse(fix.rootPath, `refs/remotes/origin/${fix.defaultBranch}`);

    assert.strictEqual(
      after,
      before,
      'fetch on an up-to-date repo must not move the remote-tracking ref'
    );
  });
});
