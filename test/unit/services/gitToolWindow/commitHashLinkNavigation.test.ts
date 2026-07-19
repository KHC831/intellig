/**
 * A hash written inside a commit message renders as a link whose tooltip
 * promises "Jump to commit". Clicking it must SELECT and SCROLL to the target
 * (vcs-log CommitPresentationUtil navigates, not just selects), and in a
 * merged multi-root window an abbreviated hash that matches commits in more
 * than one root must resolve in the root of the commit whose message carries
 * the link (CommitPresentationUtil.parseTargetCommit).
 */

import '../../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../../src/git-core/gitToolWindow/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';
import type { ICommitNode } from '../../../../src/git-core/commitGraph';

const A_ROOT = '/repo-a';
const B_ROOT = '/repo-b';
/** Same 4-char prefix, different roots — the colliding-prefix case. */
const A_HASH = 'beef1111111111111111111111111111111111aa';
const B_HASH = 'beef2222222222222222222222222222222222bb';
const OTHER = 'cafe3333333333333333333333333333333333cc';

interface Internals {
  _extendedLogState: {
    commitNodes: ICommitNode[];
    selectedCommits: Set<string>;
    expandedCommit: string | null;
  };
  _commitRepoRoots: Map<string, string | null>;
  _handleWebviewMessage(msg: Record<string, unknown>): void;
}

function node(hash: string, repoRoot: string): ICommitNode {
  return {
    commit: {
      hash,
      shortHash: hash.slice(0, 7),
      message: `commit ${hash.slice(0, 7)}`,
      author: { name: 'a', email: 'a@x' },
      committer: { name: 'a', email: 'a@x' },
      parents: [],
      authorDate: new Date(0),
      commitDate: new Date(0),
      repoRoot,
    },
    graphColumn: 0,
    graphLines: [],
    branches: [],
    tags: [],
  } as unknown as ICommitNode;
}

function makeProvider(): {
  provider: GitToolWindowProvider;
  internals: Internals;
  scrolled: string[];
} {
  const provider = new GitToolWindowProvider(Uri.file('/ext'));
  (provider as unknown as { _view: unknown })._view = {
    webview: {
      postMessage: () => Promise.resolve(true),
      cspSource: 'test:',
      asWebviewUri: (u: unknown) => u,
      html: '',
    },
  };
  const internals = provider as unknown as Internals;
  internals._extendedLogState.commitNodes = [
    node(OTHER, A_ROOT),
    node(A_HASH, A_ROOT),
    node(B_HASH, B_ROOT),
  ];
  internals._commitRepoRoots = new Map([
    [OTHER, A_ROOT],
    [A_HASH, A_ROOT],
    [B_HASH, B_ROOT],
  ]);

  const scrolled: string[] = [];
  (provider as unknown as { scrollToCommit: (h: string) => boolean }).scrollToCommit = (
    h: string
  ): boolean => {
    scrolled.push(h);
    return true;
  };
  return { provider, internals, scrolled };
}

describe('commit-message hash links', () => {
  it('scrolls to the target, not just selects it', () => {
    const h = makeProvider();

    h.internals._handleWebviewMessage({
      type: 'selectCommit',
      commitHash: OTHER.slice(0, 7),
      viaHashLink: true,
    });

    assert.deepStrictEqual(h.scrolled, [OTHER], 'the jump must bring the commit into view');
    assert.ok(h.internals._extendedLogState.selectedCommits.has(OTHER), 'and select it, as before');
  });

  it('leaves a plain row click alone (no scroll)', () => {
    const h = makeProvider();

    h.internals._handleWebviewMessage({ type: 'selectCommit', commitHash: OTHER });

    assert.deepStrictEqual(h.scrolled, [], 'clicking a visible row must not move the list');
    assert.ok(h.internals._extendedLogState.selectedCommits.has(OTHER));
  });

  it('resolves a colliding prefix in the root of the commit carrying the link', () => {
    const h = makeProvider();
    // The details panel is showing a commit from repo B, so a link in ITS
    // message means repo B's commit even though repo A sorts first.
    h.internals._extendedLogState.expandedCommit = B_HASH;

    h.internals._handleWebviewMessage({
      type: 'selectCommit',
      commitHash: 'beef',
      viaHashLink: true,
    });

    assert.deepStrictEqual(h.scrolled, [B_HASH], 'the owning root wins over first-match');
    assert.ok(h.internals._extendedLogState.selectedCommits.has(B_HASH));
  });

  it('falls back to the first match when no root matches', () => {
    const h = makeProvider();
    h.internals._extendedLogState.expandedCommit = null;

    h.internals._handleWebviewMessage({
      type: 'selectCommit',
      commitHash: 'beef',
      viaHashLink: true,
    });

    assert.deepStrictEqual(h.scrolled, [A_HASH], 'first match in graph order');
  });

  it('passes an unknown hash through untouched', () => {
    const h = makeProvider();

    h.internals._handleWebviewMessage({
      type: 'selectCommit',
      commitHash: 'ffff',
      viaHashLink: true,
    });

    assert.deepStrictEqual(h.scrolled, ['ffff'], 'nothing to expand against');
  });
});
