/**
 * Tier-2 E2E — `intellig.commit.cherryPick` (log context-menu / palette).
 *
 * The command takes a commit hash (string or {hash}) and delegates to the
 * commit context-menu handler, which resolves the repo via the tool-window
 * selection and falls back to resolveRepo (single-repo) — so in a one-repo
 * workspace it cherry-picks without any UI wiring. Assert the picked commit's
 * change lands on the current branch.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';

describe('e2e — commit.cherryPick (real git state)', function () {
  this.timeout(30_000);

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

  it('intellig.commit.cherryPick — applies the commit onto the current branch', async () => {
    fix = await createFixtureRepo({ commits: 2 });
    await useFixtureWorkspace(fix.rootPath);

    const base = (await execGit(fix.rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    // A commit that exists only on a side branch.
    await execGit(fix.rootPath, ['checkout', '-b', 'side']);
    fs.writeFileSync(path.join(fix.rootPath, 'cherry.txt'), 'picked\n');
    await execGit(fix.rootPath, ['add', 'cherry.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'side commit']);
    const sha = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    await execGit(fix.rootPath, ['checkout', base]);
    assert.ok(
      !fs.existsSync(path.join(fix.rootPath, 'cherry.txt')),
      'precondition: file absent on base'
    );
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.commit.cherryPick', sha);

    assert.ok(
      fs.existsSync(path.join(fix.rootPath, 'cherry.txt')),
      `cherry-picked file should land on the current branch; ` +
        `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });
});
