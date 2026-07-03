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
} from '../../../src/commands/registration/commitRepoCoreCommands';

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
