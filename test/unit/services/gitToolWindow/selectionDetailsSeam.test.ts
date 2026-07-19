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
    graphColumn: 0,
    graphLines: [{ fromColumn: 0, toColumn: 0, color: '#4CAF50', type: 'commit' as const }],
    branches: [],
    tags: [],
  })) as unknown as ICommitNode[];
  return { provider, internals, messages };
}

function mockWebview(): never {
  return {
    cspSource: 'test:',
    asWebviewUri: (u: vscode.Uri) => u,
    postMessage: () => Promise.resolve(true),
    html: '',
  } as never;
}

/** The details model the rendered document seeds its panel with. */
function detailsModelFromHtml(html: string): { kind?: string; count?: number } | undefined {
  const m = html.match(/id="intellig-init"\s+data-init="([^"]*)"/);
  if (!m) {
    return undefined;
  }
  const json = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return (JSON.parse(json) as { initialDetails?: { kind?: string; count?: number } })
    .initialDetails;
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

  it('notifies on every selection change, carrying the new range', () => {
    // The listener owns the load decision: it invalidates whatever is in
    // flight on every change, and only starts a load at two commits or more.
    // A single-commit selection therefore has to be announced too, or
    // shrinking a range leaves its remaining diffs running.
    const h = makeProvider();
    provider = h.provider;
    const asked: string[][] = [];
    provider.onDidSelectCommits(({ hashes }) => asked.push(hashes));

    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: C });

    assert.strictEqual(asked.length, 2, 'one notification per selection change');
    assert.deepStrictEqual(asked[0], [A], 'the single-commit selection is announced');
    assert.deepStrictEqual([...asked[1]].sort(), [A, B, C].sort());
  });

  it('notifies when a range shrinks to one commit (so the load can be abandoned)', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: C });

    const asked: string[][] = [];
    provider.onDidSelectCommits(({ hashes }) => asked.push(hashes));
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: B });

    assert.deepStrictEqual(asked, [[B]], 'shrinking the selection must reach the loader');
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
      ]),
      [A, B, C],
      new Map()
    );

    const model = lastDetailsModel(h.messages);
    assert.strictEqual(model?.kind, 'multi');
    assert.strictEqual(model?.changedFilesCount, 3, 'all three commits contribute files');
    const json = JSON.stringify(model);
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      assert.ok(json.includes(name), `${name} is in the combined tree`);
    }
  });

  // No current path reaches these states: the single-commit loads are started
  // from `fireDidSelectCommit`, whose only call site is `selectCommit`, and
  // range/add-range/toggle never fire it. These pin the guard that makes the
  // SELECTION — not the expanded commit — authoritative, so the public
  // `selectCommits` (no production caller today) or any other future
  // multi-select entry point cannot land a single-commit load over a range.
  it('a late containing-branches load cannot repaint a range as one commit', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: C });
    assert.strictEqual(lastDetailsModel(h.messages)?.kind, 'multi', 'sanity: range is showing');

    provider.updateContainingBranches(C, ['main']);

    assert.strictEqual(
      lastDetailsModel(h.messages)?.kind,
      'multi',
      'a range selection owns the panel'
    );
  });

  it('a late changed-files load cannot repaint a range as one commit', () => {
    // Dropping the payload as well as the paint is the deliberate half: see
    // the note at the guard about the reload a future caller must arrange.
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: C });

    provider.updateCommitDetails(C, [{ path: 'src/late.ts', status: 'modified' }]);

    assert.strictEqual(
      lastDetailsModel(h.messages)?.kind,
      'multi',
      'a range selection owns the panel'
    );
    assert.strictEqual(
      (provider as unknown as { _pendingChangedFiles?: unknown[] })._pendingChangedFiles,
      undefined,
      'and the single-commit payload must not be stashed under a range selection'
    );
  });

  it('still applies a single-commit load when one commit is selected', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });

    provider.updateCommitDetails(A, [{ path: 'src/one.ts', status: 'modified' }]);

    const model = lastDetailsModel(h.messages);
    assert.strictEqual(model?.kind, 'single', 'the single-commit path must keep working');
    assert.strictEqual(model?.changedFilesCount, 1);
  });

  it('a full HTML re-render keeps an N-commit selection as a multi model', () => {
    // Any full re-render (a .git watcher tick, load-more, repo switch, undock)
    // rebuilds the document. Reading only the expanded commit there repainted
    // the whole selection as its tip.
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: C });

    const html = provider._getThreePanelHtmlContent(
      mockWebview(),
      [...h.internals._extendedLogState.commitNodes],
      { hash: C, message: 'commit', changedFiles: [] } as never
    );

    const model = detailsModelFromHtml(html);
    assert.strictEqual(model?.kind, 'multi', `a re-render must keep the multi model:\n${html}`);
    assert.strictEqual(model?.count, 3);
  });

  it('a full HTML re-render keeps the empty-selection placeholder', () => {
    const h = makeProvider();
    provider = h.provider;
    // Select, then ctrl+click it away: expandedCommit persists, selection is empty.
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'toggleCommitSelection', commitHash: A });
    assert.strictEqual(h.internals._extendedLogState.selectedCommits.size, 0, 'sanity: none left');

    // _render derives commitDetails from expandedCommit, which survives the
    // deselect — that is exactly what used to overwrite the placeholder.
    const html = provider._getThreePanelHtmlContent(
      mockWebview(),
      [...h.internals._extendedLogState.commitNodes],
      { hash: A, message: 'commit', changedFiles: [] } as never
    );

    assert.strictEqual(
      detailsModelFromHtml(html)?.kind,
      'placeholder',
      `a re-render must not resurrect the last expanded commit:\n${html}`
    );
  });

  it('reports why a commit contributed no files instead of showing "no changes"', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: C });

    provider.updateMultiCommitDetails(
      [A, B, C],
      new Map([
        [A, [{ path: 'src/a.ts', status: 'modified' as const }]],
        [B, []],
        [C, [{ path: 'src/c.ts', status: 'added' as const }]],
      ]),
      [A, B, C],
      new Map([[B, 'bad object 1234567']])
    );

    const model = lastDetailsModel(h.messages);
    assert.strictEqual(model?.kind, 'multi');
    assert.match(
      String(model?.changedFilesError ?? ''),
      /bad object 1234567/,
      "the failing commit's reason must reach the panel"
    );
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
      ]),
      [A, B],
      new Map()
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
      new Map([[A, [{ path: 'src/stale.ts', status: 'modified' as const }]]]),
      [A, B, C],
      new Map()
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
    provider.updateMultiCommitDetails([A, B, C], new Map(), [A, B, C], new Map());
    // A Group By switch repaints the same selection.
    provider.setDetailsGroupBy('flat');

    assert.strictEqual(requests, 2, 'one per selection CHANGE (single, then range)');
  });

  it('says so when the selection exceeds the load cap', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: C });

    provider.updateMultiCommitDetails(
      [A, B, C],
      new Map([[A, [{ path: 'src/a.ts', status: 'modified' as const }]]]),
      [A],
      new Map()
    );

    const model = lastDetailsModel(h.messages);
    assert.match(
      String(model?.changedFilesError ?? ''),
      /first 1 of 3 selected commits/,
      'a capped tree is never presented as the whole truth'
    );
  });

  it('counts the cap notice against the commits actually rendered', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    h.internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: C });
    // The log re-renders with a shorter page while the selection stands, so C
    // is selected but no longer a rendered node — it contributes no block.
    h.internals._extendedLogState.commitNodes = h.internals._extendedLogState.commitNodes.filter(
      (n) => n.commit.hash !== C
    );

    provider.updateMultiCommitDetails(
      [A, B, C],
      new Map([[A, [{ path: 'src/a.ts', status: 'modified' as const }]]]),
      [A],
      new Map()
    );

    const model = lastDetailsModel(h.messages);
    const rendered = (model?.commits as unknown[]).length;
    assert.strictEqual(rendered, 2, 'sanity: only the rendered commits get a block');
    assert.match(
      String(model?.changedFilesError ?? ''),
      new RegExp(`first 1 of ${rendered} selected commits`),
      'both numbers in the notice must describe the rendered list'
    );
  });
});

