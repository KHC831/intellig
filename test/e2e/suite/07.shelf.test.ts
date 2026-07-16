/**
 * Tier-2 E2E — shelf commands.
 *
 * Covers:
 *   - `intellig.shelve.silent`   — captures the active changelist without
 *                                  prompting. Depends on
 *                                  `ChangelistService.reconcileWithGitStatus()`
 *                                  running so the active changelist has
 *                                  the dirty files; reconcile is
 *                                  always-on, which makes this spec
 *                                  feasible.
 *   - `intellig.unshelve.silent` — unshelves the single pending entry
 *                                  without prompting.
 *   - `intellig.showShelfList`   — opens the shelf quick pick.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';
import { getServices, getCommitToolWindow } from '../support/activatedExtension';
import { injectRecordingView, lastPushedStashNames, pollUntil } from '../support/ctwLiveHarness';

describe('e2e — shelf commands', function () {
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

  it('intellig.shelve.silent — captures a dirty tracked file into a new shelf entry', async () => {
    fix = await createFixtureRepo({ commits: 1 });

    // `ShelfService.shelve` diffs via `git diff -- <path>`, which needs a
    // tracked + modified file. Commit first, then mutate.
    const fpath = path.join(fix.rootPath, 'dirty.txt');
    fs.writeFileSync(fpath, 'original\n');
    await execGit(fix.rootPath, ['add', 'dirty.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'add dirty.txt']);
    fs.writeFileSync(fpath, 'modified\n');

    const repo = await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    const services = getServices();
    assert.ok(services, 'extension services not initialised');

    // Pre-condition: shelf is empty.
    const before = services.shelfService.getShelfItems(repo);
    assert.strictEqual(before.length, 0, 'sanity: shelf should start empty');

    // Note: we do NOT need to await the ~550ms watcher+reconcile debounce
    // chain (watcher 250ms + reconcile 300ms) that normally populates the
    // default changelist via `onDidChangeRepository`. The
    // `intellig.shelve.silent` handler awaits
    // `changelistService.reconcileWithGitStatus(repo)` inline before reading
    // the active changelist (see extension.ts:993), so the store is brought
    // in sync synchronously against `git status` at the moment of the
    // command call. This is intentional in the handler: the user pressing
    // Ctrl+Shift+H expects the just-edited file to be captured regardless
    // of debounce state.
    await vscode.commands.executeCommand('intellig.shelve.silent');

    // Post-conditions:
    //   1. Exactly one new shelf entry exists.
    //   2. The entry references `dirty.txt` in its file list.
    //   3. The working-tree copy of `dirty.txt` has been reset to HEAD
    //      content (shelve is capture + reset).
    const after = services.shelfService.getShelfItems(repo);
    assert.strictEqual(after.length, 1, `expected exactly one shelf item, got ${after.length}`);
    assert.ok(
      after[0].files.some((f) => f.path === 'dirty.txt'),
      `shelf entry should reference dirty.txt; got files=${JSON.stringify(after[0].files.map((f) => f.path))}`
    );
    assert.strictEqual(
      fs.readFileSync(fpath, 'utf8'),
      'original\n',
      'shelve should restore the working-tree copy to HEAD content'
    );
  });

  it('intellig.unshelve.silent — restores a pre-seeded shelf entry to the working tree', async () => {
    fix = await createFixtureRepo({ commits: 1 });

    // Tracked + modified file so `git diff --` has output.
    const fpath = path.join(fix.rootPath, 'round-trip.txt');
    fs.writeFileSync(fpath, 'original\n');
    await execGit(fix.rootPath, ['add', 'round-trip.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'add round-trip.txt']);
    fs.writeFileSync(fpath, 'round trip content\n');

    const repo = await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    const services = getServices();
    assert.ok(services, 'extension services not initialised');

    const seeded = await services.shelfService.shelve(repo, 'e2e-seed', {
      files: ['round-trip.txt'],
    });
    assert.strictEqual(
      fs.readFileSync(fpath, 'utf8'),
      'original\n',
      'sanity: seed shelve should restore file to HEAD content'
    );

    await vscode.commands.executeCommand('intellig.unshelve.silent');
    // Grace window for the async unshelve patch-apply.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const restored = fs.readFileSync(fpath, 'utf8');
    assert.strictEqual(
      restored,
      'round trip content\n',
      `unshelved content should match what was shelved; got: ${JSON.stringify(restored)}`
    );

    // Post-condition: `unshelveSilent` uses `removeFromShelf: true`, so the
    // seeded entry is removed from the shelf after a successful apply.
    const items = services.shelfService.getShelfItems(repo);
    const entry = items.find((i) => i.id === seeded.id);
    assert.strictEqual(
      entry,
      undefined,
      'unshelveSilent should remove the applied entry from the shelf'
    );
  });

  it('intellig.unshelve.silent — no-op when there are no pending shelf entries', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    // With nothing shelved, the command should return quietly without
    // throwing or mutating the working tree.
    await vscode.commands.executeCommand('intellig.unshelve.silent');
  });

  it('CTW live updates — external stash push and NON-TOP drop reach the pushed model', async function () {
    this.timeout(45_000);
    fix = await createFixtureRepo({ commits: 1 });
    const fpath = path.join(fix.rootPath, 'file0.txt');
    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    const ctw = getCommitToolWindow();
    assert.ok(ctw, 'commit tool window singleton not initialised');
    const rec = injectRecordingView(ctw);
    try {
      // Two external stashes from "a terminal" (real git subprocess).
      fs.writeFileSync(fpath, 'stash-me-1\n');
      await execGit(fix.rootPath, ['stash', 'push', '-m', 'e2e-first']);
      await pollUntil(
        () => lastPushedStashNames(rec.posted).some((n) => n.includes('e2e-first')),
        20_000,
        'first external stash never reached an updateModel push'
      );

      fs.writeFileSync(fpath, 'stash-me-2\n');
      await execGit(fix.rootPath, ['stash', 'push', '-m', 'e2e-second']);
      await pollUntil(
        () => lastPushedStashNames(rec.posted).some((n) => n.includes('e2e-second')),
        20_000,
        'second external stash never reached an updateModel push'
      );

      // The reflog case: dropping the NON-TOP stash rewrites only
      // .git/logs/refs/stash — this leg fails without that watcher entry.
      await execGit(fix.rootPath, ['stash', 'drop', 'stash@{1}']);
      await pollUntil(
        () => {
          const names = lastPushedStashNames(rec.posted);
          return (
            names.some((n) => n.includes('e2e-second')) &&
            !names.some((n) => n.includes('e2e-first'))
          );
        },
        20_000,
        'non-top stash drop never reached an updateModel push (logs/refs/stash watcher)'
      );

      // Host mirror agrees with the pushed wire model.
      const mirror = rec.stashEntries().map((s) => s.message);
      assert.strictEqual(
        mirror.length,
        1,
        `expected one stash in the host mirror, got ${JSON.stringify(mirror)}`
      );
      assert.ok(
        mirror[0].includes('e2e-second'),
        `host mirror should hold the surviving stash; got ${mirror[0]}`
      );
    } finally {
      rec.restore();
    }
  });

  it('intellig.showShelfList — opens without throwing on an empty shelf', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    // The command creates a QuickPick via `createQuickPick()`. We don't
    // wait for user interaction — just verify the call completes without
    // throwing. The QuickPick UI auto-disposes when the test ends.
    await vscode.commands.executeCommand('intellig.showShelfList');
  });
});
