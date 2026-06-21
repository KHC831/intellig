/**
 * Tier-2 E2E — refresh commands.
 *
 *   - `intellig.refresh`           — refreshes the Git tool window + tree.
 *   - `intellig.branches.refresh`  — refreshes just the branch tree.
 *
 * Both commands are fire-and-forget: their only observable is "did it
 * complete without throwing?". We execute each twice to shake out
 * idempotency regressions — the post-#78 debounced refresh path would
 * fail this check if it swallowed the second invocation.
 */

import * as vscode from 'vscode';

import { createFixtureRepo, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';

describe('e2e — refresh commands', function () {
  this.timeout(15_000);

  let fix: Fixture;
  let stubs: PromptStubs;

  beforeEach(async () => {
    fix = await createFixtureRepo({ commits: 2, branches: [{ name: 'feature' }] });
    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});
  });

  afterEach(async () => {
    stubs.restore();
    await clearWorkspace();
    await fix.cleanup();
  });

  it('intellig.refresh — runs twice in a row without throwing', async () => {
    await vscode.commands.executeCommand('intellig.refresh');
    await vscode.commands.executeCommand('intellig.refresh');
  });

  it('intellig.branches.refresh — runs twice in a row without throwing', async () => {
    await vscode.commands.executeCommand('intellig.branches.refresh');
    await vscode.commands.executeCommand('intellig.branches.refresh');
  });
});
