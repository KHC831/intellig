/**
 * Tier-2 E2E — history-rewrite gates (real git).
 *
 * Pins the refusal gates in front of the history-rewrite runner and the
 * undo-commit flow:
 *
 *   1. dropping a commit BELOW a merge is refused before any rebase starts
 *      (a linear rebase would silently flatten the merge),
 *   2. rewriting a commit reachable from a protected remote branch is
 *      refused naming the branch (IntelliJ GitCommitEditingActionBase +
 *      GitSharedSettings parity — main/master are protected by default),
 *   3. Undo Commit on HEAD resets to the parent, keeps the changes, and
 *      routes them to the changelist picked in the chooser.
 *
 * Like 29.dropConflict, actions enter through `_handleAction` on the live
 * CommitContextMenuCommands instance — these menu actions have no palette
 * command.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';
import { getCommitContextMenuCommands, getServices } from '../support/activatedExtension';
import type { IMenuStateNode } from '../../../src/git-core/gitToolWindow/multiSelect';

describe('e2e — history-rewrite gates', function () {
  this.timeout(30_000);

  let fix: Fixture;
  let stubs: PromptStubs;

  afterEach(async () => {
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

  /** Newest-first commit nodes as the rendered log would supply them. */
  async function logNodes(cwd: string): Promise<IMenuStateNode[]> {
    const log = await execGit(cwd, ['log', '--pretty=format:%H %P']);
    return log.stdout
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const [hash, ...parents] = line.trim().split(/\s+/);
        return { hash, parentCount: parents.length, parents };
      });
  }

  const toastTrail = (): string =>
    `warn=${JSON.stringify(stubs.warningMessageCalls.map((c) => c.message))} ` +
    `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`;

  it('drop of a commit below a merge is refused before any rebase starts', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    const cwd = fix.rootPath;

    // below.txt lands BELOW the merge; the merge joins a side branch; one
    // more commit sits above it so the drop target is strictly below.
    fs.writeFileSync(path.join(cwd, 'below.txt'), 'below\n');
    await execGit(cwd, ['add', 'below.txt']);
    await execGit(cwd, ['commit', '-m', 'below the merge']);
    const shaBelow = (await execGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();

    await execGit(cwd, ['checkout', '-b', 'side']);
    fs.writeFileSync(path.join(cwd, 'side.txt'), 'side\n');
    await execGit(cwd, ['add', 'side.txt']);
    await execGit(cwd, ['commit', '-m', 'side work']);
    await execGit(cwd, ['checkout', fix.defaultBranch]);
    await execGit(cwd, ['merge', '--no-ff', 'side', '-m', 'merge side']);
    fs.writeFileSync(path.join(cwd, 'above.txt'), 'above\n');
    await execGit(cwd, ['add', 'above.txt']);
    await execGit(cwd, ['commit', '-m', 'above the merge']);

    await useFixtureWorkspace(cwd);
    const preHead = (await execGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();

    stubs = stubPrompts({
      warningMessage: (_msg, _opts, ...items) =>
        (items.find((i) => i === 'Drop') as string) ?? undefined,
    });

    const menu = getCommitContextMenuCommands();
    assert.ok(menu, 'CommitContextMenuCommands not initialised');
    await menu._handleAction('dropCommit', [shaBelow], await logNodes(cwd));

    // Refused: no rebase started, HEAD untouched, the target still exists.
    assert.ok(
      !fs.existsSync(path.join(cwd, '.git', 'rebase-merge')),
      `no rebase may start for a below-merge drop; ${toastTrail()}`
    );
    const head = (await execGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.strictEqual(head, preHead, `HEAD must be untouched; ${toastTrail()}`);

    const all = stubs.errorMessageCalls
      .map((c) => c.message)
      .concat(stubs.warningMessageCalls.map((c) => c.message));
    assert.ok(
      all.some((m) => /merge/i.test(m)),
      `the refusal must name the merge as the reason; ${toastTrail()}`
    );
  });

  it('rewrite of a commit on a protected remote branch is refused naming the branch', async () => {
    // withRemote pushes the default branch ('main') to origin — and 'main'
    // is protected by the DEFAULT intellig.protectedBranches value, exactly
    // the state a fresh clone of a real project is in.
    fix = await createFixtureRepo({ commits: 3, withRemote: true });
    const cwd = fix.rootPath;
    await useFixtureWorkspace(cwd);

    const nodes = await logNodes(cwd);
    // A pushed, non-tip commit — rewritable shape, but published.
    const target = nodes[1].hash;
    const preHead = (await execGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();

    stubs = stubPrompts({
      warningMessage: (_msg, _opts, ...items) =>
        (items.find((i) => i === 'Drop') as string) ?? undefined,
    });

    const menu = getCommitContextMenuCommands();
    assert.ok(menu, 'CommitContextMenuCommands not initialised');

    await menu._handleAction('dropCommit', [target], nodes);
    await menu._handleAction('editCommitMessage', [target], nodes);

    assert.ok(
      !fs.existsSync(path.join(cwd, '.git', 'rebase-merge')),
      `no rebase may start on a protected branch; ${toastTrail()}`
    );
    const head = (await execGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.strictEqual(head, preHead, `HEAD must be untouched; ${toastTrail()}`);

    const refusals = stubs.errorMessageCalls
      .map((c) => c.message)
      .concat(stubs.warningMessageCalls.map((c) => c.message))
      .filter((m) => m.includes('origin/main'));
    assert.strictEqual(
      refusals.length,
      2,
      `both drop and reword must refuse naming origin/main; ${toastTrail()}`
    );
  });

  it('undo commit resets to the parent, keeps changes, and routes them to the chosen changelist', async () => {
    fix = await createFixtureRepo({ commits: 2 });
    const cwd = fix.rootPath;

    fs.writeFileSync(path.join(cwd, 'undone.txt'), 'to be undone\n');
    await execGit(cwd, ['add', 'undone.txt']);
    await execGit(cwd, ['commit', '-m', 'Add undone.txt']);
    const tip = (await execGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    const parent = (await execGit(cwd, ['rev-parse', 'HEAD~1'])).stdout.trim();

    const repo = await useFixtureWorkspace(cwd);

    stubs = stubPrompts({
      // Undo Commit's changelist chooser: take the suggested "New changelist"
      // entry derived from the commit subject.
      quickPick: (items) => {
        const arr = items as Array<{ label: string }>;
        return arr.find((i) => i.label.includes('New changelist'));
      },
      warningMessage: (_msg, _opts, ...items) => (items[0] as string) ?? undefined,
    });

    const menu = getCommitContextMenuCommands();
    assert.ok(menu, 'CommitContextMenuCommands not initialised');
    await menu._handleAction('undoCommit', [tip], await logNodes(cwd));

    const head = (await execGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.strictEqual(head, parent, `HEAD must move to the parent; ${toastTrail()}`);

    // The undone change is preserved in the working tree / index, not lost.
    const status = (await execGit(cwd, ['status', '--porcelain'])).stdout;
    assert.ok(
      status.includes('undone.txt'),
      `the undone commit's change must survive as a local change; status:\n${status}\n${toastTrail()}`
    );

    // The chooser's "new changelist from subject" answer took effect.
    const services = getServices();
    assert.ok(services, 'services not available');
    const lists = services.changelistService.getChangelists(repo);
    assert.ok(
      lists.some((l) => l.name.includes('Add undone.txt')),
      `a changelist named after the commit subject must exist; got: ${lists
        .map((l) => l.name)
        .join(', ')}`
    );
  });
});
