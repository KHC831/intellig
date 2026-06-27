/**
 * Shared helpers for graph print-model / painter tests (post renderGraphSvg
 * deletion). Two entry points:
 *  - `renderDag` — whole-DAG render via the production Layer 3 + Layer 4 path.
 *  - `mkRowModel` — construct a single IRowPrintModel for direct paintRow unit
 *    tests (icons, colors, geometry primitives).
 */

import { generateCommitGraph, IBranchRef, ICommitNode } from '../../src/git-core/commitGraph';
import {
  buildGraphPrintModel,
  projectRow,
  IRowPrintModel,
  IRowEdgeElement,
} from '../../src/git-core/graph/printModel';
import { paintRow } from '../../src/git-core/graph/graphPainter';
import {
  DEFAULT_GRAPH_CONFIG,
  IGraphRenderConfig,
  computeActiveLanes,
  computeLaneContinuesFromAbove,
  computeLaneContinuesBelow,
} from '../../src/utils/graphRenderer';
import { computeIncomingBendsMap } from '../../src/git-core/commitGraph';
import type { ICommit } from '../../src/git-core/interfaces/IGitService';

export function mkCommit(hash: string, parents: string[] = []): ICommit {
  const d = new Date('2024-01-01T00:00:00Z');
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: hash,
    author: { name: 'a', email: 'a@a' },
    committer: { name: 'a', email: 'a@a' },
    parents,
    authorDate: d,
    commitDate: d,
  };
}

/** Build the print models for a DAG (newest-first commit list). */
export function modelsForDag(
  commits: ICommit[],
  branchMap?: Map<string, IBranchRef[]>,
  headBranchName?: string,
  headHash?: string
): IRowPrintModel[] {
  const nodes = generateCommitGraph(
    commits,
    branchMap,
    undefined,
    undefined,
    headBranchName,
    headHash
  );
  return buildGraphPrintModel(nodes);
}

/** Render a DAG to one SVG string per row via the production path. */
export function renderDag(
  commits: ICommit[],
  config: IGraphRenderConfig = DEFAULT_GRAPH_CONFIG
): string[] {
  return modelsForDag(commits).map((m) => paintRow(m, config));
}

/** A straight vertical edge segment for a IRowPrintModel. */
export function straightEdge(
  lane: number,
  half: 'up' | 'down' | 'full',
  style: 'solid' | 'dashed' = 'solid'
): IRowEdgeElement {
  return {
    edge: { childRow: 0, parent: { kind: 'inWindow', row: 1 }, lane },
    half,
    lane,
    fromLane: lane,
    targetLane: lane,
    curved: false,
    type: 'commit',
    style,
  };
}

/** A curved bezier edge segment for a IRowPrintModel. */
export function curvedEdge(
  fromLane: number,
  targetLane: number,
  half: 'up' | 'down',
  type: 'commit' | 'merge' | 'branch' = 'merge',
  style: 'solid' | 'dashed' = 'solid'
): IRowEdgeElement {
  return {
    edge: { childRow: 0, parent: { kind: 'inWindow', row: 1 }, lane: targetLane },
    half,
    lane: targetLane,
    fromLane,
    targetLane,
    curved: true,
    type,
    style,
  };
}

/** Construct a IRowPrintModel with sane defaults for direct paintRow unit tests. */
export function mkRowModel(
  overrides: Omit<Partial<IRowPrintModel>, 'node'> & { node?: Partial<IRowPrintModel['node']> } = {}
): IRowPrintModel {
  const { node: nodeOverrides, ...rest } = overrides;
  const node = {
    lane: 0,
    isMerge: false,
    isTerminal: false,
    isCurrentHead: false,
    isBranchSplit: false,
    onFocusedBranchPath: false,
    ...nodeOverrides,
  };
  const edges = rest.edges ?? [];
  const inkedLanes = rest.inkedLanes ?? [
    ...new Set<number>([node.lane, ...edges.map((e) => e.lane)]),
  ];
  return {
    rowIndex: rest.rowIndex ?? 0,
    node,
    edges,
    inkedLanes,
    isLastRow: rest.isLastRow ?? false,
    chevronLanes: rest.chevronLanes ?? [],
    hasFocusedBranch: rest.hasFocusedBranch ?? false,
  };
}

