/**
 * Tier-2 E2E — shelf and stash actions stay correct when the list they act on
 * has moved since the row was captured.
 *
 * A shelf entry is addressed by a stable id, so this half is a positive
 * control: proves the right entry among several is actually mutated (file
 * content restored, sibling entries untouched) rather than merely "doesn't
 * throw". A stash is addressed by POSITION, and git renumbers the whole
 * stack on every drop — `StashView` re-validates the sha at that position
 * before acting, and this suite drives that re-validation against a REAL
 * `git stash` stack, not a mock: a stale row must refuse rather than act on
 * whatever now sits at its old index.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';
import { StashView } from '../../../src/shelf/StashView';

describe('e2e — shelf and stash actions against a mutating list', function () {
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

  it('unshelves the correct entry by id after a sibling entry was removed from the list', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    const cwd = fix.rootPath;
    for (const f of ['a.txt', 'b.txt', 'c.txt']) {
      fs.writeFileSync(path.join(cwd, f), `head-${f}\n`);
    }
    await execGit(cwd, ['add', 'a.txt', 'b.txt', 'c.txt']);
    await execGit(cwd, ['commit', '-m', 'seed a/b/c']);

    const repo = await useFixtureWorkspace(cwd);
    stubs = stubPrompts({});
    const services = getServices();
    assert.ok(services, 'extension services not initialised');

    // Three independent shelved changesets — each shelve resets its own file
    // to HEAD before the next edit, so the three entries stay distinguishable.
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'shelved-a\n');
    const shelfA = await services.shelfService.shelve(repo, 'shelf-a', { files: ['a.txt'] });
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'shelved-b\n');
    const shelfB = await services.shelfService.shelve(repo, 'shelf-b', { files: ['b.txt'] });
    fs.writeFileSync(path.join(cwd, 'c.txt'), 'shelved-c\n');
    await services.shelfService.shelve(repo, 'shelf-c', { files: ['c.txt'] });

    // The list moves out from under a pending action on shelf-b's row.
    services.shelfService.deleteShelfItem(repo, shelfA.id);

    const result = await services.shelfService.unshelve(repo, shelfB.id);
    assert.ok(
      result.success,
      `unshelve of shelf-b must succeed; conflicts=${JSON.stringify(result.conflicts)}`
    );

    assert.strictEqual(
      fs.readFileSync(path.join(cwd, 'b.txt'), 'utf8'),
      'shelved-b\n',
      "b.txt must carry shelf-b's content — a position-based resolution would have hit a different entry"
    );
    assert.strictEqual(
      fs.readFileSync(path.join(cwd, 'c.txt'), 'utf8'),
      'head-c.txt\n',
      'c.txt must be untouched — shelf-c was never applied'
    );

    const remaining = services.shelfService.getShelfItems(repo).map((i) => i.name);
    assert.deepStrictEqual(
      remaining.sort(),
      ['shelf-c'],
      'only shelf-c should remain active: shelf-a was deleted, shelf-b was applied'
    );
  });

  it('drop refuses a row whose index drifted to a different stash, leaving both real stashes intact', async () => {
    fix = await createFixtureRepo({ commits: 3 });
    const cwd = fix.rootPath;
    const repo = await useFixtureWorkspace(cwd);
    stubs = stubPrompts({
      warningMessage: (_msg, _opts, ...items) =>
        (items.find((i) => i === 'Drop') as string | undefined) ?? undefined,
    });

    const view = new StashView(getServices()!.gitService);
    view.setRepository(repo);
    try {
      fs.writeFileSync(path.join(cwd, 'file0.txt'), 'stash-A\n');
      await execGit(cwd, ['stash', 'push', '-m', 'A']);
      fs.writeFileSync(path.join(cwd, 'file1.txt'), 'stash-B\n');
      await execGit(cwd, ['stash', 'push', '-m', 'B']);
      fs.writeFileSync(path.join(cwd, 'file2.txt'), 'stash-C\n');
      await execGit(cwd, ['stash', 'push', '-m', 'C']);
      // Stack: 0=C, 1=B, 2=A.

      await view.refresh();
      const rowB = view.getState().stashes.find((s) => s.stash.message === 'B');
      assert.ok(rowB, 'sanity: stash B must be in the freshly-refreshed list');
      assert.strictEqual(rowB.stash.index, 1, 'sanity: B starts at index 1');
      assert.ok(rowB.stash.hash, 'sanity: the real stash list must carry a sha per entry');

      // The stack renumbers from under the captured row: dropping C (index 0)
      // from elsewhere shifts A down into B's old slot (index 1).
      await execGit(cwd, ['stash', 'drop', 'stash@{0}']);

      const result = await view.dropStash(rowB.stash.index, rowB.stash.hash);
      assert.strictEqual(
        result.success,
        false,
        'a drifted row must refuse rather than drop whatever now sits at that index'
      );

      const listAfter = (await execGit(cwd, ['stash', 'list'])).stdout;
      assert.ok(
        listAfter.includes(': B'),
        `stash B must survive the refused drop; got: ${listAfter}`
      );
      assert.ok(
        listAfter.includes(': A'),
        `stash A, now at the stale index, must NOT have been dropped instead; got: ${listAfter}`
      );
    } finally {
      view.dispose();
    }
  });

  it('drop resolves the correct entry among several when the row is still current', async () => {
    fix = await createFixtureRepo({ commits: 3 });
    const cwd = fix.rootPath;
    const repo = await useFixtureWorkspace(cwd);
    stubs = stubPrompts({
      warningMessage: (_msg, _opts, ...items) =>
        (items.find((i) => i === 'Drop') as string | undefined) ?? undefined,
    });

    const view = new StashView(getServices()!.gitService);
    view.setRepository(repo);
    try {
      fs.writeFileSync(path.join(cwd, 'file0.txt'), 'stash-A\n');
      await execGit(cwd, ['stash', 'push', '-m', 'A']);
      fs.writeFileSync(path.join(cwd, 'file1.txt'), 'stash-B\n');
      await execGit(cwd, ['stash', 'push', '-m', 'B']);
      fs.writeFileSync(path.join(cwd, 'file2.txt'), 'stash-C\n');
      await execGit(cwd, ['stash', 'push', '-m', 'C']);

      await view.refresh();
      const rowB = view.getState().stashes.find((s) => s.stash.message === 'B');
      assert.ok(rowB, 'sanity: stash B must be in the freshly-refreshed list');

      const result = await view.dropStash(rowB.stash.index, rowB.stash.hash);
      assert.ok(
        result.success,
        `drop of the still-current row B must succeed; error=${result.error}`
      );

      const listAfter = (await execGit(cwd, ['stash', 'list'])).stdout;
      assert.ok(!listAfter.includes(': B'), `stash B must be gone; got: ${listAfter}`);
      assert.ok(listAfter.includes(': A'), `stash A must survive untouched; got: ${listAfter}`);
      assert.ok(listAfter.includes(': C'), `stash C must survive untouched; got: ${listAfter}`);
    } finally {
      view.dispose();
    }
  });
});
