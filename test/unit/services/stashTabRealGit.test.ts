/**
 * Real-git end-to-end for the Commit tool window's Stash-tab actions.
 *
 * The tab renders its stash list from the tool window's own `stashList` call,
 * but the ACTIONS run against a separate `StashView` whose `_state.stashes`
 * only populates on `refresh()`. The bug: the bind helper set the repository on
 * the stash view but never refreshed it, so every action missed
 * `_findStashByIndex` and failed "Stash not found: stash@{n}" against a repo
 * that plainly had stashes.
 *
 * This drives the PRODUCTION path — `bindShelfTabRepo` → `StashView` — against a
 * live repo with two real stashes, proving both the failure (no refresh) and
 * the fix (bind refreshes the stash view, the action finds and applies it).
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { StashTagHistoryOps } from '../../../src/git-core/ops/StashTagHistoryOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { createGitCli } from '../../../src/git-core/gitCli';
import { createStashView } from '../../../src/shelf/StashView';
import { bindShelfTabRepo } from '../../../src/registration/registerViews';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

// Real-git tmp repos live under the gitignored workspace-notes/tmp, never
// os.tmpdir() or the repo root (project rule).
const TMP_ROOT = SCRATCH_ROOT;

function makeRealGitService(): IGitService {
  const ops = new StashTagHistoryOps({
    gitCli: createGitCli(),
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext);
  // Mirror GitService's facade: stashList absorbs to [], the mutating ops pass
  // their Result channel straight through (the view unwraps via .match).
  return {
    stashList: (r: IRepository) => ops.stashList(r).unwrapOr([]),
    stashApply: (r: IRepository, i: number, reinstate?: boolean) => ops.stashApply(r, i, reinstate),
    stashPop: (r: IRepository, i: number, reinstate?: boolean) => ops.stashPop(r, i, reinstate),
    stashDrop: (r: IRepository, i: number) => ops.stashDrop(r, i),
  } as unknown as IGitService;
}

describe('Commit tool window Stash tab — real git, bind then act', function () {
  this.timeout(60000);

  let dir: string;
  const repo = (): IRepository => ({ rootUri: { fsPath: dir } }) as unknown as IRepository;
  const gitService = makeRealGitService();

  before(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TMP_ROOT, 'stashtab-'));
    const git = (...a: string[]): void => {
      execFileSync('git', a, { cwd: dir });
    };
    git('init', '-q');
    git('config', 'user.email', 't@t.io');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'a.txt'), '0\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), '0\n');
    git('add', 'a.txt', 'b.txt');
    git('commit', '-q', '-m', 'base');
    // Two stashes on different files so an apply is conflict-free.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A\n');
    git('stash', 'push', '-q', '-m', 'stash A'); // becomes stash@{1}
    fs.writeFileSync(path.join(dir, 'b.txt'), 'B\n');
    git('stash', 'push', '-q', '-m', 'stash B'); // stash@{0}
    const list = execFileSync('git', ['stash', 'list'], { cwd: dir }).toString();
    assert.strictEqual(list.split('\n').filter((l) => l.trim()).length, 2, 'fixture has 2 stashes');
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('WITHOUT a refresh the action misses — reproduces "Stash not found"', async () => {
    // The pre-fix bind path: setRepository but never refresh the stash view.
    const view = createStashView(gitService);
    view.setRepository(repo());

    const result = await view.applyStash(1);

    assert.strictEqual(result.success, false);
    assert.match(result.error ?? '', /Stash not found: stash@\{1\}/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), '0\n', 'nothing applied');
  });

  it('after bindShelfTabRepo the stash view is refreshed and the action applies the real stash', async () => {
    const view = createStashView(gitService);
    const shelfStub = {
      setRepository: (): void => {},
      refresh: async (): Promise<{ error?: string }> => ({}),
    };

    const bound = await bindShelfTabRepo(
      { getSelectedRepository: () => repo() },
      [repo()],
      shelfStub,
      view,
      () => {}
    );

    assert.ok(bound, 'a repo is bound');
    assert.strictEqual(view.getState().stashes.length, 2, 'stash view populated by the refresh');

    const result = await view.applyStash(1);

    assert.strictEqual(result.success, true, `apply should succeed, got: ${result.error ?? ''}`);
    assert.strictEqual(
      fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'),
      'A\n',
      'stash@{1} (the a.txt change) was actually applied'
    );
  });
});
