/**
 * Tier-2 E2E — shelf commands.
 *
 * Covers:
 *   - `intellig.unshelve.silent`  — unshelves the single pending entry
 *                                    without prompting.
 *   - `intellig.showShelfList`    — opens the shelf quick pick.
 *
 * `intellig.shelve.silent` is NOT exercised end-to-end here. The wrapping
 * command body calls `ChangelistService.reconcileWithGitStatus()` to
 * populate the active changelist before shelving; reconcile is a no-op
 * unless the service was constructed with a GitService reference, and the
 * production wiring at `ExtensionServices.initialize()` omits that argument
 * (see `ChangelistService` constructor signature + `ExtensionServices.ts`
 * line ~224). Running the command against a dirty fixture repo deterministically
 * short-circuits at "No files in active changelist" — a real production bug.
 * Per the Tier-2 task directive, this test PR flags the bug rather than
 * patching it. Follow-up: wire `gitService` into `ChangelistService` inside
 * `ExtensionServices.initialize()` (one-line fix).
 *
 * To still verify the *unshelve* path end-to-end we seed an entry via the
 * `ShelfService` direct API in `beforeEach`, then run the silent-unshelve
 * command through `executeCommand` like every other test.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { createFixtureRepo, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';
import { getServices } from '../../../extension';

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

  it('intellig.unshelve.silent — restores a pre-seeded shelf entry to the working tree', async () => {
    fix = await createFixtureRepo({ commits: 1 });

    // The shelf service diffs via `git diff -- <path>`, which only returns
    // output for tracked files. Commit the file first, then modify it so
    // the diff is non-empty.
    const fpath = path.join(fix.rootPath, 'round-trip.txt');
    fs.writeFileSync(fpath, 'original\n');
    const { execGit } = await import('../support/gitFixture');
    await execGit(fix.rootPath, ['add', 'round-trip.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'add round-trip.txt']);
    fs.writeFileSync(fpath, 'round trip content\n');

    const repo = await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    const services = getServices();
    assert.ok(services, 'extension services not initialised');

    // Seed a shelf entry directly (bypasses the shelve-silent bug). The
    // ShelfService.shelve() API resets the working-tree file to HEAD as
    // part of capture.
    const seeded = await services!.shelfService.shelve(repo, 'e2e-seed', {
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
    const items = services!.shelfService.getShelfItems(repo);
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
