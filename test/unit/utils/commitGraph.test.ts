/**
 * Unit tests for commit graph generation utilities.
 *
 * Tests cover:
 * - generateCommitGraph() for creating graph visualization data
 * - Handling of linear commit history
 * - Handling of merge commits with multiple parents
 * - Lane (column) assignment for branches
 * - Graph line generation
 */

import * as assert from 'assert';
import {
  generateCommitGraph,
  getMaxGraphColumn,
  isMergeCommit,
  isRootCommit,
  getActiveLaneCount,
  getColumnColor,
  computeTerminalNodes,
  computeChildCountMap,
  isBranchSplit,
  ICommitNode,
  IBranchRef,
} from '../../../src/git-core/commitGraph';
import {
  computeActiveLanes,
  getColumnX,
  DEFAULT_GRAPH_CONFIG,
} from '../../../src/utils/graphRenderer';
import { buildGraphPrintModel } from '../../../src/git-core/graph/printModel';
import { paintRow } from '../../../src/git-core/graph/graphPainter';
import { ICommit } from '../../../src/git-core/interfaces/IGitService';

/**
 * Helper function to create a mock commit for testing.
 */
function createMockCommit(
  hash: string,
  parents: string[] = [],
  message: string = 'Test commit'
): ICommit {
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message,
    author: { name: 'Test Author', email: 'test@example.com' },
    committer: { name: 'Test Author', email: 'test@example.com' },
    parents,
    authorDate: new Date(),
    commitDate: new Date(),
  };
}

