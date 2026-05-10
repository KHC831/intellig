/**
 * Tier-2 E2E — clipboard / copy commands against real git state.
 *
 * Exercises `intellig.commit.copyHash` with a real commit hash against a
 * freshly-initialised temp repo. The command route goes:
 *
 *   executeCommand('intellig.commit.copyHash', { hash })
 *     → extension.ts: _delegateLogAction('copyHash', arg)
 *     → CommitContextMenuCommands._handleCopyHash
 *     → vscode.env.clipboard.writeText(hash)
 *
 * We then read the clipboard back and compare.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';

describe('e2e — copy / revision commands', function () {
  this.timeout(15_000);

  let fix: Fixture;
  let stubs: PromptStubs;
  let originalClipboard: string;

  beforeEach(async () => {
    fix = await createFixtureRepo({ commits: 3 });
    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});
    originalClipboard = await vscode.env.clipboard.readText();
  });

  afterEach(async () => {
    stubs.restore();
    // Best-effort restore. If the user had something important on the
    // clipboard before the test, put it back.
    try {
      await vscode.env.clipboard.writeText(originalClipboard);
    } catch {
      // Ignore — tests shouldn't fail on clipboard restore.
    }
    await clearWorkspace();
    await fix.cleanup();
  });

  it('intellig.commit.copyHash — copies the full 40-char hash to the clipboard', async () => {
    const head = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.strictEqual(head.length, 40, 'sanity: HEAD should be a 40-char sha1');

    await vscode.commands.executeCommand('intellig.commit.copyHash', { hash: head });

    const got = await vscode.env.clipboard.readText();
    assert.strictEqual(got, head, `clipboard should contain HEAD hash; got "${got}"`);
  });

  it('intellig.commit.copyHash — copies the exact selected ancestor hash, not HEAD', async () => {
    // Pick the middle commit (not HEAD) and assert that the clipboard
    // matches it exactly — catches regressions that silently substitute HEAD.
    const log = (await execGit(fix.rootPath, ['log', '--pretty=format:%H', '--reverse'])).stdout
      .split('\n')
      .filter((s) => s.length > 0);
    assert.strictEqual(log.length, 3, 'sanity: fixture should have 3 commits');
    const middle = log[1];

    await vscode.commands.executeCommand('intellig.commit.copyHash', { hash: middle });

    const got = await vscode.env.clipboard.readText();
    assert.strictEqual(got, middle, `clipboard should equal middle commit; got "${got}"`);
  });

  it('intellig.commit.copyHash — no-op when invoked without a commit arg', async () => {
    // The command surfaces an error toast but must not throw. We set the
    // clipboard to a sentinel up front and assert it is unchanged.
    const sentinel = 'E2E-SENTINEL-NO-ARG';
    await vscode.env.clipboard.writeText(sentinel);

    await vscode.commands.executeCommand('intellig.commit.copyHash');

    const got = await vscode.env.clipboard.readText();
    assert.strictEqual(got, sentinel, 'copyHash with no arg should not mutate the clipboard');
  });
});
