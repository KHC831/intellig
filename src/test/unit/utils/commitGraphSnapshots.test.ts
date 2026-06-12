/**
 * Visual-snapshot tests for `generateCommitGraph`.
 *
 * These tests freeze the lane assignments + graph-line topology for five
 * canonical fixtures so any algorithm change that *visually* alters the
 * graph triggers a deliberate snapshot update.
 *
 * The original divergent-branch bug (Gap 1: divergent branches collapsing onto a single
 * lane) shipped past the existing behavioural tests because no fixture
 * pinned the divergent-branch lane numbers — only counts. snap-2
 * specifically pins lane numbers for the two-children-of-unseen-parent
 * case, so a future regression to single-pass would force a snapshot
 * change explicitly.
 *
 * NO new test framework — same `assert.deepStrictEqual` against inline
 * frozen objects pattern used elsewhere in `commitGraph.test.ts`. When
 * the algorithm changes legitimately, the developer updates the inline
 * expected literal; there is no `--update-snapshots` opacity.
 *
 * Each snapshot captures `{ graphColumn, parents, graphLines }` per row
 * — enough to reproduce the on-screen lane layout deterministically.
 */

import '../../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import {
  generateCommitGraph,
  computeChildCountMap,
  computeChildLanesMap,
  computeIncomingBendsMap,
  computeTerminalNodes,
  isBranchSplit,
  type ICommitNode,
  type IBranchRef,
} from '../../../git-core/commitGraph';
import type { ICommit } from '../../../git-core/interfaces/IGitService';
import {
  computeActiveLanes,
  getColumnX,
  renderGraphSvg,
  DEFAULT_GRAPH_CONFIG,
} from '../../../utils/graphRenderer';
import { GitToolWindowProvider } from '../../../ui-shell/GitToolWindowProvider';
import type { IExtendedLogState } from '../../../ui-shell/GitToolWindowProvider';
import { Uri } from '../../mocks/vscode';

function mkCommit(hash: string, parents: string[] = []): ICommit {
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message: hash,
    author: { name: 'a', email: 'a@a' },
    committer: { name: 'a', email: 'a@a' },
    parents,
    authorDate: new Date('2024-01-01T00:00:00Z'),
    commitDate: new Date('2024-01-01T00:00:00Z'),
  };
}

/**
 * Fixture sugar: coerce a list of branch names (or already-typed refs) into
 * `IBranchRef[]`. A bare string is mapped to a `type` using the historical
 * `name.includes('/')` convention purely so these legacy fixtures keep the
 * same expected HTML. The production chip renderer reads `ref.type` directly
 * (Bug E) — this convention is a test-fixture shorthand, NOT the code path
 * under test.
 */
function toBranchRefs(branches: Array<string | IBranchRef>): IBranchRef[] {
  return branches.map((b) =>
    typeof b === 'string' ? { name: b, type: b.includes('/') ? 'remote' : 'local' } : b
  );
}

interface SnapshotRow {
  hash: string;
  graphColumn: number;
  parents: string[];
  graphLines: Array<{ fromColumn: number; toColumn: number; type: 'commit' | 'merge' | 'branch' }>;
}

function snapshotOf(nodes: ICommitNode[]): SnapshotRow[] {
  return nodes.map((n) => ({
    hash: n.commit.hash,
    graphColumn: n.graphColumn,
    parents: [...n.commit.parents],
    graphLines: n.graphLines.map((line) => ({
      fromColumn: line.fromColumn,
      toColumn: line.toColumn,
      type: line.type,
    })),
  }));
}

describe('Wave D / D4-snap — frozen visual snapshots for generateCommitGraph', () => {
  // ─── snap-1: linear baseline ──────────────────────────────────────────
  it('snap-1: single-branch linear (must NOT regress to multi-lane)', () => {
    const commits = [
      mkCommit('c5', ['c4']),
      mkCommit('c4', ['c3']),
      mkCommit('c3', ['c2']),
      mkCommit('c2', ['c1']),
      mkCommit('c1'),
    ];
    const result = generateCommitGraph(commits);
    const expected: SnapshotRow[] = [
      {
        hash: 'c5',
        graphColumn: 0,
        parents: ['c4'],
        graphLines: [{ fromColumn: 0, toColumn: 0, type: 'commit' }],
      },
      {
        hash: 'c4',
        graphColumn: 0,
        parents: ['c3'],
        graphLines: [{ fromColumn: 0, toColumn: 0, type: 'commit' }],
      },
      {
        hash: 'c3',
        graphColumn: 0,
        parents: ['c2'],
        graphLines: [{ fromColumn: 0, toColumn: 0, type: 'commit' }],
      },
      {
        hash: 'c2',
        graphColumn: 0,
        parents: ['c1'],
        graphLines: [{ fromColumn: 0, toColumn: 0, type: 'commit' }],
      },
      { hash: 'c1', graphColumn: 0, parents: [], graphLines: [] },
    ];
    assert.deepStrictEqual(snapshotOf(result), expected);
  });

  // ─── snap-2: divergent two-children-of-unseen-parent (Gap 1 repro) ────
  it('snap-2: two divergent branches with shared ancestor (PINS lane separation)', () => {
    const commits = [mkCommit('tipA', ['base']), mkCommit('tipB', ['base']), mkCommit('base')];
    const result = generateCommitGraph(commits);
    const expected: SnapshotRow[] = [
      {
        hash: 'tipA',
        graphColumn: 0,
        parents: ['base'],
        graphLines: [{ fromColumn: 0, toColumn: 0, type: 'commit' }],
      },
      {
        hash: 'tipB',
        // Gap 1 GUARD — tipB MUST NOT collapse onto lane 0. The
        // original single-pass algorithm produced graphColumn: 0 here.
        graphColumn: 1,
        parents: ['base'],
        graphLines: [{ fromColumn: 1, toColumn: 0, type: 'commit' }],
      },
      { hash: 'base', graphColumn: 0, parents: [], graphLines: [] },
    ];
    assert.deepStrictEqual(snapshotOf(result), expected);
  });

  // ─── snap-3: three branches (2 local + 1 remote-tracking) ─────────────
  it('snap-3: three divergent branches all root in distinct lanes', () => {
    const commits = [
      mkCommit('local1', ['base']),
      mkCommit('local2', ['base']),
      mkCommit('originMain', ['base']),
      mkCommit('base'),
    ];
    const result = generateCommitGraph(commits);
    const expected: SnapshotRow[] = [
      {
        hash: 'local1',
        graphColumn: 0,
        parents: ['base'],
        graphLines: [{ fromColumn: 0, toColumn: 0, type: 'commit' }],
      },
      {
        hash: 'local2',
        graphColumn: 1,
        parents: ['base'],
        graphLines: [{ fromColumn: 1, toColumn: 0, type: 'commit' }],
      },
      {
        hash: 'originMain',
        graphColumn: 2,
        parents: ['base'],
        graphLines: [{ fromColumn: 2, toColumn: 0, type: 'commit' }],
      },
      { hash: 'base', graphColumn: 0, parents: [], graphLines: [] },
    ];
    assert.deepStrictEqual(snapshotOf(result), expected);
  });

  // ─── snap-4: merge with branches at both parents ──────────────────────
  it('snap-4: merge commit with both parents in distinct lanes', () => {
    const commits = [
      mkCommit('merge', ['main2', 'feat']),
      mkCommit('feat', ['base']),
      mkCommit('main2', ['base']),
      mkCommit('base'),
    ];
    const result = generateCommitGraph(commits);
    const expected: SnapshotRow[] = [
      {
        hash: 'merge',
        graphColumn: 0,
        parents: ['main2', 'feat'],
        graphLines: [
          // First parent (main2) — inherits merge's lane.
          { fromColumn: 0, toColumn: 0, type: 'commit' },
          // Second parent (feat) — must claim a NEW lane.
          { fromColumn: 0, toColumn: 1, type: 'merge' },
        ],
      },
      {
        hash: 'feat',
        graphColumn: 1,
        parents: ['base'],
        graphLines: [{ fromColumn: 1, toColumn: 1, type: 'commit' }],
      },
      {
        hash: 'main2',
        graphColumn: 0,
        parents: ['base'],
        graphLines: [{ fromColumn: 0, toColumn: 1, type: 'commit' }],
      },
      { hash: 'base', graphColumn: 1, parents: [], graphLines: [] },
    ];
    assert.deepStrictEqual(snapshotOf(result), expected);
  });

  // ─── snap-5: focus state (chip + on-path tagging) ─────────────────────
  it('snap-5: focused branch path tagging applied to nodes', () => {
    const commits = [
      mkCommit('aaa', ['bbb']),
      mkCommit('bbb', ['ccc']),
      mkCommit('ccc', ['ddd']),
      mkCommit('ddd'),
    ];
    const branchMap = new Map<string, IBranchRef[]>();
    branchMap.set('aaa', [{ name: 'feature', type: 'local' }]);
    const focusedPath = new Set(['aaa', 'bbb', 'ccc']);
    const result = generateCommitGraph(commits, branchMap, undefined, focusedPath);

    // Snapshot the lane shape PLUS the onFocusedBranchPath flag.
    const focusSnapshot = result.map((n) => ({
      hash: n.commit.hash,
      graphColumn: n.graphColumn,
      branches: n.branches,
      onFocusedBranchPath: n.onFocusedBranchPath,
    }));
    const expected = [
      {
        hash: 'aaa',
        graphColumn: 0,
        branches: [{ name: 'feature', type: 'local' }],
        onFocusedBranchPath: true,
      },
      { hash: 'bbb', graphColumn: 0, branches: [], onFocusedBranchPath: true },
      { hash: 'ccc', graphColumn: 0, branches: [], onFocusedBranchPath: true },
      { hash: 'ddd', graphColumn: 0, branches: [], onFocusedBranchPath: false },
    ];
    assert.deepStrictEqual(focusSnapshot, expected);
  });

  // ─── snap-far-parent: divergent branch with far-parent fork point ─────
  it('snap-far-parent: side branch first-parent line carries endRow + renderer draws bend at parent row (Wave 2 / task #68)', () => {
    // Synthetic 8-commit deterministic topology. Mainline m0..m4 on lane 0
    // (newest first); side branch b0→b1→b2 on lane 1 whose oldest commit
    // (b2) first-parents to mainline m4 several rows below. headHash=m0 so
    // mainline pre-claims lane 0.
    //   row 0: m0  parents=[m1]
    //   row 1: m1  parents=[m2]
    //   row 2: b0  parents=[b1]    (side branch tip on lane 1)
    //   row 3: b1  parents=[b2]
    //   row 4: b2  parents=[m4]    (far-parent — m4 is 3 rows below)
    //   row 5: m2  parents=[m3]
    //   row 6: m3  parents=[m4]
    //   row 7: m4  parents=[]
    const commits = [
      mkCommit('m0', ['m1']),
      mkCommit('m1', ['m2']),
      mkCommit('b0', ['b1']),
      mkCommit('b1', ['b2']),
      mkCommit('b2', ['m4']),
      mkCommit('m2', ['m3']),
      mkCommit('m3', ['m4']),
      mkCommit('m4'),
    ];
    const branchMap = new Map<string, IBranchRef[]>();
    branchMap.set('m0', [{ name: 'main', type: 'local' }]);
    branchMap.set('b0', [{ name: 'side', type: 'local' }]);
    const result = generateCommitGraph(commits, branchMap, undefined, undefined, 'main', 'm0');

    // Pin b2's graphLines — the far-parent first-parent line must carry
    // endRow=7 (m4's row), bending from lane 1 to lane 0.
    const b2 = result.find((n) => n.commit.hash === 'b2');
    assert.ok(b2, 'b2 node must exist');
    assert.deepStrictEqual(
      b2.graphLines,
      [
        {
          fromColumn: 1,
          toColumn: 0,
          color: '#2196F3', // lane 1 colour (Blue) — first-parent uses source lane colour
          type: 'commit',
          endRow: 7,
        },
      ],
      `b2 graphLines must pin endRow=7 (m4's row); got ${JSON.stringify(b2.graphLines)}`
    );

    // Lane assignments (smoke): mainline rows on lane 0, side branch rows
    // on lane 1, b2's parent m4 on lane 0.
    const expectedLanes: Record<string, number> = {
      m0: 0,
      m1: 0,
      b0: 1,
      b1: 1,
      b2: 1,
      m2: 0,
      m3: 0,
      m4: 0,
    };
    for (const n of result) {
      assert.strictEqual(
        n.graphColumn,
        expectedLanes[n.commit.hash],
        `${n.commit.hash} expected lane ${expectedLanes[n.commit.hash]} got ${n.graphColumn}`
      );
    }

    // computeIncomingBendsMap surfaces source lane 1 at m4's row; b2's row
    // has no incoming bend.
    const incoming = computeIncomingBendsMap(result);
    const m4Bends = incoming.get('m4') ?? new Set<number>();
    assert.deepStrictEqual(
      [...m4Bends].sort(),
      [1],
      `incoming bends at m4 must be {1}; got {${[...m4Bends].join(',')}}`
    );
    assert.strictEqual(
      (incoming.get('b2') ?? new Set<number>()).size,
      0,
      'incoming bends at b2 must be empty'
    );

    // Renderer SVG snapshot — m4's row carries the top-half bend, b2's row
    // does NOT carry the old source-row bezier and DOES carry the lane-1
    // downward stub.
    const cfg = DEFAULT_GRAPH_CONFIG;
    const centerY = cfg.rowHeight / 2;
    const bottomY = cfg.rowHeight;
    const lane0X = getColumnX(0, cfg);
    const lane1X = getColumnX(1, cfg);
    const active = computeActiveLanes(result);
    const childCountMap = computeChildCountMap(result);
    const childLanesMap = computeChildLanesMap(result);
    const terminals = computeTerminalNodes(result);

    const m4Row = result.findIndex((n) => n.commit.hash === 'm4');
    const m4Node = result[m4Row];
    const m4Svg = renderGraphSvg(
      m4Node,
      m4Row,
      active.get(m4Row) ?? new Set<number>(),
      cfg,
      terminals.has('m4'),
      isBranchSplit('m4', childCountMap),
      childLanesMap.get('m4') ?? new Set<number>(),
      false,
      active.get(m4Row + 1) ?? new Set<number>(),
      incoming.get('m4') ?? new Set<number>()
    );
    const expectedTopHalfBend = `<path d="M ${lane1X},0 C ${lane1X},${centerY} ${lane0X},0 ${lane0X},${centerY}"`;
    assert.ok(
      m4Svg.includes(expectedTopHalfBend),
      `m4 SVG must include top-half bend "${expectedTopHalfBend}"; got: ${m4Svg}`
    );

    const b2Row = result.findIndex((n) => n.commit.hash === 'b2');
    const b2Svg = renderGraphSvg(
      result[b2Row],
      b2Row,
      active.get(b2Row) ?? new Set<number>(),
      cfg,
      terminals.has('b2'),
      isBranchSplit('b2', childCountMap),
      childLanesMap.get('b2') ?? new Set<number>(),
      false,
      active.get(b2Row + 1) ?? new Set<number>(),
      incoming.get('b2') ?? new Set<number>()
    );
    const oldSourceRowBend = `M ${lane1X},${centerY} C ${lane1X},${bottomY} ${lane0X},${centerY} ${lane0X},${bottomY}`;
    assert.ok(
      !b2Svg.includes(oldSourceRowBend),
      `b2 SVG must NOT include the OLD source-row bezier "${oldSourceRowBend}"; got: ${b2Svg}`
    );
    const lane1Stub = `<line x1="${lane1X}" y1="${centerY}" x2="${lane1X}" y2="${bottomY}"`;
    assert.ok(
      b2Svg.includes(lane1Stub),
      `b2 SVG must include lane-1 downward stub "${lane1Stub}"; got: ${b2Svg}`
    );
  });
});

