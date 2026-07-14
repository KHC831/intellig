/**
 * Unit test: a background log refresh that produced IDENTICAL data must not
 * rebuild the graph webview DOM.
 *
 * Root cause of the "whole extension constantly refreshing / details panel
 * jumps to top after a few seconds" dogfood report: the working-tree watcher
 * fires on any workspace write (build output, a live sqlite db, editor saves),
 * each firing runs the full graph reload, and `updateLogState` re-rendered the
 * entire webview even when the reloaded commits/refs were identical to what is
 * already on screen. A captured dogfood session showed a full re-render every
 * 5–12 seconds while the user was idle.
 *
 * The fix: `updateLogState` fingerprints its inputs (commit hashes + branch
 * map + tag map + head anchor + total) and short-circuits the render, state
 * fire, and post sequence when nothing changed. A pending scroll-reset mark
 * (true navigation) always forces the render through, and losing the
 * repository invalidates the fingerprint so the no-repo screen can never eat
 * a later identical update.
 */

import '../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { ICommit, IAuthor } from '../../src/git-core/interfaces/IGitService';
import { fingerprintLogState } from '../../src/git-core/gitToolWindow/provider/logStateFingerprint';
import { Uri } from '../mocks/vscode';

const AUTHOR: IAuthor = { name: 'tester', email: 't@example.com' };

function mkCommit(hash: string): ICommit {
  const date = new Date(2020, 0, 1);
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message: 'm',
    author: AUTHOR,
    committer: AUTHOR,
    parents: [],
    authorDate: date,
    commitDate: date,
  };
}

function tapView(provider: GitToolWindowProvider): { htmlSetCount: () => number } {
  let count = 0;
  let backing = '';
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
  (provider as any)._view = {
    webview: {
      get html(): string {
        return backing;
      },
      set html(v: string) {
        count += 1;
        backing = v;
      },
      options: {},
      cspSource: 'test:',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (u: unknown) => u,
    },
    visible: true,
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
  return { htmlSetCount: () => count };
}

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

function branchMapOn(hash: string, name: string): Map<string, { name: string; type: 'local' }[]> {
  return new Map([[hash, [{ name, type: 'local' as const }]]]);
}

describe('identical background log refresh does not re-render the graph', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  it('a second updateLogState with identical inputs is a render no-op', () => {
    const view = tapView(provider);
    const commits = [mkCommit(HASH_A), mkCommit(HASH_B)];

    provider.updateLogState(commits, branchMapOn(HASH_A, 'main'), new Map(), HASH_A, 'main');
    const rendersAfterFirst = view.htmlSetCount();
    assert.ok(rendersAfterFirst >= 1, 'precondition: the first update renders');

    provider.updateLogState(commits, branchMapOn(HASH_A, 'main'), new Map(), HASH_A, 'main');
    assert.strictEqual(
      view.htmlSetCount(),
      rendersAfterFirst,
      'an identical background refresh must not rebuild the webview DOM'
    );
  });

  it('a changed branch map still re-renders (new branch chip must appear)', () => {
    const view = tapView(provider);
    const commits = [mkCommit(HASH_A)];

    provider.updateLogState(commits, branchMapOn(HASH_A, 'main'), new Map(), HASH_A, 'main');
    const rendersAfterFirst = view.htmlSetCount();

    const grown = new Map([
      [
        HASH_A,
        [
          { name: 'main', type: 'local' as const },
          { name: 'feat', type: 'local' as const },
        ],
      ],
    ]);
    provider.updateLogState(commits, grown, new Map(), HASH_A, 'main');
    assert.ok(
      view.htmlSetCount() > rendersAfterFirst,
      'a branch-map change must re-render so the new chip shows'
    );
  });

  it('a changed commit list still re-renders', () => {
    const view = tapView(provider);
    provider.updateLogState([mkCommit(HASH_A)], new Map(), new Map(), HASH_A);
    const rendersAfterFirst = view.htmlSetCount();

    provider.updateLogState([mkCommit(HASH_B), mkCommit(HASH_A)], new Map(), new Map(), HASH_B);
    assert.ok(view.htmlSetCount() > rendersAfterFirst, 'new commits must re-render');
  });

  it('a pending scroll-reset mark (navigation) forces the render through', () => {
    const view = tapView(provider);
    const commits = [mkCommit(HASH_A)];

    provider.updateLogState(commits, new Map(), new Map(), HASH_A);
    const rendersAfterFirst = view.htmlSetCount();

    provider.markResetScrollOnNextRender();
    provider.updateLogState(commits, new Map(), new Map(), HASH_A);
    assert.ok(
      view.htmlSetCount() > rendersAfterFirst,
      'a navigational load must render (and consume its scroll reset) even when the data is identical'
    );
  });

  it('losing the repository invalidates the fingerprint', () => {
    const view = tapView(provider);
    const commits = [mkCommit(HASH_A)];

    provider.updateLogState(commits, new Map(), new Map(), HASH_A);
    provider.setHasRepository(false);
    const rendersAfterNoRepo = view.htmlSetCount();

    provider.updateLogState(commits, new Map(), new Map(), HASH_A);
    assert.ok(
      view.htmlSetCount() > rendersAfterNoRepo,
      'an identical update after the no-repo screen must repaint the graph'
    );
  });
});

