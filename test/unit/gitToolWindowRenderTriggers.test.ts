/**
 * Which entry points are allowed to destroy the tool window's document.
 *
 * Every render reassigns `webview.html`, and `htmlBuilders` puts a fresh CSP
 * nonce in each document, so every reassignment is a guaranteed iframe reload:
 * scroll position, focus, and the log filter's uncommitted draft all die with
 * the old document. The draft is the sharp case — the host renders only the
 * COMMITTED filter text, so whatever the user has typed exists nowhere but the
 * DOM being thrown away.
 *
 * These specs count document rebuilds, not `_render` calls, because the
 * reassignment is the thing that actually costs the user something.
 */

import '../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import type { ICommit, IRepository } from '../../src/git-core/interfaces/IGitService';
import { Uri, setMockConfigValue } from '../mocks/vscode';

/**
 * A freshly-constructed repository object for `rootPath`. Callers deliberately
 * build a NEW object each time: a reload replaces these, so "same roots" and
 * "same objects" are different questions and only the first one is about the
 * document.
 */
function mkRepo(rootPath: string): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

function mkCommit(hash: string): ICommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: `commit ${hash}`,
    author: { name: 'a', email: 'a@x' },
    committer: { name: 'a', email: 'a@x' },
    parents: [],
    authorDate: new Date(0),
    commitDate: new Date(0),
  };
}

/** Count `webview.html` assignments — one per destroyed document. */
function tapView(provider: GitToolWindowProvider): { rebuilds: () => number } {
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
  return { rebuilds: () => count };
}

describe('refresh() asks for fresh data instead of repainting stale data', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  // Instrument control. Every assertion below expects zero rebuilds, and a tap
  // wired to the wrong object would report zero for all of them — which reads
  // exactly like success. So prove the tap sees a rebuild that must happen.
  it('counts a rebuild for new log data, which is known to repaint', () => {
    const view = tapView(provider);

    provider.updateLogState([mkCommit('aaaaaaa1')]);

    assert.strictEqual(
      view.rebuilds(),
      1,
      'tap is blind: genuinely new log data must rebuild the document'
    );
  });

  it('does not rebuild the document synchronously', () => {
    provider.updateLogState([mkCommit('aaaaaaa1')]);
    const view = tapView(provider);

    provider.refresh();

    assert.strictEqual(
      view.rebuilds(),
      0,
      'refresh() repaints pre-reload state: a stale flash that costs the document. ' +
        'The reload it requests renders again when the data actually arrives.'
    );
  });

  it('still asks the host to re-fetch', () => {
    let requested = 0;
    const sub = provider.onDidRequestRefresh(() => {
      requested += 1;
    });

    provider.refresh();
    sub.dispose();

    assert.strictEqual(requested, 1, 'dropping the render must not drop the reload request');
  });

  it('still announces its state change', () => {
    let changed = 0;
    const sub = provider.onDidChangeState(() => {
      changed += 1;
    });

    provider.refresh();
    sub.dispose();

    assert.strictEqual(changed, 1, 'dropping the render must not drop the state event');
  });

  it('leaves the existing document in place for the reload to replace', () => {
    provider.updateLogState([mkCommit('aaaaaaa1')]);
    const view = tapView(provider);

    provider.refresh();
    provider.refresh();
    provider.refresh();

    assert.strictEqual(
      view.rebuilds(),
      0,
      'three refreshes in a row destroyed up to three documents before this fix'
    );
  });
});

