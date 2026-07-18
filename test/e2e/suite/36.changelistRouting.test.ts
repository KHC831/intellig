/**
 * Tier-2 E2E — active-changelist routing (real git).
 *
 * IntelliJ's contract (F-B2): "active" and "default" are ONE concept — a new
 * local change lands in the ACTIVE changelist, whichever list that is, and
 * the active list cannot be deleted.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

describe('e2e — active-changelist routing', function () {
  this.timeout(30_000);

  let fix: Fixture;
  let repo: IRepository;
  let stubs: PromptStubs;

  afterEach(async () => {
    if (stubs) {
      stubs.restore();
    }
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  it('a new change lands in the ACTIVE changelist, and the active list cannot be deleted', async () => {
    fix = await createFixtureRepo({ commits: 2 });
    repo = await useFixtureWorkspace(fix.rootPath);
    const { changelistService } = getServices()!;
    assert.ok(changelistService, 'changelistService not available');
    stubs = stubPrompts({});

    const feature = changelistService.createChangelist(repo, 'feature-work');
    await changelistService.setActiveChangelist(repo, feature.id);

    // A brand-new local change, reconciled from real git status.
    fs.writeFileSync(path.join(fix.rootPath, 'file0.txt'), 'routed change\n');
    await changelistService.reconcileWithGitStatus(repo);

    const owner = await changelistService.getChangelistForFile(repo, 'file0.txt');
    assert.strictEqual(
      owner,
      feature.id,
      `the new change must land in the ACTIVE list, not Default; got ${String(owner)}`
    );

    // The active list refuses deletion.
    await vscode.commands.executeCommand('intellig.changelist.delete', feature.id);
    const lists = changelistService.getChangelists(repo);
    assert.ok(
      lists.some((l) => l.id === feature.id),
      `the active changelist must survive a delete attempt; lists: ${lists
        .map((l) => l.name)
        .join(', ')} err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );

    const active = await changelistService.getActiveChangelist(repo);
    assert.strictEqual(active.id, feature.id, 'the active list must remain active');
  });
});
