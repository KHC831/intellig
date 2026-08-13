/**
 * Tier-2 E2E — commit BODIES survive squash-family message plumbing.
 *
 * Real-git proof for the drops-the-body family: the log/show parse splits the
 * subject (%s) from the body, and three surfaces used to assemble messages
 * from the subject alone — the squash seed, the Squash-Into combine, and the
 * rebase editor's reword seed. This suite drives the REAL services:
 *
 *   1. `getCommit` + `fullCommitMessage` reconstruct subject+body from a real
 *      commit (the exact assembly the squash seed uses).
 *   2. `startInteractiveRebase` carries each commit's full message (the new
 *      `%H%x1f%B%x00` enumeration parsed against genuine git output).
 *   3. A squash-shaped plan (reword override + fixup) executed through the
 *      real runner lands the full multi-line combined message in the final
 *      commit — `git log --format=%B` is the arbiter.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';
import { fullCommitMessage } from '../../../src/git-core/gitParser';

describe('e2e — squash-family flows keep commit bodies', function () {
  this.timeout(30_000);

  let fix: Fixture;

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  it('full messages survive getCommit, the rebase session, and a squash rebase', async () => {
    fix = await createFixtureRepo({ commits: 1 });

    fs.writeFileSync(path.join(fix.rootPath, 'a.txt'), 'a\n');
    await execGit(fix.rootPath, ['add', 'a.txt']);
    await execGit(fix.rootPath, [
      'commit',
      '-m',
      'First subject\n\nFirst body paragraph.\n\nSecond paragraph of first.',
    ]);
    const oldestHash = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    fs.writeFileSync(path.join(fix.rootPath, 'b.txt'), 'b\n');
    await execGit(fix.rootPath, ['add', 'b.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'Second subject\n\nSecond body line.']);
    const newestHash = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    const repo = await useFixtureWorkspace(fix.rootPath);
    const services = getServices()!;

    // 1. The squash seed's assembly: getCommit + fullCommitMessage.
    const oldest = await services.gitService.getCommit(repo, oldestHash);
    assert.strictEqual(oldest.message, 'First subject', 'subject stays the one-line field');
    assert.strictEqual(
      fullCommitMessage(oldest),
      'First subject\n\nFirst body paragraph.\n\nSecond paragraph of first.',
      'fullCommitMessage reconstructs the message git stores'
    );

    // 2. The rebase session enumeration carries full messages.
    const session = await services.rebaseService.startInteractiveRebase(repo, `${oldestHash}~1`);
    assert.strictEqual(session.commits.length, 2);
    assert.strictEqual(session.commits[0].message, 'First subject');
    assert.strictEqual(
      session.commits[0].fullMessage,
      'First subject\n\nFirst body paragraph.\n\nSecond paragraph of first.'
    );
    assert.strictEqual(session.commits[1].fullMessage, 'Second subject\n\nSecond body line.');

    // 3. The squash plan shape (reword override on the root + fixup) delivers
    // the combined multi-line message through the real rebase.
    const combined = [session.commits[0].fullMessage, session.commits[1].fullMessage].join(
      '\n\n\n'
    );
    services.rebaseService.updateRebasePlan(repo, [
      { hash: oldestHash, action: 'reword', newMessage: combined },
      { hash: newestHash, action: 'fixup' },
    ]);
    const result = await services.rebaseService.executeRebase(repo);
    assert.strictEqual(result.success, true, `rebase must complete: ${JSON.stringify(result)}`);

    const finalMessage = (await execGit(fix.rootPath, ['log', '-1', '--format=%B'])).stdout.replace(
      /\n+$/,
      ''
    );
    assert.ok(
      finalMessage.includes('First body paragraph.') && finalMessage.includes('Second body line.'),
      `the squashed commit must keep both bodies; got:\n${finalMessage}`
    );
    const count = (await execGit(fix.rootPath, ['rev-list', '--count', 'HEAD'])).stdout.trim();
    assert.strictEqual(count, '2', 'fixture base + the one squashed commit');
  });
});
