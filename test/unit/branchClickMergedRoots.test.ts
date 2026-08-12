/**
 * Unit test: branch click navigates the graph in the merged all-roots log.
 *
 * The merged multi-root loader keys its branch map by graphRowKey(hash, root)
 * — `hash\0root` — so a ref only labels the row of the repo that carries it.
 * The branch-click tip resolution must decompose that composite key back to
 * the bare commit hash before selecting/scrolling: the webview rows and the
 * commitNodes both identify commits by bare hash, so a composite key handed
 * to selectCommit/scrollToCommit matches nothing and the click dies silently.
 *
 * Repro: BRANCHES tree click in a multi-root workspace with no repository
 * filter — "selecting a branch does not jump to the commit on the GIT window".
 */

import '../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { graphRowKey } from '../../src/git-core/graphRowKey';
import { ICommit, IAuthor } from '../../src/git-core/interfaces/IGitService';
import { Uri } from '../mocks/vscode';

interface IPostedMessage {
  type?: string;
  commitHash?: string;
  [key: string]: unknown;
}

const AUTHOR: IAuthor = { name: 'tester', email: 't@example.com' };

/** Build a minimal ICommit for the given hash, tagged with its source root. */
function mkCommit(hash: string, message: string, repoRoot: string): ICommit {
  const date = new Date(2020, 0, 1);
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message,
    author: AUTHOR,
    committer: AUTHOR,
    parents: [],
    authorDate: date,
    commitDate: date,
    repoRoot,
  } as ICommit;
}

const ROOT_A = '/work/alpha';
const ROOT_B = '/work/beta';
const TIP_A = '1'.repeat(40);
const TIP_B = '2'.repeat(40);

describe('branch click in the merged all-roots log', () => {
  let provider: GitToolWindowProvider;
  let posted: IPostedMessage[];

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    posted = [];
  });

  afterEach(() => {
    provider.dispose();
  });

  /**
   * Seed a merged-mode log: one commit per root, branch map keyed by the
   * composite (hash, root) row key exactly as the merged loader builds it.
   */
  function seedMergedState(branchMap: Map<string, { name: string; type: 'local' | 'remote' }[]>) {
    const commits = [mkCommit(TIP_A, 'alpha tip', ROOT_A), mkCommit(TIP_B, 'beta tip', ROOT_B)];
    provider.updateLogState(commits, branchMap, new Map());

    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
    const internals = provider as any;
    internals._view = {
      webview: {
        html: '',
        options: {},
        cspSource: 'test:',
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: (message: IPostedMessage) => {
          posted.push(message);
          return Promise.resolve(true);
        },
        asWebviewUri: (u: unknown) => u,
      },
      visible: true,
      onDidChangeVisibility: () => ({ dispose: () => {} }),
      onDidDispose: () => ({ dispose: () => {} }),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
  }

  it('resolves a composite-keyed branch tip to the bare hash and navigates', () => {
    seedMergedState(
      new Map([
        [graphRowKey(TIP_A, ROOT_A), [{ name: 'main', type: 'local' as const }]],
        [graphRowKey(TIP_B, ROOT_B), [{ name: 'dev', type: 'local' as const }]],
      ])
    );

    provider.navigateToBranch('dev');

    const selectMsg = posted.find((m) => m.type === 'selectGraphRow');
    assert.ok(selectMsg, 'branch click must post selectGraphRow in merged mode');
    assert.strictEqual(selectMsg?.commitHash, TIP_B, 'selectGraphRow carries the BARE tip hash');

    const scrollMsg = posted.find((m) => m.type === 'scrollToCommit');
    assert.ok(scrollMsg, 'branch click must post scrollToCommit in merged mode');
    assert.strictEqual(scrollMsg?.commitHash, TIP_B, 'scrollToCommit carries the BARE tip hash');

    const state = provider.getExtendedLogState();
    assert.strictEqual(state.expandedCommit, TIP_B, 'selection lands on the bare hash');
  });

  it('prefers the clicked row’s own repo when the branch name exists in several roots', () => {
    seedMergedState(
      new Map([
        [graphRowKey(TIP_A, ROOT_A), [{ name: 'main', type: 'local' as const }]],
        [graphRowKey(TIP_B, ROOT_B), [{ name: 'main', type: 'local' as const }]],
      ])
    );

    provider.navigateToBranch('main', ROOT_B);

    const selectMsg = posted.find((m) => m.type === 'selectGraphRow');
    assert.strictEqual(
      selectMsg?.commitHash,
      TIP_B,
      'the beta row’s "main" must land on beta’s tip, not alpha’s'
    );
  });

  it('falls back to the name match when the preferred root has no such branch', () => {
    seedMergedState(
      new Map([
        [graphRowKey(TIP_A, ROOT_A), [{ name: 'alpha-only', type: 'local' as const }]],
        [graphRowKey(TIP_B, ROOT_B), [{ name: 'dev', type: 'local' as const }]],
      ])
    );

    provider.navigateToBranch('alpha-only', ROOT_B);

    const selectMsg = posted.find((m) => m.type === 'selectGraphRow');
    assert.strictEqual(selectMsg?.commitHash, TIP_A, 'name match stands when the root has no hit');
  });

  it('focuses a branch (eye icon) through the composite key', async () => {
    seedMergedState(
      new Map([
        [graphRowKey(TIP_A, ROOT_A), [{ name: 'main', type: 'local' as const }]],
        [graphRowKey(TIP_B, ROOT_B), [{ name: 'dev', type: 'local' as const }]],
      ])
    );

    await provider.setFocusedBranch('dev');

    const focusMsg = posted.find((m) => m.type === 'updateBranchFocus');
    assert.ok(focusMsg, 'focus must post updateBranchFocus');
    assert.strictEqual(
      focusMsg?.focusedHash,
      TIP_B,
      'the focused tip resolves to the BARE hash, not the composite row key'
    );
  });
});