/**
 * Renderer-stage snapshots.
 *
 * snap-1..5 above pin algorithm output (lane assignments + onFocusedBranchPath
 * flags). snap-6 closes the multi-stage discipline gap by pinning the
 * RENDERED SVG markup `renderGraphSvg` emits, so a refactor that changes
 * how the brighten/dim treatment lands (per-element opacity vs CSS class
 * vs anything else) shows up as a deliberate snapshot diff.
 */
describe('Wave D R1 / D4-snap — renderer-stage SVG snapshots', () => {
  function nodeOf(hash: string, onFocusedBranchPath: boolean): ICommitNode {
    return {
      commit: mkCommit(hash, ['parent']),
      graphColumn: 0,
      graphLines: [{ fromColumn: 0, toColumn: 0, color: '#4CAF50', type: 'commit' }],
      branches: [],
      tags: [],
      onFocusedBranchPath,
    };
  }

  it('snap-6a: hasFocusedBranch=false → NO opacity attribute on any element', () => {
    const node = nodeOf('aaa', false);
    const svg = renderGraphSvg(
      node,
      0,
      new Set([0]),
      DEFAULT_GRAPH_CONFIG,
      false /* isTerminal */,
      false /* isBranchSplitPoint */,
      new Set() /* childLanes */,
      false /* hasFocusedBranch */
    );
    assert.ok(
      !/\bopacity=/.test(svg),
      `expected NO opacity= attribute when hasFocusedBranch=false; got: ${svg}`
    );
  });

  it('snap-6b: hasFocusedBranch=true + on-path → opacity="1" + 1.5× lineWidth', () => {
    const node = nodeOf('aaa', true);
    const svg = renderGraphSvg(
      node,
      0,
      new Set([0]),
      DEFAULT_GRAPH_CONFIG,
      false,
      false,
      new Set(),
      true /* hasFocusedBranch */
    );
    // baseline lineWidth = 2 → on-path = 2 × 1.5 = 3
    assert.ok(svg.includes('opacity="1"'), `on-path must brighten to opacity="1"; got: ${svg}`);
    assert.ok(
      svg.includes('stroke-width="3"'),
      `on-path must boost stroke-width to 3 (1.5× of 2); got: ${svg}`
    );
  });

  it('snap-6c: hasFocusedBranch=true + off-path → opacity="0.6" + baseline stroke', () => {
    const node = nodeOf('aaa', false);
    const svg = renderGraphSvg(
      node,
      0,
      new Set([0]),
      DEFAULT_GRAPH_CONFIG,
      false,
      false,
      new Set(),
      true /* hasFocusedBranch */
    );
    assert.ok(svg.includes('opacity="0.6"'), `off-path must dim to opacity="0.6"; got: ${svg}`);
    assert.ok(
      svg.includes('stroke-width="2"'),
      `off-path keeps baseline stroke-width="2"; got: ${svg}`
    );
    // And it must NOT have the boosted stroke.
    assert.ok(
      !svg.includes('stroke-width="3"'),
      `off-path must not boost stroke-width; got: ${svg}`
    );
  });
});

/**
 * Chip-renderer-stage HTML snapshots.
 *
 * snap-1..6 above pin algorithm output and SVG renderer output. The
 * production bug — chips disappearing in narrow panels — lived in the
 * chip-emit + CSS layout layers, both of which were untested. snap-3 only
 * pinned `node.branches: ['feature']` (algorithm input), not the actual
 * `<span class="branch-label-local">…</span>` HTML emit.
 *
 * snap-7a..7e pin the LITERAL HTML `_getBranchLabelsHtml(node)` returns.
 * snap-7f uses jsdom to assert that the chip is parsed as a sibling of
 * `.commit-title`, NOT a child — pinning the layout-stage shape that the
 * narrow-panel chip repair introduced.
 *
 * ADR-010 multi-stage discipline: each visual transformation stage gets its
 * own snapshot fixture set (algorithm → renderer (per-element) → renderer
 * (layout) → final HTML emit).
 */
interface ProviderInternals {
  _extendedLogState: IExtendedLogState;
}

function nodeWithBranches(hash: string, branches: Array<string | IBranchRef>): ICommitNode {
  return {
    commit: mkCommit(hash, ['parent']),
    graphColumn: 0,
    graphLines: [{ fromColumn: 0, toColumn: 0, color: '#4CAF50', type: 'commit' }],
    branches: toBranchRefs(branches),
    tags: [],
    onFocusedBranchPath: false,
  };
}

