/**
 * Property test — node color must match its own outgoing line color, for
 * ANY commit DAG (spec 8 L4 family).
 *
 * Reported repeatedly from real multi-branch repos: a commit rendered with
 * one color dot but a different color line leaving it (blue node + orange
 * line; green node + blue/orange lines). Hand-built unit fixtures kept
 * passing while the real graph stayed broken — the fixtures didn't match
 * the real `git log --all --topo-order` topology. A PROPERTY test fixes the
 * turnaround: it generates hundreds of random DAGs (forks + merges at
 * varying depths, branches that rejoin, HEAD anywhere) and shrinks to a
 * minimal counterexample when the invariant breaks.
 *
 * The visual contract being pinned, end-to-end through the real renderer:
 *
 *   For every commit row, the node circle's fill color
 *   (getColumnColor(node.graphColumn)) MUST equal the stroke color of the
 *   edge that LEAVES the node toward its FIRST parent — the commit's own
 *   mainline continuation. A first-parent edge is the visual spine of the
 *   commit; if it's a different color from the node, you get the reported
 *   "blue dot, orange line" artifact.
 *
 *   Merge/branch edges (2nd+ parents) are exempt — they intentionally take
 *   the merged-branch's (destination) color.
 *
 * We assert against BOTH layers:
 *   1. the algorithm's per-line `color` field on the first-parent line, and
 *   2. the actual `<path>` / `<line>` stroke the renderer emits for that
 *      first-parent edge.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  generateCommitGraph,
  getColumnColor,
  IBranchRef,
  ICommitNode,
} from '../../src/git-core/commitGraph';
import { computeActiveLanes, DEFAULT_GRAPH_CONFIG } from '../../src/utils/graphRenderer';
import { buildGraphPrintModel } from '../../src/git-core/graph/printModel';
import { paintRow } from '../../src/git-core/graph/graphPainter';
import { ICommit } from '../../src/git-core/interfaces/IGitService';

function mkCommit(hash: string, parents: string[]): ICommit {
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message: `commit ${hash}`,
    author: { name: 'a', email: 'a@a' },
    committer: { name: 'a', email: 'a@a' },
    parents,
    authorDate: new Date('2024-01-01T00:00:00Z'),
    commitDate: new Date('2024-01-01T00:00:00Z'),
  };
}

interface GenDag {
  /** Newest-first display order — what the host feeds generateCommitGraph. */
  commits: ICommit[];
  /** Branch tips: hash → names. */
  branchMap: Map<string, IBranchRef[]>;
  /** Which branch is HEAD (name), or undefined (models detached HEAD). */
  headName: string | undefined;
  /** HEAD's commit SHA (always known, even when detached). */
  headHash: string | undefined;
  /**
   * When true, the branchMap is emptied to model `getBranches` failing /
   * detached HEAD — the algorithm must still anchor the mainline via
   * headHash alone.
   */
  dropBranchMap: boolean;
}

/**
 * Random DAG arbitrary modeling real `git log --all --topo-order` output.
 *
 * Builds a linear "trunk" then sprouts side branches that fork off the
 * trunk at a random commit and either (a) dangle as their own tip, or
 * (b) merge back into a later trunk commit (creating a 2-parent merge).
 * Some trunk commits also get an off-window parent. The result is the
 * fork/merge-at-varying-depth shape the screenshots show — NOT the
 * "K branches off one root" shape the older arbitrary used.
 *
 * Output is in newest-first topological order: a commit's parents always
 * appear later in the array (or are off-window), matching --topo-order.
 */
