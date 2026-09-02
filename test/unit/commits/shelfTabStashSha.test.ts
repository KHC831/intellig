/**
 * A stash row is addressed by POSITION, and positions move: popping one
 * elsewhere renumbers the stack, so the slot a menu was opened on can hold a
 * different stash by the time the user picks. The row's sha rides with the
 * index so the view can tell.
 */
import '../../setup';
import * as assert from 'assert';
import {
  handleShelfTabAction,
  type IShelfTabActionDeps,
  type IShelfTabStashController,
} from '../../../src/commits/shelfTab';
import type { ICommitToolWebviewMessage } from '../../../src/commits/commitToolWindow.types';

function depsWith(stash: IShelfTabStashController): IShelfTabActionDeps {
  return {
    getShelfController: () => ({}),
    getStashController: () => stash,
    getShelfItems: () => [],
    showContextMenu: () => undefined,
  } as unknown as IShelfTabActionDeps;
}

describe('shelf tab — a stash action carries the sha its row displayed', () => {
  const DESTRUCTIVE = [
    'stashPop',
    'stashApply',
    'stashDrop',
    'stashRename',
    'stashBranchFromStash',
  ];

  for (const action of DESTRUCTIVE) {
    it(`${action} forwards the sha alongside the index`, async () => {
      const seen: Array<[number, string | undefined]> = [];
      const record =
        () =>
        async (index: number, expectedSha?: string): Promise<void> => {
          seen.push([index, expectedSha]);
        };
      await handleShelfTabAction(
        depsWith({
          pop: record(),
          apply: record(),
          drop: record(),
          rename: record(),
          branchFromStash: record(),
        }),
        {
          type: 'shelfTabContextAction',
          action,
          rowKind: 'stash',
          stashIndex: 2,
          stashSha: 'deadbeefcafe',
        } as unknown as ICommitToolWebviewMessage
      );

      assert.deepStrictEqual(
        seen,
        [[2, 'deadbeefcafe']],
        'the index alone cannot say which stash the user clicked'
      );
    });
  }

  it('still acts when the row carried no sha', async () => {
    const seen: Array<[number, string | undefined]> = [];
    await handleShelfTabAction(
      depsWith({
        drop: async (index, expectedSha): Promise<void> => {
          seen.push([index, expectedSha]);
        },
      }),
      {
        type: 'shelfTabContextAction',
        action: 'stashDrop',
        rowKind: 'stash',
        stashIndex: 0,
      } as unknown as ICommitToolWebviewMessage
    );

    assert.deepStrictEqual(seen, [[0, undefined]], 'an absent sha is not a reason to refuse');
  });

  it('drops a non-string sha rather than passing it on', async () => {
    const seen: Array<[number, string | undefined]> = [];
    await handleShelfTabAction(
      depsWith({
        drop: async (index, expectedSha): Promise<void> => {
          seen.push([index, expectedSha]);
        },
      }),
      {
        type: 'shelfTabContextAction',
        action: 'stashDrop',
        rowKind: 'stash',
        stashIndex: 0,
        stashSha: 42,
      } as unknown as ICommitToolWebviewMessage
    );

    assert.deepStrictEqual(seen, [[0, undefined]], 'a bad sha degrades to no sha, not to a throw');
  });
});