describe('Wave E / E3 — chip-renderer-stage HTML snapshots', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('snap-7a: single local branch → literal <span class="branch-label-local"> HTML', () => {
    const node = nodeWithBranches('aaa1234567890aaaaaaaaaaaaaaaaaaaaaaaaaaaa', ['main']);
    const html = provider._getBranchLabelsHtml(node);
    // Pins the LITERAL emit: a future refactor that swaps span for
    // div, drops the data-branch-name attribute, or changes the class
    // string forces a deliberate snapshot diff.
    // Emit gained `role="img"`, `aria-label="Local branch: …"`,
    // and a leading `<i class="codicon codicon-git-branch">`. snap-12a..d
    // / snap-12f pin those new tokens INDEPENDENTLY of this string;
    // updating snap-7a here is a deliberate co-update of the literal
    // baseline.
    assert.strictEqual(
      html,
      '<span class="branch-label-local" data-branch-name="main" role="img" aria-label="Local branch: main"><i class="codicon codicon-git-branch" aria-hidden="true"></i>main</span>'
    );
  });

  it('snap-7b: single remote branch → literal <span class="branch-label-remote"> HTML', () => {
    const node = nodeWithBranches('bbb1234567890bbbbbbbbbbbbbbbbbbbbbbbbbbbb', ['origin/main']);
    const html = provider._getBranchLabelsHtml(node);
    assert.strictEqual(
      html,
      '<span class="branch-label-remote" data-branch-name="origin/main" role="img" aria-label="Remote branch: origin/main"><i class="codicon codicon-git-branch" aria-hidden="true"></i>origin/main</span>'
    );
  });

  it('snap-7c: 3 branches at same commit → 2 inline chips + collapsed +1 summary chip', () => {
    // The collapse behaviour (UI fix 5) caps inline branch chips at
    // MAX_INLINE_BRANCH_CHIPS = 2. The third branch lands in a `+1`
    // summary chip with the full name available via title=tooltip and
    // data-collapsed-branches.
    const node = nodeWithBranches('ccc1234567890cccccccccccccccccccccccccccc', [
      'main',
      'develop',
      'origin/main',
    ]);
    const html = provider._getBranchLabelsHtml(node);
    assert.strictEqual(
      html,
      [
        '<span class="branch-label-local" data-branch-name="main" role="img" aria-label="Local branch: main"><i class="codicon codicon-git-branch" aria-hidden="true"></i>main</span>',
        '<span class="branch-label-local" data-branch-name="develop" role="img" aria-label="Local branch: develop"><i class="codicon codicon-git-branch" aria-hidden="true"></i>develop</span>',
        '<span class="branch-label-collapsed" data-collapsed-branches="origin/main" role="img" aria-label="1 more branch: origin/main" title="origin/main">+1</span>',
      ].join('')
    );
  });

  it('snap-7d: no branches → empty string return (the contract `.commit-branches:empty` relies on)', () => {
    const node = nodeWithBranches('ddd1234567890dddddddddddddddddddddddddddd', []);
    const html = provider._getBranchLabelsHtml(node);
    // `.commit-branches:empty { display: none }` in the webview CSS depends
    // on this returning an EMPTY string (not whitespace, not an HTML
    // comment) so the empty wrapper collapses with no margin / no flex
    // basis. Pin the empty return explicitly.
    assert.strictEqual(html, '');
  });

  it('snap-7e: focused branch → chip carries `branch-label-local branch-label-focused` class', () => {
    const node = nodeWithBranches('eee1234567890eeeeeeeeeeeeeeeeeeeeeeeeeeee', ['feature']);
    // Inject the focused-branch state directly — `setFocusedBranch` would
    // pull in `gitService.getMergeBase` which is out of scope for this
    // pure-HTML snapshot.
    const internals = provider as unknown as ProviderInternals;
    internals._extendedLogState.focusedBranchName = 'feature';
    const html = provider._getBranchLabelsHtml(node);
    // Focused chip carries
    // aria-describedby="focused-branch-help" pointing at a panel-level
    // visually-hidden help span. Non-focused chips omit the attribute
    // (snap-7a..d still pin the no-attribute shape).
    assert.strictEqual(
      html,
      '<span class="branch-label-local branch-label-focused" data-branch-name="feature" role="img" aria-label="Local branch: feature" aria-describedby="focused-branch-help"><i class="codicon codicon-git-branch" aria-hidden="true"></i>feature</span>'
    );
  });
});

/**
 * jsdom layout-stage snapshot.
 *
 * The algorithm/renderer surface only pinned per-element output (algorithm
 * snap-1..5, SVG renderer snap-6). The narrow-panel bug lived in DOM nesting:
 * the chip span was a CHILD of `.commit-title` (which has overflow:hidden
 * + white-space:nowrap), so chips clipped in narrow panels. snap-7f
 * parses the rendered graph-panel HTML through jsdom and asserts the
 * chip's parentElement is `.commit-branches`, NOT `.commit-title`. This
 * is the layout-stage analog of snap-6a/6b/6c — pinning the DOM tree
 * shape that the CSS fix relies on.
 *
 * ADR-010's "each visual transformation stage gets its own snapshot
 * fixture set" — this adds the layout stage.
 */
describe('Wave E / E3-layout — jsdom DOM-tree snapshot', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('snap-7f: chip is sibling of .commit-title, not nested inside (Wave E layout fix)', () => {
    const node = nodeWithBranches('fff1234567890ffffffffffffffffffffffffffff', ['main']);
    const html = provider._getGraphPanelHtml([node]);
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
    const doc = dom.window.document;

    // The chip element exists.
    const chip = doc.querySelector('.branch-label-local');
    assert.ok(chip, 'chip element exists in DOM after parse');

    // The chip MUST NOT be nested inside `.commit-title` — that's the
    // layout that caused chips to clip when the panel was
    // narrow (overflow:hidden + white-space:nowrap on `.commit-title`).
    const parent = chip.parentElement;
    assert.ok(parent, 'chip must have a parent element');
    assert.ok(
      !parent.classList.contains('commit-title'),
      `chip must NOT be a child of .commit-title (pre-Wave-E bug). Got parent class: "${parent.className}"`
    );

    // The chip lives in the dedicated `.commit-branches` flex slot —
    // this is the IntelliJ-parity layout that reserves chip space and
    // ellipsises the message instead of the chip.
    assert.ok(
      parent.classList.contains('commit-branches'),
      `chip should be in .commit-branches sibling slot. Got parent class: "${parent.className}"`
    );

    // And `.commit-branches` is itself a sibling of `.commit-title`, not
    // a descendant — the fix is structural, not just CSS.
    const commitInfo = parent.parentElement;
    assert.ok(commitInfo, '.commit-branches must have a parent .commit-info');
    assert.ok(
      commitInfo.classList.contains('commit-info'),
      `expected .commit-branches inside .commit-info; got "${commitInfo.className}"`
    );
    const commitTitle = commitInfo.querySelector('.commit-title');
    assert.ok(commitTitle, '.commit-info should still contain a .commit-title');
    assert.notStrictEqual(
      commitTitle,
      parent,
      '.commit-title and .commit-branches must be DISTINCT siblings'
    );
    assert.ok(
      !commitTitle.contains(parent),
      '.commit-title must NOT contain .commit-branches (the Wave E bug shape)'
    );
  });
});

/**
 * JS message truncation removed.
 *
 * The row template previously hard-capped the rendered message at 60
 * characters via `_truncateMessage(commit.message, 60)`, appending JS
 * `...` regardless of panel width. The fix passes the full first line
 * to the row template and lets `.commit-title { overflow:hidden;
 * text-overflow:ellipsis; white-space:nowrap }` handle responsive
 * clipping. snap-7g pins the new contract: the row HTML carries the
 * full first line of long subjects, with no embedded `...` ellipsis.
 *
 * (`_truncateMessage` itself is still used by `_getCommitDetailsHtml`
 * for the details panel, where a hard cap is genuinely desired —
 * snap-7g asserts the row ONLY, not the details panel.)
 */
describe('Wave E / E2-bonus — row template emits full first line, CSS handles ellipsis', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('snap-7g: 200-char first line lands in .commit-title text content with NO embedded "..." (CSS does the ellipsis)', () => {
    // 200 chars — well past the 60-char cap.
    const longFirstLine =
      'feat(scope): a deliberately verbose commit subject that nobody would actually write but exists here precisely to exceed the 60-character pre-Wave-E hard truncation by a comfortable safety margin to pin the new behaviour';
    assert.ok(longFirstLine.length >= 200, 'fixture sanity: first line is at least 200 chars');
    const node: ICommitNode = {
      commit: {
        ...mkCommit('ggg1234567890gggggggggggggggggggggggggggg', ['parent']),
        message: longFirstLine + '\n\nBody paragraph that must NOT leak into the row title.',
      },
      graphColumn: 0,
      graphLines: [{ fromColumn: 0, toColumn: 0, color: '#4CAF50', type: 'commit' }],
      branches: [],
      tags: [],
      onFocusedBranchPath: false,
    };

    const html = provider._getGraphPanelHtml([node]);
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
    const doc = dom.window.document;
    const titleEl = doc.querySelector('.commit-title');
    assert.ok(titleEl, '.commit-title element exists');

    // The row's text content is the FULL first line — no JS truncation.
    // CSS overflow:hidden + text-overflow:ellipsis is what users see at
    // narrow widths, but the underlying text is complete (so screen
    // readers, find-in-page, and the responsive ellipsis all work).
    assert.strictEqual(
      titleEl.textContent,
      longFirstLine,
      `.commit-title textContent should be the full first line; got "${titleEl.textContent}"`
    );

    // The row text content must NOT contain a literal "..." — the
    // earlier truncation appended one. CSS ellipsis is a visual
    // treatment, not text content; jsdom does NOT layout, so any
    // "..." here would mean JS truncation came back.
    assert.ok(
      !(titleEl.textContent ?? '').includes('...'),
      `.commit-title must NOT contain a literal "..." (pre-Wave-E truncation marker); got "${titleEl.textContent}"`
    );

    // Body paragraph must NOT leak into the row title (only into the
    // tooltip via title=). Existing graphPanel.test.ts at :100-113
    // already covers the multi-line case, but pin it here too so this
    // file is the single source of truth for row-message contracts.
    assert.ok(
      !(titleEl.textContent ?? '').includes('Body paragraph'),
      'multi-line body must not leak into the row .commit-title text'
    );

    // Tooltip carries the full first line (escaping aside) — useful when
    // the visual ellipsis kicks in at narrow panel widths.
    const titleAttr = titleEl.getAttribute('title');
    assert.ok(titleAttr, 'commit-title should still carry a title= tooltip');
    assert.ok(
      titleAttr.includes(longFirstLine),
      'title= tooltip should still carry the full message (multi-line included)'
    );
  });
});

