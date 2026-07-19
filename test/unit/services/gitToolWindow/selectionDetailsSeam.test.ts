/**
 * Every gesture that changes the log selection posts the details model that
 * selection calls for.
 *
 * The multi-commit model was reachable only from `selectCommits`, a
 * programmatic API no webview gesture calls: shift-click and ctrl+shift-click
 * posted the range TIP's single-commit details, and ctrl-click posted nothing
 * at all. All of them now route through one selection-changed seam, so the
 * panel follows the selection whichever gesture produced it.
 *
 * Reference: CommitDetailsListPanel.rebuildPanel renders one detail block per
 * selected commit, so a multi-selection never presents as one commit upstream.
 */

import '../../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitToolWindowProvider } from '../../../../src/ui-shell/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';
import type { ICommitNode } from '../../../../src/git-core/commitGraph';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function mkCommit(hash: string): ICommitNode['commit'] {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: `commit ${hash.slice(0, 7)}`,
    author: { name: 'a', email: 'a@x' },
    committer: { name: 'a', email: 'a@x' },
    parents: [],
    authorDate: new Date(0),
    commitDate: new Date(0),
  } as unknown as ICommitNode['commit'];
}

interface Internals {
  _extendedLogState: {
    commitNodes: ICommitNode[];
    selectedCommits: Set<string>;
    anchorHash: string | null;
    expandedCommit?: string;
  };
  _pendingChangedFiles?: Array<{ path: string; status: string }>;
  _handleWebviewMessage(message: { type: string; commitHash?: string }): void;
}

function makeProvider(): {
  provider: GitToolWindowProvider;
  internals: Internals;
  messages: Array<Record<string, unknown>>;
} {
  const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  const messages: Array<Record<string, unknown>> = [];
  (provider as unknown as { _view: unknown })._view = {
    webview: {
      postMessage: (msg: Record<string, unknown>) => {
        messages.push(msg);
        return Promise.resolve(true);
      },
      cspSource: 'test:',
      asWebviewUri: (u: vscode.Uri) => u,
      html: '',
    },
  };
  const internals = provider as unknown as Internals;
  internals._extendedLogState.commitNodes = [A, B, C].map((h) => ({
    commit: mkCommit(h),
  })) as unknown as ICommitNode[];
  return { provider, internals, messages };
}

function lastDetailsModel(
  messages: Array<Record<string, unknown>>
): Record<string, unknown> | undefined {
  const posts = messages.filter((m) => m.type === 'updateDetailsPanel');
  return posts.length > 0 ? (posts[posts.length - 1].model as Record<string, unknown>) : undefined;
}

describe('selection-changed details seam', () => {
  let provider: GitToolWindowProvider;

  afterEach(() => {
    provider?.dispose();
  });

  it('shift+click range-select of three commits posts a MULTI model', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });

    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: C });

    assert.strictEqual(h.internals._extendedLogState.selectedCommits.size, 3, 'sanity: 3 selected');
    assert.strictEqual(
      lastDetailsModel(h.messages)?.kind,
      'multi',
      'the range posts the selection, not just its tip'
    );
    assert.strictEqual(lastDetailsModel(h.messages)?.count, 3);
  });

  it('ctrl+shift+click additive range-select posts a MULTI model', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });

    h.internals._handleWebviewMessage({ type: 'addRangeSelectCommit', commitHash: B });

    assert.strictEqual(lastDetailsModel(h.messages)?.kind, 'multi');
  });

  it('ctrl+click growing the selection to two posts a MULTI model', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });

    h.internals._handleWebviewMessage({ type: 'toggleCommitSelection', commitHash: B });

    assert.strictEqual(
      lastDetailsModel(h.messages)?.kind,
      'multi',
      'ctrl-click must post details at all'
    );
  });

  it('toggling back down to one commit returns to the SINGLE model', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'toggleCommitSelection', commitHash: B });
    assert.strictEqual(lastDetailsModel(h.messages)?.kind, 'multi', 'sanity: two selected');

    h.internals._handleWebviewMessage({ type: 'toggleCommitSelection', commitHash: B });

    assert.strictEqual(h.internals._extendedLogState.selectedCommits.size, 1);
    assert.notStrictEqual(lastDetailsModel(h.messages)?.kind, 'multi');
  });

  it('a plain click still posts the single-commit model', () => {
    const h = makeProvider();
    provider = h.provider;

    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: B });

    assert.notStrictEqual(lastDetailsModel(h.messages)?.kind, 'multi');
  });
});

