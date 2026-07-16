/**
 * Tier-2 E2E — drop-commit replay conflicts (real git).
 *
 * Dropping a non-tip commit whose files later commits also modify makes the
 * replay of those commits conflict. IntelliJ (git4idea GitRebaseProcess)
 * leaves the rebase PAUSED for the user to resolve and continue; `rebase
 * --abort` runs only on explicit user action. These tests pin that contract
 * on real git state after the drop handler returns on a conflict:
 *
 *   1. the rebase is still in progress (`.git/rebase-merge` present),
 *   2. the conflicted file is listed unmerged in the index,
 *   3. HEAD sits at the replayed prefix — NOT restored to the pre-drop tip
 *      (an abort would restore it).
 *
 * The drop action has no palette command (it enters through the tool
 * window's webview event), so the suite drives `_handleAction` on the live
 * CommitContextMenuCommands instance via the activated-bundle bridge.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';
import { getCommitContextMenuCommands, getServices } from '../support/activatedExtension';
import type { IMenuStateNode } from '../../../src/git-core/gitToolWindow/multiSelect';

describe('e2e — drop commit replay conflict pauses the rebase', function () {
  this.timeout(30_000);

  let fix: Fixture;
  let stubs: PromptStubs;

  afterEach(async () => {
    if (stubs) {
      stubs.restore();
    }
    if (fix) {
      // A conflict may leave the fixture mid-rebase by design; abort it so the
      // teardown's status probes and directory removal see a quiet repo.
      await execGit(fix.rootPath, ['rebase', '--abort'], { allowNonZero: true });
    }
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  /**
   * Base commit writes `f.txt`; commit A and commit B each rewrite the same
   * line. Dropping A forces B's replay onto the base to conflict on `f.txt`.
   * Returns A's sha plus the newest-first commit-node projection the webview
   * would have supplied.
   */
  async function setupDropConflictFixture(opts?: { withTrackedG?: boolean }): Promise<{
    shaA: string;
    nodes: IMenuStateNode[];
  }> {
    fix = await createFixtureRepo({ commits: 1 });
    const f = path.join(fix.rootPath, 'f.txt');

    fs.writeFileSync(f, 'base\n');
    await execGit(fix.rootPath, ['add', 'f.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'add f.txt']);

    if (opts?.withTrackedG) {
      // Committed BELOW the drop target so it exists at the replayed prefix
      // where the rebase pauses.
      fs.writeFileSync(path.join(fix.rootPath, 'g.txt'), 'g base\n');
      await execGit(fix.rootPath, ['add', 'g.txt']);
      await execGit(fix.rootPath, ['commit', '-m', 'add g.txt']);
    }

    fs.writeFileSync(f, 'change A\n');
    await execGit(fix.rootPath, ['commit', '-am', 'A: modify f.txt']);
    const shaA = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    fs.writeFileSync(f, 'change B\n');
    await execGit(fix.rootPath, ['commit', '-am', 'B: modify f.txt']);

    // Newest-first commit nodes, as the rendered log supplies them.
    const log = await execGit(fix.rootPath, ['log', '--pretty=format:%H %P']);
    const nodes: IMenuStateNode[] = log.stdout
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const [hash, ...parents] = line.trim().split(/\s+/);
        return { hash, parentCount: parents.length, parents };
      });
    return { shaA, nodes };
  }

  it('drop of a non-tip commit leaves the conflicted rebase paused for resolution', async () => {
    const { shaA, nodes } = await setupDropConflictFixture();
    await useFixtureWorkspace(fix.rootPath);
    const preDropHead = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    stubs = stubPrompts({
      // Answer only the destructive-op confirm; any other modal is cancelled.
      warningMessage: (_msg, _opts, ...items) =>
        (items.find((i) => i === 'Drop') as string) ?? undefined,
    });

    const menu = getCommitContextMenuCommands();
    assert.ok(menu, 'CommitContextMenuCommands not initialised — did activation fail?');
    await menu._handleAction('dropCommit', [shaA], nodes);

    const diag = (): string =>
      `toasts: warn=${JSON.stringify(stubs.warningMessageCalls.map((c) => c.message))} ` +
      `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`;

    // 1. The rebase must still be in progress — pause, never auto-abort.
    const gitDir = path.join(fix.rootPath, '.git');
    assert.ok(
      fs.existsSync(path.join(gitDir, 'rebase-merge')),
      `expected the conflicted rebase to stay in progress (.git/rebase-merge present); ${diag()}`
    );

    // 2. The conflicting file is unmerged in the index.
    const unmerged = (await execGit(fix.rootPath, ['ls-files', '-u', '--', 'f.txt'])).stdout;
    assert.ok(
      unmerged.trim().length > 0,
      `expected f.txt to be listed unmerged while the rebase is paused; ${diag()}`
    );

    // 3. HEAD is at the replayed prefix, not restored to the pre-drop tip.
    const head = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.notStrictEqual(
      head,
      preDropHead,
      `expected HEAD at the replayed prefix — an abort restored the pre-drop tip; ${diag()}`
    );

    // 4. The toast trail is honest: the conflict-pause copy fired, and
    // nothing claimed the operation was aborted (so the test cannot go
    // green via a silent no-op).
    const warns = stubs.warningMessageCalls.map((c) => c.message);
    assert.ok(
      warns.some((m) => m.includes('hit conflicts') && m.includes('resolve them to continue')),
      `expected the conflict-pause warning; ${diag()}`
    );
    assert.ok(
      !warns.concat(stubs.errorMessageCalls.map((c) => c.message)).some((m) => /aborted/i.test(m)),
      `nothing may claim the operation was aborted; ${diag()}`
    );
  });

  /** Take B's side of the paused replay conflict on f.txt and stage it. */
  async function resolveConflictTakingTheirs(root: string): Promise<void> {
    await execGit(root, ['checkout', '--theirs', '--', 'f.txt']);
    await execGit(root, ['add', 'f.txt']);
  }

  async function dropAViaMenu(shaA: string, nodes: IMenuStateNode[]): Promise<void> {
    stubs = stubPrompts({
      warningMessage: (_msg, _opts, ...items) =>
        (items.find((i) => i === 'Drop') as string) ?? undefined,
    });
    const menu = getCommitContextMenuCommands();
    assert.ok(menu, 'CommitContextMenuCommands not initialised — did activation fail?');
    await menu._handleAction('dropCommit', [shaA], nodes);
  }

  it('resolve → continue completes the drop: A gone, B kept', async () => {
    const { shaA, nodes } = await setupDropConflictFixture();
    const repo = await useFixtureWorkspace(fix.rootPath);

    await dropAViaMenu(shaA, nodes);
    assert.ok(
      fs.existsSync(path.join(fix.rootPath, '.git', 'rebase-merge')),
      'precondition: paused mid-rebase'
    );

    await resolveConflictTakingTheirs(fix.rootPath);
    const result = await getServices()!.gitService.rebaseContinue(repo);
    assert.ok(
      result.success,
      `rebase --continue must complete the drop; got ${JSON.stringify(result)}`
    );

    assert.ok(
      !fs.existsSync(path.join(fix.rootPath, '.git', 'rebase-merge')),
      'the rebase must be finished after continue'
    );
    const log = (await execGit(fix.rootPath, ['log', '--pretty=format:%s'])).stdout;
    assert.ok(!log.includes('A: modify f.txt'), 'A must be dropped from history');
    assert.ok(log.includes('B: modify f.txt'), 'B must survive as the replayed commit');
    assert.strictEqual(
      fs.readFileSync(path.join(fix.rootPath, 'f.txt'), 'utf8'),
      'change B\n',
      "B's content must be the final tree state"
    );
  });

  it('autostash lifecycle: dirty edits park at the pause and return after continue', async () => {
    const { shaA, nodes } = await setupDropConflictFixture({ withTrackedG: true });
    // A tracked, dirty, non-conflicting edit — git's autostash territory.
    const g = path.join(fix.rootPath, 'g.txt');
    fs.writeFileSync(g, 'g dirty edit\n');

    const repo = await useFixtureWorkspace(fix.rootPath);
    await dropAViaMenu(shaA, nodes);

    // At the pause: the edits are parked in git's autostash, not the tree.
    assert.strictEqual(
      fs.readFileSync(g, 'utf8'),
      'g base\n',
      "g's dirty edit must be autostashed away while the rebase is paused"
    );
    assert.ok(
      fs.existsSync(path.join(fix.rootPath, '.git', 'rebase-merge', 'autostash')),
      'the autostash marker file must exist while paused'
    );

    await resolveConflictTakingTheirs(fix.rootPath);
    const result = await getServices()!.gitService.rebaseContinue(repo);
    assert.ok(result.success, `continue must complete; got ${JSON.stringify(result)}`);

    assert.strictEqual(
      fs.readFileSync(g, 'utf8'),
      'g dirty edit\n',
      "g's edits must be restored by git after the rebase completes"
    );
    const stashList = (await execGit(fix.rootPath, ['stash', 'list'])).stdout.trim();
    assert.strictEqual(stashList, '', 'the autostash entry must be consumed, not left parked');
  });

  it('abort at the pause restores HEAD and the autostashed edits', async () => {
    // Pins git's abort-applies-autostash behavior the design relies on — a
    // git regression here should fail loudly.
    const { shaA, nodes } = await setupDropConflictFixture({ withTrackedG: true });
    const g = path.join(fix.rootPath, 'g.txt');
    fs.writeFileSync(g, 'g dirty edit\n');

    const repo = await useFixtureWorkspace(fix.rootPath);
    const preDropHead = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    await dropAViaMenu(shaA, nodes);
    assert.ok(
      fs.existsSync(path.join(fix.rootPath, '.git', 'rebase-merge')),
      'precondition: paused mid-rebase'
    );

    // The resolve dialog's Abort path.
    await getServices()!.conflictResolutionService.abortRebase(repo);

    const head = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.strictEqual(head, preDropHead, 'abort must restore the pre-drop HEAD');
    assert.strictEqual(
      fs.readFileSync(g, 'utf8'),
      'g dirty edit\n',
      "abort must reapply the autostash — g's edits return"
    );
    assert.ok(
      !fs.existsSync(path.join(fix.rootPath, '.git', 'rebase-merge')),
      'no rebase may remain after abort'
    );
  });

  it('multi-drop conflict pauses the rebase the same way', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    const f = path.join(fix.rootPath, 'f.txt');
    const h = path.join(fix.rootPath, 'h.txt');

    fs.writeFileSync(f, 'base\n');
    await execGit(fix.rootPath, ['add', 'f.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'add f.txt']);

    fs.writeFileSync(h, 'h content\n');
    await execGit(fix.rootPath, ['add', 'h.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'A0: add h.txt']);
    const shaA0 = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    fs.writeFileSync(f, 'change A\n');
    await execGit(fix.rootPath, ['commit', '-am', 'A: modify f.txt']);
    const shaA = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    fs.writeFileSync(f, 'change B\n');
    await execGit(fix.rootPath, ['commit', '-am', 'B: modify f.txt']);

    const log = await execGit(fix.rootPath, ['log', '--pretty=format:%H %P']);
    const nodes: IMenuStateNode[] = log.stdout
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const [hash, ...parents] = line.trim().split(/\s+/);
        return { hash, parentCount: parents.length, parents };
      });

    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({
      warningMessage: (_msg, _opts, ...items) =>
        (items.find((i) => i === 'Drop') as string) ?? undefined,
    });
    const menu = getCommitContextMenuCommands();
    assert.ok(menu, 'CommitContextMenuCommands not initialised');
    // Newest-first selection of the two commits to drop; B's replay conflicts.
    await menu._handleAction('dropCommit', [shaA, shaA0], nodes);

    assert.ok(
      fs.existsSync(path.join(fix.rootPath, '.git', 'rebase-merge')),
      `multi-drop conflict must stay paused; err=${JSON.stringify(
        stubs.errorMessageCalls.map((c) => c.message)
      )}`
    );
    const unmerged = (await execGit(fix.rootPath, ['ls-files', '-u', '--', 'f.txt'])).stdout;
    assert.ok(unmerged.trim().length > 0, 'f.txt must be unmerged at the pause');
  });

  it('squash/fixup conflict (flattened merge in the window) pauses the rebase', async () => {
    // A squash of commits BELOW a merge flattens that merge out of the todo
    // and replays its side branch, which can conflict with the resolved
    // content — the realistic conflict source for squash on linear-looking
    // logs. Fixup mode is driven directly (same body, same runner) because
    // the squash-message webview dialog cannot be answered headlessly.
    fix = await createFixtureRepo({ commits: 1 });
    const f = path.join(fix.rootPath, 'f.txt');
    const g = path.join(fix.rootPath, 'g2.txt');

    fs.writeFileSync(f, 'base\n');
    await execGit(fix.rootPath, ['add', 'f.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'add f.txt']);

    // Side branch modifies f.
    await execGit(fix.rootPath, ['checkout', '-b', 'side']);
    fs.writeFileSync(f, 'side change\n');
    await execGit(fix.rootPath, ['commit', '-am', 'X: side modifies f.txt']);

    // Back on main: P and Y are the contiguous squash targets; Y touches f.
    await execGit(fix.rootPath, ['checkout', fix.defaultBranch]);
    fs.writeFileSync(g, 'p content\n');
    await execGit(fix.rootPath, ['add', 'g2.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'P: add g2.txt']);
    const shaP = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    fs.writeFileSync(f, 'main change\n');
    await execGit(fix.rootPath, ['commit', '-am', 'Y: main modifies f.txt']);
    const shaY = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    // Merge the side branch, resolving the f conflict.
    await execGit(fix.rootPath, ['merge', 'side'], { allowNonZero: true });
    fs.writeFileSync(f, 'merged\n');
    await execGit(fix.rootPath, ['add', 'f.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'M: merge side']);

    const log = await execGit(fix.rootPath, ['log', '--first-parent', '--pretty=format:%H %P']);
    const nodes: IMenuStateNode[] = log.stdout
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const [hash, ...parents] = line.trim().split(/\s+/);
        return { hash, parentCount: parents.length, parents };
      });

    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});
    const menu = getCommitContextMenuCommands();
    assert.ok(menu, 'CommitContextMenuCommands not initialised');
    await (
      menu as unknown as {
        _handleSquashCommits(
          hashes: string[],
          nodes: readonly IMenuStateNode[],
          options?: { mode?: 'squash' | 'fixup' }
        ): Promise<void>;
      }
    )._handleSquashCommits([shaY, shaP], nodes, { mode: 'fixup' });

    assert.ok(
      fs.existsSync(path.join(fix.rootPath, '.git', 'rebase-merge')),
      `squash conflict must stay paused; err=${JSON.stringify(
        stubs.errorMessageCalls.map((c) => c.message)
      )} warn=${JSON.stringify(stubs.warningMessageCalls.map((c) => c.message))}`
    );
    const unmerged = (await execGit(fix.rootPath, ['ls-files', '-u', '--', 'f.txt'])).stdout;
    assert.ok(unmerged.trim().length > 0, 'f.txt must be unmerged at the pause');
  });
});
