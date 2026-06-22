/**
 * Tier-2 E2E — tag context-menu commands that mutate real git state:
 * `intellig.tag.delete`, `intellig.tag.checkoutDetached`, `intellig.tag.cherryPick`.
 *
 * Synthetic BranchTreeItem carrying `.tag`, stubbed prompts, assertions against
 * real git (`git tag -l`, `git rev-parse HEAD`, working-tree contents). The
 * dialog-backed tag.mergeIntoCurrent / tag.newBranchFrom delegate to webviews
 * and are out of scope here.
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

function tagItem(name: string, commit: string, repo: IRepository): unknown {
  return {
    tag: { name, commit, isAnnotated: false },
    repository: repo,
    getDetachedHeadSha: () => undefined,
  };
}

async function revParse(rootPath: string, ref: string): Promise<string> {
  return (await execGit(rootPath, ['rev-parse', ref])).stdout.trim();
}

async function tagExists(rootPath: string, name: string): Promise<boolean> {
  return (await execGit(rootPath, ['tag', '-l', name])).stdout.trim().length > 0;
}

describe('e2e — tag lifecycle (real git state)', function () {
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

  it('intellig.tag.delete — deletes the tag after confirmation', async () => {
    await setup();
    await execGit(fix.rootPath, ['tag', 'v1']);
    assert.ok(await tagExists(fix.rootPath, 'v1'), 'precondition: tag exists');
    const sha = await revParse(fix.rootPath, 'v1');
    stubs = stubPrompts({ warningMessage: () => 'Delete' });

    await vscode.commands.executeCommand('intellig.tag.delete', tagItem('v1', sha, repo));

    assert.ok(
      !(await tagExists(fix.rootPath, 'v1')),
      `tag v1 should be removed; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.tag.checkoutDetached — checks out the tag in detached HEAD', async () => {
    await setup();
    // Tag the parent commit so checkout actually moves HEAD off the tip.
    await execGit(fix.rootPath, ['tag', 'v-old', 'HEAD~1']);
    const tagSha = await revParse(fix.rootPath, 'v-old');
    stubs = stubPrompts({ warningMessage: () => 'Checkout' });

    await vscode.commands.executeCommand(
      'intellig.tag.checkoutDetached',
      tagItem('v-old', tagSha, repo)
    );

    assert.strictEqual(
      await revParse(fix.rootPath, 'HEAD'),
      tagSha,
      `HEAD should point at the tag commit; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('intellig.tag.cherryPick — applies the tagged commit onto the current branch', async () => {
    await setup();
    const base = (await execGit(fix.rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    // A commit that exists only on a side branch, tagged.
    await execGit(fix.rootPath, ['checkout', '-b', 'side']);
    fs.writeFileSync(path.join(fix.rootPath, 'cherry.txt'), 'picked\n');
    await execGit(fix.rootPath, ['add', 'cherry.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'side commit']);
    const tagSha = await revParse(fix.rootPath, 'HEAD');
    await execGit(fix.rootPath, ['tag', 'v-cp']);
    await execGit(fix.rootPath, ['checkout', base]);
    assert.ok(
      !fs.existsSync(path.join(fix.rootPath, 'cherry.txt')),
      'precondition: file absent on base'
    );
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.tag.cherryPick', tagItem('v-cp', tagSha, repo));

    assert.ok(
      fs.existsSync(path.join(fix.rootPath, 'cherry.txt')),
      `cherry-picked file should appear on the current branch; ` +
        `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });
});
