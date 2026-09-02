/**
 * The Commit window's destructive rows are tinted like the Git tool window's.
 *
 * Its row type shares the shape carrying `danger`, so Rollback…, Remove
 * Changelist, Delete and Drop render tinted like Reset and Drop do elsewhere,
 * instead of like Show Diff, drawn by the same widget that tints them there.
 */

import '../../setup';
import * as assert from 'assert';
import {
  changelistContextMenuLabels,
  fileContextMenuLabels,
} from '../../../src/commits/changelistTab';
import {
  shelfRowContextMenuLabels,
  stashRowContextMenuLabels,
} from '../../../src/commits/shelfTab';

const dangerActions = (items: ReadonlyArray<{ action: string; danger?: boolean }>): string[] =>
  items.filter((i) => i.danger).map((i) => i.action);

describe('Commit window menu — destructive rows carry danger', () => {
  it('marks Rollback on a file row', () => {
    assert.deepStrictEqual(
      dangerActions(fileContextMenuLabels({ path: 'a.ts', status: 'modified', staged: false })),
      ['rollback']
    );
  });

  it('marks Remove Changelist', () => {
    assert.deepStrictEqual(
      dangerActions(changelistContextMenuLabels({ isActive: false, isDefault: false })),
      ['delete']
    );
  });

  it('marks Delete on a shelf row', () => {
    assert.deepStrictEqual(
      dangerActions(shelfRowContextMenuLabels({ isAlreadyUnshelved: false })),
      ['shelfDelete']
    );
  });

  it('marks Drop and Clear All on a stash row', () => {
    assert.deepStrictEqual(dangerActions(stashRowContextMenuLabels()), [
      'stashDrop',
      'stashClearAll',
    ]);
  });

  it('leaves the non-destructive rows alone', () => {
    // Without this the checks above would pass on a menu where every row was
    // marked danger, which would be its own bug.
    const file = fileContextMenuLabels({ path: 'a.ts', status: 'modified', staged: false });
    assert.ok(
      file.some((i) => i.action === 'showDiff' && !i.danger),
      'Show Diff is not destructive'
    );
  });
});