describe('setAvailableRepositories stores every time and repaints only on a visible change', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  // Instrument control, same reasoning as above.
  it('counts a rebuild for the first population, which is known to repaint', () => {
    const view = tapView(provider);

    provider.setAvailableRepositories([mkRepo('/repo/a')]);

    assert.strictEqual(
      view.rebuilds(),
      1,
      'tap is blind: going from no repositories to one must rebuild the document'
    );
  });

  it('does not repaint when the same roots arrive again', () => {
    provider.setAvailableRepositories([mkRepo('/repo/a'), mkRepo('/repo/b')]);
    const view = tapView(provider);

    provider.setAvailableRepositories([mkRepo('/repo/a'), mkRepo('/repo/b')]);

    assert.strictEqual(
      view.rebuilds(),
      0,
      'this runs on every watcher tick; repainting here defeats the log fingerprint guard downstream'
    );
  });

  // The failure mode the method-level guard exists to avoid. A reload REPLACES
  // repository objects, and the stored array feeds action paths, not just the
  // render. Skipping the STORE to avoid the render would freeze stale objects
  // into those paths — a data bug traded for a render bug.
  it('still stores the fresh repository objects when it does not repaint', () => {
    provider.setAvailableRepositories([mkRepo('/repo/a')]);
    const view = tapView(provider);
    const replacement = mkRepo('/repo/a');

    provider.setAvailableRepositories([replacement]);

    assert.strictEqual(view.rebuilds(), 0, 'precondition: the identical root set must not repaint');
    assert.strictEqual(
      provider.getSelectedRepository(),
      replacement,
      'the selected repository must be the object just handed in, not the one it replaced'
    );
  });

  it('repaints when a repository is added', () => {
    provider.setAvailableRepositories([mkRepo('/repo/a')]);
    const view = tapView(provider);

    provider.setAvailableRepositories([mkRepo('/repo/a'), mkRepo('/repo/b')]);

    assert.strictEqual(view.rebuilds(), 1, 'a new root is visible in the selector');
  });

  it('repaints when a repository disappears', () => {
    provider.setAvailableRepositories([mkRepo('/repo/a'), mkRepo('/repo/b')]);
    const view = tapView(provider);

    provider.setAvailableRepositories([mkRepo('/repo/a')]);

    assert.strictEqual(view.rebuilds(), 1, 'a dropped root is visible in the selector');
  });

  it('repaints when the roots are reordered, since the selector renders them in order', () => {
    provider.setAvailableRepositories([mkRepo('/repo/a'), mkRepo('/repo/b')]);
    const view = tapView(provider);

    provider.setAvailableRepositories([mkRepo('/repo/b'), mkRepo('/repo/a')]);

    assert.strictEqual(view.rebuilds(), 1, 'the dropdown lists roots in array order');
  });

  it('repaints when the last repository goes away', () => {
    provider.setAvailableRepositories([mkRepo('/repo/a')]);
    const view = tapView(provider);

    provider.setAvailableRepositories([]);

    assert.strictEqual(view.rebuilds(), 1, 'the empty state is a different document');
  });

  it('repaints once, not twice, across two identical follow-up populations', () => {
    provider.setAvailableRepositories([mkRepo('/repo/a')]);
    const view = tapView(provider);

    provider.setAvailableRepositories([mkRepo('/repo/a'), mkRepo('/repo/b')]);
    provider.setAvailableRepositories([mkRepo('/repo/a'), mkRepo('/repo/b')]);

    assert.strictEqual(view.rebuilds(), 1, 'only the first of the two changed anything');
  });

  // The method's most intricate branch: an active visible-roots SUBSET gets
  // pruned against the incoming list, and that prune can rewrite the selection
  // and the scope. A repeated identical population must leave all of it alone.
  it('leaves an active visible-roots subset untouched and unrepainted on a repeat', () => {
    const roots = ['/repo/a', '/repo/b', '/repo/c'];
    provider.setAvailableRepositories(roots.map(mkRepo));
    (
      provider as unknown as { _handleVisibleRepositoriesSelection(r: string[]): void }
    )._handleVisibleRepositoriesSelection([Uri.file('/repo/a').fsPath, Uri.file('/repo/b').fsPath]);
    const subsetBefore = provider.getVisibleRepoRoots();
    assert.ok(subsetBefore && subsetBefore.length === 2, 'precondition: a real 2-of-3 subset');

    const view = tapView(provider);
    provider.setAvailableRepositories(roots.map(mkRepo));

    assert.strictEqual(view.rebuilds(), 0, 'the same three roots arriving again show nothing new');
    assert.deepStrictEqual(
      provider.getVisibleRepoRoots(),
      subsetBefore,
      'the prune must not quietly narrow or drop a subset it did not need to touch'
    );
  });

  // The scope is RE-DERIVED from config on every population while the user has
  // made no explicit choice, so it can change with an identical root set. This
  // is the only dimension that moves on its own, and without it the guard would
  // hold the document at the previous scope until something else repainted.
  it('repaints when the resolved scope changes under an unchanged root set', () => {
    setMockConfigValue('intellig', 'log.showAllRoots', true);
    provider.setAvailableRepositories([mkRepo('/repo/a'), mkRepo('/repo/b')]);
    const view = tapView(provider);

    setMockConfigValue('intellig', 'log.showAllRoots', false);
    provider.setAvailableRepositories([mkRepo('/repo/a'), mkRepo('/repo/b')]);

    assert.strictEqual(
      view.rebuilds(),
      1,
      'the merged scope collapsed to a single repository: same roots, different document'
    );
  });

  it('repaints when the surviving subset collapses to a single root', () => {
    provider.setAvailableRepositories(['/repo/a', '/repo/b', '/repo/c'].map(mkRepo));
    (
      provider as unknown as { _handleVisibleRepositoriesSelection(r: string[]): void }
    )._handleVisibleRepositoriesSelection([Uri.file('/repo/a').fsPath, Uri.file('/repo/b').fsPath]);
    const view = tapView(provider);

    // /repo/b disappears, so the subset has one survivor and collapses to the
    // single-repo scope — a different document in three separate ways.
    provider.setAvailableRepositories(['/repo/a', '/repo/c'].map(mkRepo));

    assert.strictEqual(view.rebuilds(), 1, 'selection, scope and subset all changed');
    assert.strictEqual(provider.getVisibleRepoRoots(), null, 'the subset collapsed');
  });
});