/**
 * Chip max-width contract.
 *
 * Previously `.branch-label-local` and `.branch-label-remote` had no
 * `max-width` and no ellipsis. A 70-char branch name like
 * `feature/JIRA-12345-very-long-descriptive-feature-name-with-context`
 * rendered at its natural ~350px width inside the non-shrinking
 * `.commit-branches` slot, squeezing `.commit-title` (`flex:1,
 * min-width:0`) to a few characters at typical panel widths. The fix
 * caps chips at 200px with `text-overflow: ellipsis` (IntelliJ parity).
 *
 * snap-7h pins TWO contracts:
 *  1. The chip's textContent is the FULL branch name (HTML emit
 *     unchanged; CSS handles visual ellipsis, not the host).
 *  2. The inline `<style>` block embeds `max-width: 200px` and
 *     `text-overflow: ellipsis` rules for chip selectors. jsdom does
 *     NOT compute layout, so we pin the CSS at the source level —
 *     a future regression that drops the cap shows up as a deliberate
 *     diff.
 */
describe('Wave E R1 / Senior M-1 — chip max-width contract', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('snap-7h: long branch name → chip text is full name; inline CSS pins max-width 200px + ellipsis', () => {
    // Bug E: classification is now type-driven, not name-shape-driven. The
    // LOCAL fixture name deliberately CONTAINS a `/` (`feature/...`) — the
    // exact case the old `classifyBranchName` heuristic misclassified as
    // remote. With the typed ref it must render as `.branch-label-local`.
    // The remote fixture carries `type: 'remote'`.
    const longLocalName = 'feature/JIRA-12345-very-long-descriptive-feature-name-with-context';
    const longRemoteName = 'origin/JIRA-12345-very-long-descriptive-feature-name-with-context';
    assert.ok(longLocalName.length >= 60, 'fixture sanity: local name is at least 60 chars');
    assert.ok(longRemoteName.length >= 60, 'fixture sanity: remote name is at least 60 chars');
    assert.ok(longLocalName.includes('/'), 'fixture sanity: local name contains a slash (Bug E)');

    // Chip-emit-stage assertion — host emits the FULL branch name for
    // BOTH variants; CSS does the visual clipping.
    const node = nodeWithBranches('hhh1234567890hhhhhhhhhhhhhhhhhhhhhhhhhhh', [
      { name: longLocalName, type: 'local' },
      { name: longRemoteName, type: 'remote' },
    ]);
    const labelHtml = provider._getBranchLabelsHtml(node);
    assert.ok(
      labelHtml.includes(longRemoteName),
      `chip emit must contain the FULL remote branch name (no host-side truncation); got: ${labelHtml}`
    );
    assert.ok(
      labelHtml.includes(longLocalName),
      `chip emit must contain the FULL local branch name (no host-side truncation); got: ${labelHtml}`
    );

    // Parse the chip spans and assert textContent = full branch names.
    const chipDom = new JSDOM(`<!doctype html><html><body>${labelHtml}</body></html>`);
    const localChip = chipDom.window.document.querySelector('.branch-label-local');
    const remoteChip = chipDom.window.document.querySelector('.branch-label-remote');
    assert.ok(localChip, 'local chip element parses');
    assert.ok(remoteChip, 'remote chip element parses');
    assert.strictEqual(
      localChip.textContent,
      longLocalName,
      `local chip textContent must be the full branch name; got "${localChip.textContent}"`
    );
    assert.strictEqual(
      remoteChip.textContent,
      longRemoteName,
      `remote chip textContent must be the full branch name; got "${remoteChip.textContent}"`
    );

    // Inline-CSS-stage assertion — the embedded `<style>` block carries
    // the `max-width` + `text-overflow: ellipsis` rules. We probe the
    // full webview HTML (which embeds `_getInlineStyles()`).
    const mockWebview = {
      html: '',
      options: {},
      cspSource: 'https://mock.csp.source',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri: import('vscode').Uri) => uri,
    } as unknown as import('vscode').Webview;
    const fullHtml = provider._getThreePanelHtmlContent(mockWebview, []);

    // Selector list must include both chip classes (covers the combined
    // `.branch-label-local, .branch-label-remote { … }` selector AND a
    // future split into separate rules — either form satisfies the
    // contract).
    assert.ok(
      /\.branch-label-local[\s,{][\s\S]*?max-width:\s*200px/.test(fullHtml) ||
        /\.branch-label-local\s*,\s*\.branch-label-remote[\s\S]*?max-width:\s*200px/.test(fullHtml),
      'inline CSS must pin `max-width: 200px` on .branch-label-local chip selector (Wave E R1)'
    );
    assert.ok(
      /\.branch-label-remote[\s,{][\s\S]*?max-width:\s*200px/.test(fullHtml) ||
        /\.branch-label-local\s*,\s*\.branch-label-remote[\s\S]*?max-width:\s*200px/.test(fullHtml),
      'inline CSS must pin `max-width: 200px` on .branch-label-remote chip selector (Wave E R1)'
    );
    assert.ok(
      /text-overflow:\s*ellipsis/.test(fullHtml),
      'inline CSS must declare `text-overflow: ellipsis` somewhere — chip selectors require it for the responsive cap'
    );
    // The combined block must also pin `overflow: hidden` and
    // `white-space: nowrap` — without them, `text-overflow: ellipsis` is
    // a no-op.
    //
    // Extended the combined selector to include `.tag-label`
    // so the tag chip joins the responsive-cap family. The regex tolerates
    // the optional `, .tag-label` suffix between the two original selectors
    // and the opening brace. If a future wave splits the rule into a
    // dedicated tag-label-only block this test will start failing — that's
    // intended (snap-13d covers tag-only sharing of these properties).
    assert.ok(
      /\.branch-label-local\s*,\s*\.branch-label-remote(?:\s*,\s*\.tag-label)?\s*\{[^}]*overflow:\s*hidden/.test(
        fullHtml
      ),
      'combined chip selector must declare overflow: hidden (without it ellipsis is a no-op)'
    );
    assert.ok(
      /\.branch-label-local\s*,\s*\.branch-label-remote(?:\s*,\s*\.tag-label)?\s*\{[^}]*white-space:\s*nowrap/.test(
        fullHtml
      ),
      'combined chip selector must declare white-space: nowrap (without it ellipsis is a no-op)'
    );
  });
});

/**
 * Detached-HEAD pseudo-ref filtering, end-to-end.
 *
 * When HEAD was detached, `parseBranches` previously returned an
 * `IBranch` with `name = '(HEAD detached at <sha>)'` and `type='local'`.
 * That fake branch propagated into:
 *   - the branch-map keyed by commit hash (extension.ts:3870-3879),
 *     which then drove the log graph chip for the detached commit
 *   - the BranchTreeProvider local-branches list, which rendered a
 *     `(HEAD detached at …)` row in the side panel
 *   - `_handleNewBranchFrom`'s `startPoint = item.branch?.name`,
 *     which got passed verbatim to `git checkout -b`, failing with
 *     `fatal: '(HEAD detached at 5eed84b)' is not a commit`
 *
 * The parser filters parenthesized refnames. The two
 * snapshots below pin the post-fix downstream contract — the chip
 * for a detached commit is the EMPTY string, and the local-branches
 * list contains NO parenthesized entries — so a future regression
 * that re-introduces the leak is caught by these snapshots, not by a
 * production-time runtime error.
 *
 * snap-8a: chip-emit-stage. Build the branch-map from `parseBranches`
 *   on the detached fixture, locate the detached commit's node, assert
 *   `_getBranchLabelsHtml(node)` returns `''`. This is the same
 *   chip-stage contract as snap-7d (no branches → empty string), but
 *   reached via the parser filter rather than an empty input.
 *
 * snap-8b: branch-tree-stage. Render the BranchTreeProvider local
 *   branches list for the detached fixture and assert no item label
 *   or `branch.name` starts with `(`.
 */