describe('identical cherry marks do not re-render the graph', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  it('setCherryPickedHashes with unchanged marks is a render no-op', () => {
    const view = tapView(provider);
    provider.updateLogState([mkCommit(HASH_A)], new Map(), new Map(), HASH_A);

    provider.setCherryPickedHashes(new Set([HASH_A]), 'origin/main');
    const after = view.htmlSetCount();
    provider.setCherryPickedHashes(new Set([HASH_A]), 'origin/main');
    assert.strictEqual(
      view.htmlSetCount(),
      after,
      'the cherry-mark follow-up of a background refresh must not rebuild the DOM when nothing changed'
    );
  });

  it('changed marks or base ref still re-render', () => {
    const view = tapView(provider);
    provider.setCherryPickedHashes(new Set([HASH_A]), 'origin/main');
    const after = view.htmlSetCount();

    provider.setCherryPickedHashes(new Set([HASH_A, HASH_B]), 'origin/main');
    assert.ok(view.htmlSetCount() > after, 'a grown mark set must render');

    const afterGrow = view.htmlSetCount();
    provider.setCherryPickedHashes(new Set([HASH_A, HASH_B]), 'origin/dev');
    assert.ok(view.htmlSetCount() > afterGrow, 'a changed base ref must render');
  });

  it('clearing marks renders once and repeated clears are no-ops', () => {
    const view = tapView(provider);
    provider.setCherryPickedHashes(new Set([HASH_A]), 'origin/main');
    const after = view.htmlSetCount();

    provider.setCherryPickedHashes(undefined);
    assert.ok(view.htmlSetCount() > after, 'clearing must render');

    const afterClear = view.htmlSetCount();
    provider.setCherryPickedHashes(undefined);
    provider.setCherryPickedHashes(new Set(), undefined);
    assert.strictEqual(
      view.htmlSetCount(),
      afterClear,
      'an already-empty mark state must not re-render (empty set normalizes to undefined)'
    );
  });
});

describe('fingerprint encoding is injective over ref names', () => {
  it('one branch containing a comma differs from two branches', () => {
    const commits = [mkCommit(HASH_A)];
    const one = fingerprintLogState(
      commits,
      new Map([[HASH_A, [{ name: 'a/local,b', type: 'local' as const }]]]),
      new Map(),
      HASH_A,
      undefined,
      undefined
    );
    const two = fingerprintLogState(
      commits,
      new Map([
        [
          HASH_A,
          [
            { name: 'a', type: 'local' as const },
            { name: 'b', type: 'local' as const },
          ],
        ],
      ]),
      new Map(),
      HASH_A,
      undefined,
      undefined
    );
    assert.notStrictEqual(one, two, 'comma in a branch name must not fake equality');
  });

  it('one tag containing a comma differs from two tags', () => {
    const commits = [mkCommit(HASH_A)];
    const one = fingerprintLogState(
      commits,
      new Map(),
      new Map([[HASH_A, ['v1,v2']]]),
      HASH_A,
      undefined,
      undefined
    );
    const two = fingerprintLogState(
      commits,
      new Map(),
      new Map([[HASH_A, ['v1', 'v2']]]),
      HASH_A,
      undefined,
      undefined
    );
    assert.notStrictEqual(one, two, 'comma in a tag name must not fake equality');
  });
});
