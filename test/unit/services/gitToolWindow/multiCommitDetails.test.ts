/**
 * Multi-select drives the MULTI details model end to end.
 *
 * `buildMultiCommitDetailsPanelModel` and the webview's `.multi-commit-details`
 * branch both shipped, but nothing ever produced a `kind:'multi'` model:
 * selecting N commits left the panel showing the FIRST commit's details, so the
 * count header, the per-commit summary list and the combined changed-file tree
 * were unreachable code.
 *
 * Reference: CommitDetailsListPanel.rebuildPanel renders one detail block per
 * selected commit (platform/vcs-log/impl/src/com/intellij/vcs/log/ui/details/
 * CommitDetailsListPanel.kt:107) — a multi-selection never presents as a single
 * commit upstream either.
 */

import '../../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitToolWindowProvider } from '../../../../src/ui-shell/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';
import type { ICommitNode } from '../../../../src/git-core/commitGraph';

function mkCommit(hash: string, message = `commit ${hash}`): ICommitNode['commit'] {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message,
    author: { name: 'a', email: 'a@x' },
    committer: { name: 'a', email: 'a@x' },
    parents: [],
    authorDate: new Date(0),
    commitDate: new Date(0),
  } as unknown as ICommitNode['commit'];
}

/** Provider with a recording webview and three selectable commits. */
function makeProvider(): {
  provider: GitToolWindowProvider;
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
  const state = (provider as unknown as { _extendedLogState: Record<string, unknown> })
    ._extendedLogState;
  state.commitNodes = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].map((h) => ({
    commit: mkCommit(h),
  })) as unknown as ICommitNode[];
  return { provider, messages };
}

/** The last `updateDetailsPanel` model posted, if any. */
function lastDetailsModel(
  messages: Array<Record<string, unknown>>
): Record<string, unknown> | undefined {
  const posts = messages.filter((m) => m.type === 'updateDetailsPanel');
  return posts.length > 0 ? (posts[posts.length - 1].model as Record<string, unknown>) : undefined;
}

describe('multi-select details panel', () => {
  it('posts a multi model when two or more commits are selected', () => {
    const { provider, messages } = makeProvider();

    provider.selectCommits(['a'.repeat(40), 'b'.repeat(40)]);

    assert.strictEqual(lastDetailsModel(messages)?.kind, 'multi');
  });

  it('reports the selected commit count so the header can state it', () => {
    const { provider, messages } = makeProvider();

    provider.selectCommits(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)]);

    assert.strictEqual(lastDetailsModel(messages)?.count, 3);
  });

  it('lists every selected commit, not just the first', () => {
    const { provider, messages } = makeProvider();

    provider.selectCommits(['a'.repeat(40), 'b'.repeat(40)]);

    const commits = lastDetailsModel(messages)?.commits as Array<{ shortHash: string }>;
    assert.deepStrictEqual(
      commits.map((c) => c.shortHash),
      ['aaaaaaa', 'bbbbbbb']
    );
  });

  it('keeps the single-commit model for a one-commit selection', () => {
    const { provider, messages } = makeProvider();

    provider.selectCommits(['a'.repeat(40)]);

    assert.notStrictEqual(lastDetailsModel(messages)?.kind, 'multi');
  });

  it('ignores hashes that are not in the rendered list when counting', () => {
    const { provider, messages } = makeProvider();

    provider.selectCommits(['a'.repeat(40), 'b'.repeat(40), 'z'.repeat(40)]);

    assert.strictEqual(lastDetailsModel(messages)?.count, 2);
  });
});
