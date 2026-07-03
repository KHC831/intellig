/**
 * Tier-2 E2E — remote-facing branch/tag commands against a `file://` origin.
 *
 * Covers the direct-git remote ops (the dialog-backed push/pull are excluded):
 * branch.update / updateSelected (fetch upstream), remoteBranch.checkoutAsLocal
 * / trackBranch / pullIntoCurrent / pullUsingMerge / pullUsingRebase /
 * deleteRemote, tag.push / tag.deleteRemote. Each lands real state on the bare
 * origin via a throwaway helper clone, then asserts real git (`ls-remote`,
 * remote-tracking refs, working tree, upstream config).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

describe('e2e — remote ops (against file:// origin)', function () {
  this.timeout(45_000);

  let fix: Fixture;
  let repo: IRepository;
  let stubs: PromptStubs;

  async function setup(): Promise<void> {
    fix = await createFixtureRepo({ commits: 2, withRemote: true });
    assert.ok(fix.remotePath, 'fixture: expected a remote');
    await useFixtureWorkspace(fix.rootPath);
    const repos = getServices()!.gitService.getRepositories();
    assert.strictEqual(repos.length, 1, 'one repo registered');
    repo = repos[0];
  }

  /** Land a commit on the bare origin via a throwaway working-tree clone. */
  async function landRemoteCommit(
    branch: string,
    opts: { newBranch?: boolean; file?: string } = {}
  ): Promise<string> {
    const file = opts.file ?? 'remote-only.txt';
    const helper = path.join(path.dirname(fix.remotePath!), `helper-${branch}-${Date.now()}`);
    await execGit(fix.rootPath, ['clone', `file://${fix.remotePath}`, helper]);
    await execGit(helper, ['config', 'user.name', 'IntelliG E2E']);
    await execGit(helper, ['config', 'user.email', 'e2e@intellig.test']);
    await execGit(helper, opts.newBranch ? ['checkout', '-b', branch] : ['checkout', branch]);
    fs.writeFileSync(path.join(helper, file), `from ${branch}\n`);
    await execGit(helper, ['add', file]);
    await execGit(helper, ['commit', '-m', `commit on ${branch}`]);
    await execGit(helper, ['push', 'origin', branch]);
    const head = (await execGit(helper, ['rev-parse', 'HEAD'])).stdout.trim();
    fs.rmSync(helper, { recursive: true, force: true });
    return head;
  }

  function branchItem(name: string, type: 'local' | 'remote', extra: object = {}): unknown {
    return {
      branch: { name, type, commit: '', isHead: false, ...extra },
      repository: repo,
      getDetachedHeadSha: () => undefined,
    };
  }
  function tagItem(name: string): unknown {
    return { tag: { name, commit: '', isAnnotated: false }, repository: repo };
  }

  const revParse = async (ref: string): Promise<string> =>
    (await execGit(fix.rootPath, ['rev-parse', ref])).stdout.trim();
  const currentBranch = async (): Promise<string> =>
    (await execGit(fix.rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const lsRemote = async (...args: string[]): Promise<string> =>
    (await execGit(fix.rootPath, ['ls-remote', ...args])).stdout.trim();

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

  it('intellig.branch.update — fetches the upstream and advances the tracking ref', async () => {
    await setup();
    const remoteHead = await landRemoteCommit(fix.defaultBranch);
    assert.notStrictEqual(
      await revParse(`refs/remotes/origin/${fix.defaultBranch}`),
      remoteHead,
      'precondition: tracking ref not yet advanced'
    );
    stubs = stubPrompts({});

    await vscode.commands.executeCommand(
      'intellig.branch.update',
      branchItem(fix.defaultBranch, 'local', {
        // The default branch is checked out — the real tree item carries
        // isHead: true, which routes Update down the fetch path (align-local
        // is only for non-checked-out branches; git refuses to ff a
        // checked-out ref via refspec fetch).
        isHead: true,
        upstream: { remote: 'origin', name: fix.defaultBranch },
      })
    );

    assert.strictEqual(
      await revParse(`refs/remotes/origin/${fix.defaultBranch}`),
      remoteHead,
      `tracking ref should advance; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.remoteBranch.checkoutAsLocal — creates and checks out a local tracking branch', async () => {
    await setup();
    await landRemoteCommit('feature', { newBranch: true });
    await execGit(fix.rootPath, ['fetch', 'origin']);
    stubs = stubPrompts({});

    await vscode.commands.executeCommand(
      'intellig.remoteBranch.checkoutAsLocal',
      branchItem('origin/feature', 'remote')
    );

    assert.strictEqual(
      await currentBranch(),
      'feature',
      `HEAD should be on the new local 'feature'; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.remoteBranch.trackBranch — creates a local branch tracking the remote', async () => {
    await setup();
    await landRemoteCommit('feature', { newBranch: true });
    await execGit(fix.rootPath, ['fetch', 'origin']);
    stubs = stubPrompts({});

    await vscode.commands.executeCommand(
      'intellig.remoteBranch.trackBranch',
      branchItem('origin/feature', 'remote')
    );

    const upstream = (
      await execGit(fix.rootPath, ['rev-parse', '--abbrev-ref', 'feature@{u}'])
    ).stdout.trim();
    assert.strictEqual(
      upstream,
      'origin/feature',
      `local 'feature' should track origin/feature; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.remoteBranch.pullIntoCurrent — merges the remote branch into HEAD', async () => {
    await setup();
    await landRemoteCommit(fix.defaultBranch);
    stubs = stubPrompts({});

    await vscode.commands.executeCommand(
      'intellig.remoteBranch.pullIntoCurrent',
      branchItem(`origin/${fix.defaultBranch}`, 'remote')
    );

    assert.ok(
      fs.existsSync(path.join(fix.rootPath, 'remote-only.txt')),
      `pull should integrate the remote commit; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.remoteBranch.pullUsingMerge — merges the remote branch into HEAD', async () => {
    await setup();
    await landRemoteCommit(fix.defaultBranch);
    stubs = stubPrompts({});

    await vscode.commands.executeCommand(
      'intellig.remoteBranch.pullUsingMerge',
      branchItem(`origin/${fix.defaultBranch}`, 'remote')
    );

    assert.ok(
      fs.existsSync(path.join(fix.rootPath, 'remote-only.txt')),
      `pull --merge should integrate the remote commit; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.remoteBranch.pullUsingRebase — rebases HEAD onto the remote branch', async () => {
    await setup();
    await landRemoteCommit(fix.defaultBranch);
    stubs = stubPrompts({});

    await vscode.commands.executeCommand(
      'intellig.remoteBranch.pullUsingRebase',
      branchItem(`origin/${fix.defaultBranch}`, 'remote')
    );

    assert.ok(
      fs.existsSync(path.join(fix.rootPath, 'remote-only.txt')),
      `pull --rebase should integrate the remote commit; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.remoteBranch.deleteRemote — deletes the branch on origin', async () => {
    await setup();
    await landRemoteCommit('feature', { newBranch: true });
    assert.ok(
      (await lsRemote('--heads', 'origin', 'feature')).length > 0,
      'precondition: remote feature exists'
    );
    stubs = stubPrompts({ warningMessage: () => 'Delete' });

    await vscode.commands.executeCommand(
      'intellig.remoteBranch.deleteRemote',
      branchItem('origin/feature', 'remote')
    );

    assert.strictEqual(
      await lsRemote('--heads', 'origin', 'feature'),
      '',
      `origin/feature should be deleted; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.tag.push — pushes a local tag to origin', async () => {
    await setup();
    await execGit(fix.rootPath, ['tag', 'v1']);
    assert.strictEqual(
      await lsRemote('--tags', 'origin', 'v1'),
      '',
      'precondition: tag not on remote'
    );
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.tag.push', tagItem('v1'));

    assert.ok(
      (await lsRemote('--tags', 'origin', 'v1')).length > 0,
      `tag v1 should exist on origin; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.tag.deleteRemote — deletes a tag on origin', async () => {
    await setup();
    await execGit(fix.rootPath, ['tag', 'v1']);
    await execGit(fix.rootPath, ['push', 'origin', 'v1']);
    assert.ok((await lsRemote('--tags', 'origin', 'v1')).length > 0, 'precondition: tag on remote');
    stubs = stubPrompts({ warningMessage: () => 'Delete from Remote' });

    await vscode.commands.executeCommand('intellig.tag.deleteRemote', tagItem('v1'));

    assert.strictEqual(
      await lsRemote('--tags', 'origin', 'v1'),
      '',
      `remote tag v1 should be deleted; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });
});
