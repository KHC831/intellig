/**
 * Regression: the git graph dropped a one-row segment (a vertical "gap") when a
 * branch-split row also carried a SEPARATE line transiting straight through it.
 *
 * Topology (anonymized, newest-first), reduced from a multi-branch / multi-merge
 * history that reproduced the gap:
 *   - two long-lived lanes, "main" and "feature";
 *   - a side commit that branches off a main commit and merges straight back;
 *   - a merge commit ("merge of main into feature") whose FIRST parent is far
 *     down its own (feature) lane and SECOND parent is a nearby main commit, so
 *     the feature trunk transits through a row that is ALSO a branch-split
 *     (the shared main commit `base`, which has two children);
 *   - off-window parents at the bottom of the loaded slice.
 *
 * Invariants: (1) every edge to an in-window parent keeps its lane active on
 * every row between them; (2) the rendered SVG has no dangling lane — a lane
 * active across a row boundary must have ink on both sides of it.
 */

import '../../../setup';
import * as assert from 'assert';
import {
  generateCommitGraph,
  computeChildLanesMap,
  computeChildCountMap,
  computeTerminalNodes,
  computeIncomingBendsMap,
  isBranchSplit,
} from '../../../../src/git-core/commitGraph';
import {
  computeActiveLanes,
  computeLaneContinuesFromAbove,
  renderGraphSvg,
  getColumnX,
  DEFAULT_GRAPH_CONFIG,
} from '../../../../src/utils/graphRenderer';
import type { ICommit } from '../../../../src/git-core/interfaces/IGitService';

const BOTTOM_Y = DEFAULT_GRAPH_CONFIG.rowHeight;

function c(hash: string, parents: string[]): ICommit {
  const d = new Date('2024-01-01T00:00:00Z');
  return {
    hash,
    shortHash: hash,
    message: hash,
    author: { name: 'A', email: 'a@x' },
    committer: { name: 'A', email: 'a@x' },
    parents,
    authorDate: d,
    commitDate: d,
  };
}

/**
 * Newest-first display order. `n21` and `n25` have parents not present in the
 * list (off-window, below the loaded slice). `base` (n13) has two children
 * (n10 main + the n12 merge) → it is a branch-split row that the feature lane
 * also transits straight through.
 */
function multiMergeSplitTopology(): ICommit[] {
  return [
    c('n0', ['n1']),
    c('n1', ['n2']),
    c('n2', ['n3']),
    c('n3', ['n4']),
    c('n4', ['n5']),
    c('n5', ['n6']),
    c('n6', ['n8']),
    c('n7', ['n8']), // side branch off n8, merges straight back
    c('n8', ['n9']),
    c('n9', ['n10']),
    c('n10', ['n13']),
    c('n11', ['n12']), // feature tip
    c('n12', ['n22', 'n13']), // merge: first parent far down feature lane, second = main
    c('n13', ['n14']), // shared "base": child of n10 (main) AND n12 (merge) → split row
    c('n14', ['n15']),
    c('n15', ['n16']),
    c('n16', ['n17']),
    c('n17', ['n18']),
    c('n18', ['n19']),
    c('n19', ['n20']),
    c('n20', ['n21']),
    c('n21', ['off_a']), // main continues off-window
    c('n22', ['n23']), // feature continues (first parent of the n12 merge)
    c('n23', ['n24']),
    c('n24', ['n25']),
    c('n25', ['off_b', 'off_c']), // merge, off-window
  ];
}

