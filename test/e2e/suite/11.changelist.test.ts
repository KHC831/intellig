/**
 * Tier-2 E2E — changelist commands.
 *
 * Covers:
 *   - `intellig.changelist.new` — creates a new changelist via the input-box
 *     prompt. We assert the ChangelistService sees the new entry.
 *
 * The changelist store is backed by workspaceState, not git, so we can't
 * use `git` to verify — we read back through the extension's service.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { createFixtureRepo, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';

describe('e2e — changelist commands', function () {
  this.timeout(15_000);

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

  it('intellig.changelist.new — creates a named changelist via the input box', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    await useFixtureWorkspace(fix.rootPath);

    // The flow asks name → description (input boxes) → make-active
    // QuickPick; answer the name, skip the description, keep the default.
    let inputCall = 0;
    stubs = stubPrompts({
      inputBox: () => (++inputCall === 1 ? 'Urgent Fix' : ''),
      quickPick: (items) => (items as Array<{ label: string }>)[0],
    });

    const services = getServices();
    assert.ok(services, 'extension services not initialised');
    const repos = services.gitService.getRepositories();
    assert.ok(repos.length > 0, 'fixture repo should be discovered');
    const repo = repos[0];

    // Default changelist is always present; snapshot how many existed before
    // creation so we can verify our new one was added.
    const before = services.changelistService.getChangelists(repo);

    await vscode.commands.executeCommand('intellig.changelist.new');

    const after = services.changelistService.getChangelists(repo);
    assert.strictEqual(
      after.length,
      before.length + 1,
      `expected one new changelist; before=${before.length}, after=${after.length}`
    );
    assert.ok(
      after.some((cl) => cl.name === 'Urgent Fix'),
      `new changelist "Urgent Fix" not found in ${after.map((cl) => cl.name).join(', ')}`
    );
  });

  it('intellig.changelist.new — empty input cancels creation', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    await useFixtureWorkspace(fix.rootPath);

    stubs = stubPrompts({
      inputBox: () => undefined,
    });

    const services = getServices();
    assert.ok(services, 'extension services not initialised');
    const repos = services.gitService.getRepositories();
    const repo = repos[0];

    const before = services.changelistService.getChangelists(repo).length;
    await vscode.commands.executeCommand('intellig.changelist.new');
    const after = services.changelistService.getChangelists(repo).length;

    assert.strictEqual(after, before, 'cancel must not create a changelist');
  });

  it('intellig.changelist.rename — renames the target changelist via the input box', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    const repo = await useFixtureWorkspace(fix.rootPath);

    const services = getServices();
    assert.ok(services);

    // Seed a non-default changelist to rename.
    const created = services.changelistService.createChangelist(repo, 'Original Name');

    stubs = stubPrompts({
      inputBox: () => 'Renamed',
    });

    await vscode.commands.executeCommand('intellig.changelist.rename', created.id);

    const after = services.changelistService.getChangelists(repo);
    const renamed = after.find((cl) => cl.id === created.id);
    assert.ok(renamed, 'changelist should still exist after rename');
    assert.strictEqual(renamed.name, 'Renamed', 'name should reflect the new input');
  });

  it('intellig.changelist.setActive — activates the specified changelist id', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    const repo = await useFixtureWorkspace(fix.rootPath);

    const services = getServices();
    assert.ok(services);
    const created = services.changelistService.createChangelist(repo, 'Make Me Active');

    stubs = stubPrompts({});
    await vscode.commands.executeCommand('intellig.changelist.setActive', created.id);

    const active = await services.changelistService.getActiveChangelist(repo);
    assert.strictEqual(
      active.id,
      created.id,
      'active changelist should switch to the one we targeted'
    );
  });

  it('intellig.changelist.delete — removes the target changelist from the list', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    const repo = await useFixtureWorkspace(fix.rootPath);

    const services = getServices();
    assert.ok(services);
    const created = services.changelistService.createChangelist(repo, 'Deletable');

    stubs = stubPrompts({});
    await vscode.commands.executeCommand('intellig.changelist.delete', created.id);

    const remaining = services.changelistService.getChangelists(repo);
    assert.strictEqual(
      remaining.find((cl) => cl.id === created.id),
      undefined,
      'deleted changelist should be gone'
    );
  });
});
