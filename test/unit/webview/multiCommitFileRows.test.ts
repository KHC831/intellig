/**
 * Every file row in the multi-commit combined tree is as interactive as it
 * looks.
 *
 * The rows ship `role="treeitem"`, `tabindex="0"` and the single-panel hover
 * styling, but the context menu (`.changed-file-item[data-path][data-commit-hash]`)
 * and the double-click-to-diff handler both key off the commit hash — which the
 * multi panel never emitted, so both gestures silently did nothing on a tree
 * that advertised them.
 *
 * Upstream serves a diff for any change in that browser regardless of how many
 * commits are selected: VcsLogChangesBrowser.getDiffRequestProducer takes the
 * row's Change and builds a producer from it.
 */

import '../../setup';
import * as assert from 'assert';
import { renderDetailsPanel } from '../../helpers/detailsPanelDom';
import { buildMultiCommitDetailsPanelModel } from '../../../src/git-core/gitToolWindow/provider/detailsPanelModel';
import type { ICommitDetails } from '../../../src/services/interfaces';

const OLDER = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);

function details(hash: string, paths: string[]): ICommitDetails {
  return {
    hash,
    message: `commit ${hash.slice(0, 7)}`,
    author: { name: 'a', email: 'a@x' },
    date: new Date(0),
    parents: [],
    changedFiles: paths.map((path) => ({ path, status: 'modified' as const })),
  } as unknown as ICommitDetails;
}

/** Every rendered file row, in document order. */
function fileRows(model: ReturnType<typeof buildMultiCommitDetailsPanelModel>): Element[] {
  return Array.from(renderDetailsPanel(model).querySelectorAll('.changed-file-item'));
}

describe('multi-commit combined tree file rows', () => {
  it('carries the owning commit on every row', () => {
    const model = buildMultiCommitDetailsPanelModel([
      details(NEWER, ['src/only-newer.ts']),
      details(OLDER, ['src/only-older.ts']),
    ]);

    const rows = fileRows(model);
    assert.strictEqual(rows.length, 2, 'sanity: both files rendered');
    for (const row of rows) {
      const hash = row.getAttribute('data-commit-hash');
      assert.ok(
        hash,
        `row ${row.getAttribute('data-path')} needs a commit to diff against, ` +
          'or the context menu and double-click both no-op'
      );
    }
    assert.deepStrictEqual(
      rows.map((r) => [r.getAttribute('data-path'), r.getAttribute('data-commit-hash')]),
      [
        ['src/only-newer.ts', NEWER],
        ['src/only-older.ts', OLDER],
      ],
      'each row names the commit that contributed it'
    );
  });

  it('attributes a path touched twice to the NEWEST commit that touched it', () => {
    // The list arrives in graph order — newest first — and the panel shows one
    // row per path. That row must describe the selection's latest state of the
    // file: if the newest commit DELETED a path an older one added, painting
    // the add is not merely a different choice, it reports the opposite of what
    // the selection did and offers a diff of a change that was undone. The row
    // must also diff against the same commit whose status it shows, or the
    // label and the double-click disagree.
    const model = buildMultiCommitDetailsPanelModel([
      { ...details(NEWER, []), changedFiles: [{ path: 'src/shared.ts', status: 'deleted' }] },
      { ...details(OLDER, []), changedFiles: [{ path: 'src/shared.ts', status: 'added' }] },
    ] as never);

    const rows = fileRows(model);
    assert.strictEqual(rows.length, 1, 'sanity: deduplicated to one row');
    assert.strictEqual(
      rows[0].getAttribute('data-commit-hash'),
      NEWER,
      'the newest commit that touched the path owns the row'
    );
    assert.strictEqual(
      rows[0].getAttribute('data-status'),
      'deleted',
      "and the status shown is that same commit's, not an older one it superseded"
    );
  });
});
