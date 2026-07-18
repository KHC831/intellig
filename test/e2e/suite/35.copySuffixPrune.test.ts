/**
 * Tier-2 E2E — multi-hash copy order, cherry-pick provenance suffix, and
 * fetch --prune (real git).
 *
 *   1. Copy Hash with a multi-selection lands OLDEST-first, space-separated
 *      (paste-ready for `git cherry-pick a b c` — IntelliJ A14 ruling),
 *   2. cherry-picking a PUBLISHED commit (reachable from a protected remote
 *      branch) appends `(cherry picked from commit …)`; an unpublished one
 *      does not (git4idea shouldAddSuffix parity),
 *   3. fetch prunes remote-tracking refs whose remote branch is gone.
 *
 * (The git locale-env contract — LC_ALL pinned, LANGUAGE cleared — is pinned
 * by the unit-lane spawn-env contract test at the gitCli seam; a bundle-side
 * spawn hook is not reliably observable from this lane.)
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getCommitContextMenuCommands } from '../support/activatedExtension';
import type { IMenuStateNode } from '../../../src/git-core/gitToolWindow/multiSelect';

describe('e2e — copy order, cherry-pick suffix, fetch prune', function () {
  this.timeout(30_000);

  let fix: Fixture;
  let stubs: PromptStubs;

  afterEach(async () => {
    if (stubs) {
      stubs.restore();
    }
    if (fix) {
      await execGit(fix.rootPath, ['cherry-pick', '--abort'], { allowNonZero: true });
    }
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  async function logNodes(cwd: string): Promise<IMenuStateNode[]> {
    const log = await execGit(cwd, ['log', '--pretty=format:%H %P']);
    return log.stdout
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const [hash, ...parents] = line.trim().split(/\s+/);
        return { hash, parentCount: parents.length, parents };
      });
  }

  it('multi-select Copy Hash is oldest-first, space-separated', async () => {
    fix = await createFixtureRepo({ commits: 3 });
    await useFixtureWorkspace(fix.rootPath);
    const nodes = await logNodes(fix.rootPath);
    // Selection arrives newest-first from the rendered log.
    const newestFirst = [nodes[0].hash, nodes[1].hash, nodes[2].hash];

    stubs = stubPrompts({});
    const menu = getCommitContextMenuCommands();
    assert.ok(menu, 'CommitContextMenuCommands not initialised');
    await menu._handleAction('copyHash', newestFirst, nodes);

    const clip = await vscode.env.clipboard.readText();
    assert.strictEqual(
      clip,
      `${newestFirst[2]} ${newestFirst[1]} ${newestFirst[0]}`,
      'clipboard must be oldest-first, single-space separated'
    );
  });

  it('cherry-pick appends the provenance suffix for published commits only', async () => {
    // withRemote pushes 'main' — protected by default, so its commits are
    // "published" in the reference sense (isCommitPublished).
    fix = await createFixtureRepo({ commits: 3, withRemote: true });
    const cwd = fix.rootPath;
    const nodes = await logNodes(cwd);
    const publishedSha = nodes[0].hash; // pushed tip of main

    // An UNPUBLISHED commit on top of main (never pushed).
    fs.writeFileSync(path.join(cwd, 'unpublished.txt'), 'not pushed\n');
    await execGit(cwd, ['add', 'unpublished.txt']);
    await execGit(cwd, ['commit', '-m', 'unpublished work']);
    const unpublishedSha = (await execGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();

    // Cherry-pick target: a branch rooted below both commits.
    await execGit(cwd, ['branch', 'target', nodes[2].hash]);
    await execGit(cwd, ['checkout', 'target']);

    await useFixtureWorkspace(cwd);
    stubs = stubPrompts({
      warningMessage: (_msg, _opts, ...items) => (items[0] as string) ?? undefined,
    });
    const menu = getCommitContextMenuCommands();
    assert.ok(menu, 'CommitContextMenuCommands not initialised');

    const allNodes = await logNodes(cwd);
    await menu._handleAction('cherryPick', [publishedSha], allNodes);
    const publishedMsg = (await execGit(cwd, ['log', '-1', '--format=%B'])).stdout;
    assert.ok(
      publishedMsg.includes(`(cherry picked from commit ${publishedSha})`),
      `published pick must carry the provenance suffix; got:\n${publishedMsg}`
    );

    await menu._handleAction('cherryPick', [unpublishedSha], allNodes);
    const unpublishedMsg = (await execGit(cwd, ['log', '-1', '--format=%B'])).stdout;
    assert.ok(
      unpublishedMsg.includes('unpublished work') &&
        !unpublishedMsg.includes('cherry picked from commit'),
      `unpublished pick must NOT carry the suffix; got:\n${unpublishedMsg}`
    );
  });

  it('fetch prunes remote-tracking refs for branches deleted on the remote', async () => {
    fix = await createFixtureRepo({ commits: 2, withRemote: true });
    const cwd = fix.rootPath;

    await execGit(cwd, ['branch', 'gone']);
    await execGit(cwd, ['push', 'origin', 'gone']);
    assert.ok(
      (await execGit(cwd, ['branch', '-r', '--list', 'origin/gone'])).stdout.trim().length > 0,
      'origin/gone must exist before the remote-side delete'
    );
    // Delete on the remote out-of-band.
    await execGit(fix.remotePath!, ['branch', '-D', 'gone']);

    await useFixtureWorkspace(cwd);
    stubs = stubPrompts({});
    await vscode.commands.executeCommand('intellig.fetch');

    const tracking = (await execGit(cwd, ['branch', '-r', '--list', 'origin/gone'])).stdout.trim();
    assert.strictEqual(
      tracking,
      '',
      `fetch must prune the deleted remote branch; err=${JSON.stringify(
        stubs.errorMessageCalls.map((c) => c.message)
      )}`
    );
  });
});