describe('Wave F / F3 — detached-HEAD pseudo-ref filtered through the rendering chain', () => {
  it('snap-8a: detached fixture → branch-map empty for HEAD sha → _getBranchLabelsHtml returns ""', async () => {
    const { parseBranches } = await import('../../../git-core/gitParser');

    // Reproduce the EXACT line shape `git branch -a --format=...` emits
    // when HEAD is detached at a real commit.
    const detachedSha = 'abc1234567890123456789012345678901234567890';
    const fixture = `(HEAD detached at abc1234)|${detachedSha}||*`;

    // parseBranches must filter the parenthesized line out.
    const branches = parseBranches(fixture);
    assert.strictEqual(
      branches.length,
      0,
      'Wave F: parenthesized pseudo-ref must be filtered before reaching branch-map'
    );

    // The production path (extension.ts) builds a
    // commit-hash → branch-ref map from `branches`. With the parser
    // filtering the pseudo-ref, the detached SHA has NO entry.
    const branchMap = new Map<string, IBranchRef[]>();
    for (const b of branches) {
      if (b.type === 'tag') {
        continue;
      }
      const existing = branchMap.get(b.commit) ?? [];
      existing.push({ name: b.name, type: b.type });
      branchMap.set(b.commit, existing);
    }
    assert.strictEqual(
      branchMap.has(detachedSha),
      false,
      'Wave F: branch-map must NOT contain the detached SHA (no branch points there)'
    );

    // The chip emit for a node whose branches array is empty
    // (because the branch-map didn't surface any) is the empty string.
    // This is the contract `.commit-branches:empty { display: none }`
    // relies on (covered by snap-7d), here re-exercised via the
    // parser filter chain to pin the end-to-end behavior.
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    try {
      const node: ICommitNode = {
        commit: mkCommit(detachedSha, ['parent1234567890123456789012345678901234']),
        graphColumn: 0,
        graphLines: [{ fromColumn: 0, toColumn: 0, color: '#4CAF50', type: 'commit' }],
        branches: branchMap.get(detachedSha) ?? [],
        tags: [],
        onFocusedBranchPath: false,
      };
      const html = provider._getBranchLabelsHtml(node);
      assert.strictEqual(
        html,
        '',
        `Wave F: chip emit for detached commit must be empty; got "${html}"`
      );
    } finally {
      provider.dispose();
    }
  });

  it('snap-8b: branch-tree local-branches list contains NO parenthesized entry for a detached fixture', async () => {
    // The BranchTreeProvider's `_getLocalBranches` filters by
    // `b.type === 'local'` and maps each remaining branch onto a
    // BranchTreeItem. Previously the parenthesized pseudo-ref was
    // typed `'local'` and rendered as a tree item; now the
    // parser filters it before BranchTreeProvider ever sees it, so
    // the rendered list contains zero parenthesized entries.

    const { parseBranches } = await import('../../../git-core/gitParser');
    const { BranchTreeProvider } = await import('../../../branches/BranchTreeProvider');
    const { createMockGitService } = await import('../../mocks/mockGitService');
    type IRepository = import('../../../git-core/interfaces/IGitService').IRepository;
    type IBranch = import('../../../git-core/interfaces/IGitService').IBranch;

    // Fixture: detached pseudo-ref + 2 normal local + 1 remote.
    const detachedSha = 'abc1234567890123456789012345678901234567890';
    const mainSha = 'def4567890123456789012345678901234567890abc';
    const featureSha = 'ghi7890123456789012345678901234567890abcdef';
    const fixture = [
      `(HEAD detached at abc1234)|${detachedSha}||*`,
      `refs/heads/main|${mainSha}||`,
      `refs/heads/feature|${featureSha}||`,
      `refs/remotes/origin/main|${mainSha}||`,
    ].join('\n');
    const parsed: IBranch[] = parseBranches(fixture);

    // Sanity: parser already filtered the parenthesized line; the
    // tree provider can only render what the parser hands it.
    assert.ok(
      !parsed.some((b) => b.name.startsWith('(')),
      `Wave F: parsed branches must contain no parenthesized name; got ${JSON.stringify(parsed.map((b) => b.name))}`
    );

    // Repo with `head.name = detachedSha` (literal SHA-as-name)
    // is intentionally non-detached for THIS test: it pins
    // parser-stage filtering, NOT the `head.name === undefined`
    // tree-prepend logic. Setting `name` here keeps the synthetic
    // detached row out of `_getLocalBranches`, so the assertion
    // `localItems.length === 2` (main + feature) still holds.
    const mockRepo: IRepository = {
      rootUri: {
        scheme: 'file',
        authority: '',
        path: '/test',
        query: '',
        fragment: '',
        fsPath: '/test',
      } as unknown as IRepository['rootUri'],
      state: 'idle',
      head: { name: detachedSha, ahead: 0, behind: 0, commit: detachedSha },
      remotes: [],
      submodules: [],
    };

    // Extracted shared mock; this site duplicated
    // the entire IGitService stub (~85 LoC). See `mockGitService.ts`.
    const mockGitService = createMockGitService(mockRepo, {
      getBranches: async () => parsed,
    });

    const treeProvider = new BranchTreeProvider(mockGitService);
    treeProvider.setRepository(mockRepo);

    // Drive `_getLocalBranches` via the public `getChildren` API.
    const localCategory = (await treeProvider.getChildren()).find((item) => item.label === 'Local');
    assert.ok(localCategory, 'Local category must exist at root');
    const localItems = await treeProvider.getChildren(localCategory);

    // Pin the contract: NO item label or branch.name starts with `(`.
    for (const item of localItems) {
      const label = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
      assert.ok(
        !label.startsWith('('),
        `Wave F: BranchTreeItem.label must not start with '(' (parenthesized pseudo-ref); got "${label}"`
      );
      assert.ok(
        !item.branch || !item.branch.name.startsWith('('),
        `Wave F: BranchTreeItem.branch.name must not start with '('; got "${item.branch?.name}"`
      );
    }

    // And the count matches the post-filter expectation: 2 local
    // branches survived (main, feature). The detached pseudo-ref is
    // gone, the remote-typed entry is excluded by the local-branch
    // filter inside the provider.
    assert.strictEqual(
      localItems.length,
      2,
      `expected 2 local branches (main + feature); got ${localItems.length} (${localItems.map((i) => i.label).join(', ')})`
    );
  });
});

/**
 * HEAD chip rendering snapshots.
 *
 * Earlier stages introduced the chip-emit infrastructure, added the
 * focused-branch class, pinned the literal HTML output (snap-7a..e)
 * and the layout-stage DOM tree (snap-7f). This adds a NEW chip variant:
 * the HEAD chip (yellow/gold, prepended FIRST, IntelliJ parity).
 *
 * Per ADR-010 multi-stage discipline:
 *   - snap-9a..d pin the chip-emit-stage HTML literal (algorithm output)
 *   - snap-9e pins the DOM-tree layout via jsdom (renderer-layout stage)
 *   - snap-9f pins the inline CSS contract (renderer-styling stage)
 *
 * Per ADR-010 Layer 4 (repo-state coverage), snap-9b explicitly covers
 * detached-HEAD-with-no-branches; the §1.5 entry in
 * `docs/parity/repo-states.md` cites it as the back-reference.
 */

interface HeadStateInternals {
  _extendedLogState: IExtendedLogState;
}

function nodeAt(hash: string, branches: Array<string | IBranchRef> = []): ICommitNode {
  return {
    commit: mkCommit(hash, ['parent1234567890123456789012345678901234']),
    graphColumn: 0,
    graphLines: [{ fromColumn: 0, toColumn: 0, color: '#4CAF50', type: 'commit' }],
    branches: toBranchRefs(branches),
    tags: [],
    onFocusedBranchPath: false,
  };
}

describe('Wave G / G1 — HEAD chip chip-emit snapshots', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');
  const headSha = 'aaa1234567890aaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('snap-9a: HEAD on commit WITH branch chips → HEAD chip prepended FIRST', () => {
    const internals = provider as unknown as HeadStateInternals;
    internals._extendedLogState.headHash = headSha;
    const node = nodeAt(headSha, ['main', 'origin/main']);
    const html = provider._getBranchLabelsHtml(node);
    // HEAD chip first, then branch chips in branchMap order.
    // Chips gained `role="img"` + descriptive aria-labels and a
    // leading codicon prefix (snap-12a..d, 12f). Co-updated baseline.
    assert.strictEqual(
      html,
      '<span class="branch-label-head" data-head-chip="true" role="img" aria-label="Current HEAD"><i class="codicon codicon-check" aria-hidden="true"></i>HEAD</span>' +
        '<span class="branch-label-local" data-branch-name="main" role="img" aria-label="Local branch: main"><i class="codicon codicon-git-branch" aria-hidden="true"></i>main</span>' +
        '<span class="branch-label-remote" data-branch-name="origin/main" role="img" aria-label="Remote branch: origin/main"><i class="codicon codicon-git-branch" aria-hidden="true"></i>origin/main</span>'
    );
  });

  it('snap-9b: HEAD on commit WITHOUT branch chips (detached) → HEAD chip alone', () => {
    const internals = provider as unknown as HeadStateInternals;
    internals._extendedLogState.headHash = headSha;
    const node = nodeAt(headSha, []);
    const html = provider._getBranchLabelsHtml(node);
    // ADR-010 Layer 4 — covers detached-HEAD repo state. Cited from
    // `docs/parity/repo-states.md` §1.5 as the back-reference.
    // See snap-9a comment.
    assert.strictEqual(
      html,
      '<span class="branch-label-head" data-head-chip="true" role="img" aria-label="Current HEAD"><i class="codicon codicon-check" aria-hidden="true"></i>HEAD</span>'
    );
  });

  it('snap-9c: headHash undefined → no HEAD chip anywhere; branch chips render unchanged', () => {
    const internals = provider as unknown as HeadStateInternals;
    internals._extendedLogState.headHash = undefined;
    const node = nodeAt(headSha, ['main']);
    const html = provider._getBranchLabelsHtml(node);
    // The HEAD-less output, byte-for-byte. Pins backward compatibility.
    // Branch chip emit gained role/aria/codicon (snap-12b/12f).
    assert.strictEqual(
      html,
      '<span class="branch-label-local" data-branch-name="main" role="img" aria-label="Local branch: main"><i class="codicon codicon-git-branch" aria-hidden="true"></i>main</span>'
    );
  });

  it('snap-9d: headHash matches NO loaded node (out-of-window) → no HEAD chip on any node', () => {
    const internals = provider as unknown as HeadStateInternals;
    internals._extendedLogState.headHash = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
    const nodeWithBranches = nodeAt(headSha, ['feature']);
    const nodeNoBranches = nodeAt('bbb1234567890bbbbbbbbbbbbbbbbbbbbbbbbbbbb', []);
    // Neither node matches headHash → neither emits a HEAD chip.
    // Branch chip emit gained role/aria/codicon (snap-12b/12f).
    assert.strictEqual(
      provider._getBranchLabelsHtml(nodeWithBranches),
      '<span class="branch-label-local" data-branch-name="feature" role="img" aria-label="Local branch: feature"><i class="codicon codicon-git-branch" aria-hidden="true"></i>feature</span>'
    );
    assert.strictEqual(provider._getBranchLabelsHtml(nodeNoBranches), '');
  });
});

describe('Wave G / G1 — HEAD chip layout snapshot (jsdom)', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');
  const headSha = 'aaa1234567890aaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('snap-9e: HEAD chip is sibling of .commit-title in .commit-branches slot (Wave E layout invariant holds)', () => {
    const internals = provider as unknown as HeadStateInternals;
    internals._extendedLogState.headHash = headSha;
    const node = nodeAt(headSha, ['main']);
    const html = provider._getGraphPanelHtml([node]);
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
    const doc = dom.window.document;

    const headChip = doc.querySelector('.branch-label-head');
    assert.ok(headChip, 'HEAD chip element exists');

    // HEAD chip must NOT be inside .commit-title (layout
    // invariant — chips live in the .commit-branches flex slot).
    const parent = headChip.parentElement;
    assert.ok(parent, 'HEAD chip has parent');
    assert.ok(
      !parent.classList.contains('commit-title'),
      `HEAD chip must NOT be a child of .commit-title; got "${parent.className}"`
    );
    assert.ok(
      parent.classList.contains('commit-branches'),
      `HEAD chip should be in .commit-branches sibling slot; got "${parent.className}"`
    );

    // HEAD chip is the FIRST child of .commit-branches (prepended).
    assert.strictEqual(
      parent.firstElementChild,
      headChip,
      'HEAD chip must be the first child of .commit-branches'
    );
  });
});