/**
 * Render a single FABRICATED node row (arbitrary activeLanes / continuity), for
 * painter primitive tests that don't build a whole DAG. Interval-model semantics:
 * a pass-through lane only draws when continuity is supplied. Defaults render the
 * node + own-lane segments per the node's own graphLines.
 */
export function paintFabricatedRow(
  node: ICommitNode,
  rowIndex: number,
  ctx: Partial<{
    activeLanes: Iterable<number>;
    continuesFromAbove: Iterable<number>;
    continuesBelow: Iterable<number>;
    incomingBendLanes: Iterable<number>;
    bendsLandingBelow: Iterable<number>;
    isTerminal: boolean;
    isCurrentHead: boolean;
    isBranchSplit: boolean;
    isLastRow: boolean;
    hasFocusedBranch: boolean;
  }> = {},
  config: IGraphRenderConfig = DEFAULT_GRAPH_CONFIG
): string {
  const model = projectRow(node, rowIndex, {
    activeLanes: new Set<number>(ctx.activeLanes ?? [node.graphColumn]),
    continuesFromAbove: new Set<number>(ctx.continuesFromAbove ?? []),
    continuesBelow: new Set<number>(ctx.continuesBelow ?? []),
    incomingBendLanes: new Set<number>(ctx.incomingBendLanes ?? []),
    bendsLandingBelow: new Set<number>(ctx.bendsLandingBelow ?? []),
    isTerminal: ctx.isTerminal ?? false,
    isCurrentHead: ctx.isCurrentHead ?? false,
    isBranchSplit: ctx.isBranchSplit ?? false,
    isLastRow: ctx.isLastRow ?? false,
    hasFocusedBranch: ctx.hasFocusedBranch ?? node.onFocusedBranchPath === true,
    nodes: [node],
    // Empty interval lookup: the painter ignores edge.parent, so kit-built
    // edges' edge.parent is NOT authoritative (it falls back to offWindow).
    // Real edge identity is pinned via buildGraphPrintModel in printModel.test.ts.
    intervalByLane: new Map(),
  });
  return paintRow(model, config);
}

/**
 * Render ONE row of a REAL DAG with continuity/bends derived from the actual
 * node array (the faithful equivalent of the old `renderGraphSvg(nodes[i], i,
 * active.get(i), config, isTerminal, isBranchSplit)` real-DAG calls). Node-icon
 * flags default to false (matching those call sites, which forced false to test
 * the primitive) and are overridable.
 */
export function paintDagRow(
  nodes: ICommitNode[],
  rowIndex: number,
  config: IGraphRenderConfig = DEFAULT_GRAPH_CONFIG,
  overrides: { isTerminal?: boolean; isCurrentHead?: boolean; isBranchSplit?: boolean } = {}
): string {
  const active = computeActiveLanes(nodes);
  const above = computeLaneContinuesFromAbove(nodes);
  const below = computeLaneContinuesBelow(nodes);
  const incoming = computeIncomingBendsMap(nodes);
  // Source lanes whose far-parent bend lands at rowIndex+1 need to bottom this
  // row (mirrors printModel.computeBendsLandingBelowMap for this single row).
  const bendsLandingBelow = new Set<number>();
  for (const n of nodes) {
    for (const line of n.graphLines) {
      if (line.endRow === rowIndex + 1) {
        bendsLandingBelow.add(line.fromColumn);
      }
    }
  }
  const model = projectRow(nodes[rowIndex], rowIndex, {
    activeLanes: active.get(rowIndex) ?? new Set<number>(),
    continuesFromAbove: above.get(rowIndex) ?? new Set<number>(),
    continuesBelow: below.get(rowIndex) ?? new Set<number>(),
    incomingBendLanes: incoming.get(nodes[rowIndex].commit.hash) ?? new Set<number>(),
    bendsLandingBelow,
    isTerminal: overrides.isTerminal ?? false,
    isCurrentHead: overrides.isCurrentHead ?? false,
    isBranchSplit: overrides.isBranchSplit ?? false,
    isLastRow: rowIndex === nodes.length - 1,
    hasFocusedBranch: false,
    nodes,
    // edge.parent not authoritative here (painter ignores it); see paintFabricatedRow.
    intervalByLane: new Map(),
  });
  return paintRow(model, config);
}

export { paintRow, DEFAULT_GRAPH_CONFIG };