/**
 * Clearing the selection is a selection change like any other: the panel must
 * follow it to the placeholder rather than keep painting the commit the user
 * just deselected, which the graph no longer shows as selected.
 */
describe('empty selection clears the details panel', () => {
  let provider: GitToolWindowProvider;

  afterEach(() => {
    provider?.dispose();
  });

  it('ctrl+click deselecting the only selected commit posts the placeholder', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    provider.updateCommitDetails(A, [{ path: 'src/a.ts', status: 'modified' }] as never);

    h.internals._handleWebviewMessage({ type: 'toggleCommitSelection', commitHash: A });

    assert.strictEqual(h.internals._extendedLogState.selectedCommits.size, 0, 'sanity: none left');
    assert.strictEqual(
      lastDetailsModel(h.messages)?.kind,
      'placeholder',
      'the panel must not describe a commit the graph shows as unselected'
    );
    assert.strictEqual(
      h.internals._pendingChangedFiles,
      undefined,
      'the deselected commit files must not survive into the next selection'
    );
  });

  it('a programmatic empty selection posts the placeholder', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });
    provider.updateCommitDetails(A, [{ path: 'src/a.ts', status: 'modified' }] as never);

    provider.selectCommits([]);

    assert.strictEqual(lastDetailsModel(h.messages)?.kind, 'placeholder');
    assert.strictEqual(h.internals._pendingChangedFiles, undefined);
  });

  it('a selection whose hashes are all unknown posts the placeholder', () => {
    const h = makeProvider();
    provider = h.provider;
    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: A });

    provider.selectCommits(['z'.repeat(40)]);

    assert.strictEqual(lastDetailsModel(h.messages)?.kind, 'placeholder');
  });
});
