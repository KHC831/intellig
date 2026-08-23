/**
 * The retarget guard's policy, isolated from the view.
 *
 * The stamp exists because the repository selector retargets synchronously and
 * reloads asynchronously. The half that matters is WHICH messages it covers:
 * the first version stamped four file actions per call site and left `commit`,
 * `commitAndPush` and the stash actions unstamped — the three that mutate.
 * Exempting is now the explicit list, so a message type added later is guarded
 * by default.
 */

import '../../setup';
import * as assert from 'assert';
import { isStaleForTarget } from '../../../src/commits/ctwRetargetGuard';

const CURRENT = '/repo/current';
const isCurrentRoot = (root: string): boolean => root === CURRENT;

/** Everything that acts on repository content, including the mutating paths. */
const REPO_SCOPED = [
  'selectFile',
  'openFileDiff',
  'toggleFile',
  'changelistContextAction',
  'commit',
  'commitAndPush',
  'shelfTabContextAction',
];

const VIEW_PREFERENCE = [
  'tabChange',
  'changesGroupingChange',
  'shelfTabFilterChange',
  'gearAction',
];

describe('Commit window retarget guard', () => {
  for (const type of REPO_SCOPED) {
    it(`drops "${type}" stamped with a repo that is no longer the target`, () => {
      assert.strictEqual(isStaleForTarget({ type, repoRoot: '/repo/other' }, isCurrentRoot), true);
    });

    it(`allows "${type}" stamped with the current target`, () => {
      assert.strictEqual(isStaleForTarget({ type, repoRoot: CURRENT }, isCurrentRoot), false);
    });
  }

  for (const type of VIEW_PREFERENCE) {
    it(`never drops "${type}" — it renders, it does not act`, () => {
      assert.strictEqual(isStaleForTarget({ type, repoRoot: '/repo/other' }, isCurrentRoot), false);
    });
  }

  it('guards an unknown message type by default', () => {
    assert.strictEqual(
      isStaleForTarget({ type: 'somethingAddedLater', repoRoot: '/repo/other' }, isCurrentRoot),
      true,
      'a new repo-scoped message must not silently opt out of the guard'
    );
  });

  it('lets an unstamped message through, so a stale webview degrades rather than goes silent', () => {
    assert.strictEqual(isStaleForTarget({ type: 'commit' }, isCurrentRoot), false);
  });
});
