/**
 * Favorites-section rows in the Branches tree: the context value a row
 * carries (which decides the right-click menu it gets) and the cost of
 * rendering the section.
 */

import '../../setup';
import * as assert from 'assert';
import {
  BranchTreeProvider,
  CONTEXT_VALUES,
  type BranchTreeItem,
} from '../../../src/branches/BranchTreeProvider';
import { createMockGitService, attachedRepo } from '../../mocks/mockGitService';
import type { IBranch, IRepository } from '../../../src/git-core/interfaces/IGitService';

const REMOTE_DEFAULT: IBranch = {
  name: 'origin/main',
  type: 'remote',
  commit: 'a'.repeat(40),
  isHead: false,
};
const LOCAL_DEFAULT: IBranch = {
  name: 'main',
  type: 'local',
  commit: 'b'.repeat(40),
  isHead: true,
};

async function favoriteRows(provider: BranchTreeProvider): Promise<BranchTreeItem[]> {
  const roots = await provider.getChildren();
  const favorites = roots.find((c) => c.label === 'Favorites');
  assert.ok(favorites, 'Favorites category must render when a starred ref exists');
  return provider.getChildren(favorites);
}

describe('Branches tree: favorite row context values', () => {
  it('gives a remote favorite the REMOTE branch context value, not the local one', async () => {
    const repo: IRepository = attachedRepo('main');
    const gitService = createMockGitService(repo, {
      getBranches: async () => [REMOTE_DEFAULT],
    });
    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(repo);

    const rows = await favoriteRows(provider);
    const remoteRow = rows.find((r) => r.label === 'origin/main');

    assert.ok(remoteRow, 'the predefined remote favorite renders a row');
    assert.strictEqual(remoteRow.itemType, 'remote-branch');
    assert.strictEqual(
      remoteRow.contextValue,
      CONTEXT_VALUES.REMOTE_BRANCH,
      'a local context value would offer Checkout, which detaches HEAD on a remote name'
    );
  });

  it('keeps the local context value on a local favorite', async () => {
    const repo: IRepository = attachedRepo('main');
    const gitService = createMockGitService(repo, {
      getBranches: async () => [LOCAL_DEFAULT],
    });
    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(repo);

    const rows = await favoriteRows(provider);
    const localRow = rows.find((r) => r.label === 'main');

    assert.ok(localRow);
    assert.strictEqual(localRow.itemType, 'local-branch');
  });
});

describe('Branches tree: favorites gating cost', () => {
  it('reads the branch list once per repository while building the category nodes', async () => {
    const repo: IRepository = attachedRepo('main');
    let calls = 0;
    const gitService = createMockGitService(repo, {
      getBranches: async () => {
        calls++;
        return [LOCAL_DEFAULT, REMOTE_DEFAULT];
      },
    });
    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(repo);

    await provider.getChildren();

    assert.strictEqual(calls, 1, `category-node render spawned ${calls} getBranches calls`);
  });
});

/**
 * A starred ref renders a filled star whichever side of the local/remote
 * line it sits on. Only the local arm consulted the favorite flag, so a
 * starred remote branch was indistinguishable from an unstarred one —
 * including inside the Favorites section itself.
 */
describe('Branches tree: favorite rows render a star', () => {
  async function iconIdOf(
    branch: IBranch,
    label: string,
    headBranch = 'main'
  ): Promise<string | undefined> {
    const repo: IRepository = attachedRepo(headBranch);
    const gitService = createMockGitService(repo, { getBranches: async () => [branch] });
    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(repo);

    const row = (await favoriteRows(provider)).find((r) => r.label === label);
    assert.ok(row, `${label} renders a favorite row`);
    return (row.iconPath as { id?: string } | undefined)?.id;
  }

  it('stars a favorite REMOTE branch', async () => {
    assert.strictEqual(await iconIdOf(REMOTE_DEFAULT, 'origin/main'), 'star-full');
  });

  it('still stars a favorite local branch', async () => {
    // HEAD points elsewhere: the current-branch check mark outranks the star,
    // so leaving `main` checked out would mask the icon under test.
    const notHead: IBranch = { ...LOCAL_DEFAULT, isHead: false };
    assert.strictEqual(await iconIdOf(notHead, 'main', 'other'), 'star-full');
  });
});