const dagArb: fc.Arbitrary<GenDag> = fc
  .record({
    trunkLen: fc.integer({ min: 2, max: 12 }),
    // Each side branch: {forkAt (trunk index), len, mergesBack}.
    sideBranches: fc.array(
      fc.record({
        forkAt: fc.integer({ min: 0, max: 11 }),
        len: fc.integer({ min: 1, max: 4 }),
        mergesBack: fc.boolean(),
        mergeOffset: fc.integer({ min: 1, max: 4 }),
      }),
      { minLength: 0, maxLength: 4 }
    ),
    headPick: fc.integer({ min: 0, max: 10 }),
    headIsTrunk: fc.boolean(),
    // Models how HEAD identity reaches the algorithm:
    //   'name'     — branch name resolvable in branchMap (happy path)
    //   'detached' — no name (undefined), only the SHA (detached HEAD)
    //   'noBranchMap' — getBranches failed: empty branchMap, SHA only
    headMode: fc.constantFrom('name', 'detached', 'noBranchMap'),
  })
  .map(({ trunkLen, sideBranches, headPick, headIsTrunk, headMode }) => {
    // Trunk commits: T0 (newest) .. T{trunkLen-1} (oldest). Ti's parent is
    // T{i+1}; the oldest trunk commit is a root (no parents).
    // We build a parents map then emit in newest-first order.
    const parentsOf = new Map<string, string[]>();
    const trunk: string[] = [];
    for (let i = 0; i < trunkLen; i++) {
      trunk.push(`T${i}`);
    }
    for (let i = 0; i < trunkLen; i++) {
      parentsOf.set(trunk[i], i + 1 < trunkLen ? [trunk[i + 1]] : []);
    }

    // Side branches sprout from a trunk commit. Branch commits:
    // S{b}_{j}, newest j=0. The branch's oldest commit's parent is the
    // trunk fork point. Optionally a later trunk commit gains the branch
    // tip as a SECOND parent (merge).
    const branchTips: Array<{ hash: string; name: string }> = [];
    const tipNames = ['alpha', 'beta', 'gamma', 'delta'];
    sideBranches.forEach((sb, b) => {
      const forkIdx = sb.forkAt % trunkLen; // trunk commit it forks from
      const branchHashes: string[] = [];
      for (let j = 0; j < sb.len; j++) {
        branchHashes.push(`S${b}_${j}`);
      }
      // Link branch chain: S{b}_j's parent is S{b}_{j+1}; the oldest
      // (j=len-1) points at the trunk fork commit.
      for (let j = 0; j < sb.len; j++) {
        parentsOf.set(branchHashes[j], j + 1 < sb.len ? [branchHashes[j + 1]] : [trunk[forkIdx]]);
      }
      const tipHash = branchHashes[0];
      // Merge back: a trunk commit NEWER than the fork point gains the
      // branch tip as a 2nd parent. mergeAt must be < forkIdx (newer =
      // smaller index) so topo order holds (parent appears later).
      if (sb.mergesBack && forkIdx > 0) {
        const mergeAt = Math.max(0, forkIdx - (sb.mergeOffset % forkIdx || 1));
        const cur = parentsOf.get(trunk[mergeAt]) ?? [];
        // Avoid duplicate / self parent.
        if (!cur.includes(tipHash) && trunk[mergeAt] !== tipHash) {
          parentsOf.set(trunk[mergeAt], [...cur, tipHash]);
        }
      } else {
        // Dangling tip — it's a branch ref.
        branchTips.push({ hash: tipHash, name: tipNames[b] });
      }
    });

    // Emit newest-first topo order via Kahn-ish DFS from the newest trunk
    // commit + all dangling tips, ensuring parents come after children.
    // Simpler: collect all hashes, then sort so that for any edge
    // child->parent, child precedes parent. We do a DFS post-order then
    // reverse.
    const allHashes = [...parentsOf.keys()];
    const visited = new Set<string>();
    const order: string[] = [];
    const visit = (h: string): void => {
      if (visited.has(h)) {
        return;
      }
      visited.add(h);
      // Visit children first? We want newest-first; emit a node BEFORE its
      // parents. So recurse into parents, then push (post-order) gives
      // parents-first; reverse at the end → newest-first. But we must seed
      // from the newest nodes. Seeds = nodes that are no one's parent.
      for (const p of parentsOf.get(h) ?? []) {
        if (parentsOf.has(p)) {
          visit(p);
        }
      }
      order.push(h);
    };
    // Seeds: nodes that never appear as a parent (the tips, newest).
    const asParent = new Set<string>();
    for (const ps of parentsOf.values()) {
      for (const p of ps) {
        asParent.add(p);
      }
    }
    const seeds = allHashes.filter((h) => !asParent.has(h));
    for (const s of seeds) {
      visit(s);
    }
    // Any unvisited (cycles shouldn't happen) — append.
    for (const h of allHashes) {
      visit(h);
    }
    // `order` is parents-first (post-order); reverse → newest-first.
    order.reverse();

    const commits = order.map((h) => mkCommit(h, parentsOf.get(h) ?? []));

    // Branch map: trunk tip (T0) is "mainline", plus dangling side tips.
    const branchMap = new Map<string, IBranchRef[]>();
    branchMap.set('T0', [{ name: 'mainline', type: 'local' }]);
    for (const t of branchTips) {
      const existing = branchMap.get(t.hash) ?? [];
      existing.push({ name: t.name, type: 'local' });
      branchMap.set(t.hash, existing);
    }

    // HEAD: either mainline (trunk) or one of the dangling side tips.
    let headName: string | undefined = 'mainline';
    let headHashFull: string | undefined = 'T0';
    if (!headIsTrunk && branchTips.length > 0) {
      const t = branchTips[headPick % branchTips.length];
      headName = t.name;
      headHashFull = t.hash;
    }

    // Apply the HEAD-identity model:
    //   'name'        — name resolvable (happy path)
    //   'detached'    — no name, SHA only (detached HEAD)
    //   'noBranchMap' — getBranches failed: empty branchMap, SHA only
    let outBranchMap = branchMap;
    let outHeadName: string | undefined = headName;
    const dropBranchMap = headMode === 'noBranchMap';
    if (headMode === 'detached') {
      outHeadName = undefined;
    } else if (headMode === 'noBranchMap') {
      outHeadName = undefined;
      outBranchMap = new Map<string, IBranchRef[]>();
    }

    return {
      commits,
      branchMap: outBranchMap,
      headName: outHeadName,
      headHash: headHashFull,
      dropBranchMap,
    };
  });

