/**
 * Tier-2 E2E — branch-switch safety arms, tracked-branch delete cross-offer,
 * and conflicting tag cherry-pick (real git).
 *
 * Pins the checkout guard-rails git4idea's Smart Checkout defines:
 *
 *   1. a dirty TRACKED file that differs on the target branch → the
 *      Stash & Switch / Force Checkout / Cancel dialog; Stash & Switch is
 *      stash → checkout → unstash (the changes come back, the stash drains),
 *   2. an UNTRACKED collision → fatal refusal naming the files, with NO
 *      Stash & Switch offer (a stash can't move untracked files),
 *   3. deleting a local branch with an upstream → the matching remote
 *      deletion is offered,
 *   4. a conflicting `intellig.tag.cherryPick` pauses for resolution
 *      (CHERRY_PICK_HEAD present) instead of failing silently.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

function branchItem(
  name: string,
  repo: IRepository,
  upstream?: { remote: string; name: string }
): unknown {
  return {
    branch: { name, type: 'local', commit: '', isHead: false, ...(upstream ? { upstream } : {}) },
    repository: repo,
    getDetachedHeadSha: () => undefined,
  };
}

function tagItem(name: string, commit: string, repo: IRepository): unknown {
  return {
    tag: { name, commit, isAnnotated: false },
    repository: repo,
    getDetachedHeadSha: () => undefined,
  };
}

async function currentBranch(rootPath: string): Promise<string> {
  return (await execGit(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
}

describe('e2e — branch-switch arms, delete cross-offer, conflicting tag pick', function () {
  this.timeout(30_000);

  let fix: Fixture;
  let repo: IRepository;
  let stubs: PromptStubs;

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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

  const toastTrail = (): string =>
    `warn=${JSON.stringify(stubs.warningMessageCalls.map((c) => c.message))} ` +
    `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`;

  /**
   * ten-line f.txt committed on main; branch 'other' rewrites LINE 1 in a
   * commit; back on main line 10 is left dirty. Checking out 'other' must
   * then refuse (f.txt differs between the branches) while the stashed edit
   * still pops cleanly onto 'other' (disjoint lines).
   */
  async function setupDirtySwitchFixture(): Promise<void> {
    fix = await createFixtureRepo({ commits: 1 });
    const cwd = fix.rootPath;
    const f = path.join(cwd, 'f.txt');
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(f, lines.join('\n') + '\n');
    await execGit(cwd, ['add', 'f.txt']);
    await execGit(cwd, ['commit', '-m', 'add f.txt']);

    await execGit(cwd, ['checkout', '-b', 'other']);
    const otherLines = [...lines];
    otherLines[0] = 'line 1 (other)';
    fs.writeFileSync(f, otherLines.join('\n') + '\n');
    await execGit(cwd, ['commit', '-am', 'other: change line 1']);
    // Untracked collision target for the second test.
    fs.writeFileSync(path.join(cwd, 'u.txt'), 'committed on other\n');
    await execGit(cwd, ['add', 'u.txt']);
    await execGit(cwd, ['commit', '-m', 'other: add u.txt']);
    await execGit(cwd, ['checkout', fix.defaultBranch]);

    const dirty = [...lines];
    dirty[9] = 'line 10 (dirty local edit)';
    fs.writeFileSync(f, dirty.join('\n') + '\n');

    repo = await useFixtureWorkspace(cwd);
  }

  it('dirty tracked checkout offers Stash & Switch, which restores the edits on the new branch', async () => {
    await setupDirtySwitchFixture();
    const cwd = fix.rootPath;

    stubs = stubPrompts({
      // The dirty-checkout dialog passes its buttons WITHOUT an options
      // object, so the first button lands in the stub's `optionsOrItems`
      // slot — scan both.
      warningMessage: (_msg, optionsOrItems, ...items) =>
        ([optionsOrItems, ...items].find((i) => i === 'Stash & Switch') as string) ?? undefined,
    });

    await vscode.commands.executeCommand('intellig.branch.checkout', branchItem('other', repo));

    // The stash → checkout → unstash recovery continues after the dialog
    // resolves; poll for the switch instead of racing it.
    for (let i = 0; i < 60 && (await currentBranch(cwd)) !== 'other'; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.strictEqual(await currentBranch(cwd), 'other', `must land on 'other'; ${toastTrail()}`);
    // The pop is the last step of the recovery; wait for the stash to drain
    // before asserting on content.
    for (let i = 0; i < 40; i++) {
      if ((await execGit(cwd, ['stash', 'list'])).stdout.trim() === '') {
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // The dialog actually offered all three arms (first button rides the
    // `options` slot — see the stub note above).
    const buttons = (c: (typeof stubs.warningMessageCalls)[number]): unknown[] => [
      c.options,
      ...c.items,
    ];
    const offer = stubs.warningMessageCalls.find((c) => buttons(c).includes('Stash & Switch'));
    assert.ok(offer, `the Stash & Switch dialog must have been offered; ${toastTrail()}`);
    assert.ok(
      buttons(offer).includes('Force Checkout'),
      `Force Checkout must be offered alongside Stash & Switch; ${toastTrail()}`
    );

    // Smart Checkout = stash → checkout → UNSTASH: both the branch's line-1
    // change and the parked line-10 edit are present, and the auto-stash
    // drained back out of the stack.
    const content = fs.readFileSync(path.join(cwd, 'f.txt'), 'utf8');
    assert.ok(
      content.includes('line 1 (other)'),
      `branch content must be present; ${toastTrail()}`
    );
    assert.ok(
      content.includes('line 10 (dirty local edit)'),
      `the stashed local edit must be restored after the switch; ${toastTrail()}`
    );
    const stashes = (await execGit(cwd, ['stash', 'list'])).stdout.trim();
    assert.strictEqual(stashes, '', `the auto-stash must not linger in the stack; ${toastTrail()}`);
  });

  it('untracked collision refuses fatally with the file list and offers no Stash & Switch', async () => {
    await setupDirtySwitchFixture();
    const cwd = fix.rootPath;
    // Neutralise the tracked-dirt arm so only the untracked collision fires.
    await execGit(cwd, ['checkout', '--', 'f.txt']);
    fs.writeFileSync(path.join(cwd, 'u.txt'), 'local untracked\n');

    stubs = stubPrompts({
      warningMessage: (_msg, optionsOrItems, ...items) =>
        ([optionsOrItems, ...items].find((i) => i === 'Stash & Switch') as string) ?? undefined,
    });

    await vscode.commands.executeCommand('intellig.branch.checkout', branchItem('other', repo));

    assert.strictEqual(
      await currentBranch(cwd),
      fix.defaultBranch,
      `the checkout must not happen; ${toastTrail()}`
    );
    assert.strictEqual(
      fs.readFileSync(path.join(cwd, 'u.txt'), 'utf8'),
      'local untracked\n',
      `the untracked file must be untouched; ${toastTrail()}`
    );
    const errors = stubs.errorMessageCalls.map((c) => c.message);
    assert.ok(
      errors.some((m) => m.includes('u.txt')),
      `the refusal must name the colliding file; ${toastTrail()}`
    );
    assert.ok(
      !stubs.warningMessageCalls.some((c) => [c.options, ...c.items].includes('Stash & Switch')),
      `Stash & Switch must NOT be offered for untracked collisions; ${toastTrail()}`
    );
  });

  it('deleting a local branch with an upstream offers the matching remote deletion', async () => {
    fix = await createFixtureRepo({ commits: 2, withRemote: true });
    const cwd = fix.rootPath;
    await execGit(cwd, ['branch', 'tracked']);
    await execGit(cwd, ['push', '-u', 'origin', 'tracked']);
    repo = await useFixtureWorkspace(cwd);

    stubs = stubPrompts({
      // The delete confirm rides a warning toast; the tracked-branch
      // cascade rides an INFORMATION toast ("… is no longer tracked.").
      warningMessage: (_msg, _opts, ...items) => (items[0] as string) ?? undefined,
      informationMessage: (_msg, ...items) =>
        (items.find((i) => i === 'Delete Tracked Branch') as string) ?? undefined,
    });

    await vscode.commands.executeCommand(
      'intellig.branch.delete',
      branchItem('tracked', repo, { remote: 'origin', name: 'tracked' })
    );
    // The cross-offer is fired without awaiting the command's resolution;
    // poll for the remote-side effect.
    for (let i = 0; i < 60; i++) {
      const remoteRefs = (
        await execGit(fix.remotePath!, ['branch', '--list', 'tracked'])
      ).stdout.trim();
      if (remoteRefs === '') {
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    const local = (await execGit(cwd, ['branch', '--list', 'tracked'])).stdout.trim();
    assert.strictEqual(local, '', `the local branch must be deleted; ${toastTrail()}`);
    const infoTrail = JSON.stringify(stubs.informationMessageCalls);
    assert.ok(
      stubs.informationMessageCalls.some(
        (c) => /Deleted branch 'tracked'/.test(c.message) && /no longer tracked/.test(c.message)
      ),
      `the remote-deletion cross-offer must fire after the local delete; info=${infoTrail}`
    );
    const remote = (await execGit(fix.remotePath!, ['branch', '--list', 'tracked'])).stdout.trim();
    assert.strictEqual(
      remote,
      '',
      `accepting the offer must delete origin/tracked; info=${infoTrail}`
    );
  });

  it('a conflicting tag cherry-pick pauses for resolution instead of failing silently', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    const cwd = fix.rootPath;
    const f = path.join(cwd, 'pick.txt');

    fs.writeFileSync(f, 'base\n');
    await execGit(cwd, ['add', 'pick.txt']);
    await execGit(cwd, ['commit', '-m', 'add pick.txt']);

    await execGit(cwd, ['checkout', '-b', 'side']);
    fs.writeFileSync(f, 'side change\n');
    await execGit(cwd, ['commit', '-am', 'side: change pick.txt']);
    const tagSha = (await execGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    await execGit(cwd, ['tag', 'v-conf']);
    await execGit(cwd, ['checkout', fix.defaultBranch]);
    fs.writeFileSync(f, 'main change\n');
    await execGit(cwd, ['commit', '-am', 'main: change pick.txt']);

    repo = await useFixtureWorkspace(cwd);
    stubs = stubPrompts({
      warningMessage: (_msg, _opts, ...items) => (items[0] as string) ?? undefined,
    });

    await vscode.commands.executeCommand(
      'intellig.tag.cherryPick',
      tagItem('v-conf', tagSha, repo)
    );

    // Paused mid-pick: CHERRY_PICK_HEAD present, the file unmerged, and
    // nothing claimed the pick was aborted.
    assert.ok(
      fs.existsSync(path.join(cwd, '.git', 'CHERRY_PICK_HEAD')),
      `the conflicted cherry-pick must stay in progress; ${toastTrail()}`
    );
    const unmerged = (await execGit(cwd, ['ls-files', '-u', '--', 'pick.txt'])).stdout.trim();
    assert.ok(unmerged.length > 0, `pick.txt must be unmerged at the pause; ${toastTrail()}`);
    assert.ok(
      !stubs.errorMessageCalls
        .map((c) => c.message)
        .concat(stubs.warningMessageCalls.map((c) => c.message))
        .some((m) => /aborted/i.test(m)),
      `nothing may claim the pick was aborted; ${toastTrail()}`
    );
  });
});