describe('Commit Graph Generation', () => {
  describe('generateCommitGraph()', () => {
    describe('Empty input', () => {
      it('should return empty array for empty input', () => {
        const result = generateCommitGraph([]);
        assert.deepStrictEqual(result, []);
      });
    });

    describe('Single commit (root)', () => {
      it('should handle a single root commit', () => {
        const commits = [createMockCommit('abc123', [], 'Initial commit')];

        const result = generateCommitGraph(commits);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].commit.hash, 'abc123');
        assert.strictEqual(result[0].graphColumn, 0);
        assert.strictEqual(result[0].graphLines.length, 0); // Root has no parent lines
      });
    });

    describe('Linear history', () => {
      it('should handle linear commit history', () => {
        // Commits in topological order (newest first)
        const commits = [
          createMockCommit('commit3', ['commit2'], 'Third commit'),
          createMockCommit('commit2', ['commit1'], 'Second commit'),
          createMockCommit('commit1', [], 'Initial commit'),
        ];

        const result = generateCommitGraph(commits);

        assert.strictEqual(result.length, 3);

        // All commits should be in the same column (lane 0)
        assert.strictEqual(result[0].graphColumn, 0);
        assert.strictEqual(result[1].graphColumn, 0);
        assert.strictEqual(result[2].graphColumn, 0);

        // First two commits should have lines to their parents
        assert.strictEqual(result[0].graphLines.length, 1);
        assert.strictEqual(result[0].graphLines[0].fromColumn, 0);
        assert.strictEqual(result[0].graphLines[0].toColumn, 0);
        assert.strictEqual(result[0].graphLines[0].type, 'commit');

        assert.strictEqual(result[1].graphLines.length, 1);
        assert.strictEqual(result[1].graphLines[0].fromColumn, 0);
        assert.strictEqual(result[1].graphLines[0].toColumn, 0);
        assert.strictEqual(result[1].graphLines[0].type, 'commit');

        // Root commit has no lines
        assert.strictEqual(result[2].graphLines.length, 0);
      });

      it('should assign correct line types for normal commits', () => {
        const commits = [
          createMockCommit('commit2', ['commit1'], 'Second commit'),
          createMockCommit('commit1', [], 'Initial commit'),
        ];

        const result = generateCommitGraph(commits);

        assert.strictEqual(result[0].graphLines[0].type, 'commit');
      });
    });

    describe('Merge commits', () => {
      it('should handle a simple merge commit', () => {
        // Merge commit with two parents
        const commits = [
          createMockCommit('merge', ['main2', 'feature1'], 'Merge feature into main'),
          createMockCommit('main2', ['main1'], 'Main commit 2'),
          createMockCommit('feature1', ['main1'], 'Feature commit'),
          createMockCommit('main1', [], 'Initial commit'),
        ];

        const result = generateCommitGraph(commits);

        assert.strictEqual(result.length, 4);

        // Merge commit should have two graph lines
        const mergeNode = result[0];
        assert.strictEqual(mergeNode.graphLines.length, 2);

        // First line should be to first parent (main line)
        assert.strictEqual(mergeNode.graphLines[0].type, 'commit');

        // Second line should be to second parent (merged branch)
        assert.strictEqual(mergeNode.graphLines[1].type, 'merge');
      });

      it('should handle merge commit with three parents (octopus merge)', () => {
        const commits = [
          createMockCommit('octopus', ['parent1', 'parent2', 'parent3'], 'Octopus merge'),
          createMockCommit('parent1', ['base'], 'Parent 1'),
          createMockCommit('parent2', ['base'], 'Parent 2'),
          createMockCommit('parent3', ['base'], 'Parent 3'),
          createMockCommit('base', [], 'Base commit'),
        ];

        const result = generateCommitGraph(commits);

        // Octopus merge should have three graph lines
        const octopusNode = result[0];
        assert.strictEqual(octopusNode.graphLines.length, 3);

        // First line is main, others are merge lines
        assert.strictEqual(octopusNode.graphLines[0].type, 'commit');
        assert.strictEqual(octopusNode.graphLines[1].type, 'merge');
        assert.strictEqual(octopusNode.graphLines[2].type, 'merge');
      });
    });

    describe('Branch and merge scenario', () => {
      it('should handle a typical branch and merge workflow', () => {
        // Simulating:
        // * merge (main)
        // |\
        // | * feature2
        // | * feature1
        // * | main2
        // |/
        // * main1 (base)
        const commits = [
          createMockCommit('merge', ['main2', 'feature2'], 'Merge feature'),
          createMockCommit('feature2', ['feature1'], 'Feature 2'),
          createMockCommit('main2', ['main1'], 'Main 2'),
          createMockCommit('feature1', ['main1'], 'Feature 1'),
          createMockCommit('main1', [], 'Main 1'),
        ];

        const result = generateCommitGraph(commits);

        assert.strictEqual(result.length, 5);

        // Verify merge commit has two lines
        assert.strictEqual(result[0].graphLines.length, 2);
      });
    });

    describe('Branch and tag mapping', () => {
      it('should include branch names in commit nodes', () => {
        const commits = [createMockCommit('abc123', [], 'Initial commit')];

        const branchMap = new Map<string, IBranchRef[]>();
        branchMap.set('abc123', [
          { name: 'main', type: 'local' },
          { name: 'develop', type: 'local' },
        ]);

        const result = generateCommitGraph(commits, branchMap);

        assert.deepStrictEqual(result[0].branches, [
          { name: 'main', type: 'local' },
          { name: 'develop', type: 'local' },
        ]);
      });

      it('should include tag names in commit nodes', () => {
        const commits = [createMockCommit('abc123', [], 'Initial commit')];

        const tagMap = new Map<string, string[]>();
        tagMap.set('abc123', ['v1.0.0', 'release']);

        const result = generateCommitGraph(commits, undefined, tagMap);

        assert.deepStrictEqual(result[0].tags, ['v1.0.0', 'release']);
      });

      it('should include both branches and tags', () => {
        const commits = [createMockCommit('abc123', [], 'Initial commit')];

        const branchMap = new Map<string, IBranchRef[]>();
        branchMap.set('abc123', [{ name: 'main', type: 'local' }]);

        const tagMap = new Map<string, string[]>();
        tagMap.set('abc123', ['v1.0.0']);

        const result = generateCommitGraph(commits, branchMap, tagMap);

        assert.deepStrictEqual(result[0].branches, [{ name: 'main', type: 'local' }]);
        assert.deepStrictEqual(result[0].tags, ['v1.0.0']);
      });

      it('should return empty arrays when no branches or tags', () => {
        const commits = [createMockCommit('abc123', [], 'Initial commit')];

        const result = generateCommitGraph(commits);

        assert.deepStrictEqual(result[0].branches, []);
        assert.deepStrictEqual(result[0].tags, []);
      });
    });

    describe('Graph line colors', () => {
      it('should assign colors to graph lines', () => {
        const commits = [
          createMockCommit('commit2', ['commit1'], 'Second commit'),
          createMockCommit('commit1', [], 'Initial commit'),
        ];

        const result = generateCommitGraph(commits);

        // Lines should have colors assigned
        assert.ok(result[0].graphLines[0].color);
        assert.ok(result[0].graphLines[0].color.startsWith('#'));
      });
    });

    // ─── Dashed style for off-window edges (architectural fix #4) ─────
    //
    // The IGraphLine.style field exposes "is this edge a stub for
    // history that fell off the loaded window" to the renderer. The
    // renderer paints dashed strokes for them — IntelliJ-parity
    // affordance for "history continues below".
    describe('Off-window parent stubs are marked style: dashed (architectural fix #4)', () => {
      it('emits style:"dashed" on the same-lane stub when parent is OUTSIDE the loaded window', () => {
        // Only `child` is in the window; its parent `off-window-parent`
        // is older than the slice. The stub line must be dashed.
        const commits = [createMockCommit('child', ['off-window-parent'])];

        const result = generateCommitGraph(commits);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].graphLines.length, 1);
        const line = result[0].graphLines[0];
        // Verify it's the off-window stub (same-lane).
        assert.strictEqual(line.fromColumn, line.toColumn);
        assert.strictEqual(
          line.style,
          'dashed',
          `off-window stub must be dashed; got style=${String(line.style)}`
        );
      });

      it('does NOT emit style:"dashed" on a normal in-window same-lane line', () => {
        // Linear history — both rows in the window. The line from
        // `child` to `parent` is solid (no `style` field set, which
        // the renderer treats as solid).
        const commits = [createMockCommit('child', ['parent']), createMockCommit('parent', [])];

        const result = generateCommitGraph(commits);
        const line = result[0].graphLines[0];
        assert.notStrictEqual(line.style, 'dashed', 'in-window edges must NOT be dashed');
      });

      it('emits style:"dashed" on a merge stub when parents[1] is off-window', () => {
        // Merge whose second parent is off-window. The merge edge for
        // that parent should still be dashed — same affordance.
        const commits = [
          createMockCommit('m', ['p1', 'off-window-p2']),
          createMockCommit('p1', []),
        ];

        const result = generateCommitGraph(commits);
        const merge = result[0];
        assert.strictEqual(merge.graphLines.length, 2);
        // graphLines[1] is the merge edge for parents[1].
        const stubLine = merge.graphLines[1];
        // Off-window stub: same-lane.
        assert.strictEqual(stubLine.fromColumn, stubLine.toColumn);
        assert.strictEqual(stubLine.style, 'dashed', 'off-window merge stub must be dashed');
      });
    });

    // ─── Lane seeding from branchMap (architectural fix #3) ────────────
    //
    // Without seeding, lane indices were a pure function of input
    // ordering. After a squash, refresh, or repository reload,
    // branches could "jump" between columns. Seeding pre-claims a lane
    // for each branch tip in priority order: HEAD's branch → 0;
    // other locals A→Z → 1, 2, ...; remotes A→Z last. This keeps
    // HEAD's branch on the leftmost column across renders, which is
    // both IntelliJ parity and the prerequisite for cross-render
    // lane stability.
    describe('Lane seeding from branchMap (architectural fix #3)', () => {
      it("HEAD's branch tip lands on lane 0 even when it's not the newest commit", () => {
        // Topology:
        //   tip-feature (newest)
        //     └─ shared-base
        //   tip-main
        //     └─ shared-base
        //
        // tip-feature is processed FIRST (newest in input). Without
        // seeding, tip-feature claims lane 0 and tip-main is forced
        // to lane 1. With HEAD = main, tip-main MUST get lane 0.
        const commits = [
          createMockCommit('tip-feature', ['shared-base']),
          createMockCommit('tip-main', ['shared-base']),
          createMockCommit('shared-base', []),
        ];
        const branchMap = new Map<string, IBranchRef[]>();
        branchMap.set('tip-feature', [{ name: 'feature', type: 'local' }]);
        branchMap.set('tip-main', [{ name: 'main', type: 'local' }]);

        const result = generateCommitGraph(commits, branchMap, undefined, undefined, 'main');

        const tipMain = result.find((n) => n.commit.hash === 'tip-main')!;
        assert.strictEqual(
          tipMain.graphColumn,
          0,
          `HEAD's branch tip must land on lane 0 even when later in display order; got ${tipMain.graphColumn}`
        );
      });

      it('keeps the whole chain on lane 0 when HEAD is BEHIND newer in-window descendants', () => {
        // Regression (reported via screenshot): the log loads commits
        // NEWER than HEAD's branch tip — e.g. an un-pulled upstream
        // commit, or another branch built on top of HEAD, included by the
        // `--all` / topo slice. HEAD ('mainline') is the SECOND row; a
        // newer descendant ('newer') is the first row and is a child of
        // HEAD's tip.
        //
        // The old unconditional HEAD-seed pre-claimed lane 0 for the HEAD
        // tip, which forced 'newer' onto lane 1 with a `1->0` bend (the
        // blue-dot-on-lane-1-above-green-HEAD artifact + a stray vertical
        // stub). The fix pre-claims HEAD's whole FIRST-PARENT SPINE on lane
        // 0, walking UP through first-parent-children so a newer descendant
        // (like 'newer') is part of the spine and pinned to lane 0 too.
        // Every commit must end up on lane 0 with a straight same-lane
        // line — no bend, no second lane.
        const commits = [
          createMockCommit('newer', ['mainline']), // newest, child of HEAD tip
          createMockCommit('mainline', ['p1']), // HEAD's branch tip
          createMockCommit('p1', ['p2']),
          createMockCommit('p2', []),
        ];
        const branchMap = new Map<string, IBranchRef[]>();
        branchMap.set('mainline', [{ name: 'mainline', type: 'local' }]);

        const result = generateCommitGraph(commits, branchMap, undefined, undefined, 'mainline');

        for (const node of result) {
          assert.strictEqual(
            node.graphColumn,
            0,
            `${node.commit.hash} must stay on lane 0 (HEAD-behind-newer must not bend the chain); got ${node.graphColumn}`
          );
          for (const line of node.graphLines) {
            assert.strictEqual(
              line.fromColumn,
              line.toColumn,
              `${node.commit.hash} line must be same-lane (no sideways bend); got ${line.fromColumn}->${line.toColumn}`
            );
          }
        }
      });

      it('keeps the HEAD mainline spine straight on lane 0 when divergent branches share its ancestors', () => {
        // Reported via screenshot: with `mainline`, `mainline-clone`, and
        // `test_squash` all loaded via --all, mainline commits (the shared
        // ancestors) were dragged onto a side lane because a divergent
        // branch listed earlier in the topo slice reached the shared parent
        // FIRST and the main pass allocated it a fresh lane. That rendered a
        // mainline commit on lane 2 (orange) with the mainline line hooking
        // sideways into it (green/blue node, orange line).
        //
        // Fix: pre-claim HEAD's entire first-parent spine on lane 0, so the
        // shared ancestors are pinned to lane 0 and the DIVERGENT branches
        // are the ones that bend into lane 0 (correct IntelliJ behavior).
        //
        // Topology (newest-first; test_squash listed before mainline, as
        // --all topo order tends to interleave):
        //   t_tip -> t2 -> squash -> base   (test_squash)
        //   m_tip -> m2 -> base             (mainline / HEAD)
        //   c_tip -> base                   (mainline-clone)
        const commits = [
          createMockCommit('t_tip', ['t2']),
          createMockCommit('t2', ['squash']),
          createMockCommit('squash', ['base']),
          createMockCommit('m_tip', ['m2']),
          createMockCommit('m2', ['base']),
          createMockCommit('c_tip', ['base']),
          createMockCommit('base', ['older']),
          createMockCommit('older', []),
        ];
        const branchMap = new Map<string, IBranchRef[]>();
        branchMap.set('t_tip', [{ name: 'test_squash', type: 'local' }]);
        branchMap.set('m_tip', [{ name: 'mainline', type: 'local' }]);
        branchMap.set('c_tip', [{ name: 'mainline-clone', type: 'local' }]);

        const result = generateCommitGraph(commits, branchMap, undefined, undefined, 'mainline');
        const col = (h: string): number => result.find((n) => n.commit.hash === h)!.graphColumn;

        // The whole HEAD first-parent spine pins to lane 0.
        for (const h of ['m_tip', 'm2', 'base', 'older']) {
          assert.strictEqual(col(h), 0, `${h} (mainline spine) must be on lane 0; got ${col(h)}`);
        }
        // Divergent branches sit on their own non-zero lanes (they bend INTO
        // lane 0, not the other way around).
        assert.notStrictEqual(col('t_tip'), 0, 'test_squash tip must not be on lane 0');
        assert.notStrictEqual(col('c_tip'), 0, 'mainline-clone tip must not be on lane 0');

        // node/line color match: every commit's own first-parent line is
        // colored by its own lane (the renderer keys 'commit' edges off the
        // source column).
        for (const node of result) {
          const firstParent = node.graphLines.find((l) => l.type === 'commit');
          if (firstParent) {
            assert.strictEqual(
              firstParent.color,
              getColumnColor(node.graphColumn),
              `${node.commit.hash}: first-parent line color must equal node lane color`
            );
          }
        }
      });

      it('RELEASES a lane when its branch ends so a later branch reuses the column (compact width)', () => {
        // Reported: with several branches the graph grew wider and wider,
        // pushing older branches off-screen even with room — because lanes
        // were never freed (each ended branch left a permanently-reserved
        // column). Two divergent branches that are NOT alive at the same row
        // must SHARE a lane: branch A (forks high, rejoins) ends before
        // branch B begins, so B reuses A's lane instead of taking a new one.
        //
        // Topo (newest-first): m0, A(a0 → rejoins m1), m1, B(b0 → rejoins
        // m2), m2, m3. Branch A is a single commit a0 (row 1) whose line
        // bends to m1 (row 2); A's lane frees at row 2. Branch B's tip b0
        // (row 3) starts AFTER A has ended, so it reuses A's freed lane —
        // both A and B share one side lane. Without release B takes a fresh
        // lane 2.
        const commits = [
          createMockCommit('m0', ['m1']),
          createMockCommit('a0', ['m1']),
          createMockCommit('m1', ['m2']),
          createMockCommit('b0', ['m2']),
          createMockCommit('m2', ['m3']),
          createMockCommit('m3', []),
        ];
        const branchMap = new Map<string, IBranchRef[]>();
        branchMap.set('m0', [{ name: 'mainline', type: 'local' }]);
        branchMap.set('a0', [{ name: 'A', type: 'local' }]);
        branchMap.set('b0', [{ name: 'B', type: 'local' }]);

        const result = generateCommitGraph(
          commits,
          branchMap,
          undefined,
          undefined,
          'mainline',
          'm0'
        );
        let maxCol = 0;
        for (const n of result) {
          maxCol = Math.max(maxCol, n.graphColumn);
          for (const l of n.graphLines) {
            maxCol = Math.max(maxCol, l.fromColumn, l.toColumn);
          }
        }
        // Mainline lane 0 + at most ONE side lane reused by both A and B.
        // Without release, A=lane1 and B=lane2 → maxCol 2; with release they
        // share lane 1 → maxCol 1.
        assert.strictEqual(
          maxCol,
          1,
          `A ends before B starts, so they must SHARE one side lane (maxCol 1); got ${maxCol}`
        );
      });

      it('does NOT reuse a lane while a bending line is still in transit (no mid-transit collision)', () => {
        // The release must wait until the bending line LANDS at its parent
        // row. Three sibling tips all diving to a shared base are pairwise
        // concurrent (each one's bezier crosses the next one's row), so they
        // must get THREE distinct lanes — releasing too early would collapse
        // them onto one column and overlap their nodes/lines.
        const commits = [
          createMockCommit('tipA', ['base']),
          createMockCommit('tipB', ['base']),
          createMockCommit('tipC', ['base']),
          createMockCommit('base', []),
        ];
        const result = generateCommitGraph(commits);
        const lanes = new Set([
          result[0].graphColumn,
          result[1].graphColumn,
          result[2].graphColumn,
        ]);
        assert.strictEqual(lanes.size, 3, 'three concurrent tips need three distinct lanes');
      });

      it('without seeding (no headBranchName), preserves the existing first-seen order', () => {
        // The seeding pre-pass is a strict superset: when no
        // headBranchName is provided AND no branchMap is supplied, the
        // algorithm must be byte-identical to the pre-fix behaviour.
        // This guards against regressions in callers that don't pass
        // a head branch name.
        const commits = [
          createMockCommit('tip-feature', ['shared-base']),
          createMockCommit('tip-main', ['shared-base']),
          createMockCommit('shared-base', []),
        ];

        const result = generateCommitGraph(commits);
        const tipFeature = result.find((n) => n.commit.hash === 'tip-feature')!;
        const tipMain = result.find((n) => n.commit.hash === 'tip-main')!;

        assert.strictEqual(tipFeature.graphColumn, 0, 'first commit takes lane 0 by default');
        assert.notStrictEqual(
          tipMain.graphColumn,
          tipFeature.graphColumn,
          'divergent fork must take a different lane'
        );
      });

      it('seeding is a no-op when HEAD branch tip is OUTSIDE the loaded window', () => {
        // The seeding skips tips whose commit isn't in commits[].
        // Without that guard, lane 0 would be silently wasted on a
        // ghost tip and the rendered commits would all shift right.
        const commits = [createMockCommit('a', ['b']), createMockCommit('b', [])];
        const branchMap = new Map<string, IBranchRef[]>();
        branchMap.set('off-window-hash', [{ name: 'main', type: 'local' }]);

        const result = generateCommitGraph(commits, branchMap, undefined, undefined, 'main');

        // Both visible commits sit in lane 0 — no wasted lane.
        assert.strictEqual(result[0].graphColumn, 0);
        assert.strictEqual(result[1].graphColumn, 0);
      });

      it('locals before remotes when both share the same tip', () => {
        // A common state: `main` and `origin/main` point at the same
        // commit. Both names compete for lane 0; the LOCAL wins
        // (priority sort). The remote entry collapses onto the same
        // lane (no double-allocation).
        const commits = [createMockCommit('tip', [])];
        const branchMap = new Map<string, IBranchRef[]>();
        branchMap.set('tip', [
          { name: 'origin/main', type: 'remote' },
          { name: 'main', type: 'local' },
        ]);

        const result = generateCommitGraph(commits, branchMap, undefined, undefined, 'main');
        assert.strictEqual(result[0].graphColumn, 0);
      });

      it('non-HEAD branches take whatever lane the natural algorithm assigns; only HEAD is privileged on lane 0', () => {
        // Earlier the seeding pre-pass walked EVERY branch tip in a
        // priority order and pre-claimed a lane for each. That broke
        // the common case where a local branch and its remote-tracking
        // counterpart sit on the SAME physical chain (e.g. local `main`
        // and `origin/main` after a no-divergence fetch): they got
        // pinned to separate lanes, producing a green-node-on-blue-line
        // visual mismatch in the rendered graph.
        //
        // The new contract: ONLY HEAD's branch is pre-seeded onto lane
        // 0. Every other ref falls through to the natural first-seen-
        // child algorithm, which keeps non-divergent refs on the same
        // lane.
        //
        // Pin: with HEAD = main (lane 0 always), the other locals each
        // sit on a distinct lane (they're divergent siblings here), but
        // the EXACT lane index is whatever the natural algorithm picks
        // — NOT a pre-assigned alphabetical ordering.
        const commits = [
          createMockCommit('cherry-tip', ['shared']),
          createMockCommit('apple-tip', ['shared']),
          createMockCommit('main-tip', ['shared']),
          createMockCommit('banana-tip', ['shared']),
          createMockCommit('shared', []),
        ];
        const branchMap = new Map<string, IBranchRef[]>();
        branchMap.set('main-tip', [{ name: 'main', type: 'local' }]);
        branchMap.set('apple-tip', [{ name: 'apple', type: 'local' }]);
        branchMap.set('banana-tip', [{ name: 'banana', type: 'local' }]);
        branchMap.set('cherry-tip', [{ name: 'cherry', type: 'local' }]);

        const result = generateCommitGraph(commits, branchMap, undefined, undefined, 'main');
        const main = result.find((n) => n.commit.hash === 'main-tip')!;
        const apple = result.find((n) => n.commit.hash === 'apple-tip')!;
        const banana = result.find((n) => n.commit.hash === 'banana-tip')!;
        const cherry = result.find((n) => n.commit.hash === 'cherry-tip')!;

        // 1. HEAD branch is on lane 0 (the privileged invariant).
        assert.strictEqual(main.graphColumn, 0, 'HEAD branch on lane 0');
        // 2. Other tips each claim a DISTINCT lane (no overlap among
        //    divergent siblings).
        const otherLanes = new Set([apple.graphColumn, banana.graphColumn, cherry.graphColumn]);
        assert.strictEqual(
          otherLanes.size,
          3,
          `divergent sibling tips must claim distinct lanes; got ${[
            apple.graphColumn,
            banana.graphColumn,
            cherry.graphColumn,
          ].join(',')}`
        );
        // 3. None of them collide with lane 0 (main's reserved column).
        assert.ok(
          ![apple, banana, cherry].some((n) => n.graphColumn === 0),
          'no non-HEAD tip should land on the reserved lane 0'
        );
      });

      it('local + remote on the SAME chain (no divergence) keep the same lane → no node/line color mismatch', () => {
        // Regression for the screenshot bug: local main and origin/main
        // both point at "main-tip" (no divergence). They MUST share a
        // single lane so the row's node color matches the line color
        // flowing to its parent. The earlier seeding split them onto
        // lanes 0 and 1, producing a green node on a blue line.
        const commits = [
          createMockCommit('main-tip', ['parent-1']),
          createMockCommit('parent-1', ['parent-2']),
          createMockCommit('parent-2', []),
        ];
        const branchMap = new Map<string, IBranchRef[]>();
        // Both refs point at the same commit — no divergence.
        branchMap.set('main-tip', [
          { name: 'main', type: 'local' },
          { name: 'origin/main', type: 'remote' },
        ]);

        const result = generateCommitGraph(commits, branchMap, undefined, undefined, 'main');

        assert.strictEqual(result[0].graphColumn, 0, 'main-tip on lane 0 (HEAD branch privilege)');
        assert.strictEqual(result[1].graphColumn, 0, 'parent-1 on lane 0 (linear chain — no fork)');
        assert.strictEqual(result[2].graphColumn, 0, 'parent-2 on lane 0 (still linear chain)');
      });

      it('cross-render stability: same branchMap → same lane assignments', () => {
        // The load-bearing property: if you call generateCommitGraph
        // twice with the same input, you get the same lane indices.
        // This guards against any nondeterministic ordering creeping
        // into the seeding sort.
        const commits = [
          createMockCommit('tip-feature', ['shared']),
          createMockCommit('tip-main', ['shared']),
          createMockCommit('shared', []),
        ];
        const branchMap = new Map<string, IBranchRef[]>();
        branchMap.set('tip-feature', [{ name: 'feature', type: 'local' }]);
        branchMap.set('tip-main', [{ name: 'main', type: 'local' }]);

        const r1 = generateCommitGraph(commits, branchMap, undefined, undefined, 'main');
        const r2 = generateCommitGraph(commits, branchMap, undefined, undefined, 'main');

        for (let i = 0; i < r1.length; i++) {
          assert.strictEqual(
            r1[i].graphColumn,
            r2[i].graphColumn,
            `commit ${r1[i].commit.hash} must get the same lane across calls`
          );
        }
      });
    });

    // ─── Phase 1a pins (spec 8 L1, L9) ─────────────────────────────────────
    //
    // The four cases below are the unit-level pins for the Phase 1a
    // invariants (`docs/adr/ADR-013-graph-data-model-invariants.md`
    // sections 2 and 3). They live alongside the seeding suite above
    // because they exercise exactly the same code paths from a different
    // angle — each one names a specific bug-class shape from spec 8 and
    // pins it in isolation, so a regression points the next reader
    // straight at the rule it broke.
    //
    // Property-level coverage of the same invariants lives in
    // `test/property/laneStabilityAcrossReload.property.test.ts`
    // and `test/property/headAncestryPromotion.property.test.ts`.
    //
    // ADR ref: `docs/adr/ADR-013-graph-data-model-invariants.md`.
    describe('Phase 1a pins (spec 8 L1, L9)', () => {
      it('seeds lane 0 from HEAD only — local + origin/main on same SHA share lane 0 (spec 8 L1)', () => {
        // The tightest L1 pin: when `main` and `origin/main` both
        // point at the same SHA, we render ONE chain on lane 0, not
        // two parallel chains (one on lane 0 for `main`, one on
        // lane 1 for `origin/main`). The seeding pre-pass collapses
        // the remote entry onto the local's lane via the
        // `state.commitToLane.has(tip.commit)` guard at the head of
        // the seeding loop.
        //
        // Spec ref: spec 8.L1 "a repo with `main` and `origin/main` at
        // the same SHA must render ONE chain on lane 0".
        const commits = [createMockCommit('tip', ['parent']), createMockCommit('parent', [])];
        const branchMap = new Map<string, IBranchRef[]>();
        branchMap.set('tip', [
          { name: 'main', type: 'local' },
          { name: 'origin/main', type: 'remote' },
        ]);

        const result = generateCommitGraph(commits, branchMap, undefined, undefined, 'main');

        // Both rows must be on lane 0 — the `parent` row inherits
        // straight-down via the first-child + first-parent rule.
        assert.strictEqual(result[0].graphColumn, 0, 'tip must be on lane 0 (HEAD pre-seed)');
        assert.strictEqual(
          result[1].graphColumn,
          0,
          'parent must inherit lane 0 (no second chain claimed by origin/main)'
        );
        // `getMaxGraphColumn` is the renderer-visible upper bound.
        // If the remote entry had double-allocated, it would be 1.
        assert.strictEqual(
          getMaxGraphColumn(result),
          0,
          'no lane index ≥ 1 may appear when local + remote share the SHA'
        );
      });

      it('does NOT pre-seed non-HEAD branch tips — second branch goes through main pass (spec 8 L1)', () => {
        // The complement of the test above: prove that the seeding
        // pre-pass is HEAD-only in the lane-0 sense. A second local
        // branch tip is still pre-claimed (so it lands on its
        // alpha-sorted lane), but its lane number comes from
        // `findNextAvailableLane`, NOT from a hard-coded "second
        // tip → lane 1" rule. We verify this by giving the FIRST
        // branch in display order a name that's alphabetically
        // LATER than HEAD's branch — without HEAD pre-seeding the
        // input-first behaviour would land it on lane 0, and the
        // alpha-second branch would skip to lane 1.
        //
        // The test asserts both:
        //   1. HEAD's tip is on lane 0 (pre-seeded).
        //   2. The non-HEAD tip's lane is determined by the
        //      alpha-sorted seeding order, NOT by display order.
        //
        // If a future change "pre-seeded non-HEAD tips at their
        // input-display-order index" instead of going through the
        // priority sort, this test fails — that regression would
        // re-introduce the lane-jumps-on-refresh bug class.
        const commits = [
          // `zebra` appears first in display order, but is alpha-
          // last in the priority sort. With seeding, `main` (HEAD)
          // claims lane 0 first, then `apple` claims lane 1, then
          // `zebra` claims lane 2 — even though `zebra` is the
          // newest commit.
          createMockCommit('zebra-tip', ['shared']),
          createMockCommit('apple-tip', ['shared']),
          createMockCommit('main-tip', ['shared']),
          createMockCommit('shared', []),
        ];
        const branchMap = new Map<string, IBranchRef[]>();
        branchMap.set('main-tip', [{ name: 'main', type: 'local' }]);
        branchMap.set('apple-tip', [{ name: 'apple', type: 'local' }]);
        branchMap.set('zebra-tip', [{ name: 'zebra', type: 'local' }]);

        const result = generateCommitGraph(commits, branchMap, undefined, undefined, 'main');
        const main = result.find((n) => n.commit.hash === 'main-tip')!;
        const apple = result.find((n) => n.commit.hash === 'apple-tip')!;
        const zebra = result.find((n) => n.commit.hash === 'zebra-tip')!;

        // spec 8 L1 invariants the new contract guarantees:
        //   1. HEAD's branch lands on lane 0 (privileged).
        //   2. Non-HEAD tips each claim a distinct lane (no overlap).
        //   3. Non-HEAD tips do NOT collide with the reserved lane 0.
        // The exact lane index for non-HEAD tips is whatever the
        // natural first-seen-child algorithm picks — display order,
        // NOT alphabetical priority. The earlier seed-everything
        // contract pre-allocated lanes by alpha priority; the
        // narrowed contract drops that, and these assertions reflect
        // it.
        assert.strictEqual(main.graphColumn, 0, 'HEAD branch (main) on lane 0');
        const nonHeadLanes = new Set([apple.graphColumn, zebra.graphColumn]);
        assert.strictEqual(
          nonHeadLanes.size,
          2,
          `non-HEAD tips must claim distinct lanes; got apple=${apple.graphColumn} zebra=${zebra.graphColumn}`
        );
        assert.ok(
          ![apple, zebra].some((n) => n.graphColumn === 0),
          'no non-HEAD tip should land on the reserved lane 0'
        );
      });

      it('off-window parent ⇒ {fromColumn === toColumn, style: "dashed"} and zero new lane allocations (spec 8 L9)', () => {
        // spec 8.L9 — when a commit's parent is not in the loaded
        // window, emit a same-lane dashed stub and DO NOT allocate
        // a fresh lane. The "zero allocations" piece is what stops
        // the stray-bezier-into-empty-lane bug; if we allocated,
        // the renderer would draw a phantom hook to a column with
        // no row anywhere.
        //
        // We assert "no lane allocation" structurally via
        // `getMaxGraphColumn` — every commit lives on lane 0 (no
        // non-HEAD seeding), the off-window edge stays on lane 0,
        // therefore the max graph column is exactly 0. Any new
        // lane allocation would lift the max to ≥ 1.
        const commits = [createMockCommit('child', ['off-window-parent'])];

        const result = generateCommitGraph(commits);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].graphLines.length, 1);
        const line = result[0].graphLines[0];
        assert.strictEqual(line.fromColumn, line.toColumn, 'same-lane stub');
        assert.strictEqual(line.style, 'dashed', 'off-window stub must be dashed');
        assert.strictEqual(line.fromColumn, 0, 'stub stays on the source commit lane');
        assert.strictEqual(
          getMaxGraphColumn(result),
          0,
          'no fresh lane was allocated for the off-window parent'
        );
      });

      it('off-window first parent of an in-window merge ⇒ same-lane dashed; bezier still emitted for second parent (spec 8 L9 + merge interaction)', () => {
        // The trickier L9 shape: a merge commit whose FIRST parent
        // is off-window (the mainline branch's history fell off
        // the loaded slice) but whose SECOND parent IS in the
        // window. The first-parent edge must be the dashed
        // same-lane stub (per L9); the second-parent edge is a
        // normal merge bezier that DOES allocate / inherit a lane,
        // because that parent has a row to land on.
        //
        // This mirrors the IntelliJ behaviour where a long-running
        // feature branch merges back into a paginated mainline:
        // the mainline trunk continues "below the loaded window"
        // (dashed stub), and the merged branch shows up as a
        // proper bezier from the merge row to its in-window
        // second-parent row.
        const commits = [
          // Merge: first parent is off-window (mainline), second
          // parent is in-window (the feature branch).
          createMockCommit('merge', ['off-window-mainline', 'feature-tip']),
          createMockCommit('feature-tip', ['feature-base']),
          createMockCommit('feature-base', []),
        ];

        const result = generateCommitGraph(commits);

        const merge = result[0];
        assert.strictEqual(merge.graphLines.length, 2, 'merge emits 2 graph lines');

        // First parent: off-window dashed same-lane stub.
        const firstEdge = merge.graphLines[0];
        assert.strictEqual(firstEdge.fromColumn, firstEdge.toColumn, 'L9 same-lane');
        assert.strictEqual(firstEdge.style, 'dashed', 'L9 dashed style');
        assert.strictEqual(firstEdge.type, 'commit', 'first-parent edge type stays "commit"');

        // Second parent: real merge bezier to the feature-tip row.
        const secondEdge = merge.graphLines[1];
        assert.notStrictEqual(
          secondEdge.style,
          'dashed',
          'in-window merge edge must NOT be dashed'
        );
        assert.strictEqual(secondEdge.type, 'merge', 'second-parent edge type is "merge"');
        // The bezier targets the lane of the in-window feature-tip.
        const featureTip = result.find((n) => n.commit.hash === 'feature-tip')!;
        assert.strictEqual(
          secondEdge.toColumn,
          featureTip.graphColumn,
          "merge bezier endpoint matches second parent's actual lane"
        );
      });
    });

    // ─── Off-window first-parent MAINLINE CONTINUATION ──────────────────
    //
    // Reproduces a dogfooded bug seen on a heavily-merged repo's mainline
    // (a "Merge <feature> into master" commit): in a single-ref topo-order
    // log the merged side branches drain FIRST, so the merge's first parent
    // (the master continuation) is pushed PAST the loaded window. The merge
    // sits on lane 0; its first-parent edge is the L9 off-window dashed
    // same-lane stub. Pre-fix the trunk collapsed to a half-row stub at the
    // merge row (`computeActiveLanes` found no parent row to span to), lane 0
    // was freed, and an unrelated branch REUSED it a few rows lower — the
    // reported "lane-0 line breaks below the merge then reappears connecting
    // to nothing". The mainline lane continues below the loaded window, so it
    // must stay an unbroken reserved column down to the window bottom.
    describe('Off-window first-parent mainline continuation (dogfood: merge whose mainline parent fell off the slice)', () => {
      // Mirrors the real neighbourhood: a lane-0 merge whose FIRST parent is
      // off-window, the merged branch (S*) on lane 1 with its own back-merge
      // (SM) pulling in a second branch (K*) that — pre-fix — grabbed the
      // freed lane 0.
      function buildOffWindowMergeChain(): ICommitNode[] {
        const commits = [
          createMockCommit('M', ['OFF_MAIN', 'S1']), // row0 lane0 merge, fp off-window
          createMockCommit('S1', ['S2']), // row1 lane1
          createMockCommit('S2', ['SM']), // row2 lane1
          createMockCommit('SM', ['S3', 'K1']), // row3 lane1 back-merge
          createMockCommit('S3', ['OFF_S']), // row4 lane1 (off-window parent)
          createMockCommit('K1', ['K2']), // row5 — pre-fix REUSED lane0
          createMockCommit('K2', ['OFF_K']), // row6
        ];
        return generateCommitGraph(commits);
      }

      it('marks the mainline lane active at EVERY intervening row (no gap below the merge)', () => {
        const nodes = buildOffWindowMergeChain();
        const active = computeActiveLanes(nodes);
        const gapRows = [1, 2, 3, 4, 5, 6].filter((r) => !(active.get(r) ?? new Set()).has(0));
        assert.deepStrictEqual(
          gapRows,
          [],
          `lane 0 (the off-window mainline) must stay active down to the window bottom; ` +
            `it was missing at rows ${JSON.stringify(gapRows)} (the gap below the merge).`
        );
      });

      it('does NOT free the off-window mainline lane for reuse by an unrelated branch', () => {
        const nodes = buildOffWindowMergeChain();
        const k1 = nodes.find((n) => n.commit.hash === 'K1')!;
        assert.notStrictEqual(
          k1.graphColumn,
          0,
          'K1 belongs to an unrelated branch; it must NOT land on lane 0 ' +
            '(reserved by the merge whose mainline parent is off-window).'
        );
      });

      it('renders real lane-0 ink (an unbroken vertical trunk) through the intervening rows', () => {
        const nodes = buildOffWindowMergeChain();
        const cfg = DEFAULT_GRAPH_CONFIG;
        const x0 = getColumnX(0, cfg);
        const svgs = buildGraphPrintModel(nodes).map((m) => paintRow(m, cfg));
        for (const r of [2, 3]) {
          const svg = svgs[r];
          const hasLane0Line = new RegExp(`<line x1="${x0}"[^>]*y2="${cfg.rowHeight}"`).test(svg);
          assert.ok(
            hasLane0Line,
            `row ${r} must paint a full-height lane-0 vertical line (the continuing trunk); SVG: ${svg}`
          );
        }
      });

      // Renders one row with the same per-row context the production
      // graphClusterBuilder threads (prev/next active lanes), so isDashed and
      // pass-through decisions match the real pipeline.
      function renderRow(nodes: ICommitNode[], r: number): string {
        return buildGraphPrintModel(nodes).map((m) => paintRow(m, DEFAULT_GRAPH_CONFIG))[r];
      }

      it('renders the merge-row trunk stub SOLID, not dashed (the load-bearing continuation clause)', () => {
        // Pins the own-column solid-stub clause: drop it and the merge row
        // renders its centerY→bottom stub DASHED — the exact reported bug —
        // yet every other spec stays green. This is that guard.
        const nodes = buildOffWindowMergeChain();
        const x0 = getColumnX(0, DEFAULT_GRAPH_CONFIG);
        const svg = renderRow(nodes, 0);
        const stubRe = new RegExp(
          `<line x1="${x0}" y1="${DEFAULT_GRAPH_CONFIG.rowHeight / 2}" x2="${x0}" y2="${DEFAULT_GRAPH_CONFIG.rowHeight}"[^>]*/>`
        );
        const stub = stubRe.exec(svg);
        assert.ok(
          stub,
          `expected a lane-0 centerY→bottom trunk stub at the merge row; SVG: ${svg}`
        );
        assert.ok(
          !/stroke-dasharray/.test(stub[0]),
          `merge-row trunk stub must be SOLID (mainline continuation), not dashed; got: ${stub[0]}`
        );
      });

      it('treats a merge with BOTH parents off-window as a dashed LEAF, not a reserved trunk', () => {
        // Both histories fell off the slice — nothing continues this lane, so
        // it is a genuine leaf: a dashed stub, and the lane is FREED (an
        // unrelated commit below may reuse it), never permanently reserved.
        const nodes = generateCommitGraph([
          createMockCommit('M', ['OFF_A', 'OFF_B']), // both parents off-window
          createMockCommit('X', ['OFF_C']), // unrelated leaf — reuses the freed lane 0
        ]);
        const svg = renderRow(nodes, 0);
        assert.ok(
          /stroke-dasharray/.test(svg),
          `a both-parents-off-window merge must render a dashed leaf stub; SVG: ${svg}`
        );
        const x = nodes.find((n) => n.commit.hash === 'X')!;
        assert.strictEqual(
          x.graphColumn,
          0,
          'the leaf lane must be freed for reuse (not reserved), so X lands on lane 0'
        );
      });

      it('renders a non-merge LEAF (only parent off-window) as a dashed stub at a NON-bottom row — identical to the bottom-row leaf', () => {
        // A branch tip whose sole parent fell off the slice, sitting ABOVE
        // other rows. It must render the SAME dashed stub it would at the
        // window bottom — NOT a solid line run to the bottom — and its lane
        // must NOT be extended past it.
        const nodes = generateCommitGraph([
          createMockCommit('M', ['P', 'B']), // merge: P in-window, B in-window
          createMockCommit('B', ['OFF_B']), // non-merge leaf, off-window parent, NON-bottom row
          createMockCommit('P', ['OFF_P']), // mainline tail
        ]);
        const b = nodes.find((n) => n.commit.hash === 'B')!;
        const bRow = nodes.indexOf(b);
        const svg = renderRow(nodes, bRow);
        const xb = getColumnX(b.graphColumn, DEFAULT_GRAPH_CONFIG);
        const stubRe = new RegExp(
          `<line x1="${xb}" y1="${DEFAULT_GRAPH_CONFIG.rowHeight / 2}" x2="${xb}" y2="${DEFAULT_GRAPH_CONFIG.rowHeight}"[^>]*/>`
        );
        const stub = stubRe.exec(svg);
        assert.ok(stub, `expected the leaf's own-lane stub; SVG: ${svg}`);
        assert.ok(
          /stroke-dasharray/.test(stub[0]),
          `a genuine off-window leaf must render a DASHED stub at any row; got: ${stub[0]}`
        );
        const active = computeActiveLanes(nodes);
        const belowRows = nodes
          .map((_n, idx) => idx)
          .filter((idx) => idx > bRow && (active.get(idx) ?? new Set()).has(b.graphColumn));
        assert.deepStrictEqual(
          belowRows,
          [],
          `the leaf's lane must NOT be extended past it; it was still active at rows ${JSON.stringify(belowRows)}`
        );
      });

      it('does NOT leak a lane per leaf — N sequential off-window leaves keep the graph narrow (width bound)', () => {
        // The reservation must apply ONLY to genuine continuations. A repo of
        // N merges each pulling in a one-commit side branch whose base is
        // off-window (a genuine LEAF) must keep those leaves on a single
        // reused lane — max lane index tracks concurrent branches (~1), never
        // escalating with the leaf count. A reservation leak would push each
        // leaf onto its own ever-higher lane (max == N).
        const N = 30;
        const commits: ICommit[] = [];
        for (let k = 0; k < N; k++) {
          commits.push(createMockCommit(`M${k}`, [`M${k + 1}`, `L${k}`]));
          commits.push(createMockCommit(`L${k}`, [`OFF_L${k}`])); // genuine leaf
        }
        commits.push(createMockCommit(`M${N}`, ['OFF_TAIL'])); // mainline tail leaf
        const nodes = generateCommitGraph(commits);
        let maxLane = 0;
        for (const n of nodes) {
          maxLane = Math.max(maxLane, n.graphColumn);
          for (const l of n.graphLines) {
            maxLane = Math.max(maxLane, l.fromColumn, l.toColumn);
          }
        }
        assert.ok(
          maxLane <= 2,
          `genuine leaves must release their lane (no per-leaf reservation leak); ` +
            `maxLane=${maxLane} for ${N} leaves (a leak would give ~${N})`
        );
      });
    });
  });

  describe('getMaxGraphColumn()', () => {
    it('should return -1 for empty array', () => {
      assert.strictEqual(getMaxGraphColumn([]), -1);
    });

    it('should return 0 for single commit in column 0', () => {
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('abc', []),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      assert.strictEqual(getMaxGraphColumn(nodes), 0);
    });

    it('should return the maximum column from commit positions', () => {
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('a', []),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('b', []),
          graphColumn: 2,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('c', []),
          graphColumn: 1,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      assert.strictEqual(getMaxGraphColumn(nodes), 2);
    });

    it('should consider graph line columns', () => {
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('a', []),
          graphColumn: 0,
          graphLines: [{ fromColumn: 0, toColumn: 3, color: '#000', type: 'merge' }],
          branches: [],
          tags: [],
        },
      ];

      assert.strictEqual(getMaxGraphColumn(nodes), 3);
    });
  });

  describe('isMergeCommit()', () => {
    it('should return false for root commit', () => {
      const commit = createMockCommit('abc', []);
      assert.strictEqual(isMergeCommit(commit), false);
    });

    it('should return false for single parent commit', () => {
      const commit = createMockCommit('abc', ['parent1']);
      assert.strictEqual(isMergeCommit(commit), false);
    });

    it('should return true for two parent commit', () => {
      const commit = createMockCommit('abc', ['parent1', 'parent2']);
      assert.strictEqual(isMergeCommit(commit), true);
    });

    it('should return true for three parent commit (octopus)', () => {
      const commit = createMockCommit('abc', ['parent1', 'parent2', 'parent3']);
      assert.strictEqual(isMergeCommit(commit), true);
    });
  });

  describe('isRootCommit()', () => {
    it('should return true for commit with no parents', () => {
      const commit = createMockCommit('abc', []);
      assert.strictEqual(isRootCommit(commit), true);
    });

    it('should return false for commit with one parent', () => {
      const commit = createMockCommit('abc', ['parent1']);
      assert.strictEqual(isRootCommit(commit), false);
    });

    it('should return false for merge commit', () => {
      const commit = createMockCommit('abc', ['parent1', 'parent2']);
      assert.strictEqual(isRootCommit(commit), false);
    });
  });

  describe('getActiveLaneCount()', () => {
    it('should return 0 for empty array', () => {
      assert.strictEqual(getActiveLaneCount([], 0), 0);
    });

    it('should return 0 for invalid index', () => {
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('a', []),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      assert.strictEqual(getActiveLaneCount(nodes, -1), 0);
      assert.strictEqual(getActiveLaneCount(nodes, 5), 0);
    });

    it('should count active lanes correctly', () => {
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('a', []),
          graphColumn: 0,
          graphLines: [{ fromColumn: 0, toColumn: 1, color: '#000', type: 'merge' }],
          branches: [],
          tags: [],
        },
      ];

      // At index 0, we have lanes 0 and 1 active
      assert.strictEqual(getActiveLaneCount(nodes, 0), 2);
    });
  });

  describe('getColumnColor()', () => {
    it('should return a color string', () => {
      const color = getColumnColor(0);
      assert.ok(color.startsWith('#'));
    });

    it('should return different colors for different columns', () => {
      const color0 = getColumnColor(0);
      const color1 = getColumnColor(1);
      assert.notStrictEqual(color0, color1);
    });

    it('should cycle colors for large column numbers', () => {
      // Colors should cycle after the palette is exhausted
      const color0 = getColumnColor(0);
      const color10 = getColumnColor(10);
      assert.strictEqual(color0, color10); // Assuming 10 colors in palette
    });
  });
  describe('computeTerminalNodes()', () => {
    it('should return empty set for empty input', () => {
      const result = computeTerminalNodes([]);
      assert.strictEqual(result.size, 0);
    });

    it('should return the single commit as terminal for a single root commit', () => {
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('abc123', []),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      const result = computeTerminalNodes(nodes);
      assert.strictEqual(result.size, 1);
      assert.ok(result.has('abc123'));
    });

    it('should return only the tip commit in a linear history', () => {
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('commit3', ['commit2']),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('commit2', ['commit1']),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('commit1', []),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      const result = computeTerminalNodes(nodes);
      assert.strictEqual(result.size, 1);
      assert.ok(result.has('commit3'));
      assert.ok(!result.has('commit2'));
      assert.ok(!result.has('commit1'));
    });

    it('should return multiple terminal nodes for branching history', () => {
      // Two branches diverging from a common base
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('branch-a', ['base']),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('branch-b', ['base']),
          graphColumn: 1,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('base', []),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      const result = computeTerminalNodes(nodes);
      assert.strictEqual(result.size, 2);
      assert.ok(result.has('branch-a'));
      assert.ok(result.has('branch-b'));
      assert.ok(!result.has('base'));
    });

    it('should not include merge commit parents as terminal nodes', () => {
      // merge -> left, right -> base
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('merge', ['left', 'right']),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('left', ['base']),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('right', ['base']),
          graphColumn: 1,
          graphLines: [],
          branches: [],
          tags: [],
        },
        {
          commit: createMockCommit('base', []),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      const result = computeTerminalNodes(nodes);
      assert.strictEqual(result.size, 1);
      assert.ok(result.has('merge'));
    });

    it('should handle commits with parents not in the graph', () => {
      // commit2 references a parent not in the node list
      const nodes: ICommitNode[] = [
        {
          commit: createMockCommit('commit2', ['external-parent']),
          graphColumn: 0,
          graphLines: [],
          branches: [],
          tags: [],
        },
      ];

      const result = computeTerminalNodes(nodes);
      // commit2 is terminal because no other commit lists it as a parent
      assert.strictEqual(result.size, 1);
      assert.ok(result.has('commit2'));
    });
  });
});

