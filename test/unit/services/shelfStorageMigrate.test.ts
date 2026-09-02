/**
 * migrateShelfStorageForTest — the parse half of ShelfService.loadShelfStorage.
 * Malformed-store handling: a truncated or hand-edited store must never hand
 * a downstream git call a path git-core/gitCli.ts's literal-pathspec writer
 * refuses.
 */

import '../../setup';
import * as assert from 'assert';
import {
  migrateShelfStorageForTest,
  SHELF_STORAGE_VERSION,
} from '../../../src/shelf/shelfStorageMigrate';
import { captureWarnCalls } from '../../helpers/captureWarnCalls';

describe('migrateShelfStorageForTest — malformed file records', () => {
  it('drops a file record whose path is missing (would otherwise coerce to "")', () => {
    // `path: typeof fileRec.path === 'string' ? fileRec.path : ''`
    // manufactures an empty path for a record with no `path` field at all —
    // reachable via a truncated or hand-edited store — and
    // isShelfFilePathWithinRepo(root, '') passes (path.join(root, '') ===
    // root), so an empty path would otherwise sail past containment straight
    // into a git pathspec.
    const out = migrateShelfStorageForTest({
      version: 1,
      items: [
        {
          id: 's1',
          name: 'wip',
          timestamp: 0,
          files: [
            { originalContent: 'x', patchContent: 'y' }, // no path field
            { path: 'a.ts', originalContent: '', patchContent: '' },
          ],
        },
      ],
    });
    assert.strictEqual(out.items.length, 1);
    assert.deepStrictEqual(
      out.items[0].files.map((f) => f.path),
      ['a.ts'],
      'the path-less file record must be dropped, not coerced to an empty path'
    );
  });

  it('drops a file record whose path is explicitly the empty string', () => {
    const out = migrateShelfStorageForTest({
      version: 1,
      items: [
        {
          id: 's1',
          name: 'wip',
          timestamp: 0,
          files: [{ path: '', originalContent: '', patchContent: '' }],
        },
      ],
    });
    assert.deepStrictEqual(out.items[0].files, []);
  });

  it('logs the dropped file record instead of deleting it silently', () => {
    // Every other malformed input in this function is preserved (unknown
    // keys into _unknownFileField / _unknownItem) and, for
    // a newer-than-expected version, warned about. A path-less file record is
    // the one branch that DELETES data with no log line at all — a shelved
    // entry loses a file with no trace, and the next unrelated shelf action
    // (load -> mutate -> save) persists the deletion to disk.
    const { calls, restore } = captureWarnCalls();
    try {
      migrateShelfStorageForTest({
        version: 1,
        items: [
          {
            id: 's1',
            name: 'wip',
            timestamp: 0,
            files: [
              { originalContent: 'x', patchContent: 'y' }, // no path field
              { path: '', originalContent: '', patchContent: '' },
              { path: 'a.ts', originalContent: '', patchContent: '' },
            ],
          },
        ],
      });
    } finally {
      restore();
    }
    assert.strictEqual(calls.length, 1, 'exactly one warn for the one item with dropped files');
    assert.match(calls[0].message, /dropped|discard/i);
    assert.deepStrictEqual(calls[0].context, { itemId: 's1', droppedCount: 2 });
    assert.strictEqual(
      calls[0].component,
      'ShelfService',
      "a log component name is a user-facing identifier people grep in the output channel — this file's move out of ShelfService.ts must not silently rename it"
    );
  });

  it('warns under the same component as the dropped-file-record warn when the stored version is newer than expected', () => {
    // This warn and the drop warn six lines below are emitted by the SAME
    // function; both must log under the same component name, or a reader
    // grepping the output channel for one warn silently misses the other.
    const { calls, restore } = captureWarnCalls();
    try {
      migrateShelfStorageForTest({ version: SHELF_STORAGE_VERSION + 1, items: [] });
    } finally {
      restore();
    }
    assert.strictEqual(calls.length, 1, 'exactly one warn for the newer-than-expected version');
    assert.strictEqual(calls[0].component, 'ShelfService');
  });

  it('does not warn when every file record in the item survives', () => {
    // Positive control for the warn above: an ordinary item with nothing
    // dropped must not spam a log line every load.
    const { calls, restore } = captureWarnCalls();
    try {
      migrateShelfStorageForTest({
        version: 1,
        items: [
          {
            id: 's1',
            name: 'wip',
            timestamp: 0,
            files: [{ path: 'a.ts', originalContent: '', patchContent: '' }],
          },
        ],
      });
    } finally {
      restore();
    }
    assert.deepStrictEqual(calls, []);
  });
});
