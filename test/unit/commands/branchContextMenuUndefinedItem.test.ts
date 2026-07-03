/**
 * Every BranchContextMenuCommands handler must tolerate an UNDEFINED tree
 * item. VS Code delivers `undefined` to a `view/item/context` command when
 * the tree refreshes under the click (reproduced live: checkout-as-local
 * refreshed the branch tree and the immediately-following "Rebase Current
 * onto This" click crashed with "Cannot read properties of undefined
 * (reading 'branch')"), and `executeCommand(id)` with no arguments is always
 * possible. A handler given no item must return without throwing and without
 * running any git operation.
 */

import '../../setup';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

function makeProvider(repo: IRepository): BranchTreeProvider {
  return {
    getRepository: () => repo,
    refresh: () => {},
  } as unknown as BranchTreeProvider;
}

/**
 * GitService proxy that fails the test if ANY method is reached: with no
 * item there is no target, so no handler may start a git operation.
 */
function makeTrappedGitService(reached: string[]): IGitService {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        return (..._args: unknown[]) => {
          reached.push(prop);
          throw new Error(`git operation '${prop}' must not run without a tree item`);
        };
      },
    }
  ) as IGitService;
}

/** Handlers that take the clicked tree item as their only argument. */
const ITEM_HANDLERS = [
  '_handleNewWorktree',
  '_handleCheckout',
  '_handleNewBranchFrom',
  '_handleMergeIntoCurrent',
  '_handleRebaseCurrentOnto',
  '_handleCompareWithCurrent',
  '_handleRename',
  '_handleDelete',
  '_handleUpdate',
  '_handleUpdateSelected',
  '_handlePush',
  '_handleShowDiffWithWorkingTree',
  '_handleCheckoutAndRebase',
  '_handlePullUsingRebase',
  '_handlePullUsingMerge',
  '_handleCheckoutAsLocal',
  '_handleCherryPickCommits',
  '_handlePullIntoCurrent',
  '_handleDeleteRemote',
  '_handleTrackRemote',
  '_handleTagCheckoutDetached',
  '_handleTagNewBranchFrom',
  '_handleTagCherryPick',
  '_handleTagMergeIntoCurrent',
  '_handleTagDelete',
  '_handleTagPush',
  '_handleTagDeleteRemote',
] as const;

type ItemHandlerSurface = Record<
  (typeof ITEM_HANDLERS)[number],
  (item: undefined) => Promise<void> | void
>;

describe('BranchContextMenuCommands — undefined tree item', () => {
  for (const handler of ITEM_HANDLERS) {
    it(`${handler}(undefined) neither throws nor starts a git operation`, async () => {
      const reached: string[] = [];
      const commands = new BranchContextMenuCommands(
        makeTrappedGitService(reached),
        makeProvider(makeRepo())
      );
      const surface = commands as unknown as ItemHandlerSurface;
      assert.strictEqual(typeof surface[handler], 'function', `${handler} exists`);

      await surface[handler](undefined);

      assert.deepStrictEqual(reached, [], `${handler} must not reach git without an item`);
    });
  }
});
