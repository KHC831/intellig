/**
 * Direct pins for the shared git-prose predicates (gitProse.ts).
 *
 * parseUntrackedOverwriteFiles and isLocalChangesOverwriteError carry their
 * own suites (branchCheckoutUntracked.test.ts, smartReset.test.ts); these
 * cover the conflict / would-be-overwritten predicates the migrated sites
 * (StashView, ShelfService, PatchService, sync dialogs, checkout arms)
 * delegate to.
 */
import * as assert from 'assert';
import {
  looksLikeConflictText,
  looksLikePatchConflictText,
  isLocalChangesWouldBeOverwritten,
  isIndexConflictOnUnstash,
  parseLocalChangesOverwriteFiles,
  worktreeRemoveRefusal,
} from '../../../src/git-core/gitProse';

describe('gitProse — shared English-prose predicates', () => {
  describe('looksLikeConflictText', () => {
    it('matches the standard conflict phrasings', () => {
      assert.strictEqual(looksLikeConflictText('CONFLICT (content): Merge conflict in a.ts'), true);
      assert.strictEqual(
        looksLikeConflictText('error: could not apply abc123... with conflicts'),
        true
      );
      assert.strictEqual(looksLikeConflictText('a.ts: needs merge'), true);
    });

    it('stays quiet on unrelated errors', () => {
      assert.strictEqual(looksLikeConflictText('fatal: not a git repository'), false);
      assert.strictEqual(looksLikeConflictText(''), false);
    });
  });

  describe('looksLikePatchConflictText', () => {
    it('adds the apply/am-specific phrasings on top of the conflict set', () => {
      assert.strictEqual(looksLikePatchConflictText('error: patch failed: src/a.ts:10'), true);
      assert.strictEqual(looksLikePatchConflictText('error: src/a.ts: patch does not apply'), true);
      assert.strictEqual(
        looksLikePatchConflictText('Applied patch to src/a.ts with conflicts.'),
        true
      );
    });

    it('stays quiet on a hard refusal', () => {
      assert.strictEqual(looksLikePatchConflictText('fatal: unrecognized input'), false);
    });
  });

  describe('isIndexConflictOnUnstash', () => {
    it("matches git's --index refusal (reference: INDEX_CONFLICT_ON_UNSTASH = 'conflicts in index')", () => {
      assert.strictEqual(
        isIndexConflictOnUnstash('error: conflicts in index. Try without --index.'),
        true
      );
    });

    it('stays quiet on plain merge conflicts and unrelated errors', () => {
      assert.strictEqual(
        isIndexConflictOnUnstash('CONFLICT (content): Merge conflict in a.ts'),
        false
      );
      assert.strictEqual(isIndexConflictOnUnstash('fatal: not a git repository'), false);
    });
  });

  describe('parseLocalChangesOverwriteFiles', () => {
    it('extracts the file list from the modern header + indented-list form', () => {
      const msg = [
        'error: Your local changes to the following files would be overwritten by merge:',
        '\tsrc/a.ts',
        '\tsrc/b.ts',
        'Please commit your changes or stash them before you merge.',
        'Aborting',
      ].join('\n');
      assert.deepStrictEqual(parseLocalChangesOverwriteFiles(msg), ['src/a.ts', 'src/b.ts']);
    });

    it('extracts the single file from the legacy inline form', () => {
      assert.deepStrictEqual(
        parseLocalChangesOverwriteFiles(
          "error: Your local changes to 'src/a.ts' would be overwritten by merge."
        ),
        ['src/a.ts']
      );
    });

    it('returns null for the UNTRACKED-overwrite refusal and unrelated errors', () => {
      const untracked = [
        'error: The following untracked working tree files would be overwritten by merge:',
        '\tnew.txt',
        'Please move or remove them before you merge.',
      ].join('\n');
      assert.strictEqual(parseLocalChangesOverwriteFiles(untracked), null);
      assert.strictEqual(parseLocalChangesOverwriteFiles('fatal: not a git repository'), null);
    });
  });

  describe('isLocalChangesWouldBeOverwritten', () => {
    it('matches both the overwrite refusal and the commit-or-stash hint', () => {
      assert.strictEqual(
        isLocalChangesWouldBeOverwritten(
          'error: Your local changes to the following files would be overwritten by checkout:'
        ),
        true
      );
      assert.strictEqual(
        isLocalChangesWouldBeOverwritten(
          'Please commit your changes or stash them before you switch branches.'
        ),
        true
      );
    });

    it('stays quiet on unrelated errors', () => {
      assert.strictEqual(isLocalChangesWouldBeOverwritten('fatal: bad revision'), false);
    });
  });
});

describe('worktreeRemoveRefusal', () => {
  it('reads the lock refusal, with and without a lock reason', () => {
    assert.strictEqual(
      worktreeRemoveRefusal(
        "fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first"
      ),
      'overrideLock'
    );
    assert.strictEqual(
      worktreeRemoveRefusal(
        "fatal: cannot remove a locked working tree, lock reason: on a USB disk\nuse 'remove -f -f' to override or unlock first"
      ),
      'overrideLock'
    );
  });

  it('reads the changes refusal', () => {
    assert.strictEqual(
      worktreeRemoveRefusal(
        "fatal: '../wt' contains modified or untracked files, use --force to delete it"
      ),
      'discardChanges'
    );
  });

  it('answers nothing for any other failure', () => {
    assert.strictEqual(worktreeRemoveRefusal("fatal: '../wt' is not a working tree"), undefined);
    assert.strictEqual(worktreeRemoveRefusal('error: unknown switch `x`'), undefined);
  });
});
