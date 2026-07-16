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
