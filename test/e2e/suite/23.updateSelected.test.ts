/**
 * Tier-2 E2E — `intellig.branch.updateSelected`.
 *
 * Fast-forwards a behind, non-current local branch to its upstream (FF-only,
 * gated by the incoming/outgoing count from getIncomingOutgoingForBranch +
 * planAlignLocal). Set up a local 'feature' tracking origin/feature, advance
 * the remote, fetch so the local branch is genuinely behind, then assert the
 * command fast-forwards it. The precondition is verified via raw git so a
 * setup error is distinguishable from a handler bug.
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

describe('e2e — branch.updateSelected (real git state)', function () {
  this.timeout(45_000);

  let fix: Fixture;
  let repo: IRepository;
  let stubs: PromptStubs;

  const revParse = async (ref: string): Promise<string> =>
    (await execGit(fix.rootPath, ['rev-parse', ref])).stdout.trim();

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

  it('intellig.branch.updateSelected — fast-forwards a behind non-current branch', async () => {
    fix = await createFixtureRepo({ commits: 2, withRemote: true });
    assert.ok(fix.remotePath, 'fixture: expected a remote');
    await useFixtureWorkspace(fix.rootPath);
    repo = getServices()!.gitService.getRepositories()[0];

    // Local 'feature' tracks origin/feature.
    await execGit(fix.rootPath, ['checkout', '-b', 'feature']);
    await execGit(fix.rootPath, ['push', '-u', 'origin', 'feature']);
    await execGit(fix.rootPath, ['checkout', fix.defaultBranch]); // feature not current

    // Advance origin/feature via a throwaway clone.
    const helper = path.join(path.dirname(fix.remotePath), `helper-${Date.now()}`);
    await execGit(fix.rootPath, ['clone', `file://${fix.remotePath}`, helper]);
    await execGit(helper, ['config', 'user.name', 'IntelliG E2E']);
    await execGit(helper, ['config', 'user.email', 'e2e@intellig.test']);
    await execGit(helper, ['checkout', 'feature']);
    fs.writeFileSync(path.join(helper, 'rf.txt'), 'remote\n');
    await execGit(helper, ['add', 'rf.txt']);
    await execGit(helper, ['commit', '-m', 'remote on feature']);
    await execGit(helper, ['push', 'origin', 'feature']);
    const remoteHead = (await execGit(helper, ['rev-parse', 'HEAD'])).stdout.trim();
    fs.rmSync(helper, { recursive: true, force: true });

    await execGit(fix.rootPath, ['fetch', 'origin']); // local feature now behind

    // Verify the precondition with raw git: upstream resolves, local is behind.
    const upstreamRef = (
      await execGit(fix.rootPath, ['rev-parse', '--abbrev-ref', 'feature@{upstream}'])
    ).stdout.trim();
    assert.strictEqual(
      upstreamRef,
      'origin/feature',
      'precondition: feature tracks origin/feature'
    );
    const behind = (
      await execGit(fix.rootPath, ['rev-list', '--count', 'feature..origin/feature'])
    ).stdout.trim();
    assert.strictEqual(behind, '1', 'precondition: local feature is exactly 1 behind');
    assert.notStrictEqual(
      await revParse('refs/heads/feature'),
      remoteHead,
      'precondition: not yet FF'
    );

    await getServices()!.gitService.reloadRepository(repo);
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.branch.updateSelected', {
      branch: {
        name: 'feature',
        type: 'local',
        commit: '',
        isHead: false,
        upstream: { remote: 'origin', name: 'feature' },
      },
      repository: repo,
      getDetachedHeadSha: () => undefined,
    });

    assert.strictEqual(
      await revParse('refs/heads/feature'),
      remoteHead,
      `feature should be fast-forwarded to origin/feature; ` +
        `info=${JSON.stringify(stubs.informationMessageCalls.map((c) => c.message))} ` +
        `warn=${JSON.stringify(stubs.warningMessageCalls.map((c) => c.message))} ` +
        `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });
});
