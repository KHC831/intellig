/**
 * G8 — merged multi-root log view.
 *
 * Tests for:
 *   1. buildCommitRows with showRootColumn:true renders the repo basename in
 *      a log-root-label cell.
 *   2. buildCommitRows with showRootColumn:false renders no log-root-label cell.
 *   3. A commit with repoRoot '/workspace/api-service' renders 'api-service'
 *      (not the full path) in the root cell.
 */

import '../../setup';
import * as assert from 'assert';
import { buildCommitRows } from '../../../src/git-core/gitToolWindow/provider/graphClusterBuilder';
import type { ICommitNode } from '../../../src/git-core/commitGraph';
import type { ICommit } from '../../../src/git-core/interfaces/IGitService';

// Minimal fake commit factory — covers only the fields buildCommitRows reads.
function makeCommit(overrides: Partial<ICommit> & { repoRoot?: string }): ICommit & {
  repoRoot?: string;
} {
  return {
    hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    shortHash: 'aaaaaaa',
    message: 'test commit',
    author: { name: 'Alice', email: 'alice@example.com' },
    committer: { name: 'Alice', email: 'alice@example.com' },
    parents: [],
    authorDate: new Date('2024-01-01T12:00:00Z'),
    commitDate: new Date('2024-01-01T12:00:00Z'),
    ...overrides,
  };
}

function makeNode(commit: ICommit & { repoRoot?: string }): ICommitNode {
  return {
    commit,
    graphColumn: 0,
    graphLines: [],
    branches: [],
    tags: [],
    onFocusedBranchPath: false,
  } as unknown as ICommitNode;
}

// Minimal ICommitRowData — all maps/sets empty, callback returns empty string.
function makeRowData(
  extra: Partial<{
    showRootColumn: boolean;
  }> = {}
) {
  return {
    selected: new Set<string>(),
    cherryPickedHashes: undefined,
    cherryPickBaseRef: undefined,
    activeLaneMap: new Map(),
    terminalNodes: new Set<string>(),
    childCountMap: new Map(),
    childLanesMap: new Map(),
    incomingBendsMap: new Map(),
    hasFocusedBranch: false,
    branchLabelsFor: () => '',
    showGpgColumn: false,
    ...extra,
  };
}

describe('buildCommitRows — showRootColumn (G8)', () => {
  it('renders a log-root-label cell when showRootColumn is true and commit has repoRoot', () => {
    const commit = makeCommit({ repoRoot: '/workspace/my-service' });
    const nodes = [makeNode(commit)];
    const html = buildCommitRows(nodes, makeRowData({ showRootColumn: true }));
    assert.ok(
      html.includes('log-root-label'),
      'html must contain a log-root-label element when showRootColumn is true'
    );
  });

  it('does NOT render a log-root-label cell when showRootColumn is false', () => {
    const commit = makeCommit({ repoRoot: '/workspace/my-service' });
    const nodes = [makeNode(commit)];
    const html = buildCommitRows(nodes, makeRowData({ showRootColumn: false }));
    assert.ok(
      !html.includes('log-root-label'),
      'html must NOT contain log-root-label when showRootColumn is false'
    );
  });

  it("renders the basename 'api-service' (not the full path) as the cell text when repoRoot is '/workspace/api-service'", () => {
    const commit = makeCommit({ repoRoot: '/workspace/api-service' });
    const nodes = [makeNode(commit)];
    const html = buildCommitRows(nodes, makeRowData({ showRootColumn: true }));
    // The root-label span must carry the basename as its text content.
    // The full path is allowed only in the title attribute (tooltip).
    const rootCellMatch = html.match(/<span class="log-root-label"[^>]*>([^<]*)<\/span>/);
    assert.ok(rootCellMatch, 'html must include a log-root-label span element');
    assert.strictEqual(
      rootCellMatch[1],
      'api-service',
      "the visible text in the root cell must be 'api-service' (the basename), not the full path"
    );
  });
});
