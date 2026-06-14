/**
 * Unit tests for the in-progress operation status-bar badge descriptor (#28).
 *
 * `describeInProgressOp` is the pure mapping from a repository's
 * `RepositoryState` to the persistent status-bar badge (text + tooltip)
 * shown while a merge / rebase / cherry-pick / revert is in progress. It
 * returns `null` for the `idle` state (no badge).
 */

import '../../setup';
import * as assert from 'assert';
import { describeInProgressOp } from '../../../ui-shell/inProgressBadge';

describe('describeInProgressOp (#28 in-progress badge)', () => {
  it('returns null for an idle repository (no badge)', () => {
    assert.strictEqual(describeInProgressOp('idle'), null);
  });

  it('describes a rebase in progress', () => {
    const badge = describeInProgressOp('rebasing');
    assert.ok(badge);
    assert.ok(badge.text.includes('Rebase'), 'text names the operation');
    assert.ok(
      /continue|abort|resolve/i.test(badge.tooltip),
      'tooltip hints at the available actions'
    );
  });

  it('describes each non-idle op kind distinctly', () => {
    const kinds = ['merging', 'rebasing', 'cherry-picking', 'reverting'] as const;
    const texts = kinds.map((k) => describeInProgressOp(k)?.text);
    // Every kind yields a badge…
    assert.ok(texts.every((t) => typeof t === 'string' && t.length > 0));
    // …and the labels are distinct so the user can tell which op is paused.
    assert.strictEqual(new Set(texts).size, kinds.length, 'each op has a distinct label');
    assert.ok(describeInProgressOp('merging')!.text.includes('Merge'));
    assert.ok(describeInProgressOp('cherry-picking')!.text.includes('Cherry'));
    assert.ok(describeInProgressOp('reverting')!.text.includes('Revert'));
  });

  it('includes the target ref in the tooltip when known', () => {
    const badge = describeInProgressOp('rebasing', 'main');
    assert.ok(badge!.tooltip.includes('main'), 'target ref surfaces in the tooltip');
  });

  it('omits a target suffix gracefully when none is known', () => {
    const badge = describeInProgressOp('merging');
    assert.ok(badge, 'still produces a badge without a target');
    assert.ok(!badge.tooltip.includes('()'), 'no empty parenthetical when target is absent');
  });
});
