/**
 * Tier-2 E2E — "Checkout and Rebase onto Current" against real git.
 *
 * Pins the git4idea contract for the remote arm
 * (GitCheckoutAndRebaseRemoteBranchWorkflow):
 *
 *   1. the target local name IS the current branch → refuse outright
 *      ("Cannot overwrite current branch") with NO git mutation — the
 *      `-B` would move the very branch captured as the rebase base, so the
 *      rebase could only ever hit its own new tip (a no-op behind a
 *      success toast) while silently resetting local-only commits,
 *   2. a different leaf name → `checkout -B <leaf> --track <remote>` and a
 *      REAL rebase onto the previously-current branch, verified on the
 *      commit graph (not just an exit code),
 *   3. a stale local (commits the remote lacks) gates the reset behind the
 *      same confirm modal checkout-as-local uses: Cancel keeps every ref
 *      untouched; "Reset anyway" resets and proceeds to the rebase.
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

describe('e2e — checkout and rebase onto current (real git)', function () {
  this.timeout(45_000);

  let fix: Fixture;
  let repo: IRepository;
  let stubs: PromptStubs;

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (stubs) {
      stubs.restore();
    }
    if (fix) {
      await execGit(fix.rootPath, ['rebase', '--abort'], { allowNonZero: true });
    }
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  function remoteItem(fullRef: string): unknown {
    return {
      branch: { name: fullRef, type: 'remote', commit: '', isHead: false },
      repository: repo,
      getDetachedHeadSha: () => undefined,
    };
  }
  function localItem(name: string): unknown {
    return {
      branch: { name, type: 'local', commit: '', isHead: false },
      repository: repo,
      getDetachedHeadSha: () => undefined,
    };
  }

  const revParse = async (ref: string): Promise<string> =>
    (await execGit(fix.rootPath, ['rev-parse', ref])).stdout.trim();
  const currentBranch = async (): Promise<string> =>
    (await execGit(fix.rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const toastTrail = (): string =>
    `warn=${JSON.stringify(stubs.warningMessageCalls.map((c) => c.message))} ` +
    `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))} ` +
    `info=${JSON.stringify(stubs.informationMessageCalls.map((c) => c.message))}`;

  /** Land a commit on the bare origin's default branch via a helper clone. */
  async function landRemoteCommit(file: string): Promise<string> {
    const branch = fix.defaultBranch;
    const helper = path.join(path.dirname(fix.remotePath!), `helper-${Date.now()}`);
    await execGit(fix.rootPath, ['clone', `file://${fix.remotePath}`, helper]);
    await execGit(helper, ['config', 'user.name', 'IntelliG E2E']);
    await execGit(helper, ['config', 'user.email', 'e2e@intellig.test']);
    await execGit(helper, ['checkout', branch]);
    fs.writeFileSync(path.join(helper, file), `from origin\n`);
    await execGit(helper, ['add', file]);
    await execGit(helper, ['commit', '-m', `remote: add ${file}`]);
    await execGit(helper, ['push', 'origin', branch]);
    const head = (await execGit(helper, ['rev-parse', 'HEAD'])).stdout.trim();
    fs.rmSync(helper, { recursive: true, force: true });
    return head;
  }

  async function openWorkspace(): Promise<void> {
    await useFixtureWorkspace(fix.rootPath);
    const repos = getServices()!.gitService.getRepositories();
    assert.strictEqual(repos.length, 1, 'one repo registered');
    repo = repos[0];
  }

  it('refuses when the remote leaf IS the current branch: no reset, no rebase, refusal toast', async () => {
    // The reported shape exactly: on the default branch, local 1 behind
    // origin/<default>, right-click the remote counterpart.
    fix = await createFixtureRepo({ commits: 2, withRemote: true });
    const def = fix.defaultBranch;
    await landRemoteCommit('remote-only.txt');
    await execGit(fix.rootPath, ['fetch', 'origin']);
    await openWorkspace();

    const localShaBefore = await revParse(def);
    const originSha = await revParse(`origin/${def}`);
    assert.notStrictEqual(localShaBefore, originSha, 'fixture: local must be behind origin');

    stubs = stubPrompts({});
    await vscode.commands.executeCommand(
      'intellig.branch.checkoutAndRebase',
      remoteItem(`origin/${def}`)
    );

    assert.strictEqual(await currentBranch(), def, `HEAD must stay on '${def}'; ${toastTrail()}`);
    assert.strictEqual(
      await revParse(def),
      localShaBefore,
      `the local branch must NOT be reset to the remote tip; ${toastTrail()}`
    );
    assert.ok(
      stubs.errorMessageCalls.some((c) =>
        c.message.includes(`cannot overwrite the current branch '${def}'`)
      ),
      `the refusal toast must name the current branch; ${toastTrail()}`
    );
    assert.strictEqual(
      stubs.informationMessageCalls.filter((c) => c.message.includes('rebased')).length,
      0,
      `no success toast may fire on refusal; ${toastTrail()}`
    );
  });

  it('refuses the local arm the same way (the current branch itself)', async () => {
    fix = await createFixtureRepo({ commits: 2, withRemote: true });
    const def = fix.defaultBranch;
    await openWorkspace();
    const shaBefore = await revParse(def);

    stubs = stubPrompts({});
    await vscode.commands.executeCommand('intellig.branch.checkoutAndRebase', localItem(def));

    assert.strictEqual(await currentBranch(), def, toastTrail());
    assert.strictEqual(await revParse(def), shaBefore, toastTrail());
    assert.ok(
      stubs.errorMessageCalls.some((c) =>
        c.message.includes(`cannot overwrite the current branch '${def}'`)
      ),
      `the refusal toast must fire for the local arm too; ${toastTrail()}`
    );
  });

  it('different leaf: creates the tracking local and REALLY rebases it onto the previous current', async () => {
    // origin/<def> and 'feature' diverge from the same base; the command must
    // land on <def> replayed on top of feature — verified on the graph.
    fix = await createFixtureRepo({ commits: 2, withRemote: true });
    const def = fix.defaultBranch;
    await landRemoteCommit('remote-only.txt');
    await execGit(fix.rootPath, ['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(fix.rootPath, 'feature.txt'), 'local feature work\n');
    await execGit(fix.rootPath, ['add', 'feature.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'feature: add feature.txt']);
    await execGit(fix.rootPath, ['fetch', 'origin']);
    await openWorkspace();

    const featureTip = await revParse('feature');
    const originSha = await revParse(`origin/${def}`);

    stubs = stubPrompts({});
    await vscode.commands.executeCommand(
      'intellig.branch.checkoutAndRebase',
      remoteItem(`origin/${def}`)
    );

    for (let i = 0; i < 60 && (await currentBranch()) !== def; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.strictEqual(await currentBranch(), def, `must land on '${def}'; ${toastTrail()}`);
    // Real rebase, not a no-op: <def> is the remote-only commit replayed ON TOP
    // of feature — its parent is feature's tip and it is a NEW sha (the replay).
    assert.strictEqual(
      await revParse(`${def}^`),
      featureTip,
      `'${def}' must sit on top of feature after the rebase; ${toastTrail()}`
    );
    assert.notStrictEqual(
      await revParse(def),
      originSha,
      `the replayed commit must be a new sha, not the remote tip itself; ${toastTrail()}`
    );
    assert.ok(
      fs.existsSync(path.join(fix.rootPath, 'remote-only.txt')),
      `the remote commit's file must be present; ${toastTrail()}`
    );
    assert.ok(
      fs.existsSync(path.join(fix.rootPath, 'feature.txt')),
      `the rebase base's file must be present; ${toastTrail()}`
    );
    // The silent path stayed silent: the local <def> was an ancestor of the
    // remote tip, so the stale-local guard must not have prompted.
    assert.strictEqual(
      stubs.warningMessageCalls.length,
      0,
      `a fast-forward reset must not prompt; ${toastTrail()}`
    );
    assert.ok(
      stubs.informationMessageCalls.some((c) =>
        c.message.includes(`Checked out '${def}' and rebased onto 'feature'`)
      ),
      `the success toast must fire; ${toastTrail()}`
    );
  });

  /** Diverged fixture: local <def> has a commit origin lacks; HEAD on feature. */
  async function setupStaleLocal(): Promise<{ localOnlySha: string; featureTip: string }> {
    fix = await createFixtureRepo({ commits: 2, withRemote: true });
    const cwd = fix.rootPath;
    await landRemoteCommit('remote-only.txt');
    fs.writeFileSync(path.join(cwd, 'local-only.txt'), 'not pushed\n');
    await execGit(cwd, ['add', 'local-only.txt']);
    await execGit(cwd, ['commit', '-m', 'local-only commit']);
    const localOnlySha = (await execGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    await execGit(cwd, ['checkout', '-b', 'feature', 'HEAD~1']);
    fs.writeFileSync(path.join(cwd, 'feature.txt'), 'local feature work\n');
    await execGit(cwd, ['add', 'feature.txt']);
    await execGit(cwd, ['commit', '-m', 'feature: add feature.txt']);
    const featureTip = (await execGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    await execGit(cwd, ['fetch', 'origin']);
    await openWorkspace();
    return { localOnlySha, featureTip };
  }

  it('stale local + Cancel: every ref stays untouched', async () => {
    const { localOnlySha } = await setupStaleLocal();
    const def = fix.defaultBranch;

    stubs = stubPrompts({
      warningMessage: () => undefined, // dismiss = cancel
    });
    await vscode.commands.executeCommand(
      'intellig.branch.checkoutAndRebase',
      remoteItem(`origin/${def}`)
    );

    assert.ok(
      stubs.warningMessageCalls.some((c) =>
        c.message.includes(`has commits that are not on remote 'origin/${def}'`)
      ),
      `the reset must be gated on the confirm modal; ${toastTrail()}`
    );
    assert.strictEqual(await currentBranch(), 'feature', `HEAD must not move; ${toastTrail()}`);
    assert.strictEqual(
      await revParse(def),
      localOnlySha,
      `'${def}' must keep its local-only commit on Cancel; ${toastTrail()}`
    );
  });

  it('stale local + "Reset anyway": resets to the remote tip and completes the rebase', async () => {
    const { localOnlySha, featureTip } = await setupStaleLocal();
    const def = fix.defaultBranch;

    stubs = stubPrompts({
      warningMessage: (_msg, optionsOrItems, ...items) =>
        ([optionsOrItems, ...items].find((i) => i === 'Reset anyway') as string) ?? undefined,
    });
    await vscode.commands.executeCommand(
      'intellig.branch.checkoutAndRebase',
      remoteItem(`origin/${def}`)
    );

    for (let i = 0; i < 60 && (await currentBranch()) !== def; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.strictEqual(await currentBranch(), def, `must land on '${def}'; ${toastTrail()}`);
    // Without this the case passes even when the guard never fires: the reset
    // it asserts is what an unguarded handler does anyway.
    assert.ok(
      stubs.warningMessageCalls.some((c) =>
        c.message.includes(`has commits that are not on remote 'origin/${def}'`)
      ),
      `the reset must have been user-confirmed; ${toastTrail()}`
    );
    // The confirmed reset dropped the local-only commit from the branch...
    const containing = (
      await execGit(fix.rootPath, ['branch', '--contains', localOnlySha], { allowNonZero: true })
    ).stdout;
    assert.ok(
      !containing.includes(def),
      `'${def}' must no longer contain the dropped local-only commit; ${toastTrail()}`
    );
    // ...and the rebase onto feature still happened on the reset branch.
    assert.strictEqual(
      await revParse(`${def}^`),
      featureTip,
      `'${def}' must sit on top of feature after the confirmed reset; ${toastTrail()}`
    );
    assert.ok(
      !fs.existsSync(path.join(fix.rootPath, 'local-only.txt')),
      `the dropped commit's file must be gone from the tree; ${toastTrail()}`
    );
  });
});
