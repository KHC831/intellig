/**
 * Tier-2 E2E — cherry-pick commands.
 *
 * Covers:
 *   - `intellig.commit.cherryPickWithoutCommit` — applies a commit's changes
 *     to the working tree / index WITHOUT producing a new commit. We assert
 *     on `git status` + file content rather than toasts.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';

describe('e2e — cherry-pick commands', function () {
  this.timeout(20_000);

  let fix: Fixture;
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

  it('intellig.commit.cherryPickWithoutCommit — stages the commit contents without creating a new commit', async () => {
    fix = await createFixtureRepo({ commits: 1 });

    // Create a feature branch with a distinctive commit whose changes we'll
    // cherry-pick onto main.
    await execGit(fix.rootPath, ['checkout', '-b', 'feature']);
    const cherryPath = path.join(fix.rootPath, 'cherry.txt');
    fs.writeFileSync(cherryPath, 'picked content\n');
    await execGit(fix.rootPath, ['add', 'cherry.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'feature: add cherry.txt']);
    const featureHead = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    // Back to main.
    await execGit(fix.rootPath, ['checkout', fix.defaultBranch]);

    const mainHeadBefore = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.commit.cherryPickWithoutCommit', { hash: featureHead });

    // Post-conditions:
    //   1. HEAD on main has not moved — cherry-pick-n leaves no commit.
    //   2. `cherry.txt` exists in the working tree.
    //   3. Index has the staged addition.
    const mainHeadAfter = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.strictEqual(mainHeadAfter, mainHeadBefore, 'cherry-pick-n must not move HEAD');

    assert.ok(fs.existsSync(cherryPath), 'cherry.txt should exist in working tree after cherry-pick-n');
    assert.strictEqual(fs.readFileSync(cherryPath, 'utf8'), 'picked content\n');

    const status = (await execGit(fix.rootPath, ['status', '--porcelain'])).stdout;
    assert.ok(
      /^(A |M )(cherry\.txt|cherry\.txt)$/m.test(status) || /^A  cherry\.txt/m.test(status),
      `cherry.txt should be staged; got status:\n${status}`
    );
  });

  it('intellig.commit.cherryPickWithoutCommit — no-op when invoked without a commit arg', async () => {
    fix = await createFixtureRepo({ commits: 2 });
    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    const before = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    await vscode.commands.executeCommand('intellig.commit.cherryPickWithoutCommit');
    const after = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    assert.strictEqual(before, after, 'cherry-pick-n without arg must not mutate HEAD');
  });
});