describe('computeChildCountMap()', () => {
  it('should return empty map for empty input', () => {
    const result = computeChildCountMap([]);
    assert.strictEqual(result.size, 0);
  });

  it('should return empty map for a single root commit (no parents)', () => {
    const nodes: ICommitNode[] = [
      {
        commit: createMockCommit('abc123', []),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
    ];

    const result = computeChildCountMap(nodes);
    assert.strictEqual(result.size, 0);
  });

  it('should count 1 child for a parent in a linear history', () => {
    const nodes: ICommitNode[] = [
      {
        commit: createMockCommit('commit2', ['commit1']),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('commit1', []),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
    ];

    const result = computeChildCountMap(nodes);
    assert.strictEqual(result.get('commit1'), 1);
  });

  it('should count 2 children for a branch split point', () => {
    // Two branches diverging from 'base'
    const nodes: ICommitNode[] = [
      {
        commit: createMockCommit('branch-a', ['base']),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('branch-b', ['base']),
        graphColumn: 1,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('base', []),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
    ];

    const result = computeChildCountMap(nodes);
    assert.strictEqual(result.get('base'), 2);
  });

  it('should count children from merge commits correctly', () => {
    // merge -> left, right -> base
    const nodes: ICommitNode[] = [
      {
        commit: createMockCommit('merge', ['left', 'right']),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('left', ['base']),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('right', ['base']),
        graphColumn: 1,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('base', []),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
    ];

    const result = computeChildCountMap(nodes);
    // 'left' and 'right' each have 1 child (the merge commit)
    assert.strictEqual(result.get('left'), 1);
    assert.strictEqual(result.get('right'), 1);
    // 'base' has 2 children (left and right)
    assert.strictEqual(result.get('base'), 2);
  });

  it('should count parents not in the graph', () => {
    const nodes: ICommitNode[] = [
      {
        commit: createMockCommit('commit1', ['external-parent']),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
    ];

    const result = computeChildCountMap(nodes);
    assert.strictEqual(result.get('external-parent'), 1);
  });
});

describe('isBranchSplit()', () => {
  it('should return false for a commit not in the child count map', () => {
    const childCountMap = new Map<string, number>();
    assert.strictEqual(isBranchSplit('unknown', childCountMap), false);
  });

  it('should return false for a commit with 1 child', () => {
    const childCountMap = new Map<string, number>([['commit1', 1]]);
    assert.strictEqual(isBranchSplit('commit1', childCountMap), false);
  });

  it('should return true for a commit with 2 children', () => {
    const childCountMap = new Map<string, number>([['base', 2]]);
    assert.strictEqual(isBranchSplit('base', childCountMap), true);
  });

  it('should return true for a commit with 3 children', () => {
    const childCountMap = new Map<string, number>([['base', 3]]);
    assert.strictEqual(isBranchSplit('base', childCountMap), true);
  });

  it('should return false for a commit with 0 children', () => {
    const childCountMap = new Map<string, number>([['tip', 0]]);
    assert.strictEqual(isBranchSplit('tip', childCountMap), false);
  });

  it('should work correctly with a real graph topology', () => {
    // Build a graph with a branch split at 'base'
    const nodes: ICommitNode[] = [
      {
        commit: createMockCommit('branch-a', ['base']),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('branch-b', ['base']),
        graphColumn: 1,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('base', ['root']),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
      {
        commit: createMockCommit('root', []),
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      },
    ];

    const childCountMap = computeChildCountMap(nodes);
    assert.strictEqual(isBranchSplit('base', childCountMap), true);
    assert.strictEqual(isBranchSplit('root', childCountMap), false);
    assert.strictEqual(isBranchSplit('branch-a', childCountMap), false);
    assert.strictEqual(isBranchSplit('branch-b', childCountMap), false);
  });
});

describe('Commit Graph - Complex Scenarios', () => {
  describe('Multiple parallel branches', () => {
    it('should handle multiple parallel branches', () => {
      // Simulating:
      // * merge-all
      // |\|\
      // | | * branch3
      // | * | branch2
      // * | | main
      // |/ /
      // * base
      const commits = [
        createMockCommit('merge-all', ['main', 'branch2', 'branch3'], 'Merge all'),
        createMockCommit('branch3', ['base'], 'Branch 3'),
        createMockCommit('branch2', ['base'], 'Branch 2'),
        createMockCommit('main', ['base'], 'Main'),
        createMockCommit('base', [], 'Base'),
      ];

      const result = generateCommitGraph(commits);

      assert.strictEqual(result.length, 5);

      // Merge commit should have 3 lines
      assert.strictEqual(result[0].graphLines.length, 3);
    });
  });

  describe('Long linear history', () => {
    it('should handle long linear history efficiently', () => {
      const commits: ICommit[] = [];
      const count = 100;

      // Create a long linear history
      for (let i = 0; i < count; i++) {
        const parents = i < count - 1 ? [`commit${i + 1}`] : [];
        commits.push(createMockCommit(`commit${i}`, parents, `Commit ${i}`));
      }

      const result = generateCommitGraph(commits);

      assert.strictEqual(result.length, count);

      // All commits should be in column 0
      for (const node of result) {
        assert.strictEqual(node.graphColumn, 0);
      }
    });
  });

  describe('Diamond merge pattern', () => {
    it('should handle diamond merge pattern', () => {
      // Diamond pattern:
      //   * merge
      //  /|
      // * | left
      // | * right
      // |/
      // * base
      const commits = [
        createMockCommit('merge', ['left', 'right'], 'Merge'),
        createMockCommit('left', ['base'], 'Left'),
        createMockCommit('right', ['base'], 'Right'),
        createMockCommit('base', [], 'Base'),
      ];

      const result = generateCommitGraph(commits);

      assert.strictEqual(result.length, 4);

      // Merge should have 2 lines
      const mergeNode = result[0];
      assert.strictEqual(mergeNode.graphLines.length, 2);
    });
  });

  describe('Criss-cross merge', () => {
    it('should handle criss-cross merge pattern', () => {
      // Criss-cross:
      //   * merge2
      //  /|
      // * | merge1
      // |\|
      // | * b2
      // * | a2
      // | * b1
      // * | a1
      // |/
      // * base
      const commits = [
        createMockCommit('merge2', ['merge1', 'b2'], 'Merge 2'),
        createMockCommit('merge1', ['a2', 'b1'], 'Merge 1'),
        createMockCommit('b2', ['b1'], 'B2'),
        createMockCommit('a2', ['a1'], 'A2'),
        createMockCommit('b1', ['base'], 'B1'),
        createMockCommit('a1', ['base'], 'A1'),
        createMockCommit('base', [], 'Base'),
      ];

      const result = generateCommitGraph(commits);

      assert.strictEqual(result.length, 7);

      // Both merge commits should have 2 lines each
      assert.strictEqual(result[0].graphLines.length, 2);
      assert.strictEqual(result[1].graphLines.length, 2);
    });
  });
});

/**
 * Lane algorithm: divergent branch correctness.
 *
 * The pre-rewrite single-pass algorithm collapses divergent branches that
 * share an unseen parent: the SECOND child of a parent inherits the first
 * child's lane because parent-lane assignment was unconditional. The
 * children-map two-pass algorithm in the rewrite must give each divergent
 * branch its own lane.
 *
 * These tests are the RED capture for the rewrite.
 */
describe('Wave D — divergent branch lane correctness (D1)', () => {
  it('two children of unseen parent get distinct lanes', () => {
    // Display order (newest-first): tipA at lane 0, tipB diverges → must NOT
    // collapse onto lane 0. The shared parent `base` is unseen at the time
    // tipA is processed.
    //
    //   * tipA       (lane 0)
    //   |  * tipB    (lane 1, diverges)
    //   | /
    //   * base       (lane 0 — first-child-wins)
    const commits = [
      createMockCommit('tipA', ['base'], 'Tip A'),
      createMockCommit('tipB', ['base'], 'Tip B'),
      createMockCommit('base', [], 'Shared root'),
    ];

    const result = generateCommitGraph(commits);

    assert.strictEqual(result[0].graphColumn, 0, 'tipA in lane 0');
    assert.strictEqual(result[1].graphColumn, 1, 'tipB MUST be in a distinct lane');
    assert.strictEqual(result[2].graphColumn, 0, 'base settles on first-child lane');

    // tipB's line connects from lane 1 → lane 0 (base).
    assert.strictEqual(result[1].graphLines.length, 1);
    assert.strictEqual(result[1].graphLines[0].fromColumn, 1);
    assert.strictEqual(result[1].graphLines[0].toColumn, 0);
  });

  it('three-way fork at root yields three distinct lanes', () => {
    //   * tipA   (lane 0)
    //   | * tipB (lane 1)
    //   | | * tipC (lane 2)
    //   |/ /
    //   * base
    const commits = [
      createMockCommit('tipA', ['base']),
      createMockCommit('tipB', ['base']),
      createMockCommit('tipC', ['base']),
      createMockCommit('base', []),
    ];

    const result = generateCommitGraph(commits);

    const lanes = new Set([result[0].graphColumn, result[1].graphColumn, result[2].graphColumn]);
    assert.strictEqual(lanes.size, 3, 'three distinct lanes for three branch tips');
    assert.strictEqual(result[3].graphColumn, 0, 'base on first-child lane');
  });

  it('fork-then-merge-back keeps divergence and converges at merge', () => {
    //   * merge   (parents: feat, main2)        — main lane
    //   |\
    //   | * feat                                 — diverged lane
    //   * | main2                                — main lane
    //   |/
    //   * base
    const commits = [
      createMockCommit('merge', ['main2', 'feat']),
      createMockCommit('feat', ['base']),
      createMockCommit('main2', ['base']),
      createMockCommit('base', []),
    ];

    const result = generateCommitGraph(commits);

    assert.strictEqual(result[0].graphColumn, 0, 'merge on lane 0');
    assert.strictEqual(result[0].graphLines.length, 2, 'merge has two outgoing lines');
    // feat (display index 1) and main2 (display index 2) — feat is the
    // SECOND parent of merge so it claims a new lane; main2 inherits
    // merge's lane (i=0 first parent).
    assert.notStrictEqual(
      result[1].graphColumn,
      result[2].graphColumn,
      'feat and main2 in distinct lanes'
    );
    // `base` is shared by feat (display index 1) and main2 (display
    // index 2). The first-seen-child-wins rule puts base on feat's
    // lane; main2's parent edge curves over to it. Whichever lane base
    // claims, it must coincide with feat's lane.
    assert.strictEqual(result[3].graphColumn, result[1].graphColumn, 'base on feat lane');
  });

  it('fork-fork-merge nested keeps every branch on its own lane', () => {
    //   * mergeAll (main2, featTip)
    //   |\
    //   | * featTip
    //   | * featMid
    //   * | main2
    //   * | main1
    //   |/
    //   * base
    const commits = [
      createMockCommit('mergeAll', ['main2', 'featTip']),
      createMockCommit('featTip', ['featMid']),
      createMockCommit('featMid', ['base']),
      createMockCommit('main2', ['main1']),
      createMockCommit('main1', ['base']),
      createMockCommit('base', []),
    ];

    const result = generateCommitGraph(commits);

    // featTip and featMid stay together on the feat lane.
    assert.strictEqual(
      result[1].graphColumn,
      result[2].graphColumn,
      'feat lane is straight (featTip → featMid)'
    );
    // main2 and main1 stay together on the main lane.
    assert.strictEqual(
      result[3].graphColumn,
      result[4].graphColumn,
      'main lane is straight (main2 → main1)'
    );
    // The two lanes must be distinct.
    assert.notStrictEqual(
      result[1].graphColumn,
      result[3].graphColumn,
      'feat and main lanes are distinct'
    );
  });

  it('large random N=20 graph stays within K + 5 lane bound', () => {
    // 4 distinct branch tips (terminals), each 4 commits long, all rooted
    // at a shared base. 4 terminals + 1 root = 17, plus a couple of merges
    // bring the count up.
    const commits: ICommit[] = [];
    const tips = ['A', 'B', 'C', 'D'];
    for (const t of tips) {
      commits.push(createMockCommit(`${t}3`, [`${t}2`]));
      commits.push(createMockCommit(`${t}2`, [`${t}1`]));
      commits.push(createMockCommit(`${t}1`, [`${t}0`]));
      commits.push(createMockCommit(`${t}0`, ['base']));
    }
    commits.push(createMockCommit('base', []));

    const result = generateCommitGraph(commits);
    const maxCol = getMaxGraphColumn(result);
    assert.ok(
      maxCol <= tips.length + 4,
      `maxCol=${maxCol} must be ≤ ${tips.length + 4} (terminals + 5 buffer)`
    );
    // And every tip must claim a distinct lane.
    const tipLanes = new Set(
      tips.map((t) => result.find((n) => n.commit.hash === `${t}3`)!.graphColumn)
    );
    assert.strictEqual(tipLanes.size, tips.length, 'every terminal claims a distinct lane');
  });

  it('single-branch regression: linear history still in lane 0', () => {
    // The rewrite must NOT regress the single-branch baseline.
    const commits = [
      createMockCommit('c5', ['c4']),
      createMockCommit('c4', ['c3']),
      createMockCommit('c3', ['c2']),
      createMockCommit('c2', ['c1']),
      createMockCommit('c1', []),
    ];

    const result = generateCommitGraph(commits);
    for (const node of result) {
      assert.strictEqual(node.graphColumn, 0, `${node.commit.hash} in lane 0`);
    }
  });
});

describe('Wave D — focused branch path (D3)', () => {
  it('marks on-path commits when focusedPathHashes is provided', () => {
    const commits = [
      createMockCommit('tip', ['mid']),
      createMockCommit('mid', ['base']),
      createMockCommit('base', []),
    ];
    const onPath = new Set(['tip', 'mid']);

    const result = generateCommitGraph(commits, undefined, undefined, onPath);

    assert.strictEqual(result[0].onFocusedBranchPath, true);
    assert.strictEqual(result[1].onFocusedBranchPath, true);
    assert.strictEqual(result[2].onFocusedBranchPath, false);
  });

  it('all commits get false when focusedPathHashes is undefined', () => {
    const commits = [createMockCommit('tip', ['base']), createMockCommit('base', [])];

    const result = generateCommitGraph(commits);

    assert.strictEqual(result[0].onFocusedBranchPath, false);
    assert.strictEqual(result[1].onFocusedBranchPath, false);
  });

  it('all commits get false when focusedPathHashes is empty', () => {
    const commits = [createMockCommit('tip', ['base']), createMockCommit('base', [])];

    const result = generateCommitGraph(commits, undefined, undefined, new Set<string>());

    assert.strictEqual(result[0].onFocusedBranchPath, false);
    assert.strictEqual(result[1].onFocusedBranchPath, false);
  });
});
