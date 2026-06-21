/**
 * Post-ordering invariant (spec 8 L6).
 *
 * Every host method that mutates selection state and posts wire messages
 * to the webview MUST order its side effects so that:
 *
 *   1. When the method does a full re-render, `_updateWebview()` runs
 *      FIRST — the new HTML document must exist before any postMessage,
 *      or the post lands on the doomed pre-reload document and is silently
 *      swallowed (ADR-009 3, the menu-flashes-stale-state bug class).
 *   2. `_onDidChangeState.fire()` runs BEFORE the `_post*` helpers, so
 *      subscribers observe "selection changed" on the same event-loop tick
 *      the host commits it.
 *   3. `_postSyncSelection()` / `_postMenuStateUpdate()` run LAST.
 *
 * Note on partial-update methods: `selectCommit`, `rangeSelectCommit`, and
 * `addRangeSelectCommit` deliberately SKIP `_updateWebview()` — a full
 * re-render destroys the focused `.commit-row` DOM node and breaks the
 * Shift+Arrow keyboard loop (a fixed regression; see the inline rationale
 * in those methods). For those methods the invariant is only the relative
 * order of `fire` before the `_post*` helpers; there is no `_updateWebview`
 * to anchor. This test pins the ACTUAL ordering each method implements, not
 * a uniform template, because the partial vs. full split is intentional.
 *
 * Strategy: spy on the four ordering-relevant methods by replacing them on
 * the instance with recorders that push a tag into a shared call log, then
 * drive each selection-mutating method and assert the recorded order.
 */

import '../../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../../src/ui-shell/GitToolWindowProvider';
import type { ICommitNode } from '../../../../src/git-core/commitGraph';
import { Uri } from '../../../mocks/vscode';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkNode(hash: string, parents: string[] = [], column = 0): ICommitNode {
  return {
    commit: {
      hash,
      shortHash: hash.slice(0, 7),
      message: `commit ${hash}`,
      author: { name: 'a', email: 'a@x' },
      committer: { name: 'a', email: 'a@x' },
      parents,
      authorDate: new Date(0),
      commitDate: new Date(0),
    },
    graphColumn: column,
    graphLines: [],
    branches: [],
    tags: [],
  } as unknown as ICommitNode;
}

/**
 * Ordering-relevant internals we spy on. The order tags pushed into the
 * shared log are the four method names from the L6 rule.
 */
interface OrderingInternals {
  _extendedLogState: { commitNodes: ICommitNode[]; anchorHash: string | null };
  _updateWebview(): void;
  _onDidChangeState: { fire(): void };
  _postSyncSelection(): void;
  _postMenuStateUpdate(): void;
  _postDetailsForExpandedCommit(): void;
}

/**
 * Replace each ordering-relevant method on the instance with a recorder.
 * Returns the shared call log (a list of method-name tags in call order).
 */
function instrument(provider: GitToolWindowProvider): string[] {
  const log: string[] = [];
  const internals = provider as unknown as OrderingInternals;

  internals._updateWebview = (): void => {
    log.push('_updateWebview');
  };
  // `_onDidChangeState` is a readonly EventEmitter; we only need its `fire`.
  const fireRecorder = (): void => {
    log.push('fire');
  };
  (internals._onDidChangeState as { fire(): void }).fire = fireRecorder;
  internals._postSyncSelection = (): void => {
    log.push('_postSyncSelection');
  };
  internals._postMenuStateUpdate = (): void => {
    log.push('_postMenuStateUpdate');
  };
  internals._postDetailsForExpandedCommit = (): void => {
    log.push('_postDetailsForExpandedCommit');
  };
  return log;
}

function seed(provider: GitToolWindowProvider, nodes: ICommitNode[], anchor: string | null): void {
  const internals = provider as unknown as OrderingInternals;
  internals._extendedLogState.commitNodes = nodes;
  internals._extendedLogState.anchorHash = anchor;
}

/** Index of a tag in the call log, or -1 if absent. */
function idx(log: string[], tag: string): number {
  return log.indexOf(tag);
}

