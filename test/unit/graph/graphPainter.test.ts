/**
 * Layer-4 painter geometry pins, characterizing behavior before the T2a/T2b
 * packer + painter rewrite so a coordinate/color regression there shows up as
 * a moved test, not a silent behavior change. Every model is hand-built or
 * hand-packed (never a generated topology sampled post-compaction), so these
 * pins stay valid regardless of which packer produced the column numbers.
 */

import '../../setup';
import * as assert from 'assert';
import { paintRow } from '../../../src/git-core/graph/graphPainter';
import { compactPrintModelLanes } from '../../../src/git-core/graph/laneCompaction';
import { getColumnX, DEFAULT_GRAPH_CONFIG } from '../../../src/utils/graphRenderer';
import {
  buildGraphPrintModel,
  IRowPrintModel,
  IRowEdgeElement,
} from '../../../src/git-core/graph/printModel';
import { generateCommitGraph } from '../../../src/git-core/commitGraph';
import { mkRowModel, straightEdge, mkCommit } from '../../support/printModelTestKit';

const { nodeRadius, rowHeight } = DEFAULT_GRAPH_CONFIG;
const centerY = rowHeight / 2;
const bottomY = rowHeight;

function arrowStub(lane: number, arrow: 'up' | 'down', color: string): IRowEdgeElement {
  return {
    edge: { childRow: 0, parent: { kind: 'inWindow', row: 1 }, lane },
    half: arrow === 'down' ? 'up' : 'down',
    lane,
    fromLane: lane,
    targetLane: lane,
    curved: false,
    type: 'commit',
    style: 'solid',
    color,
    arrow,
  };
}

describe('paintRow — long-edge-cut arrowhead geometry', () => {
  it('paints a DOWN arrow pointing into the row center from above', () => {
    const model = mkRowModel({ edges: [arrowStub(0, 'down', '#123456')] });
    const svg = paintRow(model, DEFAULT_GRAPH_CONFIG);
    const x = getColumnX(0, DEFAULT_GRAPH_CONFIG);
    const aw = nodeRadius * 0.9;
    const ah = nodeRadius * 1.1;
    const d = `M ${x - aw},${centerY} L ${x},${centerY + ah} L ${x + aw},${centerY}`;
    assert.ok(
      svg.includes(`<path d="${d}" fill="#123456" stroke="none"/>`),
      `expected DOWN arrowhead path, got: ${svg}`
    );
  });

  it('mirrors it for an UP arrow (tip above center, not below)', () => {
    const model = mkRowModel({ edges: [arrowStub(0, 'up', '#123456')] });
    const svg = paintRow(model, DEFAULT_GRAPH_CONFIG);
    const x = getColumnX(0, DEFAULT_GRAPH_CONFIG);
    const aw = nodeRadius * 0.9;
    const ah = nodeRadius * 1.1;
    const d = `M ${x - aw},${centerY} L ${x},${centerY - ah} L ${x + aw},${centerY}`;
    assert.ok(
      svg.includes(`<path d="${d}" fill="#123456" stroke="none"/>`),
      `expected UP arrowhead path, got: ${svg}`
    );
  });
});

/** Extract every chevron `<path d="..." stroke="...">` in document order. */
function extractChevrons(svg: string): Array<{ d: string; color: string }> {
  const out: Array<{ d: string; color: string }> = [];
  const re = /<path d="([^"]+)" stroke="([^"]+)" fill="none"/g;
  for (const m of svg.matchAll(re)) {
    out.push({ d: m[1], color: m[2] });
  }
  return out;
}

describe('paintRow — two-chevron parallel-array witness (chevronLanes / chevronColors)', () => {
  function twoChevronModel(colors: [string, string]): IRowPrintModel {
    return compactPrintModelLanes([
      mkRowModel({
        node: { lane: 0 },
        inkedLanes: [0, 5],
        chevronLanes: [0, 5],
        chevronColors: colors,
      }),
    ])[0];
  }

  it('paints each chevron with its OWN parallel color, not a shared lane fallback', () => {
    const svg = paintRow(twoChevronModel(['#111111', '#222222']), DEFAULT_GRAPH_CONFIG);
    const chevrons = extractChevrons(svg);
    assert.strictEqual(chevrons.length, 2, `expected 2 chevrons, got: ${svg}`);

    // lane 0 packs to column 0, lane 5 (the only other lane in the row) packs
    // to column 1 — apexes sit at each column's x, tipY = rowHeight - 1.
    const armW = nodeRadius;
    const tipY = rowHeight - 1;
    const x0 = getColumnX(0, DEFAULT_GRAPH_CONFIG);
    const x1 = getColumnX(1, DEFAULT_GRAPH_CONFIG);
    assert.strictEqual(
      chevrons[0].d,
      `M ${x0 - armW},${tipY - armW} L ${x0},${tipY} L ${x0 + armW},${tipY - armW}`
    );
    assert.strictEqual(
      chevrons[1].d,
      `M ${x1 - armW},${tipY - armW} L ${x1},${tipY} L ${x1 + armW},${tipY - armW}`
    );
    assert.strictEqual(chevrons[0].color, '#111111');
    assert.strictEqual(chevrons[1].color, '#222222');
  });

  it('teeth test: swapping chevronColors flips which lane paints which colour (the bond is real, not coincidence)', () => {
    const original = extractChevrons(
      paintRow(twoChevronModel(['#111111', '#222222']), DEFAULT_GRAPH_CONFIG)
    );
    const swapped = extractChevrons(
      paintRow(twoChevronModel(['#222222', '#111111']), DEFAULT_GRAPH_CONFIG)
    );
    assert.strictEqual(original[0].color, '#111111');
    assert.strictEqual(
      swapped[0].color,
      '#222222',
      'swapping the colours array must change what column 0 paints'
    );
    assert.notDeepStrictEqual(original, swapped);
  });
});

/** Extract a straight segment's points from EITHER a `<line>` or a `<polyline>` —
 * a docking-polyline rewrite must not require re-targeting this pin. */
function extractStraightPoints(svg: string): Array<[number, number]> {
  const lineMatch = /<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/.exec(svg);
  if (lineMatch) {
    return [
      [Number(lineMatch[1]), Number(lineMatch[2])],
      [Number(lineMatch[3]), Number(lineMatch[4])],
    ];
  }
  const polyMatch = /<polyline points="([^"]+)"/.exec(svg);
  if (polyMatch) {
    return polyMatch[1]
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const [x, y] = pair.split(',').map(Number);
        return [x, y] as [number, number];
      });
  }
  throw new Error(`no <line> or <polyline> element found in: ${svg}`);
}