/**
 * The renderer paints a first-parent ('commit') edge with the source-lane
 * color and a merge edge with the destination color. Recover, for a node,
 * the color the renderer actually strokes for the edge leaving toward its
 * FIRST parent — whether that edge is a straight same-lane vertical (a
 * `<line>` from centerY to bottomY) or a bending bezier (`<path>`).
 *
 * Returns the stroke color string, or undefined if the node emits no
 * first-parent edge (a root / off-window-only commit at the window bottom).
 */
function firstParentEdgeColorFromSvg(svg: string, expectedNodeColor: string): string | undefined {
  // Same-lane vertical stub: `<line ... y1="centerY" ... stroke="C" ...>`.
  // centerY = rowHeight/2 = 12 for the default config; bottomY = 24.
  const lineMatch = svg.match(
    /<line x1="[\d.]+" y1="12" x2="[\d.]+" y2="24" stroke="(#[0-9A-Fa-f]+)"/
  );
  if (lineMatch) {
    return lineMatch[1];
  }
  // Bending bezier: `<path d="M ..." stroke="C" ...>`. The first <path> is
  // the first-parent edge when the first parent bends (it's emitted in
  // graphLines order, first parent first). Fall back to scanning all paths
  // for one matching the node color is wrong (that would beg the question);
  // we take the FIRST path, which corresponds to the first graphLine.
  const pathMatch = svg.match(/<path d="[^"]*" stroke="(#[0-9A-Fa-f]+)"/);
  if (pathMatch) {
    return pathMatch[1];
  }
  void expectedNodeColor;
  return undefined;
}

describe('Property — node color equals its own first-parent line color (any DAG)', () => {
  it('algorithm: every first-parent line is colored by the node lane', () => {
    fc.assert(
      fc.property(dagArb, (dag) => {
        const nodes = generateCommitGraph(
          dag.commits,
          dag.branchMap,
          undefined,
          undefined,
          dag.headName,
          dag.headHash
        );
        for (const node of nodes) {
          const nodeColor = getColumnColor(node.graphColumn);
          // The FIRST graphLine corresponds to the first parent (the
          // algorithm emits parents in order). It is the commit's own
          // mainline-continuation edge.
          const firstLine = node.graphLines[0];
          if (!firstLine || firstLine.type !== 'commit') {
            continue; // merge-first / no line — not a first-parent spine edge
          }
          assert.strictEqual(
            firstLine.color,
            nodeColor,
            `${node.commit.hash} (lane ${node.graphColumn}): first-parent line color ` +
              `${firstLine.color} != node color ${nodeColor}. ` +
              `Line ${firstLine.fromColumn}->${firstLine.toColumn}.`
          );
        }
      }),
      { numRuns: 300 }
    );
  });

  it("HEAD's first-parent ancestry chain is a single contiguous lane-0 column (mainline stays straight)", () => {
    fc.assert(
      fc.property(dagArb, (dag) => {
        const nodes = generateCommitGraph(
          dag.commits,
          dag.branchMap,
          undefined,
          undefined,
          dag.headName,
          dag.headHash
        );
        const byHash = new Map<string, ICommitNode>(nodes.map((n) => [n.commit.hash, n]));
        // HEAD's tip is the headHash directly (always known, even when the
        // branch name is unresolvable — detached / getBranches failure).
        const headTip: string | undefined = dag.headHash;
        if (headTip === undefined || !byHash.has(headTip)) {
          return; // HEAD off-window — nothing to assert
        }
        // Walk HEAD's first-parent chain through the window. Every commit
        // on it MUST be on lane 0 — that's the mainline spine. A mainline
        // commit on a side lane is the reported "mainline commit popped out
        // to an orange/purple lane" artifact.
        let cur: string | undefined = headTip;
        const guard = new Set<string>();
        while (cur !== undefined && byHash.has(cur) && !guard.has(cur)) {
          guard.add(cur);
          const n: ICommitNode | undefined = byHash.get(cur);
          if (n === undefined) {
            break;
          }
          assert.strictEqual(
            n.graphColumn,
            0,
            `HEAD first-parent chain commit ${cur} must be on lane 0 (mainline spine), ` +
              `got lane ${n.graphColumn}. headName=${dag.headName}`
          );
          cur = n.commit.parents[0];
        }
      }),
      { numRuns: 500 }
    );
  });

  it('renderer: the SVG edge leaving each node toward its first parent matches the node fill color', () => {
    fc.assert(
      fc.property(dagArb, (dag) => {
        const nodes = generateCommitGraph(
          dag.commits,
          dag.branchMap,
          undefined,
          undefined,
          dag.headName,
          dag.headHash
        );
        const svgs = buildGraphPrintModel(nodes).map((m) => paintRow(m, DEFAULT_GRAPH_CONFIG));
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          const firstLine = node.graphLines[0];
          // Only assert when the node has a first-parent ('commit') edge —
          // that's the spine continuation the contract covers.
          if (!firstLine || firstLine.type !== 'commit') {
            continue;
          }
          const svg = svgs[i];
          const nodeColor = getColumnColor(node.graphColumn);
          const edgeColor = firstParentEdgeColorFromSvg(svg, nodeColor);
          // edgeColor undefined → the row drew no downward edge (e.g. the
          // node fill <circle> only); skip — nothing to mismatch.
          if (edgeColor === undefined) {
            continue;
          }
          assert.strictEqual(
            edgeColor,
            nodeColor,
            `${node.commit.hash} (row ${i}, lane ${node.graphColumn}): rendered ` +
              `first-parent edge stroke ${edgeColor} != node fill ${nodeColor}.\nSVG: ${svg}`
          );
        }
      }),
      { numRuns: 300 }
    );
  });

  it('renderer: NO orphan pass-through stroke — a lane is active at a row only if a real edge occupies it there', () => {
    // This is the assertion the earlier (passing) tests lacked: a NEGATIVE
    // check that no vertical stroke is painted for a lane that has no actual
    // line at that row. The orphan-stroke bug marked a BENDING line's source
    // lane active all the way down to the parent's row, so the renderer
    // stroked a full-height vertical in the side-lane colour through rows
    // whose node is a different colour — the reported "orange line through
    // green mainline" artifact. We rebuild the ground-truth set of lanes
    // that legitimately occupy each row directly from the nodes (a node's
    // own column at its row; a same-lane line's column across its span; a
    // bending line's DESTINATION column across its span, plus the SOURCE
    // column at the source row only) and require computeActiveLanes to never
    // exceed it.
    fc.assert(
      fc.property(dagArb, (dag) => {
        const nodes = generateCommitGraph(
          dag.commits,
          dag.branchMap,
          undefined,
          undefined,
          dag.headName,
          dag.headHash
        );
        const rowOf = new Map<string, number>();
        nodes.forEach((n, i) => rowOf.set(n.commit.hash, i));

        // Ground truth: which lanes genuinely have ink at each row.
        const truth = new Map<number, Set<number>>();
        const mark = (row: number, lane: number): void => {
          if (!truth.has(row)) {
            truth.set(row, new Set());
          }
          truth.get(row)!.add(lane);
        };
        nodes.forEach((n, i) => {
          mark(i, n.graphColumn); // the node sits in its own lane at its row
          for (const line of n.graphLines) {
            // Far-parent fork-point bend: the source
            // lane runs straight down at rows [i..endRow-1]; the bend
            // lands at endRow but is inked there by the parent's own
            // graphColumn (we deliberately do NOT mark the source lane
            // at endRow — preserves the orphan-stroke invariant).
            if (line.endRow !== undefined) {
              if (line.endRow > i) {
                for (let r = i; r <= line.endRow - 1; r++) {
                  mark(r, line.fromColumn);
                }
              } else {
                mark(i, line.fromColumn);
              }
              continue;
            }
            // Resolve the target row: the parent on this line's toColumn.
            let target = i;
            for (const p of n.commit.parents) {
              const pr = rowOf.get(p);
              if (pr !== undefined && pr > i && nodes[pr].graphColumn === line.toColumn) {
                target = pr;
                break;
              }
            }
            if (line.fromColumn === line.toColumn) {
              // Same-lane vertical: occupies its column across the whole span.
              for (let r = i; r <= Math.max(i, target); r++) {
                mark(r, line.fromColumn);
              }
            } else {
              // Bending line: source lane at the source row only; destination
              // lane down to the parent's row.
              mark(i, line.fromColumn);
              for (let r = i; r <= Math.max(i, target); r++) {
                mark(r, line.toColumn);
              }
            }
          }
        });

        const active = computeActiveLanes(nodes);
        for (let i = 0; i < nodes.length; i++) {
          const activeLanes = active.get(i) ?? new Set<number>();
          const legit = truth.get(i) ?? new Set<number>();
          for (const lane of activeLanes) {
            assert.ok(
              legit.has(lane),
              `row ${i} (${nodes[i].commit.hash}): lane ${lane} marked ACTIVE but no ` +
                `real edge occupies it there — orphan pass-through stroke. ` +
                `legit lanes: {${[...legit].join(',')}}; active: {${[...activeLanes].join(',')}}`
            );
          }
        }
      }),
      { numRuns: 500 }
    );
  });
});
