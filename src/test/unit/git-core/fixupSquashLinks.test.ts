/**
 * G6 parity: fixup!/squash! commit subject link rendering.
 *
 * Tests the `parseFixupSquashSubject` pure helper and the HTML rendering
 * path in `buildCommitRows` for fixup!/squash! subjects.
 *
 * IntelliJ reference: GitLinkToCommitResolver (git4idea/backend/src/log/GitLinkToCommitResolver.kt)
 * recognises the fixup!/squash!/amend! prefixes and renders a clickable link
 * that jumps to the target commit.  We implement the same prefix detection.
 */

import '../../setup';
import * as assert from 'assert';
import { parseFixupSquashSubject } from '../../../git-core/gitToolWindow/provider/fixupSquashSubject';
import {
  buildCommitRows,
  ICommitRowData,
} from '../../../git-core/gitToolWindow/provider/graphClusterBuilder';
import { ICommitNode } from '../../../git-core/commitGraph';

// ---------------------------------------------------------------------------
// parseFixupSquashSubject — pure helper
// ---------------------------------------------------------------------------

describe('parseFixupSquashSubject()', () => {
  it('parses a fixup! subject and returns prefix + target', () => {
    const result = parseFixupSquashSubject('fixup! Add tests');
    assert.deepStrictEqual(result, { prefix: 'fixup!', target: 'Add tests' });
  });

  it('parses a squash! subject and returns prefix + target', () => {
    const result = parseFixupSquashSubject('squash! Fix bug');
    assert.deepStrictEqual(result, { prefix: 'squash!', target: 'Fix bug' });
  });

  it('returns undefined for a normal commit subject', () => {
    const result = parseFixupSquashSubject('Normal commit');
    assert.strictEqual(result, undefined);
  });

  it('returns undefined for "fixup!" with no space/target after it', () => {
    const result = parseFixupSquashSubject('fixup!');
    assert.strictEqual(result, undefined);
  });

  it('returns undefined for wrong-case prefix (must be lowercase)', () => {
    const result = parseFixupSquashSubject('Fixup! Wrong case');
    assert.strictEqual(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// buildCommitRows — HTML rendering for fixup!/squash! subjects
// ---------------------------------------------------------------------------

/** Minimal stub for building a single commit row in tests. */
function makeMinimalRowData(overrides: Partial<ICommitRowData> = {}): ICommitRowData {
  return {
    selected: new Set<string>(),
    activeLaneMap: new Map(),
    terminalNodes: new Set<string>(),
    childCountMap: new Map(),
    childLanesMap: new Map(),
    incomingBendsMap: new Map(),
    hasFocusedBranch: false,
    branchLabelsFor: () => '',
    showGpgColumn: false,
    ...overrides,
  };
}

/** Minimal stub commit node. */
function makeCommitNode(
  subject: string,
  hash = 'abc1234abc1234abc1234abc1234abc1234abc12'
): ICommitNode {
  return {
    commit: {
      hash,
      shortHash: hash.substring(0, 7),
      message: subject,
      body: undefined,
      author: { name: 'Alice', email: 'alice@example.com' },
      committer: { name: 'Alice', email: 'alice@example.com' },
      parents: [],
      authorDate: new Date('2024-01-01T12:00:00Z'),
      commitDate: new Date('2024-01-01T12:00:00Z'),
    },
    column: 0,
    parentColumns: [],
    graphLines: [],
    onFocusedBranchPath: false,
    branches: [],
    tags: [],
  } as unknown as ICommitNode;
}

describe('buildCommitRows — fixup!/squash! link rendering', () => {
  it('renders data-action="jumpToFixupTarget" for a fixup! subject', () => {
    const node = makeCommitNode('fixup! Add tests');
    const html = buildCommitRows([node], makeMinimalRowData());
    assert.ok(
      html.includes('data-action="jumpToFixupTarget"'),
      'fixup! subject must render a jumpToFixupTarget link'
    );
    assert.ok(
      html.includes('data-target="Add tests"'),
      'fixup! subject must embed the target text in data-target'
    );
  });

  it('does NOT render data-action="jumpToFixupTarget" for a normal commit', () => {
    const node = makeCommitNode('Normal commit');
    const html = buildCommitRows([node], makeMinimalRowData());
    assert.ok(
      !html.includes('data-action="jumpToFixupTarget"'),
      'normal commit subject must not render a jumpToFixupTarget link'
    );
  });
});