describe('paintRow — docking geometry, collapsed (single-column) case', () => {
  it('a straight full segment passes through (x,0) (x,centerY) (x,bottomY), by coordinates not tag name', () => {
    const model = mkRowModel({ node: { lane: 2 }, edges: [straightEdge(2, 'full')] });
    const svg = paintRow(model, DEFAULT_GRAPH_CONFIG);
    const points = extractStraightPoints(svg);
    const x = getColumnX(2, DEFAULT_GRAPH_CONFIG);

    assert.ok(
      points.every(([px]) => px === x),
      `every point must stay on column x=${x}: ${JSON.stringify(points)}`
    );
    assert.strictEqual(points[0][1], 0, 'segment starts at the row top');
    assert.strictEqual(points[points.length - 1][1], bottomY, 'segment ends at the row bottom');
    const ys = points.map(([, py]) => py);
    assert.ok(
      Math.min(...ys) <= centerY && Math.max(...ys) >= centerY,
      'the segment must pass through the row center'
    );
  });
});

/** The x coordinate a painted straight segment reaches at a given y (its top or
 * bottom endpoint — never interpolated, since a seam is a distinct point). */
function xAtY(points: Array<[number, number]>, y: number): number {
  const hit = points.find(([, py]) => py === y);
  if (!hit) {
    throw new Error(`no point at y=${y} in ${JSON.stringify(points)}`);
  }
  return hit[0];
}

describe('paintRow — seam docking across a row boundary (topLane / bottomLane)', () => {
  it("a lane change across the boundary docks: row 0's bottom x equals row 1's top x", () => {
    // Row 0: an edge on lane 0 whose bottom half should seam toward lane 1
    // next row. Row 1: an edge on lane 1 whose top half should seam toward
    // lane 0 from the row above.
    const row0 = mkRowModel({
      node: { lane: 0 },
      edges: [{ ...straightEdge(0, 'down'), bottomLane: 1 }],
    });
    const row1 = mkRowModel({
      node: { lane: 1 },
      edges: [{ ...straightEdge(1, 'up'), topLane: 0 }],
    });
    const bottomXRow0 = xAtY(extractStraightPoints(paintRow(row0, DEFAULT_GRAPH_CONFIG)), bottomY);
    const topXRow1 = xAtY(extractStraightPoints(paintRow(row1, DEFAULT_GRAPH_CONFIG)), 0);
    assert.strictEqual(
      bottomXRow0,
      topXRow1,
      "row 0's bottom seam x must equal row 1's top seam x so the line looks continuous"
    );
  });
});

describe('paintRow — the unpacked path (showLongEdges on, compaction skipped)', () => {
  it('a print model built without compaction is never seam-stamped and paints plain verticals', () => {
    // Mirrors production's showLongEdges-on path (logPanelHtml.ts), which
    // builds with hideLongEdges:false and never calls compactPrintModelLanes
    // — so linkSeams, the only writer of topLane/bottomLane, never runs.
    const commits = [
      mkCommit('merge', ['m0', 's0']),
      mkCommit('s0', ['s1']),
      mkCommit('s1', ['m2']),
      mkCommit('m0', ['m1']),
      mkCommit('m1', ['m2']),
      mkCommit('m2', []),
    ];
    const nodes = generateCommitGraph(commits);
    const models = buildGraphPrintModel(nodes, { hideLongEdges: false });
    const svgs = models.map((m) => paintRow(m, DEFAULT_GRAPH_CONFIG));

    assert.ok(
      models.some((m) => m.edges.some((e) => e.curved)),
      'fixture sanity: the merge must produce at least one bend edge'
    );
    assert.ok(
      models.every((m) =>
        m.edges.every((e) => e.topLane === undefined && e.bottomLane === undefined)
      ),
      'no edge should carry a seam column without compaction ever having run'
    );
    assert.ok(
      svgs.every((s) => !s.includes('<polyline')),
      'an undocked straight segment paints a plain <line>, never a docking <polyline>'
    );
  });
});