/** Assert `before` was called strictly before `after` (both must be present). */
function assertOrder(log: string[], before: string, after: string, ctx: string): void {
  const b = idx(log, before);
  const a = idx(log, after);
  assert.ok(b >= 0, `${ctx}: expected ${before} to be called (log: ${log.join(' → ')})`);
  assert.ok(a >= 0, `${ctx}: expected ${after} to be called (log: ${log.join(' → ')})`);
  assert.ok(b < a, `${ctx}: expected ${before} BEFORE ${after}, got order: ${log.join(' → ')}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Post-ordering invariant (spec 8 L6)', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  it('selectCommit: fire before _postMenuStateUpdate (partial-update path, no _updateWebview)', () => {
    const nodes = [mkNode('aaa'), mkNode('bbb')];
    seed(provider, nodes, null);
    const log = instrument(provider);

    provider.selectCommit('aaa');

    // selectCommit uses the inline partial-post path, so _updateWebview is
    // intentionally NOT called; the invariant is fire → _postMenuStateUpdate.
    assertOrder(log, 'fire', '_postMenuStateUpdate', 'selectCommit');
    assert.strictEqual(idx(log, '_updateWebview'), -1, 'selectCommit must NOT full-render');
  });

  it('selectCommits: _updateWebview → fire → _postSyncSelection → _postMenuStateUpdate (full template)', () => {
    const nodes = [mkNode('aaa'), mkNode('bbb'), mkNode('ccc')];
    seed(provider, nodes, null);
    const log = instrument(provider);

    provider.selectCommits(['aaa', 'bbb'], 'aaa');

    assertOrder(log, '_updateWebview', 'fire', 'selectCommits');
    assertOrder(log, 'fire', '_postSyncSelection', 'selectCommits');
    assertOrder(log, '_postSyncSelection', '_postMenuStateUpdate', 'selectCommits');
  });

  it('rangeSelectCommit: fire before _postSyncSelection and _postMenuStateUpdate (partial-update path)', () => {
    const nodes = [mkNode('aaa'), mkNode('bbb'), mkNode('ccc')];
    // Valid in-window anchor so the method takes the range branch, not the
    // selectCommit fallback.
    seed(provider, nodes, 'aaa');
    const log = instrument(provider);

    provider.rangeSelectCommit('ccc');

    assertOrder(log, 'fire', '_postSyncSelection', 'rangeSelectCommit');
    assertOrder(log, 'fire', '_postMenuStateUpdate', 'rangeSelectCommit');
    assertOrder(log, '_postSyncSelection', '_postMenuStateUpdate', 'rangeSelectCommit');
    // Partial-update path: full re-render is intentionally skipped.
    assert.strictEqual(idx(log, '_updateWebview'), -1, 'rangeSelectCommit must NOT full-render');
  });

  it('addRangeSelectCommit: fire before _postSyncSelection and _postMenuStateUpdate (partial-update path)', () => {
    const nodes = [mkNode('aaa'), mkNode('bbb'), mkNode('ccc')];
    seed(provider, nodes, 'aaa');
    const log = instrument(provider);

    provider.addRangeSelectCommit('ccc');

    assertOrder(log, 'fire', '_postSyncSelection', 'addRangeSelectCommit');
    assertOrder(log, 'fire', '_postMenuStateUpdate', 'addRangeSelectCommit');
    assertOrder(log, '_postSyncSelection', '_postMenuStateUpdate', 'addRangeSelectCommit');
    assert.strictEqual(idx(log, '_updateWebview'), -1, 'addRangeSelectCommit must NOT full-render');
  });

  it('toggleCommitSelection: _updateWebview → fire → _postSyncSelection → _postMenuStateUpdate (full template)', () => {
    const nodes = [mkNode('aaa'), mkNode('bbb')];
    seed(provider, nodes, null);
    const log = instrument(provider);

    provider.toggleCommitSelection('aaa');

    assertOrder(log, '_updateWebview', 'fire', 'toggleCommitSelection');
    assertOrder(log, 'fire', '_postSyncSelection', 'toggleCommitSelection');
    assertOrder(log, '_postSyncSelection', '_postMenuStateUpdate', 'toggleCommitSelection');
  });
});