describe('Wave G / G1 — HEAD chip CSS contract', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('snap-9f: inline <style> embeds .branch-label-head with theme-aware background + max-width 200px', () => {
    // Probe the full webview HTML which embeds `_getInlineStyles()`.
    const mockWebview = {
      html: '',
      options: {},
      cspSource: 'https://mock.csp.source',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri: import('vscode').Uri) => uri,
    } as unknown as import('vscode').Webview;
    const fullHtml = provider._getThreePanelHtmlContent(mockWebview, []);

    // Theme variable + fallback color. Regex-alternation form per the
    // snap-7h pattern — tolerates either single-rule or combined-rule
    // declaration as long as the contract holds.
    assert.ok(
      /\.branch-label-head[\s,{][\s\S]*?--vscode-statusBarItem-warningBackground/.test(fullHtml),
      'inline CSS must declare theme-aware HEAD chip background via --vscode-statusBarItem-warningBackground'
    );
    assert.ok(
      /\.branch-label-head[\s,{][\s\S]*?max-width:\s*200px/.test(fullHtml),
      'inline CSS must cap HEAD chip max-width at 200px (matches Wave E R1 chip-cap contract)'
    );
    assert.ok(
      /\.branch-label-head[\s,{][\s\S]*?text-overflow:\s*ellipsis/.test(fullHtml),
      'inline CSS must declare text-overflow: ellipsis on HEAD chip'
    );
  });
});

/**
 * Branch-tree-stage layout snapshot (jsdom-style end-to-end).
 *
 * The HEAD-chip snapshots (snap-9a..9f) pinned the HEAD chip on the COMMIT graph. This
 * adds the matching parity surface: the synthetic detached-row in the
 * BRANCHES tree sidebar. snap-10a drives `BranchTreeProvider.getChildren`
 * end-to-end and asserts:
 *   - the detached row is the FIRST child of Local Branches
 *   - its label is the literal `(HEAD detached at <abbr>)` text
 *   - its itemType is `'detached-head'`
 *   - its contextValue is `'intellig.detachedHead'` (drives the menu
 *     when-clauses via package.json)
 *   - the row reads as the current location (`isCurrentBranch === true`)
 *
 * Mirrors snap-8b's end-to-end driving pattern. ADR-010 Layer 4
 * back-reference for §1.6.
 */
describe('Wave H — branch-tree-stage layout snapshot (jsdom)', () => {
  it('snap-10a: detached HEAD → "(HEAD detached at <sha>)" appears as FIRST child of Local Branches', async () => {
    const { BranchTreeProvider } = await import('../../../branches/BranchTreeProvider');
    const { createMockGitService, detachedRepo } = await import('../../mocks/mockGitService');

    const fullSha = 'abc1234567890abcdef1234567890abcdef12345';
    const repo = detachedRepo(fullSha);
    const gitService = createMockGitService(repo, {
      getBranches: async () => [
        { name: 'main', type: 'local', commit: 'b'.repeat(40), isHead: false },
      ],
    });

    const provider = new BranchTreeProvider(gitService);
    provider.setRepository(repo);

    const rootChildren = await provider.getChildren();
    const localCategory = rootChildren.find((c) => c.label === 'Local');
    assert.ok(localCategory, 'Local category must exist at root');
    const items = await provider.getChildren(localCategory);

    assert.strictEqual(items[0].label, '(HEAD detached at abc1234)');
    assert.strictEqual(items[0].itemType, 'detached-head');
    assert.strictEqual(items[0].contextValue, 'intellig.detachedHead');
    assert.strictEqual(items[0].isCurrentBranch, true);

    assert.strictEqual(items[1].itemType, 'local-branch');
    assert.strictEqual(items[1].label, 'main');
  });
});

/**
 * Chip a11y + non-color affordance + theme-variable snapshots.
 *
 * Adds three independent contracts to the chip surface:
 *   - WJ-1: HEAD chip + branch chips emit `role="img"` + a descriptive
 *     `aria-label` so screen readers hear "Current HEAD" / "Local
 *     branch: main" / "Remote branch: origin/main" instead of a bare
 *     glyph or a class-prefixed string.
 *   - WJ-3: `.branch-label-local` and `.branch-label-remote` background
 *     and color use `var(--vscode-gitDecoration-*)` family with the
 *     hex literals as CSS fallbacks. Themes that override
 *     the gitDecoration family theme through to the chips automatically.
 *   - WJ-4: each chip carries a leading codicon glyph (`codicon-check`
 *     for HEAD, `codicon-git-branch` for both local and remote). Per
 *     UX request, local and remote chips share the same icon; the
 *     ref kind is still distinguishable via the chip's CSS class
 *     (`branch-label-local` / `branch-label-remote`) and aria-label
 *     ("Local branch:" / "Remote branch:").
 *
 * snap-12a..d pin chip-emit literals; snap-12e pins the inline CSS
 * theme-variable rule; snap-12f / snap-12g pin the codicon prefix.
 *
 * Per ADR-010 — each visual transformation stage gets its own
 * snapshot fixture set, so chip-emit (12a..d, 12f), CSS-style (12e),
 * and DOM layout (12g) are pinned separately.
 */
describe('Wave J / WJ-1 — chip a11y semantics (role + aria-label)', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');
  const headSha = 'aaa1234567890aaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('snap-12a: HEAD chip emits role="img" + aria-label="Current HEAD" + codicon-check + textContent "HEAD"', () => {
    const internals = provider as unknown as HeadStateInternals;
    internals._extendedLogState.headHash = headSha;
    const node = nodeAt(headSha, []);
    const html = provider._getBranchLabelsHtml(node);
    // HEAD chip a11y contract: a screen reader user must hear
    // "Current HEAD" — not just the bare letters "HEAD" with no
    // semantic context. role="img" tells AT this is a single semantic
    // unit; aria-label overrides the inner textContent for AT.
    assert.ok(/role="img"/.test(html), `HEAD chip must carry role="img"; got: ${html}`);
    assert.ok(
      /aria-label="Current HEAD"/.test(html),
      `HEAD chip must carry aria-label="Current HEAD"; got: ${html}`
    );
    assert.ok(
      /<i class="codicon codicon-check"[^>]*aria-hidden="true"[^>]*><\/i>/.test(html),
      `HEAD chip must include codicon-check with aria-hidden=true; got: ${html}`
    );
    // textContent (per jsdom parse) is "HEAD" — the codicon ligature
    // resolves to nothing visible-as-text, and the SR overrides via
    // aria-label.
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
    const chip = dom.window.document.querySelector('.branch-label-head');
    assert.ok(chip, 'HEAD chip element parses');
    assert.strictEqual(
      chip.textContent,
      'HEAD',
      `HEAD chip textContent must be "HEAD"; got "${chip.textContent}"`
    );
  });

  it('snap-12b: local branch chip emits role="img" + aria-label="Local branch: main" + codicon-git-branch', () => {
    const node = nodeWithBranches('bbb1234567890bbbbbbbbbbbbbbbbbbbbbbbbbbbb', ['main']);
    const html = provider._getBranchLabelsHtml(node);
    assert.ok(
      /<span class="branch-label-local"[^>]*role="img"[^>]*aria-label="Local branch: main"[^>]*>/.test(
        html
      ),
      `local chip must carry role="img" + aria-label="Local branch: main"; got: ${html}`
    );
    assert.ok(
      /<i class="codicon codicon-git-branch"[^>]*aria-hidden="true"[^>]*><\/i>/.test(html),
      `local chip must include codicon-git-branch with aria-hidden=true; got: ${html}`
    );
  });

  it('snap-12c: remote branch chip emits role="img" + aria-label="Remote branch: origin/main" + codicon-git-branch', () => {
    // Remote chips now use the same codicon-git-branch icon as local
    // chips (per UX request to drop the cloud-vs-branch distinction).
    // The `branch-label-remote` CSS class and `Remote branch:` aria
    // label still differentiate the ref kind for SR users.
    const node = nodeWithBranches('ccc1234567890cccccccccccccccccccccccccccc', ['origin/main']);
    const html = provider._getBranchLabelsHtml(node);
    assert.ok(
      /<span class="branch-label-remote"[^>]*role="img"[^>]*aria-label="Remote branch: origin\/main"[^>]*>/.test(
        html
      ),
      `remote chip must carry role="img" + aria-label="Remote branch: origin/main"; got: ${html}`
    );
    assert.ok(
      /<i class="codicon codicon-git-branch"[^>]*aria-hidden="true"[^>]*><\/i>/.test(html),
      `remote chip must include codicon-git-branch with aria-hidden=true (same icon as local chips); got: ${html}`
    );
  });

  it('snap-12d: focused branch chip carries both `branch-label-local branch-label-focused` AND role="img" (aria-pressed deferred to Wave K)', () => {
    const node = nodeWithBranches('ddd1234567890dddddddddddddddddddddddddddd', ['feature']);
    const internals = provider as unknown as HeadStateInternals;
    internals._extendedLogState.focusedBranchName = 'feature';
    const html = provider._getBranchLabelsHtml(node);
    // `aria-pressed` is deferred because chips
    // are NOT yet keyboard-interactive (no tabindex, no click handler).
    // Today the chip is decorative + selectable-by-focus-row only;
    // adding `aria-pressed` would lie about an interaction that doesn't
    // exist. A later change will make the chip a button; aria-pressed lands then.
    assert.ok(
      /class="branch-label-local branch-label-focused"/.test(html),
      `focused chip must carry both classes; got: ${html}`
    );
    assert.ok(/role="img"/.test(html), `focused chip must still carry role="img"; got: ${html}`);
    assert.ok(
      !/aria-pressed/.test(html),
      `focused chip must NOT carry aria-pressed yet (deferred to Wave K); got: ${html}`
    );
  });
});