describe('graph: transiting through-line at a branch-split row', () => {
  it('has no interior lane gap on any edge to an in-window parent', () => {
    const nodes = generateCommitGraph(multiMergeSplitTopology());
    const active = computeActiveLanes(nodes);
    const rowOf = new Map<string, number>();
    nodes.forEach((n, i) => rowOf.set(n.commit.hash, i));

    const gaps: string[] = [];
    nodes.forEach((node, i) => {
      for (const line of node.graphLines) {
        if (line.style === 'dashed') {
          continue;
        }
        if (line.endRow !== undefined) {
          if (line.endRow > i) {
            for (let row = i; row <= line.endRow - 1; row++) {
              if (!active.get(row)?.has(line.fromColumn)) {
                gaps.push(
                  `far-parent lane ${line.fromColumn} inactive at row ${row}` +
                    ` (source ${node.commit.hash} r${i} → endRow ${line.endRow})`
                );
              }
            }
          }
          continue;
        }
        const parentRow = node.commit.parents
          .map((p) => rowOf.get(p))
          .filter((r): r is number => r !== undefined && r > i)
          .find((r) => nodes[r].graphColumn === line.toColumn);
        if (parentRow === undefined) {
          continue;
        }
        for (let row = i; row <= parentRow; row++) {
          if (!active.get(row)?.has(line.toColumn)) {
            gaps.push(
              `lane ${line.toColumn} inactive at row ${row} between ${node.commit.hash}(r${i})` +
                ` and ${nodes[parentRow].commit.hash}(r${parentRow})`
            );
          }
        }
      }
    });

    assert.deepStrictEqual(gaps, [], `graph has interior lane gap(s):\n${gaps.join('\n')}`);
  });

  it('renders without a dangling lane (no vertical gap) in the SVG', () => {
    const nodes = generateCommitGraph(multiMergeSplitTopology());
    const active = computeActiveLanes(nodes);
    const fromAbove = computeLaneContinuesFromAbove(nodes);
    const childLanes = computeChildLanesMap(nodes);
    const childCount = computeChildCountMap(nodes);
    const incoming = computeIncomingBendsMap(nodes);
    const terminal = computeTerminalNodes(nodes);

    const svgs = nodes.map((n, i) =>
      renderGraphSvg(
        n,
        i,
        active.get(i) ?? new Set(),
        DEFAULT_GRAPH_CONFIG,
        terminal.has(n.commit.hash),
        isBranchSplit(n.commit.hash, childCount),
        childLanes.get(n.commit.hash) ?? new Set(),
        false,
        active.get(i + 1) ?? new Set(),
        incoming.get(n.commit.hash) ?? new Set(),
        active.get(i - 1) ?? new Set(),
        i === nodes.length - 1,
        fromAbove.get(i) ?? new Set()
      )
    );

    // Endpoint-only ink probe: `<line>` endpoints + a `<path>`'s START (M) and
    // FINAL point — NOT bezier control points (not drawn ink, false matches).
    const inkAt = (svg: string, x: number, y: number): boolean => {
      const lineRe = /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g;
      for (let m = lineRe.exec(svg); m; m = lineRe.exec(svg)) {
        if (+m[1] === x && +m[3] === x && (+m[2] === y || +m[4] === y)) {
          return true;
        }
      }
      const pathRe = /<path d="M ([\d.-]+),([\d.-]+) C [\d.,\s-]* ([\d.-]+),([\d.-]+)"/g;
      for (let m = pathRe.exec(svg); m; m = pathRe.exec(svg)) {
        if ((+m[1] === x && +m[2] === y) || (+m[3] === x && +m[4] === y)) {
          return true;
        }
      }
      return false;
    };

    const maxLane = Math.max(
      ...nodes.map((n) => n.graphColumn),
      ...[...active.values()].flatMap((s) => [...s])
    );
    const dangles: string[] = [];
    for (let r = 0; r + 1 < svgs.length; r++) {
      for (let lane = 0; lane <= maxLane; lane++) {
        if (!(active.get(r)?.has(lane) && active.get(r + 1)?.has(lane))) {
          continue; // lane reuse / not a through-lane here — fine
        }
        const x = getColumnX(lane, DEFAULT_GRAPH_CONFIG);
        const bottom = inkAt(svgs[r], x, BOTTOM_Y);
        const top = inkAt(svgs[r + 1], x, 0);
        if (bottom !== top) {
          dangles.push(
            `lane ${lane} between ${nodes[r].commit.hash}(r${r}) and ` +
              `${nodes[r + 1].commit.hash}(r${r + 1}): bottom=${bottom} top=${top}`
          );
        }
      }
    }

    assert.deepStrictEqual(dangles, [], `dangling lane / vertical gap:\n${dangles.join('\n')}`);
  });
});
