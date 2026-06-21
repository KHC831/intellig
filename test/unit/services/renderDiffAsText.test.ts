/**
 * unit tests for renderDiffAsText — the shared shelf/stash diff-as-text
 * renderer extracted from ShelfView._showDiffContent and
 * StashView._showDiffContent.
 *
 * The output must stay byte-identical to the original inline implementations
 * for both the shelf header shape (two title lines) and the stash header shape
 * (one title line).
 */

import * as assert from 'assert';
import { renderDiffAsText } from '../../../src/shelf/diffText';
import { IDiff } from '../../../src/git-core/interfaces/IGitService';

function makeDiff(): IDiff {
  return {
    path: 'src/foo.ts',
    status: 'modified',
    binary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        header: '@@ -1,2 +1,3 @@',
        lines: [
          { type: 'context', content: 'const a = 1;' },
          { type: 'delete', content: 'const b = 2;' },
          { type: 'add', content: 'const b = 3;' },
          { type: 'add', content: 'const c = 4;' },
        ],
      },
    ],
  };
}

describe('renderDiffAsText', () => {
  it('renders the shelf header shape (two title lines) byte-identical to the inline original', () => {
    const diff = makeDiff();

    // Independent reconstruction of ShelfView._showDiffContent's original body.
    let expected = `Shelf: My Work\n`;
    expected += `Created: 2026-06-18 10:00\n`;
    expected += `File: ${diff.path}\n`;
    expected += `Status: ${diff.status}\n`;
    expected += '─'.repeat(60) + '\n\n';
    for (const hunk of diff.hunks) {
      expected += `${hunk.header}\n`;
      for (const line of hunk.lines) {
        const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';
        expected += `${prefix}${line.content}\n`;
      }
      expected += '\n';
    }

    const actual = renderDiffAsText(['Shelf: My Work', 'Created: 2026-06-18 10:00'], diff);

    assert.strictEqual(actual, expected);
  });

  it('renders the stash header shape (one title line) byte-identical to the inline original', () => {
    const diff = makeDiff();

    // Independent reconstruction of StashView._showDiffContent's original body.
    let expected = `Stash@{2}: WIP on main\n`;
    expected += `File: ${diff.path}\n`;
    expected += `Status: ${diff.status}\n`;
    expected += '─'.repeat(60) + '\n\n';
    for (const hunk of diff.hunks) {
      expected += `${hunk.header}\n`;
      for (const line of hunk.lines) {
        const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';
        expected += `${prefix}${line.content}\n`;
      }
      expected += '\n';
    }

    const actual = renderDiffAsText(['Stash@{2}: WIP on main'], diff);

    assert.strictEqual(actual, expected);
  });
});