describe('details panel Group By keeps the loaded file list', () => {
  let provider: GitToolWindowProvider;

  afterEach(() => {
    provider?.dispose();
  });

  it('switching Group By reposts the files already loaded for the commit', () => {
    const h = makeProvider();
    provider = h.provider;
    const files = [
      { path: 'src/App.java', status: 'modified' },
      { path: 'src/util/Helper.java', status: 'added' },
    ];
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    provider.updateCommitDetails(A, files as never);

    provider.setDetailsGroupBy('flat');

    const model = lastDetailsModel(h.messages);
    assert.strictEqual(model?.kind, 'single', 'sanity: a single-commit model');
    assert.ok(
      JSON.stringify(model).includes('Helper.java'),
      'Group By must not empty the changed-files tree'
    );
  });
});

/**
 * Reaching the multi-commit panel is only half the fix: its combined file
 * tree was always empty, because the only producer built every entry with
 * `changedFiles: []`. The host now loads each selected commit's files and
 * the panel merges them.
 */
describe('multi-commit details panel carries real files', () => {
  let provider: GitToolWindowProvider;

  afterEach(() => {
    provider?.dispose();
  });

  it('asks the host to load files for a newly selected range', () => {
    const h = makeProvider();
    provider = h.provider;
    const asked: string[][] = [];
    provider.onDidSelectCommits(({ hashes }) => asked.push(hashes));

    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: C });

    assert.strictEqual(asked.length, 1, 'one load request for the range');
    assert.deepStrictEqual([...asked[0]].sort(), [A, B, C].sort());
  });

  it('merges every selected commit files into the combined tree', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: C });

    provider.updateMultiCommitDetails(
      [A, B, C],
      new Map([
        [A, [{ path: 'src/a.ts', status: 'modified' as const }]],
        [B, [{ path: 'src/b.ts', status: 'added' as const }]],
        [C, [{ path: 'src/c.ts', status: 'deleted' as const }]],
      ])
    );

    const model = lastDetailsModel(h.messages);
    assert.strictEqual(model?.kind, 'multi');
    assert.strictEqual(model?.changedFilesCount, 3, 'all three commits contribute files');
    const json = JSON.stringify(model);
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      assert.ok(json.includes(name), `${name} is in the combined tree`);
    }
  });

  it('deduplicates a path touched by more than one commit', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: B });

    provider.updateMultiCommitDetails(
      [A, B],
      new Map([
        [A, [{ path: 'src/same.ts', status: 'added' as const }]],
        [B, [{ path: 'src/same.ts', status: 'modified' as const }]],
      ])
    );

    assert.strictEqual(lastDetailsModel(h.messages)?.changedFilesCount, 1);
  });

  it('drops a load that lands after the selection moved on', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: C });
    // The user narrows the selection while the first load is still running.
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: B });
    const before = h.messages.length;

    provider.updateMultiCommitDetails(
      [A, B, C],
      new Map([[A, [{ path: 'src/stale.ts', status: 'modified' as const }]]])
    );

    assert.strictEqual(h.messages.length, before, 'a superseded load paints nothing');
  });

  it('does not re-request files when the same selection repaints', () => {
    const h = makeProvider();
    provider = h.provider;
    let requests = 0;
    provider.onDidSelectCommits(() => (requests += 1));

    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: C });
    provider.updateMultiCommitDetails([A, B, C], new Map());
    // A Group By switch repaints the same selection.
    provider.setDetailsGroupBy('flat');

    assert.strictEqual(requests, 1, 'a repaint of the same selection costs no git');
  });

  it('says so when the selection exceeds the load cap', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: C });

    provider.updateMultiCommitDetails(
      [A, B, C],
      new Map([[A, [{ path: 'src/a.ts', status: 'modified' as const }]]]),
      2
    );

    const model = lastDetailsModel(h.messages);
    assert.match(
      String(model?.changedFilesError ?? ''),
      /first 1 of 3 selected commits/,
      'a capped tree is never presented as the whole truth'
    );
  });
});