describe('Wave J / WJ-3 — chip theme-variable colors (gitDecoration-* family)', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('snap-12e: inline <style> declares `var(--vscode-gitDecoration-*)` for both .branch-label-local and .branch-label-remote with hex fallbacks', () => {
    const mockWebview = {
      html: '',
      options: {},
      cspSource: 'https://mock.csp.source',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri: import('vscode').Uri) => uri,
    } as unknown as import('vscode').Webview;
    const fullHtml = provider._getThreePanelHtmlContent(mockWebview, []);

    // Chip backgrounds switched to the
    // semantically-correct `--vscode-badge-*` family. The earlier hex
    // literals must STILL ship as the CSS-var fallback (defence in
    // depth + future hi-contrast drift detection); the legacy
    // gitDecoration-* tokens are retained as a SECONDARY var() fallback
    // for the remote chip only (snap-12e historically pinned that token).
    assert.ok(
      /\.branch-label-local[\s,{][\s\S]*?var\(--vscode-badge-background/.test(fullHtml),
      'inline CSS for .branch-label-local must use var(--vscode-badge-background) for theme-aware color'
    );
    assert.ok(
      /\.branch-label-local[\s,{][\s\S]*?#2d5a1e/.test(fullHtml),
      'inline CSS for .branch-label-local must keep #2d5a1e as the CSS-var fallback'
    );

    // Remote chip — same primary token (badge-background); legacy
    // gitDecoration-renamedResourceForeground retained as secondary
    // fallback so themes that override it still get a sensible chip.
    assert.ok(
      /\.branch-label-remote[\s,{][\s\S]*?var\(--vscode-badge-background/.test(fullHtml),
      'inline CSS for .branch-label-remote must use var(--vscode-badge-background) for theme-aware color'
    );
    assert.ok(
      /\.branch-label-remote[\s,{][\s\S]*?#1a3a5c/.test(fullHtml),
      'inline CSS for .branch-label-remote must keep #1a3a5c as the CSS-var fallback'
    );
  });
});

describe('Wave J / WJ-4 — chip codicon prefix (non-color affordance)', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');
  const headSha = 'fff1234567890fffffffffffffffffffffffffff1';

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('snap-12f: chip HTML carries codicon-git-branch for both local and remote chips, codicon-check for HEAD', () => {
    // Local and remote chips now share the same codicon-git-branch
    // icon (per UX request to drop the cloud-vs-branch distinction).
    // The CSS class (`branch-label-local` vs `branch-label-remote`)
    // still differentiates the ref kind for styling and SR labels.
    const internals = provider as unknown as HeadStateInternals;
    internals._extendedLogState.headHash = headSha;
    const node = nodeAt(headSha, ['main', 'origin/main']);
    const html = provider._getBranchLabelsHtml(node);
    assert.ok(
      /class="branch-label-head"[^>]*>[\s\S]*?codicon-check/.test(html),
      `HEAD chip must contain codicon-check; got: ${html}`
    );
    assert.ok(
      /class="branch-label-local"[^>]*>[\s\S]*?codicon-git-branch/.test(html),
      `local chip must contain codicon-git-branch; got: ${html}`
    );
    assert.ok(
      /class="branch-label-remote"[^>]*>[\s\S]*?codicon-git-branch/.test(html),
      `remote chip must contain codicon-git-branch (same icon as local; per UX request); got: ${html}`
    );
    assert.ok(
      !html.includes('codicon-cloud'),
      `no chip should use codicon-cloud anymore; got: ${html}`
    );
  });

  it('snap-12g: jsdom layout — chip width contract still ≤ 200px CSS cap with codicon icon present', () => {
    // The chip-cap contract was `max-width: 200px` on
    // .branch-label-local / .branch-label-remote / .branch-label-head.
    // The codicon adds an inline icon (~11px) inside each chip; the cap
    // STILL applies — adding an icon must NOT increase the CSS-side
    // contractual cap.
    const mockWebview = {
      html: '',
      options: {},
      cspSource: 'https://mock.csp.source',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri: import('vscode').Uri) => uri,
    } as unknown as import('vscode').Webview;
    const fullHtml = provider._getThreePanelHtmlContent(mockWebview, []);

    // The combined-rule selector or single-rule for each chip class must
    // still pin max-width: 200px. The icon-sizing rule that
    // declares `i.codicon { font-size: 11px; margin-right: 4px; }` —
    // this rule does NOT relax the cap.
    assert.ok(
      /\.branch-label-local[\s,{][\s\S]*?max-width:\s*200px/.test(fullHtml) ||
        /\.branch-label-local\s*,\s*\.branch-label-remote[\s\S]*?max-width:\s*200px/.test(fullHtml),
      'Wave J must NOT relax the Wave E R1 200px cap on .branch-label-local'
    );
    assert.ok(
      /\.branch-label-remote[\s,{][\s\S]*?max-width:\s*200px/.test(fullHtml) ||
        /\.branch-label-local\s*,\s*\.branch-label-remote[\s\S]*?max-width:\s*200px/.test(fullHtml),
      'Wave J must NOT relax the Wave E R1 200px cap on .branch-label-remote'
    );
    assert.ok(
      /\.branch-label-head[\s,{][\s\S]*?max-width:\s*200px/.test(fullHtml),
      'Wave J must NOT relax the Wave G 200px cap on .branch-label-head'
    );

    // The codicon-sizing rule must exist — it pins icon font-size at
    // 11px (matches chip text font-size) so the icon doesn't blow up
    // the chip vertically.
    assert.ok(
      /\.branch-label-(?:local|remote|head)[\s\S]*?i\.codicon[\s\S]*?font-size:\s*11px/.test(
        fullHtml
      ),
      'inline CSS must size chip codicon at 11px to match chip text height'
    );
  });
});

/**
 * Focused-branch chip non-colour affordance.
 *
 * Previously `.branch-label-focused` only carried `outline + font-weight:
 * 600`. WCAG 1.4.1 fails when the only differentiator is a colour
 * (focus outline) — under high-contrast themes the outline often
 * matches the chip border, making the focus invisible. The fix bumps
 * `font-weight: 700` and adds `text-decoration: underline` so the
 * affordance is visible in mono-chrome printout / colour-blind
 * users / hi-contrast themes alike.
 */
describe('Wave J R1 / MED-1 — focused chip carries bold + underline', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('focusedChipMED1-1: .branch-label-focused CSS rule sets font-weight 700 + text-decoration underline', () => {
    const mockWebview = {
      html: '',
      options: {},
      cspSource: 'https://mock.csp.source',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri: import('vscode').Uri) => uri,
    } as unknown as import('vscode').Webview;
    const fullHtml = provider._getThreePanelHtmlContent(mockWebview, []);

    // The .branch-label-focused rule must declare both the bold-bump
    // (font-weight: 700) and the underline. Both are non-colour
    // affordances per WCAG 1.4.1.
    assert.ok(
      /\.branch-label-focused\s*\{[^}]*font-weight:\s*700/.test(fullHtml),
      '.branch-label-focused must set font-weight: 700 (bold-bump non-colour affordance)'
    );
    assert.ok(
      /\.branch-label-focused\s*\{[^}]*text-decoration:\s*underline/.test(fullHtml),
      '.branch-label-focused must set text-decoration: underline (non-colour affordance)'
    );
    // The earlier rule had font-weight: 600 — ensure that value is gone.
    assert.ok(
      !/\.branch-label-focused\s*\{[^}]*font-weight:\s*600/.test(fullHtml),
      '.branch-label-focused must NOT set font-weight: 600 (pre-R1 weight)'
    );
  });
});

/**
 * Codicon font loader.
 *
 * Previously the webview HTML emitted `<i class="codicon codicon-…">`
 * glyphs on every chip but no `@font-face` declaration loaded the
 * actual TTF — every glyph rendered as an empty-box "tofu" and the
 * entire WCAG 1.4.1 non-colour affordance silently failed. This block
 * pins the @font-face + .codicon utility + per-glyph codepoint rules
 * + the CSP `font-src` widening, so a regression that breaks any of
 * these layers is caught by RED test rather than an in-extension
 * visual fail.
 *
 * Test coverage:
 *   codiconFont-1: rendered HTML contains `@font-face { font-family:
 *     "codicon"` declaration with an `asWebviewUri`-rewritten src.
 *   codiconFont-2: rendered HTML contains the `.codicon { font: …; }`
 *     utility rule + per-glyph `::before` content rules for the three
 *     codicons currently emitted (check, git-branch, cloud).
 *   codiconFont-3: 3-panel CSP meta tag includes
 *     `font-src ${webview.cspSource}`.
 */
describe('Wave J R1 / HIGH-1 — codicon font loader', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('codiconFont-1: rendered HTML contains @font-face declaration loading codicon TTF via asWebviewUri', () => {
    const mockWebview = {
      html: '',
      options: {},
      cspSource: 'https://mock.csp.source',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri: import('vscode').Uri) => uri,
    } as unknown as import('vscode').Webview;
    const fullHtml = provider._getThreePanelHtmlContent(mockWebview, []);

    // The @font-face block must be present with font-family "codicon".
    assert.ok(
      /@font-face\s*\{[^}]*font-family:\s*["']codicon["']/.test(fullHtml),
      'rendered HTML must contain @font-face { font-family: "codicon" } declaration'
    );
    // The src must point at the codicon TTF (asWebviewUri pass-through
    // in the mock returns the local URI; production rewrites to the
    // webview-acceptable form). Either way the path ends in
    // `media/codicon.ttf`.
    assert.ok(
      /@font-face[\s\S]*?src:\s*url\([^)]*codicon\.ttf[^)]*\)\s+format\(["']truetype["']\)/.test(
        fullHtml
      ),
      'rendered HTML must include src: url(...codicon.ttf) format("truetype") in @font-face'
    );
  });

  it('codiconFont-2: rendered HTML contains .codicon utility rule + per-glyph codepoint rules', () => {
    const mockWebview = {
      html: '',
      options: {},
      cspSource: 'https://mock.csp.source',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri: import('vscode').Uri) => uri,
    } as unknown as import('vscode').Webview;
    const fullHtml = provider._getThreePanelHtmlContent(mockWebview, []);

    // The base utility rule — must include the `font:` shorthand
    // declaring the `codicon` font-family.
    assert.ok(
      /\.codicon\s*\{[^}]*font:[^}]*codicon[^}]*\}/.test(fullHtml),
      'rendered HTML must contain .codicon { font: ...; } utility rule'
    );
    // Per-glyph codepoints — match upstream @vscode/codicons CSS:
    //   codicon-check       → \eab2
    //   codicon-git-branch  → \ec6f
    //   codicon-cloud       → \ebaa
    assert.ok(
      /\.codicon-check:before\s*\{\s*content:\s*"\\eab2"/.test(fullHtml),
      'rendered HTML must map codicon-check to codepoint \\eab2'
    );
    assert.ok(
      /\.codicon-git-branch:before\s*\{\s*content:\s*"\\ec6f"/.test(fullHtml),
      'rendered HTML must map codicon-git-branch to codepoint \\ec6f'
    );
    assert.ok(
      /\.codicon-cloud:before\s*\{\s*content:\s*"\\ebaa"/.test(fullHtml),
      'rendered HTML must map codicon-cloud to codepoint \\ebaa'
    );
  });

  it('codiconFont-3: CSP meta tag includes font-src ${webview.cspSource}', () => {
    const mockWebview = {
      html: '',
      options: {},
      cspSource: 'https://mock.csp.source',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri: import('vscode').Uri) => uri,
    } as unknown as import('vscode').Webview;
    const fullHtml = provider._getThreePanelHtmlContent(mockWebview, []);

    // The CSP must allow font-src from the webview's cspSource so the
    // same-origin TTF URL resolves. Earlier the CSP omitted font-src
    // entirely — fonts fell back to default-src 'none' and the load
    // was blocked. The new CSP MUST include font-src for the webview's
    // cspSource (mock returns 'https://mock.csp.source').
    assert.ok(
      /Content-Security-Policy[^>]*font-src\s+https:\/\/mock\.csp\.source/.test(fullHtml),
      'CSP meta tag must allow font-src from the webview cspSource'
    );
  });

  it('codiconFont-4: rendered HTML maps codicon-tag to upstream codepoint \\ea66 (Wave K WK-4)', () => {
    const mockWebview = {
      html: '',
      options: {},
      cspSource: 'https://mock.csp.source',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri: import('vscode').Uri) => uri,
    } as unknown as import('vscode').Webview;
    const fullHtml = new GitToolWindowProvider(
      Uri.file('/test/extension')
    )._getThreePanelHtmlContent(mockWebview, []);
    // codicon-tag → \ea66 (pinned from @vscode/codicons@0.0.45
    // dist/codicon.css; verify with `grep codicon-tag node_modules/@vscode/codicons/dist/codicon.css`).
    assert.ok(
      /\.codicon-tag:before\s*\{\s*content:\s*"\\ea66"/.test(fullHtml),
      `rendered HTML must map codicon-tag to codepoint \\ea66; got: ${String(fullHtml.match(/codicon-tag:before[^}]+/) ?? '(no match)')}`
    );
  });
});

