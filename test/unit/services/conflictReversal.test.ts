/**
 * Unit tests for the conflict ours/theirs reversal helpers.
 *
 * These are pure functions but they gate a data-integrity decision: which side
 * of a conflict "Accept Yours/Theirs" keeps. A wrong answer silently discards
 * the user's work, so the mapping is pinned explicitly here.
 */

import '../../setup';
import * as assert from 'assert';
import {
  isReversedOperation,
  inferReopenOperation,
  type ConflictRepoState,
} from '../../../src/conflicts/conflictReversal';
import type { IConflictOpContext } from '../../../src/conflicts/interfaces/IConflictResolutionService';

type Op = IConflictOpContext['operation'];

describe('isReversedOperation', () => {
  it('reverses ours/theirs for rebase, unstash, and unshelve', () => {
    for (const op of ['rebase', 'unstash', 'unshelve'] as Op[]) {
      assert.strictEqual(isReversedOperation(op), true, `${op} must reverse`);
    }
  });

  it('does NOT reverse for merge, cherryPick, revert, applyPatch, or undefined', () => {
    for (const op of ['merge', 'cherryPick', 'revert', 'applyPatch', undefined] as Array<
      Op | undefined
    >) {
      assert.strictEqual(isReversedOperation(op), false, `${op} must not reverse`);
    }
  });
});

describe('inferReopenOperation', () => {
  it('prefers the recorded operation over the repository state', () => {
    // Even with an idle repo, a recorded 'unstash' must win (the recorded op is
    // the truth set when the conflict was produced).
    assert.strictEqual(inferReopenOperation('unstash', 'idle'), 'unstash');
    assert.strictEqual(inferReopenOperation('merge', 'rebasing'), 'merge');
    assert.strictEqual(inferReopenOperation('cherryPick', 'idle'), 'cherryPick');
  });

  it('maps each in-progress state to its operation when nothing is recorded', () => {
    const cases: Array<[ConflictRepoState, Op]> = [
      ['merging', 'merge'],
      ['rebasing', 'rebase'],
      ['cherry-picking', 'cherryPick'],
      ['reverting', 'revert'],
    ];
    for (const [state, expected] of cases) {
      assert.strictEqual(inferReopenOperation(undefined, state), expected, `state ${state}`);
    }
  });

  it('guesses unstash (reversed) for an idle repo with no recorded op', () => {
    // An idle repo with unmerged files is never a merge/rebase/cherry/revert
    // (those leave state). It is a working-tree apply — overwhelmingly an
    // external stash pop — where reversal keeps the user's stashed work.
    assert.strictEqual(inferReopenOperation(undefined, 'idle'), 'unstash');
    assert.strictEqual(isReversedOperation(inferReopenOperation(undefined, 'idle')), true);
  });
});
