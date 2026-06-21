/**
 * P2 — Update Project preflight guard (IntelliJ git4idea
 * GitUpdateProcess.checkTrackedBranchesConfigured / isUpdatePossible parity).
 *
 * GitUpdateProcess refuses to update when a rebase or merge is already in
 * progress, or when the working tree has unmerged files (GitUpdateProcess.java
 * line ~170: `checkRebaseInProgress() || isMergeInProgress() ||
 * areUnmergedFiles()`). `updateProjectBlockedReason` is the pure predicate
 * mirroring that check — it returns a human-readable reason string when an
 * update must NOT proceed, or undefined when the repo is ready.
 */

import '../../setup';
import * as assert from 'assert';
import { updateProjectBlockedReason } from '../../../src/sync/updateProject';

describe('updateProjectBlockedReason (#P2 Update Project preflight)', () => {
  it('returns undefined for an idle repo with no unmerged files', () => {
    assert.strictEqual(updateProjectBlockedReason({ hasUnmergedFiles: false }), undefined);
  });

  it('blocks when a rebase is in progress', () => {
    const reason = updateProjectBlockedReason({
      inProgressKind: 'rebasing',
      hasUnmergedFiles: false,
    });
    assert.ok(reason && /rebase/i.test(reason), `expected a rebase reason, got: ${reason}`);
  });

  it('blocks when a merge is in progress', () => {
    const reason = updateProjectBlockedReason({
      inProgressKind: 'merging',
      hasUnmergedFiles: false,
    });
    assert.ok(reason && /merge/i.test(reason), `expected a merge reason, got: ${reason}`);
  });

  it('blocks when there are unmerged (conflicted) files', () => {
    const reason = updateProjectBlockedReason({ hasUnmergedFiles: true });
    assert.ok(
      reason && /conflict|unmerged/i.test(reason),
      `expected an unmerged reason: ${reason}`
    );
  });

  it('does NOT block for a cherry-pick or revert in progress (git update can still fast-forward)', () => {
    // GitUpdateProcess only guards rebase/merge/unmerged — a cherry-pick or
    // revert in progress is not one of its three blockers.
    assert.strictEqual(
      updateProjectBlockedReason({ inProgressKind: 'cherry-picking', hasUnmergedFiles: false }),
      undefined
    );
    assert.strictEqual(
      updateProjectBlockedReason({ inProgressKind: 'reverting', hasUnmergedFiles: false }),
      undefined
    );
  });

  it('reports the rebase/merge block even if unmerged files are also present (rebase takes precedence)', () => {
    const reason = updateProjectBlockedReason({
      inProgressKind: 'rebasing',
      hasUnmergedFiles: true,
    });
    assert.ok(reason && /rebase/i.test(reason));
  });
});
