/**
 * Tier-2 E2E — multi-command USER JOURNEYS.
 *
 * Single-command e2e proves each command in isolation; these chain several
 * commands and assert the real-git state BETWEEN steps, catching integration
 * bugs where commands compose badly (stale caches, wrong repo carried over,
 * state not reloaded between steps). All steps use direct-git commands +
 * stubbed prompts, asserting via raw git.
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

describe('e2e — multi-command journeys (real git state)', function () {
  this.timeout(40_000);

  let fix: Fixture;
  let repo: IRepository;
  let stubs: PromptStubs;

  const currentBranch = async (): Promise<string> =>
    (await execGit(fix.rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const revParse = async (ref: string): Promise<string> =>
    (await execGit(fix.rootPath, ['rev-parse', ref])).stdout.trim();
  const tagExists = async (name: string): Promise<boolean> =>
    (await execGit(fix.rootPath, ['tag', '-l', name])).stdout.trim().length > 0;
  const branchExists = async (name: string): Promise<boolean> =>
    (await execGit(fix.rootPath, ['branch', '--list', name])).stdout.trim().length > 0;

  async function setup(): Promise<void> {
    fix = await createFixtureRepo({ commits: 2 });
    await useFixtureWorkspace(fix.rootPath);
    repo = getServices()!.gitService.getRepositories()[0];
  }

  function tagItem(name: string, commit: string): unknown {
    return {
      tag: { name, commit, isAnnotated: false },
      repository: repo,
      getDetachedHeadSha: () => undefined,
    };
  }
  function branchItem(name: string): unknown {
    return {
      branch: { name, type: 'local', commit: '', isHead: false },
      repository: repo,
      getDetachedHeadSha: () => undefined,
    };
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

  it('tag journey: new → checkout detached → back to branch → delete', async () => {
    await setup();
    const base = await currentBranch();
    const headSha = await revParse('HEAD');
    // tag.new prompts for: name, ref (empty → HEAD), message (empty → lightweight).
    const tagNewAnswers = ['v1', '', ''];
    let tagNewIdx = 0;
    stubs = stubPrompts({
      inputBox: () => tagNewAnswers[tagNewIdx++],
      warningMessage: (msg) => (/detached/i.test(msg) ? 'Checkout' : 'Delete'),
    });

    // new tag at HEAD
    await vscode.commands.executeCommand('intellig.tag.new');
    assert.ok(await tagExists('v1'), 'after new: tag v1 exists');

    // checkout the tag (detached)
    await vscode.commands.executeCommand('intellig.tag.checkoutDetached', tagItem('v1', headSha));
    assert.strictEqual(await revParse('HEAD'), headSha, 'after checkout: HEAD at the tag commit');
    assert.strictEqual(await currentBranch(), 'HEAD', 'after checkout: detached');

    // back to the branch
    await execGit(fix.rootPath, ['checkout', base]);
    assert.strictEqual(await currentBranch(), base, 'back on the base branch');

    // delete the tag
    await vscode.commands.executeCommand('intellig.tag.delete', tagItem('v1', headSha));
    assert.ok(!(await tagExists('v1')), 'after delete: tag v1 gone');
  });

  it('branch journey: checkout feature → commit on it → back → delete merged base path', async () => {
    await setup();
    const base = await currentBranch();
    await execGit(fix.rootPath, ['branch', 'feature']);
    stubs = stubPrompts({ warningMessage: () => 'Delete' });

    // checkout feature
    await vscode.commands.executeCommand('intellig.branch.checkout', branchItem('feature'));
    assert.strictEqual(await currentBranch(), 'feature', 'on feature');

    // a commit on feature (advances it past base)
    fs.writeFileSync(path.join(fix.rootPath, 'f.txt'), 'feature\n');
    await execGit(fix.rootPath, ['add', 'f.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'feature work']);

    // back to base
    await vscode.commands.executeCommand('intellig.branch.checkout', branchItem(base));
    assert.strictEqual(await currentBranch(), base, 'back on base');
    assert.ok(!fs.existsSync(path.join(fix.rootPath, 'f.txt')), 'feature file not on base');

    // delete feature (unmerged → first confirm declines force, branch stays)
    stubs.restore();
    stubs = stubPrompts({ warningMessage: (msg) => (/force/i.test(msg) ? undefined : 'Delete') });
    await vscode.commands.executeCommand('intellig.branch.delete', branchItem('feature'));
    assert.ok(await branchExists('feature'), 'unmerged feature survives when force is declined');

    // delete with force accepted (first confirm 'Delete', then 'Force Delete')
    stubs.restore();
    stubs = stubPrompts({
      warningMessage: (msg) => (/force/i.test(msg) ? 'Force Delete' : 'Delete'),
    });
    await vscode.commands.executeCommand('intellig.branch.delete', branchItem('feature'));
    assert.ok(!(await branchExists('feature')), 'force-delete removes the unmerged feature');
  });
});