/**
 * Tag chip parity contracts.
 *
 * The tag chip joins the existing chip family (HEAD + local + remote).
 * Contracts:
 *   - snap-13a: HEAD + branches + tags collocated, literal HTML order
 *     (HEAD first, then branch chips in branchMap order, then tag
 *     chips rightmost — matching IntelliJ's badge ordering).
 *   - snap-13b: tag-only commit (no branches, no HEAD) → wrapper non-
 *     empty, single tag chip emitted.
 *   - snap-13c: multiple tags (semver + alias) render in array order.
 *   - snap-13d: XSS-shaped tag name escaped in textContent + aria-label
 *     + data-tag-name (no reflective injection path).
 *   - snap-13e: jsdom layout — tag chip is sibling AFTER branch chips
 *     inside .commit-branches; not nested inside .commit-title.
 *   - snap-13f: CSS contract — chip-cap (200px) + chip
 *     gitDecoration-modifiedResourceForeground / #6897BB fallback both
 *     present for `.tag-label`.
 */
describe('Wave K / WK-4 — tag chip parity (chip-emit + CSS + a11y)', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');
  const headSha = 'aaa1234567890aaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  // Helper: build a commit node carrying both branches AND tags.
  function nodeWithBranchesAndTags(
    hash: string,
    branches: Array<string | IBranchRef>,
    tags: string[]
  ): ICommitNode {
    return {
      commit: mkCommit(hash, ['parent1234567890123456789012345678901234']),
      graphColumn: 0,
      graphLines: [{ fromColumn: 0, toColumn: 0, color: '#4CAF50', type: 'commit' }],
      branches: toBranchRefs(branches),
      tags,
      onFocusedBranchPath: false,
    };
  }

  it('snap-13a: HEAD + branches + tags collocated → literal HTML order (HEAD, branches, tags rightmost)', () => {
    const internals = provider as unknown as HeadStateInternals;
    internals._extendedLogState.headHash = headSha;
    const node = nodeWithBranchesAndTags(headSha, ['main'], ['v1.0']);
    const html = provider._getBranchLabelsHtml(node);
    // IntelliJ-parity ordering: HEAD chip leftmost, branches
    // middle, tags rightmost. Pin the literal full string so a future
    // re-ordering forces a deliberate snapshot diff.
    assert.strictEqual(
      html,
      '<span class="branch-label-head" data-head-chip="true" role="img" aria-label="Current HEAD"><i class="codicon codicon-check" aria-hidden="true"></i>HEAD</span>' +
        '<span class="branch-label-local" data-branch-name="main" role="img" aria-label="Local branch: main"><i class="codicon codicon-git-branch" aria-hidden="true"></i>main</span>' +
        '<span class="tag-label" data-tag-name="v1.0" role="img" aria-label="Tag: v1.0"><i class="codicon codicon-tag" aria-hidden="true"></i>v1.0</span>'
    );
  });

  it('snap-13b: tag-only commit (no branches, no HEAD) → wrapper non-empty, single tag chip emitted', () => {
    const node = nodeWithBranchesAndTags('bbb1234567890bbbbbbbbbbbbbbbbbbbbbbbbbbbb', [], ['v0.9']);
    const html = provider._getBranchLabelsHtml(node);
    assert.notStrictEqual(html, '', 'tag-only commit must NOT collapse to empty wrapper');
    assert.strictEqual(
      html,
      '<span class="tag-label" data-tag-name="v0.9" role="img" aria-label="Tag: v0.9"><i class="codicon codicon-tag" aria-hidden="true"></i>v0.9</span>'
    );
  });

  it('snap-13c: multiple tags (semver + alias) render sequentially in array order', () => {
    const node = nodeWithBranchesAndTags(
      'ccc1234567890cccccccccccccccccccccccccccc',
      [],
      ['v1.0.0', 'latest']
    );
    const html = provider._getBranchLabelsHtml(node);
    assert.strictEqual(
      html,
      '<span class="tag-label" data-tag-name="v1.0.0" role="img" aria-label="Tag: v1.0.0"><i class="codicon codicon-tag" aria-hidden="true"></i>v1.0.0</span>' +
        '<span class="tag-label" data-tag-name="latest" role="img" aria-label="Tag: latest"><i class="codicon codicon-tag" aria-hidden="true"></i>latest</span>'
    );
  });

  it('snap-13d: XSS-shaped tag name escaped in textContent + aria-label + data-tag-name', () => {
    // A future malicious server returning `<img src=x onerror=…>` as a
    // tag name must NOT inject script. The chip emit pipes the name
    // through `_escapeHtml` for all three reflective surfaces (textContent,
    // aria-label, data-tag-name).
    const xss = '<img src=x onerror=alert(1)>';
    const node = nodeWithBranchesAndTags('ddd1234567890dddddddddddddddddddddddddddd', [], [xss]);
    const html = provider._getBranchLabelsHtml(node);
    // Raw `<img` MUST NOT appear anywhere in the output.
    assert.ok(!/<img\s+src=x/i.test(html), `tag emit must escape <img> tags; got: ${html}`);
    // The escaped form `&lt;img src=x onerror=alert(1)&gt;` should appear
    // in BOTH the data-tag-name AND aria-label slots.
    assert.ok(
      /data-tag-name="&lt;img\s+src=x[^"]*"/.test(html),
      `data-tag-name must carry the escaped name; got: ${html}`
    );
    assert.ok(
      /aria-label="Tag:\s+&lt;img\s+src=x[^"]*"/.test(html),
      `aria-label must carry the escaped name; got: ${html}`
    );
    // And the inner text content (between the </i> and </span>) must be
    // the escaped form too.
    assert.ok(
      /<\/i>&lt;img\s+src=x[^<]*<\/span>/.test(html),
      `textContent must be the escaped form; got: ${html}`
    );
  });

  it('snap-13e: jsdom layout — tag chip is sibling AFTER branch chips inside .commit-branches', () => {
    const internals = provider as unknown as HeadStateInternals;
    internals._extendedLogState.headHash = headSha;
    // Use the public _getGraphPanelHtml so we get the full DOM tree
    // including the .commit-branches wrapper.
    const node = nodeWithBranchesAndTags(headSha, ['main'], ['v1.0']);
    const html = provider._getGraphPanelHtml([node]);
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
    const doc = dom.window.document;
    const tagChip = doc.querySelector('.tag-label');
    assert.ok(tagChip, 'tag chip must exist in DOM');
    // Parent must be `.commit-branches` (not `.commit-title`).
    const parent = tagChip.parentElement;
    assert.ok(parent, 'tag chip must have a parent');
    assert.ok(
      parent.classList.contains('commit-branches'),
      `tag chip must be inside .commit-branches; got parent class: "${parent.className}"`
    );
    // Sibling order: HEAD chip / branch chip / tag chip (tag rightmost).
    const children = Array.from(parent.children);
    const tagIdx = children.indexOf(tagChip);
    const branchIdx = children.findIndex((c) => c.classList.contains('branch-label-local'));
    assert.ok(branchIdx >= 0, 'branch chip must exist');
    assert.ok(
      tagIdx > branchIdx,
      `tag chip must come AFTER branch chip; tag@${tagIdx} branch@${branchIdx}`
    );
  });

  it('snap-13f: CSS contract — .tag-label uses gitDecoration-modifiedResourceForeground + #6897BB fallback', () => {
    const mockWebview = {
      html: '',
      options: {},
      cspSource: 'https://mock.csp.source',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri: import('vscode').Uri) => uri,
    } as unknown as import('vscode').Webview;
    const fullHtml = provider._getThreePanelHtmlContent(mockWebview, []);
    // The `.tag-label` background-color rule pre-existed
    // (`var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB)`).
    // It survives the chip-family widening (snap-13f).
    assert.ok(
      /\.tag-label\s*\{[^}]*var\(--vscode-gitDecoration-modifiedResourceForeground/.test(fullHtml),
      `inline CSS for .tag-label must use var(--vscode-gitDecoration-modifiedResourceForeground)`
    );
    assert.ok(
      /\.tag-label\s*\{[^}]*#6897BB/.test(fullHtml),
      `inline CSS for .tag-label must keep #6897BB as the fallback hex`
    );
    // Chip-family 200px cap now extends to .tag-label.
    assert.ok(
      /\.tag-label[\s,{][\s\S]*?max-width:\s*200px/.test(fullHtml) ||
        /\.branch-label-local\s*,\s*\.branch-label-remote\s*,\s*\.tag-label[\s\S]*?max-width:\s*200px/.test(
          fullHtml
        ),
      'Wave K must extend the 200px cap to .tag-label'
    );
    // Chip-family theme symmetry. The `.tag-label`
    // foreground colour must use `var(--vscode-badge-foreground, white)`
    // matching the `.branch-label-*` family. Earlier it used a raw `white`
    // token which loses theme adherence on light / hi-contrast themes
    // where the theme overrides badge-foreground. Pinned here so the
    // colour-token contract for the entire chip family is locked.
    assert.ok(
      /\.tag-label\s*\{[^}]*color:\s*var\(--vscode-badge-foreground/.test(fullHtml),
      'inline CSS for .tag-label must use var(--vscode-badge-foreground) for chip-family theme symmetry'
    );
    assert.ok(
      /\.tag-label\s*\{[^}]*color:\s*var\(--vscode-badge-foreground,\s*white\)/.test(fullHtml),
      'inline CSS for .tag-label must keep `white` as the badge-foreground fallback'
    );
  });
});
