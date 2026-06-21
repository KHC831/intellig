/**
 * Log column-header label — the message column header reads "Title".
 *
 * Product divergence from IntelliJ git4idea (which labels it "Subject"):
 * the user asked for "Title". These specs pin the rendered header text and
 * the message-filter placeholder so the label can't silently regress back to
 * "Subject" on a future render-path refactor.
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import { ICommitNode } from '../../../src/git-core/commitGraph';
import { ICommit } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

function makeCommitNode(): ICommitNode {
  const commit: ICommit = {
    hash: 'abc1234567890abcdef1234567890abcdef123456',
    shortHash: 'abc1234',
    message: 'Add a thing',
    author: { name: 'Alice', email: 'alice@example.com' },
    committer: { name: 'Alice', email: 'alice@example.com' },
    parents: ['def5678901234567890abcdef1234567890abcdef'],
    authorDate: new Date(0),
    commitDate: new Date(0),
  };
  return {
    commit,
    graphColumn: 0,
    graphLines: [{ fromColumn: 0, toColumn: 0, color: '#4CAF50', type: 'commit' as const }],
    branches: [],
    tags: [],
  };
}

describe('GitToolWindowProvider — message column header label', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  it('renders the message column header as "Title", not "Subject"', () => {
    const html = provider._getGraphPanelHtml([makeCommitNode()]);
    assert.ok(
      html.includes('<div class="log-column-header-title">Title</div>'),
      'column header must read "Title"'
    );
    assert.ok(!html.includes('>Subject</div>'), 'column header must not read "Subject"');
  });

  it('uses "Title or commit hash" as the message-filter placeholder', () => {
    const html = provider._getGraphPanelHtml([makeCommitNode()]);
    assert.ok(
      html.includes('placeholder="Title or commit hash"'),
      'message-filter placeholder must read "Title or commit hash"'
    );
    assert.ok(
      !html.includes('placeholder="Subject or commit hash"'),
      'message-filter placeholder must not read "Subject or commit hash"'
    );
  });
});
