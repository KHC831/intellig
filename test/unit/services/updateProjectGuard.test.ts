/**
 * P2 — Update Project preflight guard (IntelliJ git4idea
 * GitUpdateProcess.checkTrackedBranchesConfigured / isUpdatePossible parity).
 *
 * GitUpdateProcess refuses to update when a rebase or merge is already in
 * progress, or when the working tree has unmerged files (GitUpdateProcess.java
 * line ~170: `checkRebaseInProgress() || isMergeInProgress() ||
 * areUnmergedFiles()`). `updateProjectBlockage` is the pure predicate
 * mirroring that check — it returns the blockage kind + a human-readable
 * reason when an update must NOT proceed, or undefined when the repo is ready.
 */

import '../../setup';
import * as assert from 'assert';
import { updateProjectBlockage } from '../../../src/sync/updateProject';

describe('updateProjectBlockage (#P2 Update Project preflight)', () => {
  it('returns undefined for an idle repo with no unmerged files', () => {
    assert.strictEqual(updateProjectBlockage({ hasUnmergedFiles: false }), undefined);
  });

  it('blocks when a rebase is in progress', () => {
    const blockage = updateProjectBlockage({
      inProgressKind: 'rebasing',
      hasUnmergedFiles: false,
    });
    assert.strictEqual(blockage?.kind, 'rebase');
    assert.ok(/rebase/i.test(blockage.reason), `expected a rebase reason, got: ${blockage.reason}`);
  });

  it('blocks when a merge is in progress', () => {
    const blockage = updateProjectBlockage({
      inProgressKind: 'merging',
      hasUnmergedFiles: false,
    });
    assert.strictEqual(blockage?.kind, 'merge');
    assert.ok(/merge/i.test(blockage.reason), `expected a merge reason, got: ${blockage.reason}`);
  });

  it('blocks when there are unmerged (conflicted) files', () => {
    const blockage = updateProjectBlockage({ hasUnmergedFiles: true });
    assert.strictEqual(blockage?.kind, 'conflicts');
    assert.ok(
      /conflict|unmerged/i.test(blockage.reason),
      `expected an unmerged reason: ${blockage.reason}`
    );
  });

  it('does NOT block for a cherry-pick or revert in progress (git update can still fast-forward)', () => {
    // GitUpdateProcess only guards rebase/merge/unmerged — a cherry-pick or
    // revert in progress is not one of its three blockers.
    assert.strictEqual(
      updateProjectBlockage({ inProgressKind: 'cherry-picking', hasUnmergedFiles: false }),
      undefined
    );
    assert.strictEqual(
      updateProjectBlockage({ inProgressKind: 'reverting', hasUnmergedFiles: false }),
      undefined
    );
  });

  it('reports the rebase/merge block even if unmerged files are also present (rebase takes precedence)', () => {
    const blockage = updateProjectBlockage({
      inProgressKind: 'rebasing',
      hasUnmergedFiles: true,
    });
    assert.strictEqual(blockage?.kind, 'rebase');
  });
});
