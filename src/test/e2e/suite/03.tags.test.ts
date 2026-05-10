/**
 * Tier-2 E2E — tag lifecycle commands.
 *
 * Covers:
 *   - `intellig.tag.new`      — creates a lightweight or annotated tag via
 *                                runNewTagFlow (two input boxes: name, then
 *                                optional message). We stub both inputs.
 *   - `intellig.commit.newTag` — same flow, but targets an explicit commit
 *                                arg rather than HEAD.
 *   - `intellig.pushAllTags`   — pushes every local tag to `origin`.
 *
 * These assert real git state (via `git tag -l`, `git ls-remote`) rather
 * than toast-message text — toast strings are UI affordances, not the
 * observable contract for command correctness.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';

describe('e2e — tag lifecycle commands', function () {
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

  it('intellig.tag.new — creates a lightweight tag on HEAD', async () => {
    fix = await createFixtureRepo({ commits: 2 });
    await useFixtureWorkspace(fix.rootPath);

    // Two input-box calls: first the tag name, then the annotation message.
    const answers = ['v-e2e-1', ''];
    let callIdx = 0;
    stubs = stubPrompts({
      inputBox: () => answers[callIdx++],
    });

    await vscode.commands.executeCommand('intellig.tag.new');

    const tags = (await execGit(fix.rootPath, ['tag', '-l'])).stdout.trim().split('\n').filter(Boolean);
    assert.ok(tags.includes('v-e2e-1'), `expected 'v-e2e-1' in tag list, got: ${tags.join(', ')}`);

    // Lightweight tag: `git cat-file -t` returns 'commit', not 'tag'.
    const t = (await execGit(fix.rootPath, ['cat-file', '-t', 'v-e2e-1'])).stdout.trim();
    assert.strictEqual(t, 'commit', 'empty-message tag should be lightweight');
  });

  it('intellig.tag.new — creates an annotated tag when a message is supplied', async () => {
    fix = await createFixtureRepo({ commits: 2 });
    await useFixtureWorkspace(fix.rootPath);

    const answers = ['v-e2e-annotated', 'Release candidate 1'];
    let callIdx = 0;
    stubs = stubPrompts({
      inputBox: () => answers[callIdx++],
    });

    await vscode.commands.executeCommand('intellig.tag.new');

    const t = (await execGit(fix.rootPath, ['cat-file', '-t', 'v-e2e-annotated'])).stdout.trim();
    assert.strictEqual(t, 'tag', 'non-empty message should produce an annotated tag object');
  });

  it('intellig.tag.new — cancel on tag-name input leaves no tag created', async () => {
    fix = await createFixtureRepo({ commits: 2 });
    await useFixtureWorkspace(fix.rootPath);

    stubs = stubPrompts({
      inputBox: () => undefined,
    });

    await vscode.commands.executeCommand('intellig.tag.new');

    const tags = (await execGit(fix.rootPath, ['tag', '-l'])).stdout.trim();
    assert.strictEqual(tags, '', 'no tag should exist after user cancels name input');
  });

  it('intellig.commit.newTag — tags the supplied commit, not HEAD', async () => {
    fix = await createFixtureRepo({ commits: 3 });
    await useFixtureWorkspace(fix.rootPath);

    // Target the oldest commit (index 0).
    const log = (await execGit(fix.rootPath, ['log', '--pretty=format:%H', '--reverse'])).stdout.split('\n');
    const root = log[0];
    const head = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.notStrictEqual(root, head, 'sanity: root commit should not be HEAD');

    const answers = ['root-pinned', ''];
    let callIdx = 0;
    stubs = stubPrompts({
      inputBox: () => answers[callIdx++],
    });

    await vscode.commands.executeCommand('intellig.commit.newTag', { hash: root });

    const tagged = (await execGit(fix.rootPath, ['rev-list', '-n', '1', 'root-pinned'])).stdout.trim();
    assert.strictEqual(tagged, root, 'tag should point at the supplied commit, not HEAD');
  });

  it('intellig.pushAllTags — pushes every local tag to the origin remote', async () => {
    fix = await createFixtureRepo({
      commits: 2,
      withRemote: true,
      tags: [
        { name: 'rel-1' },
        { name: 'rel-2', message: 'annotated release 2' },
      ],
    });
    await useFixtureWorkspace(fix.rootPath);

    // Sanity: tags exist locally but NOT on the remote yet.
    const remoteBefore = (await execGit(fix.rootPath, ['ls-remote', '--tags', 'origin'])).stdout.trim();
    assert.strictEqual(remoteBefore, '', 'sanity: remote should have no tags before pushAllTags');

    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.pushAllTags');

    const remoteAfter = (await execGit(fix.rootPath, ['ls-remote', '--tags', 'origin'])).stdout;
    assert.ok(remoteAfter.includes('refs/tags/rel-1'), `rel-1 should be on origin; got:\n${remoteAfter}`);
    assert.ok(remoteAfter.includes('refs/tags/rel-2'), `rel-2 should be on origin; got:\n${remoteAfter}`);
  });
});
