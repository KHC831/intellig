/**
 * Tier-2 E2E — stash apply/pop prompt contract, Clear All, and the unstash
 * overwrite arms (real git).
 *
 * Pins the reference contracts from GitUnstashDialog / GitStashUtils:
 *
 *   1. the interactive apply's reinstate-index prompt puts "Working tree
 *      only" FIRST (the default), and taking it applies WITHOUT --index,
 *   2. Clear All Stashes confirms naming the real count, then clears,
 *   3. an apply blocked by local changes / an untracked collision surfaces
 *      a message NAMING the files, not a generic failure toast.
 *
 * The suite constructs a StashView against the live GitService — the same
 * class both the sidebar and the CTW Shelf tab route through (one seam) —
 * and asserts real git state plus the recorded prompt trail.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';
import { StashView } from '../../../src/shelf/StashView';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

describe('e2e — stash prompts, clear-all, and overwrite arms', function () {
  this.timeout(30_000);

  let fix: Fixture;
  let repo: IRepository;
  let view: StashView;
  let stubs: PromptStubs;

  async function setup(): Promise<void> {
    fix = await createFixtureRepo({ commits: 2 });
    repo = await useFixtureWorkspace(fix.rootPath);
    view = new StashView(getServices()!.gitService);
    view.setRepository(repo);
  }

  afterEach(async () => {
    if (stubs) {
      stubs.restore();
    }
    if (view) {
      view.dispose();
    }
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  const toastTrail = (): string =>
    `warn=${JSON.stringify(stubs.warningMessageCalls.map((c) => c.message))} ` +
    `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))} ` +
    `info=${JSON.stringify(stubs.informationMessageCalls.map((c) => c.message))}`;

  it("interactive apply offers 'Working tree only' first and applies without --index", async () => {
    await setup();
    const cwd = fix.rootPath;
    const f = path.join(cwd, 'file0.txt');

    // A stash with a STAGED change — so --index vs no-index is observable.
    fs.writeFileSync(f, 'stashed change\n');
    await execGit(cwd, ['add', 'file0.txt']);
    await execGit(cwd, ['stash', 'push', '-m', 'staged change']);

    let offeredLabels: string[] = [];
    stubs = stubPrompts({
      quickPick: (items) => {
        const arr = items as Array<{ label: string }>;
        offeredLabels = arr.map((i) => i.label);
        return arr[0]; // take the default (first) entry
      },
    });

    await view.refresh();
    const result = await view.applyStashInteractive(0);
    assert.ok(result.success, `apply must succeed; ${toastTrail()}`);

    assert.ok(
      offeredLabels.length >= 2 && offeredLabels[0].includes('Working tree only'),
      `'Working tree only' must be the FIRST (default) choice; got ${JSON.stringify(offeredLabels)}`
    );

    // Applied to the working tree only: content is back, nothing staged.
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'stashed change\n');
    const staged = (await execGit(cwd, ['diff', '--cached', '--name-only'])).stdout.trim();
    assert.strictEqual(staged, '', `nothing may be staged without --index; ${toastTrail()}`);
  });

  it('Clear All Stashes confirms with the real count and clears the stack', async () => {
    await setup();
    const cwd = fix.rootPath;
    const f = path.join(cwd, 'file0.txt');

    fs.writeFileSync(f, 'first\n');
    await execGit(cwd, ['stash', 'push', '-m', 'first']);
    fs.writeFileSync(f, 'second\n');
    await execGit(cwd, ['stash', 'push', '-m', 'second']);

    stubs = stubPrompts({
      warningMessage: (msg, _opts, ...items) =>
        /All 2 stashes/.test(msg)
          ? ((items.find((i) => i === 'Clear') as string) ?? undefined)
          : undefined,
    });

    await view.refresh();
    const result = await view.clearAllStashes();
    assert.ok(result.success, `clear must succeed after the confirm; ${toastTrail()}`);

    assert.ok(
      stubs.warningMessageCalls.some((c) => /All 2 stashes/.test(c.message)),
      `the confirm must name the real count; ${toastTrail()}`
    );
    const stashes = (await execGit(cwd, ['stash', 'list'])).stdout.trim();
    assert.strictEqual(stashes, '', `the stack must be empty after Clear; ${toastTrail()}`);
  });

  it('an apply blocked by local changes names the files instead of a generic failure', async () => {
    await setup();
    const cwd = fix.rootPath;
    const f = path.join(cwd, 'file0.txt');

    fs.writeFileSync(f, 'stashed version\n');
    await execGit(cwd, ['stash', 'push', '-m', 'to conflict']);
    // Local dirt on the same file blocks the apply outright.
    fs.writeFileSync(f, 'local dirt\n');

    stubs = stubPrompts({});
    await view.refresh();
    const result = await view.applyStash(0, false);
    assert.ok(!result.success, `the apply must fail against local dirt; ${toastTrail()}`);

    const all = stubs.errorMessageCalls
      .map((c) => c.message)
      .concat(stubs.warningMessageCalls.map((c) => c.message));
    assert.ok(
      all.some((m) => m.includes('file0.txt')),
      `the failure must NAME the blocking file; ${toastTrail()}`
    );

    // Nothing was half-applied and the stash entry survived.
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'local dirt\n');
    const stashes = (await execGit(cwd, ['stash', 'list'])).stdout;
    assert.ok(stashes.includes('to conflict'), `the stash entry must survive; ${toastTrail()}`);
  });

  it('an apply blocked by an untracked collision names the untracked files', async () => {
    await setup();
    const cwd = fix.rootPath;
    const u = path.join(cwd, 'u.txt');

    // Stash containing an untracked file...
    fs.writeFileSync(u, 'stashed untracked\n');
    await execGit(cwd, ['stash', 'push', '-u', '-m', 'with untracked']);
    // ...and a new untracked file of the same name in the way.
    fs.writeFileSync(u, 'local untracked\n');

    stubs = stubPrompts({});
    await view.refresh();
    const result = await view.applyStash(0, false);
    assert.ok(!result.success, `the apply must fail on the untracked collision; ${toastTrail()}`);

    const all = stubs.errorMessageCalls
      .map((c) => c.message)
      .concat(stubs.warningMessageCalls.map((c) => c.message));
    assert.ok(
      all.some((m) => m.includes('u.txt')),
      `the failure must NAME the colliding untracked file; ${toastTrail()}`
    );
    assert.strictEqual(
      fs.readFileSync(u, 'utf8'),
      'local untracked\n',
      `the local untracked file must be untouched; ${toastTrail()}`
    );
  });
});
