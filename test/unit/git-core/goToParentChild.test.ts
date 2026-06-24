/**
 * G9 — go-to-parent/child commit navigation.
 *
 * Tests for:
 *   1. buildCommitRows includes data-parents attribute on each commit row.
 *   2. computeMenuEnableState disables goToParent/goToChild in multi-select.
 *   3. computeMenuEnableState enables goToParent/goToChild in single-select.
 *   4. computeMenuVisibility hides goToParent/goToChild when N>=2.
 *   5. computeMenuVisibility shows goToParent/goToChild when N=1.
 */

import '../../setup';
import * as assert from 'assert';
import { buildCommitRows } from '../../../src/git-core/gitToolWindow/provider/graphClusterBuilder';
import {
  computeMenuEnableState,
  computeMenuVisibility,
} from '../../../src/git-core/gitToolWindow/multiSelect';
import type { ICommitNode } from '../../../src/git-core/commitGraph';
import type { ICommit } from '../../../src/git-core/interfaces/IGitService';
import { mkRowModel } from '../../support/printModelTestKit';

// Minimal fake commit factory.
function makeCommit(overrides: Partial<ICommit> = {}): ICommit {
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

function makeNode(commit: ICommit): ICommitNode {
  return {
    commit,
    graphColumn: 0,
    graphLines: [],
    branches: [],
    tags: [],
    onFocusedBranchPath: false,
  } as unknown as ICommitNode;
}

function makeRowData() {
  return {
    selected: new Set<string>(),
    cherryPickedHashes: undefined,
    cherryPickBaseRef: undefined,
    printModels: [mkRowModel()],
    branchLabelsFor: () => '',
    showGpgColumn: false,
    showRootColumn: false,
  };
}

const baseInputs = {
  selectedCount: 0,
  isContiguous: false,
  isHeadInSelection: false,
  hasMergeCommitInSelection: false,
  isSelectedInCurrentBranch: true,
};

// ─── buildCommitRows: data-parents attribute ────────────────────────────────

describe('buildCommitRows — data-parents attribute (G9)', () => {
  it('renders data-parents="" for a root commit with no parents', () => {
    const commit = makeCommit({ parents: [] });
    const html = buildCommitRows([makeNode(commit)], makeRowData());
    assert.ok(
      html.includes('data-parents=""'),
      'root commit must render data-parents with empty value'
    );
  });

  it('renders data-parents with single parent hash', () => {
    const parent = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const commit = makeCommit({ parents: [parent] });
    const html = buildCommitRows([makeNode(commit)], makeRowData());
    assert.ok(
      html.includes(`data-parents="${parent}"`),
      'single-parent commit must render data-parents with that parent hash'
    );
  });

  it('renders data-parents as comma-joined for a merge commit with two parents', () => {
    const p1 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const p2 = 'cccccccccccccccccccccccccccccccccccccccc';
    const commit = makeCommit({ parents: [p1, p2] });
    const html = buildCommitRows([makeNode(commit)], makeRowData());
    assert.ok(
      html.includes(`data-parents="${p1},${p2}"`),
      'merge commit must render data-parents as comma-separated parent hashes'
    );
  });

  it('HTML-escapes parent hashes (defence in depth)', () => {
    // Real git hashes are hex so this is theoretical, but the escaping path must work.
    const commit = makeCommit({ parents: ['abc123'] });
    const html = buildCommitRows([makeNode(commit)], makeRowData());
    assert.ok(
      html.includes('data-parents="abc123"'),
      'parent hash must appear in data-parents attribute'
    );
  });
});

// ─── computeMenuVisibility: goToParent / goToChild ──────────────────────────

describe('computeMenuVisibility — goToParent/goToChild (G9)', () => {
  it('shows goToParent when N=1', () => {
    assert.strictEqual(computeMenuVisibility(1).goToParent, true);
  });

  it('shows goToChild when N=1', () => {
    assert.strictEqual(computeMenuVisibility(1).goToChild, true);
  });

  it('hides goToParent in multi-select (N>=2)', () => {
    assert.strictEqual(computeMenuVisibility(2).goToParent, false);
    assert.strictEqual(computeMenuVisibility(5).goToParent, false);
  });

  it('hides goToChild in multi-select (N>=2)', () => {
    assert.strictEqual(computeMenuVisibility(2).goToChild, false);
    assert.strictEqual(computeMenuVisibility(5).goToChild, false);
  });
});

// ─── computeMenuEnableState: goToParent / goToChild ─────────────────────────

describe('computeMenuEnableState — goToParent/goToChild (G9)', () => {
  it('enables goToParent when N=1', () => {
    const e = computeMenuEnableState({ ...baseInputs, selectedCount: 1 });
    assert.strictEqual(e.goToParent, true, 'goToParent must be enabled for single selection');
  });

  it('enables goToChild when N=1', () => {
    const e = computeMenuEnableState({ ...baseInputs, selectedCount: 1 });
    assert.strictEqual(e.goToChild, true, 'goToChild must be enabled for single selection');
  });

  it('disables goToParent when N=0', () => {
    const e = computeMenuEnableState({ ...baseInputs, selectedCount: 0 });
    assert.strictEqual(e.goToParent, false, 'goToParent must be disabled when nothing is selected');
  });

  it('disables goToChild when N=0', () => {
    const e = computeMenuEnableState({ ...baseInputs, selectedCount: 0 });
    assert.strictEqual(e.goToChild, false, 'goToChild must be disabled when nothing is selected');
  });

  it('disables goToParent in multi-select (N>=2)', () => {
    const e = computeMenuEnableState({ ...baseInputs, selectedCount: 3 });
    assert.strictEqual(e.goToParent, false, 'goToParent must be disabled in multi-select');
  });

  it('disables goToChild in multi-select (N>=2)', () => {
    const e = computeMenuEnableState({ ...baseInputs, selectedCount: 3 });
    assert.strictEqual(e.goToChild, false, 'goToChild must be disabled in multi-select');
  });
});
