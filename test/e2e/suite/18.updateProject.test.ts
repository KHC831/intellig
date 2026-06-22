/**
 * Tier-2 E2E — `intellig.updateProject` (IntelliJ Vcs.UpdateProject parity).
 *
 * Updates every open repo: fetch --all --prune, then pull with the chosen
 * method. We land a real commit on a `file://` origin (helper-clone → push),
 * pick the Merge method via a stubbed QuickPick, run the command, and assert
 * the remote commit was integrated into the local working tree — the full
 * fetch+pull path, not a silent no-op.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';

describe('e2e — update project (real fetch + pull)', function () {
  this.timeout(40_000);

  let fix: Fixture;
  let stubs: PromptStubs;

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

  it('intellig.updateProject — merges an incoming remote commit into the working tree', async () => {
    fix = await createFixtureRepo({ commits: 2, withRemote: true });
    assert.ok(fix.remotePath, 'fixture: expected a remote');
    await useFixtureWorkspace(fix.rootPath);

    // Land a commit on origin via a throwaway working-tree clone.
    const helperPath = `${fix.remotePath}-helper`;
    await execGit(fix.rootPath, ['clone', `file://${fix.remotePath}`, helperPath]);
    await execGit(helperPath, ['config', 'user.name', 'IntelliG E2E']);
    await execGit(helperPath, ['config', 'user.email', 'e2e@intellig.test']);
    fs.writeFileSync(path.join(helperPath, 'remote-only.txt'), 'from remote\n');
    await execGit(helperPath, ['add', 'remote-only.txt']);
    await execGit(helperPath, ['commit', '-m', 'remote-only commit']);
    await execGit(helperPath, ['push', 'origin', fix.defaultBranch]);

    assert.ok(
      !fs.existsSync(path.join(fix.rootPath, 'remote-only.txt')),
      'precondition: remote commit not yet local'
    );

    // Pick the Merge update method.
    stubs = stubPrompts({
      quickPick: (items) => (items as Array<{ method?: string }>).find((i) => i.method === 'merge'),
    });

    await vscode.commands.executeCommand('intellig.updateProject');

    assert.ok(
      fs.existsSync(path.join(fix.rootPath, 'remote-only.txt')),
      `updateProject should fetch+merge the incoming commit; ` +
        `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );

    fs.rmSync(helperPath, { recursive: true, force: true });
  });
});
