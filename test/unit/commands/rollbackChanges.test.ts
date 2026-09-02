/**
 * Rollback / Revert Local Changes — command-level pure helpers.
 *
 * The destructive flow itself (modal confirm → gitService.rollbackChanges) is
 * the standard repo pattern; the bits worth pinning are the argument narrowing
 * (`extractRollbackChanges`) and the IntelliJ-style confirmation text
 * (`buildRollbackConfirmMessage`) — it must list every affected file and warn
 * that included untracked files are deleted from disk.
 */

import '../../setup';
import * as assert from 'assert';
import {
  buildRollbackConfirmMessage,
  enrichRollbackChanges,
  extractRollbackChanges,
} from '../../../src/commands/registration/commitRollbackChanges';
import { captureWarnCalls } from '../../helpers/captureWarnCalls';

describe('extractRollbackChanges', () => {
  it('returns undefined for the no-arg palette invocation', () => {
    assert.strictEqual(extractRollbackChanges(undefined), undefined);
  });

  it('returns undefined for non-array args', () => {
    assert.strictEqual(extractRollbackChanges({ path: 'a', status: 'modified' }), undefined);
  });

  it('keeps only well-formed {path,status} entries with rollback-able statuses', () => {
    const out = extractRollbackChanges([
      { path: 'a.ts', status: 'modified' },
      { path: 'b.ts', status: 'untracked' },
      { path: 'c.ts', status: 'conflicted' }, // not rollback-able → dropped
      { path: 123, status: 'modified' }, // bad path → dropped
      { status: 'added' }, // missing path → dropped
    ]);
    assert.deepStrictEqual(out, [
      { path: 'a.ts', status: 'modified' },
      { path: 'b.ts', status: 'untracked' },
    ]);
  });

  it('returns undefined when nothing in the array is valid', () => {
    assert.strictEqual(extractRollbackChanges([{ foo: 'bar' }]), undefined);
  });

  it('drops an entry whose path is the empty string', () => {
    // An empty path reaches restorePathsToHead → the literal-pathspec
    // writer — where it must never land. `''` passes
    // `typeof path === 'string'`, so nothing upstream of this narrowing
    // filters it; refuse it here, before it ever reaches a confirm modal or
    // git.
    const out = extractRollbackChanges([
      { path: '', status: 'modified' },
      { path: 'a.ts', status: 'modified' },
    ]);
    assert.deepStrictEqual(out, [{ path: 'a.ts', status: 'modified' }]);
  });

  it('returns undefined when the only entry has an empty path', () => {
    assert.strictEqual(extractRollbackChanges([{ path: '', status: 'modified' }]), undefined);
  });

  it('logs the dropped-entry count instead of silently rolling back fewer files than confirmed', () => {
    // buildRollbackConfirmMessage counts the FILTERED set, so
    // a mixed-validity array's confirm modal already reads "Roll back local
    // changes to 1 file?" for what the user gestured as two — the fix is not
    // to change that count, but to make the drop observable instead of
    // silent.
    const { calls, restore } = captureWarnCalls();
    try {
      const out = extractRollbackChanges([
        { path: '', status: 'modified' },
        { path: 'a.ts', status: 'modified' },
      ]);
      assert.deepStrictEqual(
        out,
        [{ path: 'a.ts', status: 'modified' }],
        'still proceeds filtered'
      );
    } finally {
      restore();
    }
    assert.strictEqual(calls.length, 1, 'exactly one warn for the one dropped entry');
    assert.deepStrictEqual(calls[0].context, { droppedCount: 1, kept: 1 });
  });

  it('does not warn when every entry in the array is well-formed', () => {
    const { calls, restore } = captureWarnCalls();
    try {
      extractRollbackChanges([{ path: 'a.ts', status: 'modified' }]);
    } finally {
      restore();
    }
    assert.deepStrictEqual(calls, []);
  });
});

describe('buildRollbackConfirmMessage', () => {
  it('lists every affected file and warns the action is irreversible', () => {
    const { message, detail } = buildRollbackConfirmMessage([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'deleted' },
    ]);
    assert.ok(/2 files/.test(message), 'message states the file count');
    assert.ok(/cannot be undone/i.test(message), 'message warns of data loss');
    assert.ok(detail.includes('src/a.ts'), 'detail lists first file');
    assert.ok(detail.includes('src/b.ts'), 'detail lists second file');
  });

  it('spells out that included untracked files are DELETED from disk', () => {
    const { detail } = buildRollbackConfirmMessage([
      { path: 'keep.ts', status: 'modified' },
      { path: 'junk.txt', status: 'untracked' },
    ]);
    assert.ok(/untracked/.test(detail), 'detail flags the untracked file');
    assert.ok(/DELETED/.test(detail), 'detail warns of deletion');
  });

  it('omits the deletion warning when no untracked files are present', () => {
    const { detail } = buildRollbackConfirmMessage([{ path: 'a.ts', status: 'modified' }]);
    assert.ok(!/DELETED/.test(detail), 'no deletion warning without untracked files');
  });
});

describe('extractRollbackChanges — oldPath pass-through', () => {
  it('preserves oldPath on renamed/copied entries so the rollback restores the pre-rename file', () => {
    const out = extractRollbackChanges([
      { path: 'new.ts', status: 'renamed', oldPath: 'old.ts' },
      { path: 'copy.ts', status: 'copied', oldPath: 'orig.ts' },
    ]);
    assert.deepStrictEqual(out, [
      { path: 'new.ts', status: 'renamed', oldPath: 'old.ts' },
      { path: 'copy.ts', status: 'copied', oldPath: 'orig.ts' },
    ]);
  });

  it('ignores a non-string oldPath', () => {
    const out = extractRollbackChanges([{ path: 'new.ts', status: 'renamed', oldPath: 42 }]);
    assert.deepStrictEqual(out, [{ path: 'new.ts', status: 'renamed' }]);
  });
});

describe('enrichRollbackChanges', () => {
  const statuses = [
    { path: 'new.ts', indexStatus: 'R', workTreeStatus: ' ', renamed: 'old.ts' },
    { path: 'plain.ts', indexStatus: ' ', workTreeStatus: 'M' },
  ] as never;

  it('re-derives status and oldPath from git status so arg callers cannot lose the rename', () => {
    const out = enrichRollbackChanges(
      [{ path: 'new.ts', status: 'renamed' }], // caller sent no oldPath (webview row)
      statuses
    );
    assert.deepStrictEqual(out, [{ path: 'new.ts', status: 'renamed', oldPath: 'old.ts' }]);
  });

  it('leaves entries untouched when the path is absent from status', () => {
    const out = enrichRollbackChanges([{ path: 'gone.ts', status: 'modified' }], statuses);
    assert.deepStrictEqual(out, [{ path: 'gone.ts', status: 'modified' }]);
  });
});
