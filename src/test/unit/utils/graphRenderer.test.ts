/**
 * Unit tests for graph renderer core types, config, and helpers.
 *
 * Tests cover:
 * - IGraphRenderConfig default values meet minimum spacing requirements
 * - DEFAULT_GRAPH_CONFIG constant correctness
 * - getColumnX() helper function
 * - ActiveLaneMap type usage
 */

import * as assert from 'assert';
import {
  IGraphRenderConfig,
  ActiveLaneMap,
  DEFAULT_GRAPH_CONFIG,
  getColumnX,
  computeActiveLanes,
  computeGraphWidth,
  renderGraphSvg,
} from '../../../utils/graphRenderer';
import { ICommitNode, getColumnColor } from '../../../git-core/commitGraph';
import { ICommit } from '../../../git-core/interfaces/IGitService';

describe('Graph Renderer - Core Types and Config', () => {
  describe('DEFAULT_GRAPH_CONFIG', () => {
    it('should have columnWidth of 20', () => {
      assert.strictEqual(DEFAULT_GRAPH_CONFIG.columnWidth, 20);
    });

    it('should have rowHeight of 24', () => {
      assert.strictEqual(DEFAULT_GRAPH_CONFIG.rowHeight, 24);
    });

    it('should have nodeRadius of 4 (IntelliJ-snug, not oversized)', () => {
      assert.strictEqual(DEFAULT_GRAPH_CONFIG.nodeRadius, 4);
    });

    it('should have padding of 10', () => {
      assert.strictEqual(DEFAULT_GRAPH_CONFIG.padding, 10);
    });

    it('should have lineWidth of 2', () => {
      assert.strictEqual(DEFAULT_GRAPH_CONFIG.lineWidth, 2);
    });

    it('should meet minimum columnWidth requirement (>= 20)', () => {
      assert.ok(
        DEFAULT_GRAPH_CONFIG.columnWidth >= 20,
        `columnWidth ${DEFAULT_GRAPH_CONFIG.columnWidth} should be >= 20`
      );
    });

    it('should meet minimum rowHeight requirement (>= 24)', () => {
      assert.ok(
        DEFAULT_GRAPH_CONFIG.rowHeight >= 24,
        `rowHeight ${DEFAULT_GRAPH_CONFIG.rowHeight} should be >= 24`
      );
    });

    it('should meet minimum padding requirement (>= 10)', () => {
      assert.ok(
        DEFAULT_GRAPH_CONFIG.padding >= 10,
        `padding ${DEFAULT_GRAPH_CONFIG.padding} should be >= 10`
      );
    });
  });

  describe('getColumnX()', () => {
    it('should compute correct x for column 0 with default config', () => {
      // column 0: 0 * 20 + 10 + 20/2 = 0 + 10 + 10 = 20
      const x = getColumnX(0, DEFAULT_GRAPH_CONFIG);
      assert.strictEqual(x, 20);
    });

    it('should compute correct x for column 1 with default config', () => {
      // column 1: 1 * 20 + 10 + 20/2 = 20 + 10 + 10 = 40
      const x = getColumnX(1, DEFAULT_GRAPH_CONFIG);
      assert.strictEqual(x, 40);
    });

    it('should compute correct x for column 2 with default config', () => {
      // column 2: 2 * 20 + 10 + 20/2 = 40 + 10 + 10 = 60
      const x = getColumnX(2, DEFAULT_GRAPH_CONFIG);
      assert.strictEqual(x, 60);
    });

    it('should compute correct x with custom config', () => {
      const config: IGraphRenderConfig = {
        columnWidth: 30,
        rowHeight: 40,
        nodeRadius: 8,
        padding: 15,
        lineWidth: 3,
      };
      // column 1: 1 * 30 + 15 + 30/2 = 30 + 15 + 15 = 60
      const x = getColumnX(1, config);
      assert.strictEqual(x, 60);
    });

    it('should produce evenly spaced columns', () => {
      const x0 = getColumnX(0, DEFAULT_GRAPH_CONFIG);
      const x1 = getColumnX(1, DEFAULT_GRAPH_CONFIG);
      const x2 = getColumnX(2, DEFAULT_GRAPH_CONFIG);

      // Spacing between adjacent columns should equal columnWidth
      assert.strictEqual(x1 - x0, DEFAULT_GRAPH_CONFIG.columnWidth);
      assert.strictEqual(x2 - x1, DEFAULT_GRAPH_CONFIG.columnWidth);
    });

    it('should handle large column indices', () => {
      const x = getColumnX(100, DEFAULT_GRAPH_CONFIG);
      // column 100: 100 * 20 + 10 + 10 = 2020
      assert.strictEqual(x, 2020);
    });

    it('should follow the formula: column * columnWidth + padding + columnWidth / 2', () => {
      const config: IGraphRenderConfig = {
        columnWidth: 25,
        rowHeight: 36,
        nodeRadius: 7,
        padding: 12,
        lineWidth: 2,
      };
      const column = 3;
      const expected = column * config.columnWidth + config.padding + config.columnWidth / 2;
      assert.strictEqual(getColumnX(column, config), expected);
    });
  });

  describe('ActiveLaneMap type', () => {
    it('should be usable as Map<number, Set<number>>', () => {
      const activeLanes: ActiveLaneMap = new Map();
      activeLanes.set(0, new Set([0, 1, 2]));
      activeLanes.set(1, new Set([0, 2]));
      activeLanes.set(2, new Set([0]));

      assert.strictEqual(activeLanes.size, 3);
      assert.ok(activeLanes.get(0)!.has(1));
      assert.ok(!activeLanes.get(1)!.has(1));
    });

    it('should support empty sets for rows with no active lanes', () => {
      const activeLanes: ActiveLaneMap = new Map();
      activeLanes.set(0, new Set());

      assert.strictEqual(activeLanes.get(0)!.size, 0);
    });
  });
});

/**
 * Helper to create a minimal ICommit for testing.
 */
function makeCommit(hash: string, parents: string[] = []): ICommit {
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message: `Commit ${hash}`,
    author: { name: 'Test', email: 'test@test.com' },
    committer: { name: 'Test', email: 'test@test.com' },
    parents,
    authorDate: new Date(),
    commitDate: new Date(),
  };
}

/**
 * Helper to create a minimal ICommitNode for testing.
 */
function makeNode(
  hash: string,
  parents: string[],
  graphColumn: number,
  graphLines: {
    fromColumn: number;
    toColumn: number;
    type: 'commit' | 'merge' | 'branch';
    style?: 'solid' | 'dashed';
  }[] = []
): ICommitNode {
  return {
    commit: makeCommit(hash, parents),
    graphColumn,
    graphLines: graphLines.map((l) => ({
      fromColumn: l.fromColumn,
      toColumn: l.toColumn,
      color: '#000',
      type: l.type,
      ...(l.style ? { style: l.style } : {}),
    })),
    branches: [],
    tags: [],
  };
}

describe('computeActiveLanes()', () => {
  it('should return empty map for empty input', () => {
    const result = computeActiveLanes([]);
    assert.strictEqual(result.size, 0);
  });

  it('should handle single root commit (no parents, no lines)', () => {
    const nodes: ICommitNode[] = [makeNode('aaa', [], 0)];
    const result = computeActiveLanes(nodes);

    assert.strictEqual(result.size, 1);
    assert.ok(result.get(0)!.has(0), 'Row 0 should have lane 0 active (commit column)');
  });

  it('should handle linear history (3 commits, single lane)', () => {
    // Topological order: newest first
    // Row 0: commit C (parent B), column 0, line from 0 to 0
    // Row 1: commit B (parent A), column 0, line from 0 to 0
    // Row 2: commit A (root), column 0, no lines
    const nodes: ICommitNode[] = [
      makeNode('ccc', ['bbb'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]),
      makeNode('bbb', ['aaa'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]),
      makeNode('aaa', [], 0),
    ];

    const result = computeActiveLanes(nodes);

    assert.strictEqual(result.size, 3);
    // Lane 0 should be active at all rows
    assert.ok(result.get(0)!.has(0));
    assert.ok(result.get(1)!.has(0));
    assert.ok(result.get(2)!.has(0));
  });

  it('should track merge lanes correctly', () => {
    // Row 0: merge commit M (parents P1, P2), column 0
    //   graphLines: [from 0 to 0 (commit), from 0 to 1 (merge)]
    // Row 1: commit P1 (parent root), column 0
    //   graphLines: [from 0 to 0 (commit)]
    // Row 2: commit P2 (root), column 1
    const nodes: ICommitNode[] = [
      makeNode('mmm', ['p1p', 'p2p'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 1, type: 'merge' },
      ]),
      makeNode('p1p', ['root'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]),
      makeNode('p2p', [], 1),
    ];

    const result = computeActiveLanes(nodes);

    assert.strictEqual(result.size, 3);
    // Row 0: lane 0 (commit column) and lane 1 (merge target) should be active
    assert.ok(result.get(0)!.has(0), 'Row 0 should have lane 0');
    assert.ok(result.get(0)!.has(1), 'Row 0 should have lane 1 (merge line toColumn)');

    // Row 1: lane 0 should be active (P1 is there), lane 1 should be active (P2 is at row 2)
    assert.ok(result.get(1)!.has(0), 'Row 1 should have lane 0');
    assert.ok(result.get(1)!.has(1), 'Row 1 should have lane 1 (pass-through to P2)');

    // Row 2: lane 1 should be active (P2 is here)
    assert.ok(result.get(2)!.has(1), 'Row 2 should have lane 1 (P2 commit)');
  });

  it('should include the commit graphColumn in active lanes for each row', () => {
    // Even without graphLines, the commit's own column should be active
    const nodes: ICommitNode[] = [
      makeNode('aaa', [], 0),
      makeNode('bbb', [], 2),
      makeNode('ccc', [], 1),
    ];

    const result = computeActiveLanes(nodes);

    assert.ok(result.get(0)!.has(0), 'Row 0 should have lane 0');
    assert.ok(result.get(1)!.has(2), 'Row 1 should have lane 2');
    assert.ok(result.get(2)!.has(1), 'Row 2 should have lane 1');
  });

  it('should keep a lane active through intermediate rows', () => {
    // Row 0: commit A, column 0, line to column 0 (parent at row 3)
    // Row 1: commit B, column 1 (no relation to A)
    // Row 2: commit C, column 2 (no relation to A)
    // Row 3: commit D (parent of A), column 0
    const nodes: ICommitNode[] = [
      makeNode('aaa', ['ddd'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]),
      makeNode('bbb', [], 1),
      makeNode('ccc', [], 2),
      makeNode('ddd', [], 0),
    ];

    const result = computeActiveLanes(nodes);

    // Lane 0 should be active from row 0 through row 3
    assert.ok(result.get(0)!.has(0), 'Row 0 should have lane 0');
    assert.ok(result.get(1)!.has(0), 'Row 1 should have lane 0 (pass-through)');
    assert.ok(result.get(2)!.has(0), 'Row 2 should have lane 0 (pass-through)');
    assert.ok(result.get(3)!.has(0), 'Row 3 should have lane 0 (target commit)');
  });

  it('should handle a lane that terminates at its target row', () => {
    // Row 0: commit A, column 0, merge line to column 1 (parent B at row 1)
    // Row 1: commit B, column 1
    const nodes: ICommitNode[] = [
      makeNode('aaa', ['bbb'], 0, [{ fromColumn: 0, toColumn: 1, type: 'merge' }]),
      makeNode('bbb', [], 1),
    ];

    const result = computeActiveLanes(nodes);

    // Row 0: lane 0 (commit) and lane 1 (merge target)
    assert.ok(result.get(0)!.has(0));
    assert.ok(result.get(0)!.has(1));

    // Row 1: lane 1 (B's commit column)
    assert.ok(result.get(1)!.has(1));
  });

  it('should handle nodes with parents not in the array', () => {
    // Parent hash not found in nodes — should not crash
    const nodes: ICommitNode[] = [
      makeNode('aaa', ['unknown'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]),
    ];

    const result = computeActiveLanes(nodes);

    assert.strictEqual(result.size, 1);
    assert.ok(result.get(0)!.has(0));
  });

  it('should produce correct active lanes for diamond merge pattern', () => {
    // Diamond merge:
    //   Row 0: M (merge of B and C), column 0
    //     lines: [0->0 (to B), 0->1 (to C)]
    //   Row 1: B (parent of M, child of A), column 0
    //     lines: [0->0 (to A)]
    //   Row 2: C (parent of M, child of A), column 1
    //     lines: [1->0 (to A)]
    //   Row 3: A (root), column 0
    const nodes: ICommitNode[] = [
      makeNode('mmm', ['bbb', 'ccc'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 1, type: 'merge' },
      ]),
      makeNode('bbb', ['aaa'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]),
      makeNode('ccc', ['aaa'], 1, [{ fromColumn: 1, toColumn: 0, type: 'branch' }]),
      makeNode('aaa', [], 0),
    ];

    const result = computeActiveLanes(nodes);

    // Row 0: lanes 0 and 1 active
    assert.ok(result.get(0)!.has(0));
    assert.ok(result.get(0)!.has(1));

    // Row 1: lane 0 active (B is here, line to A at row 3), lane 1 active (pass-through to C at row 2)
    assert.ok(result.get(1)!.has(0));
    assert.ok(result.get(1)!.has(1));

    // Row 2: lane 1 active (C is here), lane 0 active (pass-through from B to A)
    assert.ok(result.get(2)!.has(1));
    assert.ok(result.get(2)!.has(0));

    // Row 3: lane 0 active (A is here)
    assert.ok(result.get(3)!.has(0));
  });
});

describe('computeGraphWidth()', () => {
  it('should return 0 for empty nodes array', () => {
    assert.strictEqual(computeGraphWidth([], DEFAULT_GRAPH_CONFIG), 0);
  });

  it('should compute correct width for single node at column 0', () => {
    const nodes: ICommitNode[] = [makeNode('aaa', [], 0)];
    // maxCol = 0, width = (0 + 1) * 20 + 10 * 2 = 20 + 20 = 40
    assert.strictEqual(computeGraphWidth(nodes, DEFAULT_GRAPH_CONFIG), 40);
  });

  it('should compute correct width for single node at column 2', () => {
    const nodes: ICommitNode[] = [makeNode('aaa', [], 2)];
    // maxCol = 2, width = (2 + 1) * 20 + 10 * 2 = 60 + 20 = 80
    assert.strictEqual(computeGraphWidth(nodes, DEFAULT_GRAPH_CONFIG), 80);
  });

  it('should consider graphLines fromColumn and toColumn for max column', () => {
    // Node at column 0 but has a graphLine going to column 3
    const nodes: ICommitNode[] = [
      makeNode('aaa', ['bbb'], 0, [{ fromColumn: 0, toColumn: 3, type: 'merge' }]),
      makeNode('bbb', [], 3),
    ];
    // maxCol = 3, width = (3 + 1) * 20 + 10 * 2 = 80 + 20 = 100
    assert.strictEqual(computeGraphWidth(nodes, DEFAULT_GRAPH_CONFIG), 100);
  });

  it('should use the maximum column across all nodes', () => {
    const nodes: ICommitNode[] = [
      makeNode('aaa', [], 0),
      makeNode('bbb', [], 4),
      makeNode('ccc', [], 1),
    ];
    // maxCol = 4, width = (4 + 1) * 20 + 10 * 2 = 100 + 20 = 120
    assert.strictEqual(computeGraphWidth(nodes, DEFAULT_GRAPH_CONFIG), 120);
  });

  it('should work with custom config', () => {
    const config: IGraphRenderConfig = {
      columnWidth: 30,
      rowHeight: 40,
      nodeRadius: 8,
      padding: 15,
      lineWidth: 3,
    };
    const nodes: ICommitNode[] = [makeNode('aaa', [], 1)];
    // maxCol = 1, width = (1 + 1) * 30 + 15 * 2 = 60 + 30 = 90
    assert.strictEqual(computeGraphWidth(nodes, config), 90);
  });

  it('should follow the formula: (maxCol + 1) * columnWidth + padding * 2', () => {
    const config: IGraphRenderConfig = {
      columnWidth: 25,
      rowHeight: 36,
      nodeRadius: 7,
      padding: 12,
      lineWidth: 2,
    };
    const nodes: ICommitNode[] = [makeNode('aaa', [], 0), makeNode('bbb', [], 3)];
    // maxCol = 3, expected = (3 + 1) * 25 + 12 * 2 = 100 + 24 = 124
    const expected = (3 + 1) * config.columnWidth + config.padding * 2;
    assert.strictEqual(computeGraphWidth(nodes, config), expected);
  });

  it('should handle linear history correctly', () => {
    // 3 commits all in column 0
    const nodes: ICommitNode[] = [
      makeNode('ccc', ['bbb'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]),
      makeNode('bbb', ['aaa'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]),
      makeNode('aaa', [], 0),
    ];
    // maxCol = 0, width = (0 + 1) * 20 + 10 * 2 = 20 + 20 = 40
    assert.strictEqual(computeGraphWidth(nodes, DEFAULT_GRAPH_CONFIG), 40);
  });
});

// ============================================================
// SVG parsing helpers for topology tests
// ============================================================

function extractCircles(svg: string) {
  const regex =
    /<circle\s+cx="([^"]+)"\s+cy="([^"]+)"\s+r="([^"]+)"\s+fill="([^"]+)"\s+stroke="([^"]+)"\s+stroke-width="[^"]+"\s*\/>/g;
  const circles: Array<{ cx: string; cy: string; r: string; fill: string; stroke: string }> = [];
  let match;
  while ((match = regex.exec(svg)) !== null) {
    circles.push({ cx: match[1], cy: match[2], r: match[3], fill: match[4], stroke: match[5] });
  }
  return circles;
}

function extractRects(svg: string) {
  const regex =
    /<rect\s+x="([^"]+)"\s+y="([^"]+)"\s+width="([^"]+)"\s+height="([^"]+)"\s+fill="([^"]+)"\s+stroke="([^"]+)"\s+stroke-width="([^"]+)"\s+transform="([^"]+)"\s*\/>/g;
  const rects: Array<{
    x: string;
    y: string;
    width: string;
    height: string;
    fill: string;
    stroke: string;
    strokeWidth: string;
    transform: string;
  }> = [];
  let match;
  while ((match = regex.exec(svg)) !== null) {
    rects.push({
      x: match[1],
      y: match[2],
      width: match[3],
      height: match[4],
      fill: match[5],
      stroke: match[6],
      strokeWidth: match[7],
      transform: match[8],
    });
  }
  return rects;
}

function extractPaths(svg: string) {
  const regex =
    /<path\s+d="([^"]+)"\s+stroke="([^"]+)"\s+fill="[^"]+"\s+stroke-width="[^"]+"\s+stroke-linecap="[^"]+"\s*\/>/g;
  const paths: Array<{ d: string; stroke: string }> = [];
  let match;
  while ((match = regex.exec(svg)) !== null) {
    paths.push({ d: match[1], stroke: match[2] });
  }
  return paths;
}

function extractLines(svg: string) {
  const regex =
    /<line\s+x1="([^"]+)"\s+y1="([^"]+)"\s+x2="([^"]+)"\s+y2="([^"]+)"\s+stroke="([^"]+)"\s+stroke-width="[^"]+"\s+stroke-linecap="[^"]+"\s*\/>/g;
  const lines: Array<{ x1: string; y1: string; x2: string; y2: string; stroke: string }> = [];
  let match;
  while ((match = regex.exec(svg)) !== null) {
    lines.push({ x1: match[1], y1: match[2], x2: match[3], y2: match[4], stroke: match[5] });
  }
  return lines;
}

// ============================================================
// Unit tests for known graph topologies
// ============================================================

describe('Graph Renderer - Known Graph Topologies', () => {
  const config = DEFAULT_GRAPH_CONFIG;
  const col0X = getColumnX(0, config).toString();
  const col1X = getColumnX(1, config).toString();
  const centerY = (config.rowHeight / 2).toString();

  describe('Linear history (single lane, no merges) - Req 1.1, 2.1', () => {
    // C → B → A, all in column 0
    const nodes: ICommitNode[] = [
      makeNode('ccc', ['bbb'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]),
      makeNode('bbb', ['aaa'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]),
      makeNode('aaa', [], 0),
    ];
    const activeLaneMap = computeActiveLanes(nodes);

    it('should render a circle at column 0 for each row', () => {
      for (let i = 0; i < nodes.length; i++) {
        const svg = renderGraphSvg(nodes[i], i, activeLaneMap.get(i)!, config, false, false);
        const circles = extractCircles(svg);
        assert.strictEqual(circles.length, 1, `Row ${i} should have exactly 1 circle`);
        assert.strictEqual(circles[0].cx, col0X, `Row ${i} circle should be at column 0 x`);
        assert.strictEqual(circles[0].cy, centerY, `Row ${i} circle should be at center y`);
      }
    });

    it('should not have any bezier paths (no merges)', () => {
      for (let i = 0; i < nodes.length; i++) {
        const svg = renderGraphSvg(nodes[i], i, activeLaneMap.get(i)!, config, false, false);
        const paths = extractPaths(svg);
        assert.strictEqual(paths.length, 0, `Row ${i} should have no bezier paths`);
      }
    });

    it('should have vertical line segments for lane continuity', () => {
      // Row 0 (first row): should have center-to-bottom segment (has parents)
      const svg0 = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);
      const lines0 = extractLines(svg0);
      assert.ok(lines0.length > 0, 'Row 0 should have vertical line segments');

      // Row 1 (middle row): should have top-to-center and center-to-bottom segments
      const svg1 = renderGraphSvg(nodes[1], 1, activeLaneMap.get(1)!, config, false, false);
      const lines1 = extractLines(svg1);
      assert.ok(
        lines1.length >= 2,
        'Row 1 should have at least 2 vertical line segments (top-to-center and center-to-bottom)'
      );

      // Row 2 (root): should have top-to-center segment (rowIndex > 0) but no center-to-bottom (no parents)
      const svg2 = renderGraphSvg(nodes[2], 2, activeLaneMap.get(2)!, config, false, false);
      const lines2 = extractLines(svg2);
      assert.ok(
        lines2.length >= 1,
        'Row 2 should have at least 1 vertical line segment (top-to-center)'
      );
    });
  });

  describe('Single merge (two lanes converging) - Req 1.2, 3.1', () => {
    // M (merge of P1 and P2), P1, P2
    // M at column 0, P1 at column 0, P2 at column 1
    const nodes: ICommitNode[] = [
      makeNode('mmm', ['p1p', 'p2p'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 1, type: 'merge' },
      ]),
      makeNode('p1p', [], 0),
      makeNode('p2p', [], 1),
    ];
    const activeLaneMap = computeActiveLanes(nodes);

    it('should render a bezier path for the merge line (col 0 to col 1)', () => {
      const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 1, 'Merge commit should have exactly 1 bezier path');
      // The path should connect from col 0 x to col 1 x
      assert.ok(paths[0].d.includes(col0X), 'Path should start at column 0 x');
      assert.ok(paths[0].d.includes(col1X), 'Path should end at column 1 x');
    });

    it('should render the merge commit as a diamond (rotated rect) with white stroke (Req 1.2)', () => {
      const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);
      const rects = extractRects(svg);
      assert.strictEqual(rects.length, 1, 'Should have exactly 1 rect (diamond) for merge commit');
      // Diamond should have white stroke
      assert.strictEqual(rects[0].stroke, '#ffffff', 'Merge diamond should have white stroke');
      // Diamond should be rotated 45 degrees
      assert.ok(rects[0].transform.includes('rotate(45'), 'Merge diamond should be rotated 45°');
      // Diamond should have side length nodeRadius * 1.8
      const expectedSide = (config.nodeRadius * 1.8).toString();
      assert.strictEqual(rects[0].width, expectedSide, 'Diamond width should be nodeRadius * 1.8');
      assert.strictEqual(
        rects[0].height,
        expectedSide,
        'Diamond height should be nodeRadius * 1.8'
      );
      // Merge commit should NOT have a circle
      const circles = extractCircles(svg);
      assert.strictEqual(circles.length, 0, 'Merge commit should not have a circle');
    });

    it('should render non-merge parent commits without contrasting stroke', () => {
      const svgP1 = renderGraphSvg(nodes[1], 1, activeLaneMap.get(1)!, config, false, false);
      const circlesP1 = extractCircles(svgP1);
      assert.strictEqual(circlesP1.length, 1);
      assert.strictEqual(
        circlesP1[0].fill,
        circlesP1[0].stroke,
        'Non-merge commit should have matching fill and stroke'
      );

      const svgP2 = renderGraphSvg(nodes[2], 2, activeLaneMap.get(2)!, config, false, false);
      const circlesP2 = extractCircles(svgP2);
      assert.strictEqual(circlesP2.length, 1);
      assert.strictEqual(
        circlesP2[0].fill,
        circlesP2[0].stroke,
        'Non-merge commit should have matching fill and stroke'
      );
    });
  });

  describe('Topmost merge commit pass-through guard (Bug B)', () => {
    // A merge commit at row 0 whose second parent lives on lane 1. The merge
    // line {from:0, to:1} forces lane 1 active at row 0 so the bezier has a
    // landing lane. Before the fix, the pass-through loop drew a stub from
    // y=0 down to centerY at lane 1's x — a detached blue line floating above
    // the merge commit, because nothing exists above row 0 to connect to.
    const node = makeNode('mmm', ['p1p', 'p2p'], 0, [
      { fromColumn: 0, toColumn: 0, type: 'commit' },
      { fromColumn: 0, toColumn: 1, type: 'merge' },
    ]);
    // activeLanes at row 0 includes both the commit's own lane (0) and the
    // merge target lane (1) — matches what computeActiveLanes produces.
    const activeLanes = new Set<number>([0, 1]);
    const lane1X = getColumnX(1, config).toString();

    it('emits no y1="0" pass-through line for the merged-in lane at row 0', () => {
      const svg = renderGraphSvg(node, 0, activeLanes, config, false, false);
      const lines = extractLines(svg);

      // No line that both starts at the very top (y1=0) AND sits on lane 1's
      // column may be emitted at row 0 — that's the phantom stub.
      const phantomStubs = lines.filter((l) => l.y1 === '0' && l.x1 === lane1X);
      assert.strictEqual(
        phantomStubs.length,
        0,
        `expected no y1="0" stub on lane 1 at row 0, found ${phantomStubs.length}`
      );
    });

    it('still draws the bezier connecting the merge commit to lane 1', () => {
      const svg = renderGraphSvg(node, 0, activeLanes, config, false, false);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 1, 'the merge bezier must still render');
      assert.ok(paths[0].d.includes(lane1X), 'bezier should target lane 1');
    });
  });

  describe('Merge-in lane born at a mid-graph merge row (no spurious top stub)', () => {
    // A merge commit M sits at row 1 (NOT the topmost row, so the
    // `rowIndex === 0` guard does not apply). Its second-parent lane (lane 1)
    // is BORN at the merge row and runs DOWNWARD to P2; it has no history
    // above the merge. Topology:
    //   row 0: C  (child of M)          col 0
    //   row 1: M  (merge of P1, P2)     col 0   lines {0->0 commit}, {0->1 merge}
    //   row 2: P2 (second parent)       col 1
    //   row 3: P1 (first parent)        col 0
    // Lane 1 is active at rows 1..2 (born at the merge, runs to P2). Because
    // it ALSO continues below (next row), the below-only logic painted it
    // full height — including a top-half stub (y=0 -> centerY) floating above
    // the diamond, even though nothing exists above the merge on lane 1.
    const nodes: ICommitNode[] = [
      makeNode('ccc', ['mmm'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]),
      makeNode('mmm', ['p1p', 'p2p'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 1, type: 'merge' },
      ]),
      makeNode('p2p', [], 1),
      makeNode('p1p', [], 0),
    ];
    const activeLaneMap = computeActiveLanes(nodes);
    const prevActive = activeLaneMap.get(0)!; // {0}
    const rowActive = activeLaneMap.get(1)!; // {0, 1}
    const nextActive = activeLaneMap.get(2)!; // {0, 1}
    const lane1X = getColumnX(1, config).toString();

    it('emits no y1="0" stub on the merged-in lane at the merge row', () => {
      const svg = renderGraphSvg(
        nodes[1],
        1,
        rowActive,
        config,
        false,
        false,
        new Set(),
        false,
        nextActive,
        new Set(),
        prevActive
      );
      const lines = extractLines(svg);
      // The merged-in lane (1) is born at this row, so no vertical segment
      // starting at the very top (y1=0) may sit on lane 1's column.
      const topStubs = lines.filter((l) => l.y1 === '0' && l.x1 === lane1X);
      assert.strictEqual(
        topStubs.length,
        0,
        `expected no y1="0" stub on the born-here lane 1, found ${topStubs.length}`
      );
    });

    it('still draws the merged-in lane as a bottom-half segment (runs down to P2)', () => {
      const svg = renderGraphSvg(
        nodes[1],
        1,
        rowActive,
        config,
        false,
        false,
        new Set(),
        false,
        nextActive,
        new Set(),
        prevActive
      );
      const lines = extractLines(svg);
      const bottomHalf = lines.filter(
        (l) => l.x1 === lane1X && l.y1 === centerY && l.y2 === config.rowHeight.toString()
      );
      assert.strictEqual(
        bottomHalf.length,
        1,
        'the born-here lane must still draw its bottom half (continues to P2)'
      );
    });

    it('still renders the merge bezier landing on lane 1', () => {
      const svg = renderGraphSvg(
        nodes[1],
        1,
        rowActive,
        config,
        false,
        false,
        new Set(),
        false,
        nextActive,
        new Set(),
        prevActive
      );
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 1, 'the merge bezier must still render');
      assert.ok(paths[0].d.includes(lane1X), 'bezier should target lane 1');
    });
  });

  describe('Genuine through-lane (active above AND below) stays full height', () => {
    // A commit X on lane 1 with a mainline lane 0 transiting the row — lane 0
    // is active above and below and is NOT a bezier target, so it must keep
    // its FULL-height stroke (the documented no-gap / no-disconnect case).
    const nodeX = makeNode('xxx', ['par'], 1, [{ fromColumn: 1, toColumn: 1, type: 'commit' }]);
    const prevActive = new Set<number>([0, 1]);
    const rowActive = new Set<number>([0, 1]);
    const nextActive = new Set<number>([0, 1]);
    const lane0X = getColumnX(0, config).toString();

    it('draws lane 0 full height when it continues both above and below', () => {
      const svg = renderGraphSvg(
        nodeX,
        1,
        rowActive,
        config,
        false,
        false,
        new Set(),
        false,
        nextActive,
        new Set(),
        prevActive
      );
      const lines = extractLines(svg);
      const fullHeight = lines.filter(
        (l) => l.x1 === lane0X && l.y1 === '0' && l.y2 === config.rowHeight.toString()
      );
      assert.strictEqual(
        fullHeight.length,
        1,
        'a through-lane active above and below must remain full height'
      );
    });
  });

  describe('Diamond merge pattern - Req 1.1, 1.2, 3.1', () => {
    // M → (B, C) → A
    // M at col 0, B at col 0, C at col 1, A at col 0
    const nodes: ICommitNode[] = [
      makeNode('mmm', ['bbb', 'ccc'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 1, type: 'merge' },
      ]),
      makeNode('bbb', ['aaa'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]),
      makeNode('ccc', ['aaa'], 1, [{ fromColumn: 1, toColumn: 0, type: 'branch' }]),
      makeNode('aaa', [], 0),
    ];
    const activeLaneMap = computeActiveLanes(nodes);

    it('should render a merge bezier path on the merge commit row (M)', () => {
      const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 1, 'M should have 1 bezier path (merge line)');
    });

    it('should render a branch bezier path on C (col 1 → col 0)', () => {
      const svg = renderGraphSvg(nodes[2], 2, activeLaneMap.get(2)!, config, false, false);
      const paths = extractPaths(svg);
      assert.strictEqual(
        paths.length,
        1,
        'C should have 1 bezier path (branch line back to col 0)'
      );
      // The path should connect from col 1 x to col 0 x
      assert.ok(paths[0].d.includes(col1X), 'Path should include column 1 x');
      assert.ok(paths[0].d.includes(col0X), 'Path should include column 0 x');
    });

    it('should have no bezier paths on B (same-lane commit line)', () => {
      const svg = renderGraphSvg(nodes[1], 1, activeLaneMap.get(1)!, config, false, false);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 0, 'B should have no bezier paths (same-lane line)');
    });

    it('should render a diamond on the merge row and a circle on every other row', () => {
      // Row 0 is the merge commit — should have a diamond (rect), not a circle
      const svg0 = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);
      const rects0 = extractRects(svg0);
      const circles0 = extractCircles(svg0);
      assert.strictEqual(rects0.length, 1, 'Merge row should have exactly 1 diamond rect');
      assert.strictEqual(circles0.length, 0, 'Merge row should have no circles');

      // Rows 1-3 are non-merge commits — should have circles
      for (let i = 1; i < nodes.length; i++) {
        const svg = renderGraphSvg(nodes[i], i, activeLaneMap.get(i)!, config, false, false);
        const circles = extractCircles(svg);
        assert.strictEqual(circles.length, 1, `Row ${i} should have exactly 1 circle`);
      }
    });
  });

  describe('Root commit (no parents) - Req 1.1', () => {
    const nodes: ICommitNode[] = [makeNode('root', [], 0)];
    const activeLaneMap = computeActiveLanes(nodes);

    it('should produce valid SVG wrapping', () => {
      const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);
      assert.ok(svg.startsWith('<svg'), 'SVG should start with <svg');
      assert.ok(svg.endsWith('</svg>'), 'SVG should end with </svg>');
    });

    it('should render a circle for the root commit', () => {
      const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);
      const circles = extractCircles(svg);
      assert.strictEqual(circles.length, 1, 'Root commit should have exactly 1 circle');
      assert.strictEqual(circles[0].cx, col0X);
      assert.strictEqual(circles[0].cy, centerY);
    });

    it('should not have a center-to-bottom vertical line (no parents)', () => {
      const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);
      const lines = extractLines(svg);
      // Root commit at row 0: no top-to-center (rowIndex === 0) and no center-to-bottom (no parents)
      assert.strictEqual(
        lines.length,
        0,
        'Root commit at row 0 should have no vertical line segments'
      );
    });

    it('should not have any bezier paths', () => {
      const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 0, 'Root commit should have no bezier paths');
    });
  });

  describe('Default config minimum spacing', () => {
    it('should have columnWidth >= 20 (Req 4.1)', () => {
      assert.ok(
        DEFAULT_GRAPH_CONFIG.columnWidth >= 20,
        `columnWidth ${DEFAULT_GRAPH_CONFIG.columnWidth} should be >= 20`
      );
    });

    it('should have rowHeight >= 24 (Req 4.2)', () => {
      assert.ok(
        DEFAULT_GRAPH_CONFIG.rowHeight >= 24,
        `rowHeight ${DEFAULT_GRAPH_CONFIG.rowHeight} should be >= 24`
      );
    });

    it('should have padding >= 10 (Req 4.4)', () => {
      assert.ok(
        DEFAULT_GRAPH_CONFIG.padding >= 10,
        `padding ${DEFAULT_GRAPH_CONFIG.padding} should be >= 10`
      );
    });
  });

  describe('Color palette has at least 8 entries - Req 5.2', () => {
    it('should return at least 8 distinct colors for indices 0-7', () => {
      const colors = new Set<string>();
      for (let i = 0; i < 8; i++) {
        colors.add(getColumnColor(i));
      }
      assert.ok(
        colors.size >= 8,
        `Expected at least 8 distinct colors, got ${colors.size}: ${[...colors].join(', ')}`
      );
    });

    it('should return hex color strings starting with #', () => {
      for (let i = 0; i < 8; i++) {
        const color = getColumnColor(i);
        assert.ok(color.startsWith('#'), `Color at index ${i} should start with #, got: ${color}`);
      }
    });
  });
});

// ============================================================
// Unit tests for branch split icon rendering
// ============================================================

describe('Graph Renderer - Branch Split Icon (Req 3.2, 3.4, 3.5, 3.6)', () => {
  const config = DEFAULT_GRAPH_CONFIG;
  const col0X = getColumnX(0, config);
  const centerYNum = config.rowHeight / 2;

  describe('Branch split commit (non-merge, isBranchSplitPoint=true)', () => {
    // A single commit at column 0 with one parent, flagged as branch split
    const node = makeNode('aaa', ['bbb'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]);
    const activeLanes = new Set([0]);

    it('should render a filled circle at the commit position (Req 3.4)', () => {
      const svg = renderGraphSvg(node, 1, activeLanes, config, false, true);
      const circles = extractCircles(svg);
      assert.strictEqual(circles.length, 1, 'Branch split should have exactly 1 circle');
      assert.strictEqual(circles[0].cx, col0X.toString());
      assert.strictEqual(circles[0].cy, centerYNum.toString());
      assert.strictEqual(circles[0].r, config.nodeRadius.toString());
    });

    it('should render two tick mark lines from the bottom of the circle (Req 3.4)', () => {
      const svg = renderGraphSvg(node, 1, activeLanes, config, false, true);
      const lines = extractLines(svg);
      // There should be vertical line segments (top-to-center, center-to-bottom) plus 2 tick marks = 4 lines
      // Filter for tick marks: they start at the bottom of the circle (cx, cy + nodeRadius)
      const bottomCY = centerYNum + config.nodeRadius;
      const tickLines = lines.filter(
        (l) => parseFloat(l.x1) === col0X && parseFloat(l.y1) === bottomCY
      );
      assert.strictEqual(
        tickLines.length,
        2,
        'Should have exactly 2 tick mark lines from bottom of circle'
      );
    });

    it('should use lane color for tick marks (Req 3.5)', () => {
      const svg = renderGraphSvg(node, 1, activeLanes, config, false, true);
      const lines = extractLines(svg);
      const bottomCY = centerYNum + config.nodeRadius;
      const tickLines = lines.filter(
        (l) => parseFloat(l.x1) === col0X && parseFloat(l.y1) === bottomCY
      );
      const expectedColor = getColumnColor(0);
      for (const tick of tickLines) {
        assert.strictEqual(tick.stroke, expectedColor, 'Tick mark should use lane color');
      }
    });

    it('should have tick marks at ±30° angles from bottom of circle', () => {
      const svg = renderGraphSvg(node, 1, activeLanes, config, false, true);
      const lines = extractLines(svg);
      const bottomCY = centerYNum + config.nodeRadius;
      const tickLines = lines.filter(
        (l) => parseFloat(l.x1) === col0X && parseFloat(l.y1) === bottomCY
      );
      assert.strictEqual(tickLines.length, 2);

      const tickLength = config.nodeRadius * 0.8;
      const angle = Math.PI / 6; // 30 degrees

      // Left tick: x2 < x1 (goes left)
      const leftTick = tickLines.find((l) => parseFloat(l.x2) < col0X);
      assert.ok(leftTick, 'Should have a left tick mark');
      const expectedLeftX = col0X - tickLength * Math.sin(angle);
      const expectedLeftY = bottomCY + tickLength * Math.cos(angle);
      assert.ok(
        Math.abs(parseFloat(leftTick.x2) - expectedLeftX) < 0.001,
        `Left tick x2 should be ~${expectedLeftX}, got ${leftTick.x2}`
      );
      assert.ok(
        Math.abs(parseFloat(leftTick.y2) - expectedLeftY) < 0.001,
        `Left tick y2 should be ~${expectedLeftY}, got ${leftTick.y2}`
      );

      // Right tick: x2 > x1 (goes right)
      const rightTick = tickLines.find((l) => parseFloat(l.x2) > col0X);
      assert.ok(rightTick, 'Should have a right tick mark');
      const expectedRightX = col0X + tickLength * Math.sin(angle);
      const expectedRightY = bottomCY + tickLength * Math.cos(angle);
      assert.ok(
        Math.abs(parseFloat(rightTick.x2) - expectedRightX) < 0.001,
        `Right tick x2 should be ~${expectedRightX}, got ${rightTick.x2}`
      );
      assert.ok(
        Math.abs(parseFloat(rightTick.y2) - expectedRightY) < 0.001,
        `Right tick y2 should be ~${expectedRightY}, got ${rightTick.y2}`
      );
    });

    it('should NOT render a diamond (rect) for branch split', () => {
      const svg = renderGraphSvg(node, 1, activeLanes, config, false, true);
      const rects = extractRects(svg);
      assert.strictEqual(rects.length, 0, 'Branch split should not have a diamond rect');
    });
  });

  describe('Merge precedence over branch split (Req 3.6)', () => {
    // A merge commit (2 parents) that is also a branch split point
    const mergeAndSplitNode = makeNode('mmm', ['p1p', 'p2p'], 0, [
      { fromColumn: 0, toColumn: 0, type: 'commit' },
      { fromColumn: 0, toColumn: 1, type: 'merge' },
    ]);
    const activeLanes = new Set([0, 1]);

    it('should render diamond (merge icon) when commit is both merge and branch split', () => {
      const svg = renderGraphSvg(mergeAndSplitNode, 0, activeLanes, config, false, true);
      const rects = extractRects(svg);
      assert.strictEqual(rects.length, 1, 'Should have exactly 1 diamond rect for merge');
      assert.ok(rects[0].transform.includes('rotate(45'), 'Diamond should be rotated 45°');
    });

    it('should NOT render tick marks when commit is both merge and branch split', () => {
      const svg = renderGraphSvg(mergeAndSplitNode, 0, activeLanes, config, false, true);
      const lines = extractLines(svg);
      const bottomCY = centerYNum + config.nodeRadius;
      const tickLines = lines.filter(
        (l) => parseFloat(l.x1) === col0X && parseFloat(l.y1) === bottomCY
      );
      assert.strictEqual(
        tickLines.length,
        0,
        'Merge+split should not have tick marks (merge precedence)'
      );
    });

    it('should NOT render a plain circle when commit is both merge and branch split', () => {
      const svg = renderGraphSvg(mergeAndSplitNode, 0, activeLanes, config, false, true);
      const circles = extractCircles(svg);
      assert.strictEqual(circles.length, 0, 'Merge+split should not have a plain circle');
    });
  });

  describe('Normal commit (not merge, not branch split)', () => {
    const normalNode = makeNode('nnn', ['ppp'], 0, [
      { fromColumn: 0, toColumn: 0, type: 'commit' },
    ]);
    const activeLanes = new Set([0]);

    it('should render a plain circle without tick marks', () => {
      const svg = renderGraphSvg(normalNode, 1, activeLanes, config, false, false);
      const circles = extractCircles(svg);
      assert.strictEqual(circles.length, 1, 'Normal commit should have exactly 1 circle');

      // No tick marks from bottom of circle
      const lines = extractLines(svg);
      const bottomCY = centerYNum + config.nodeRadius;
      const tickLines = lines.filter(
        (l) => parseFloat(l.x1) === col0X && parseFloat(l.y1) === bottomCY
      );
      assert.strictEqual(tickLines.length, 0, 'Normal commit should not have tick marks');
    });

    it('should not render a diamond', () => {
      const svg = renderGraphSvg(normalNode, 1, activeLanes, config, false, false);
      const rects = extractRects(svg);
      assert.strictEqual(rects.length, 0, 'Normal commit should not have a diamond rect');
    });
  });

  describe('Branch split at different columns', () => {
    it('should render branch split icon at column 2 with correct lane color', () => {
      const node = makeNode('aaa', ['bbb'], 2, [{ fromColumn: 2, toColumn: 2, type: 'commit' }]);
      const activeLanes = new Set([0, 1, 2]);
      const svg = renderGraphSvg(node, 1, activeLanes, config, false, true);

      const col2X = getColumnX(2, config);
      const expectedColor = getColumnColor(2);

      const circles = extractCircles(svg);
      // Find the branch split circle (at column 2)
      const splitCircle = circles.find(
        (c) => parseFloat(c.cx) === col2X && c.r === config.nodeRadius.toString()
      );
      assert.ok(splitCircle, 'Should have a circle at column 2');
      assert.strictEqual(
        splitCircle.fill,
        expectedColor,
        'Circle fill should use column 2 lane color'
      );

      // Check tick marks exist at column 2
      const lines = extractLines(svg);
      const bottomCY = centerYNum + config.nodeRadius;
      const tickLines = lines.filter(
        (l) => parseFloat(l.x1) === col2X && parseFloat(l.y1) === bottomCY
      );
      assert.strictEqual(tickLines.length, 2, 'Should have 2 tick marks at column 2');
      for (const tick of tickLines) {
        assert.strictEqual(tick.stroke, expectedColor, 'Tick marks should use column 2 lane color');
      }
    });
  });
});

// ============================================================
// Unit tests for terminal node icon rendering
// ============================================================

describe('Graph Renderer - Terminal Node Icon (Req 2.1, 2.2)', () => {
  const config = DEFAULT_GRAPH_CONFIG;
  const col0X = getColumnX(0, config);
  const centerYNum = config.rowHeight / 2;

  /**
   * Helper to extract ring circles (stroke-only, no fill) from SVG.
   * These have fill="none" and a stroke-width of "1.5".
   */
  function extractRingCircles(svg: string) {
    const regex =
      /<circle\s+cx="([^"]+)"\s+cy="([^"]+)"\s+r="([^"]+)"\s+fill="none"\s+stroke="([^"]+)"\s+stroke-width="1\.5"\s*\/>/g;
    const rings: Array<{ cx: string; cy: string; r: string; stroke: string }> = [];
    let match;
    while ((match = regex.exec(svg)) !== null) {
      rings.push({ cx: match[1], cy: match[2], r: match[3], stroke: match[4] });
    }
    return rings;
  }

  describe('Terminal node (isTerminal=true, non-merge, non-split)', () => {
    // A terminal commit at column 0 with one parent, at row 1 (not first row)
    const node = makeNode('term', ['parent1'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]);
    const activeLanes = new Set([0]);

    it('should NOT render a top-to-center vertical line (Req 2.2)', () => {
      const svg = renderGraphSvg(node, 1, activeLanes, config, true, false);
      const lines = extractLines(svg);
      // There should be no line from y=0 to y=centerY at the commit's column
      const topToCenterLines = lines.filter(
        (l) =>
          parseFloat(l.x1) === col0X &&
          parseFloat(l.y1) === 0 &&
          parseFloat(l.x2) === col0X &&
          parseFloat(l.y2) === centerYNum
      );
      assert.strictEqual(
        topToCenterLines.length,
        0,
        'Terminal node should NOT have a top-to-center vertical line'
      );
    });

    it('should still render a center-to-bottom vertical line (has parents)', () => {
      const svg = renderGraphSvg(node, 1, activeLanes, config, true, false);
      const lines = extractLines(svg);
      const centerToBottomLines = lines.filter(
        (l) =>
          parseFloat(l.x1) === col0X &&
          parseFloat(l.y1) === centerYNum &&
          parseFloat(l.x2) === col0X &&
          parseFloat(l.y2) === config.rowHeight
      );
      assert.strictEqual(
        centerToBottomLines.length,
        1,
        'Terminal node with parents should have center-to-bottom line'
      );
    });

    it('should render a filled circle at the commit position (Req 2.1)', () => {
      const svg = renderGraphSvg(node, 1, activeLanes, config, true, false);
      const circles = extractCircles(svg);
      // Terminal node renders 3 circles: bg circle at ringRadius, white-stroke ring (fill="none", not matched here),
      // and inner filled circle at nodeRadius. extractCircles matches filled circles only (fill !== "none").
      const filledCircles = circles.filter((c) => c.fill !== 'none');
      // There should be a bg circle (ringRadius) and an inner circle (nodeRadius)
      assert.ok(
        filledCircles.length >= 2,
        `Terminal node should have at least 2 filled circles (bg + inner), got ${filledCircles.length}`
      );
      // The inner circle should have r === nodeRadius
      const innerCircle = filledCircles.find((c) => c.r === config.nodeRadius.toString());
      assert.ok(innerCircle, 'Terminal node should have an inner filled circle at nodeRadius');
      assert.strictEqual(innerCircle.cx, col0X.toString());
      assert.strictEqual(innerCircle.cy, centerYNum.toString());
    });

    it('should render an outer ring circle with radius nodeRadius + 2 (Req 2.1)', () => {
      const svg = renderGraphSvg(node, 1, activeLanes, config, true, false);
      const rings = extractRingCircles(svg);
      assert.strictEqual(rings.length, 1, 'Terminal node should have exactly 1 outer ring circle');
      const expectedRingRadius = (config.nodeRadius + 2).toString();
      assert.strictEqual(
        rings[0].r,
        expectedRingRadius,
        `Ring radius should be nodeRadius + 2 = ${expectedRingRadius}`
      );
      assert.strictEqual(rings[0].cx, col0X.toString(), 'Ring should be centered at commit x');
      assert.strictEqual(rings[0].cy, centerYNum.toString(), 'Ring should be centered at commit y');
    });

    it('should use white stroke for the outer ring (contrasting border)', () => {
      const svg = renderGraphSvg(node, 1, activeLanes, config, true, false);
      const rings = extractRingCircles(svg);
      // The outer ring now uses a white stroke for contrast, with a filled bg circle behind it in lane color
      assert.strictEqual(rings[0].stroke, '#ffffff', 'Ring stroke should be white for contrast');
      // Verify the bg circle behind the ring uses the lane color
      const circles = extractCircles(svg);
      const expectedColor = getColumnColor(0);
      const ringRadius = (config.nodeRadius + 2).toString();
      const bgCircle = circles.find((c) => c.r === ringRadius && c.fill === expectedColor);
      assert.ok(bgCircle, 'Should have a background circle at ring radius with lane color fill');
    });
  });

  describe('Non-terminal node (isTerminal=false) at row > 0', () => {
    const node = makeNode('nterm', ['parent1'], 0, [
      { fromColumn: 0, toColumn: 0, type: 'commit' },
    ]);
    const activeLanes = new Set([0]);

    it('should render a top-to-center vertical line', () => {
      const svg = renderGraphSvg(node, 1, activeLanes, config, false, false);
      const lines = extractLines(svg);
      const topToCenterLines = lines.filter(
        (l) =>
          parseFloat(l.x1) === col0X &&
          parseFloat(l.y1) === 0 &&
          parseFloat(l.x2) === col0X &&
          parseFloat(l.y2) === centerYNum
      );
      assert.strictEqual(
        topToCenterLines.length,
        1,
        'Non-terminal node should have a top-to-center vertical line'
      );
    });

    it('should NOT render an outer ring circle', () => {
      const svg = renderGraphSvg(node, 1, activeLanes, config, false, false);
      const rings = extractRingCircles(svg);
      assert.strictEqual(rings.length, 0, 'Non-terminal node should not have an outer ring circle');
    });
  });

  describe('Terminal node at row 0 (first row)', () => {
    const node = makeNode('term0', ['parent1'], 0, [
      { fromColumn: 0, toColumn: 0, type: 'commit' },
    ]);
    const activeLanes = new Set([0]);

    it('should NOT render a top-to-center line (row 0 never has one)', () => {
      const svg = renderGraphSvg(node, 0, activeLanes, config, true, false);
      const lines = extractLines(svg);
      const topToCenterLines = lines.filter(
        (l) =>
          parseFloat(l.x1) === col0X &&
          parseFloat(l.y1) === 0 &&
          parseFloat(l.x2) === col0X &&
          parseFloat(l.y2) === centerYNum
      );
      assert.strictEqual(
        topToCenterLines.length,
        0,
        'Terminal node at row 0 should not have top-to-center line'
      );
    });

    it('should render the outer ring circle', () => {
      const svg = renderGraphSvg(node, 0, activeLanes, config, true, false);
      const rings = extractRingCircles(svg);
      assert.strictEqual(rings.length, 1, 'Terminal node at row 0 should have outer ring');
    });
  });

  describe('Terminal node that is also a root commit (no parents)', () => {
    const node = makeNode('termroot', [], 0);
    const activeLanes = new Set([0]);

    it('should have no vertical line segments at all', () => {
      const svg = renderGraphSvg(node, 0, activeLanes, config, true, false);
      const lines = extractLines(svg);
      // Filter for lines at the commit's column
      const commitLines = lines.filter(
        (l) => parseFloat(l.x1) === col0X && parseFloat(l.x2) === col0X
      );
      assert.strictEqual(
        commitLines.length,
        0,
        'Terminal root commit should have no vertical lines'
      );
    });

    it('should render the filled circle and outer ring', () => {
      const svg = renderGraphSvg(node, 0, activeLanes, config, true, false);
      const circles = extractCircles(svg);
      // Terminal node has bg circle (ringRadius) + inner circle (nodeRadius) as filled circles
      const filledCircles = circles.filter((c) => c.fill !== 'none');
      const rings = extractRingCircles(svg);
      assert.ok(
        filledCircles.length >= 2,
        `Should have at least 2 filled circles (bg + inner), got ${filledCircles.length}`
      );
      assert.strictEqual(rings.length, 1, 'Should have 1 outer ring');
    });
  });

  describe('Terminal merge commit (isTerminal=true, merge)', () => {
    // A merge commit that is also terminal
    const mergeNode = makeNode('tmerge', ['p1', 'p2'], 0, [
      { fromColumn: 0, toColumn: 0, type: 'commit' },
      { fromColumn: 0, toColumn: 1, type: 'merge' },
    ]);
    const activeLanes = new Set([0, 1]);

    it('should render diamond icon (merge) with outer ring', () => {
      const svg = renderGraphSvg(mergeNode, 1, activeLanes, config, true, false);
      const rects = extractRects(svg);
      const rings = extractRingCircles(svg);
      assert.strictEqual(rects.length, 1, 'Terminal merge should have diamond');
      assert.strictEqual(rings.length, 1, 'Terminal merge should have outer ring');
    });

    it('should NOT render top-to-center line', () => {
      const svg = renderGraphSvg(mergeNode, 1, activeLanes, config, true, false);
      const lines = extractLines(svg);
      const topToCenterLines = lines.filter(
        (l) =>
          parseFloat(l.x1) === col0X &&
          parseFloat(l.y1) === 0 &&
          parseFloat(l.x2) === col0X &&
          parseFloat(l.y2) === centerYNum
      );
      assert.strictEqual(
        topToCenterLines.length,
        0,
        'Terminal merge should not have top-to-center line'
      );
    });
  });

  describe('Terminal node at different column', () => {
    it('should render ring at the correct column position', () => {
      const node = makeNode('tcol2', ['parent1'], 2, [
        { fromColumn: 2, toColumn: 2, type: 'commit' },
      ]);
      const activeLanes = new Set([0, 1, 2]);
      const col2X = getColumnX(2, config);
      const expectedColor = getColumnColor(2);

      const svg = renderGraphSvg(node, 1, activeLanes, config, true, false);

      // Helper to extract ring circles
      const ringRegex =
        /<circle\s+cx="([^"]+)"\s+cy="([^"]+)"\s+r="([^"]+)"\s+fill="none"\s+stroke="([^"]+)"\s+stroke-width="1\.5"\s*\/>/g;
      const rings: Array<{ cx: string; cy: string; r: string; stroke: string }> = [];
      let match;
      while ((match = ringRegex.exec(svg)) !== null) {
        rings.push({ cx: match[1], cy: match[2], r: match[3], stroke: match[4] });
      }

      assert.strictEqual(rings.length, 1, 'Should have 1 outer ring');
      assert.strictEqual(rings[0].cx, col2X.toString(), 'Ring should be at column 2 x');
      assert.strictEqual(rings[0].stroke, '#ffffff', 'Ring should use white stroke for contrast');
      // Verify the bg circle behind the ring uses column 2 lane color
      const circleRegex2 =
        /<circle\s+cx="([^"]+)"\s+cy="([^"]+)"\s+r="([^"]+)"\s+fill="([^"]+)"\s+stroke="([^"]+)"\s+stroke-width="[^"]+"\s*\/>/g;
      const allCircles: Array<{ cx: string; r: string; fill: string }> = [];
      let match2;
      while ((match2 = circleRegex2.exec(svg)) !== null) {
        allCircles.push({ cx: match2[1], r: match2[3], fill: match2[4] });
      }
      const ringRadius = (config.nodeRadius + 2).toString();
      const bgCircle = allCircles.find(
        (c) => c.cx === col2X.toString() && c.r === ringRadius && c.fill === expectedColor
      );
      assert.ok(
        bgCircle,
        'Should have a background circle at ring radius with column 2 lane color'
      );
    });
  });
});

// ============================================================
// Unit tests for bezier curve connectivity
// ============================================================

describe('Graph Renderer - Bezier Curve Connectivity (Req 3.7, 3.8)', () => {
  const config = DEFAULT_GRAPH_CONFIG;
  const centerY = config.rowHeight / 2;
  const bottomY = config.rowHeight;

  /**
   * Parse a bezier path "M fromX,fromY C cp1x,cp1y cp2x,cp2y toX,toY"
   * and return the start and end coordinates.
   */
  function parseBezierPath(
    d: string
  ): { startX: number; startY: number; endX: number; endY: number } | null {
    // Match: M <x>,<y> C <x>,<y> <x>,<y> <x>,<y>
    const match = d.match(
      /^M\s+([\d.]+),([\d.]+)\s+C\s+([\d.]+),([\d.]+)\s+([\d.]+),([\d.]+)\s+([\d.]+),([\d.]+)$/
    );
    if (!match) {
      return null;
    }
    return {
      startX: parseFloat(match[1]),
      startY: parseFloat(match[2]),
      endX: parseFloat(match[7]),
      endY: parseFloat(match[8]),
    };
  }

  describe('Bezier curves start at (fromX, centerY) and end at (toX, bottomY)', () => {
    it('should start at (getColumnX(fromColumn), centerY) for a merge line from col 0 to col 1', () => {
      const node = makeNode('mmm', ['p1', 'p2'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 1, type: 'merge' },
      ]);
      const activeLanes = new Set([0, 1]);
      const svg = renderGraphSvg(node, 0, activeLanes, config, false, false);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 1, 'Should have exactly 1 bezier path');

      const parsed = parseBezierPath(paths[0].d);
      assert.ok(parsed, 'Should be able to parse the bezier path');

      const expectedFromX = getColumnX(0, config);
      assert.strictEqual(
        parsed.startX,
        expectedFromX,
        `Bezier should start at fromColumn x (${expectedFromX})`
      );
      assert.strictEqual(parsed.startY, centerY, `Bezier should start at centerY (${centerY})`);
    });

    it('should end at (getColumnX(toColumn), bottomY) for a merge line from col 0 to col 1', () => {
      const node = makeNode('mmm', ['p1', 'p2'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 1, type: 'merge' },
      ]);
      const activeLanes = new Set([0, 1]);
      const svg = renderGraphSvg(node, 0, activeLanes, config, false, false);
      const paths = extractPaths(svg);
      const parsed = parseBezierPath(paths[0].d);
      assert.ok(parsed, 'Should be able to parse the bezier path');

      const expectedToX = getColumnX(1, config);
      assert.strictEqual(
        parsed.endX,
        expectedToX,
        `Bezier should end at toColumn x (${expectedToX})`
      );
      assert.strictEqual(parsed.endY, bottomY, `Bezier should end at bottomY (${bottomY})`);
    });

    it('should have correct start/end for a branch line from col 1 to col 0', () => {
      const node = makeNode('ccc', ['aaa'], 1, [{ fromColumn: 1, toColumn: 0, type: 'branch' }]);
      const activeLanes = new Set([0, 1]);
      const svg = renderGraphSvg(node, 2, activeLanes, config, false, false);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 1, 'Should have exactly 1 bezier path');

      const parsed = parseBezierPath(paths[0].d);
      assert.ok(parsed, 'Should be able to parse the bezier path');

      const expectedFromX = getColumnX(1, config);
      const expectedToX = getColumnX(0, config);
      assert.strictEqual(
        parsed.startX,
        expectedFromX,
        `Bezier should start at col 1 x (${expectedFromX})`
      );
      assert.strictEqual(parsed.startY, centerY, `Bezier should start at centerY (${centerY})`);
      assert.strictEqual(parsed.endX, expectedToX, `Bezier should end at col 0 x (${expectedToX})`);
      assert.strictEqual(parsed.endY, bottomY, `Bezier should end at bottomY (${bottomY})`);
    });

    it('should have correct start/end for a wide merge from col 0 to col 3', () => {
      const node = makeNode('mmm', ['p1', 'p2'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 3, type: 'merge' },
      ]);
      const activeLanes = new Set([0, 1, 2, 3]);
      const svg = renderGraphSvg(node, 0, activeLanes, config, false, false);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 1, 'Should have exactly 1 bezier path');

      const parsed = parseBezierPath(paths[0].d);
      assert.ok(parsed, 'Should be able to parse the bezier path');

      const expectedFromX = getColumnX(0, config);
      const expectedToX = getColumnX(3, config);
      assert.strictEqual(parsed.startX, expectedFromX, `Bezier should start at col 0 x`);
      assert.strictEqual(parsed.startY, centerY, `Bezier should start at centerY`);
      assert.strictEqual(parsed.endX, expectedToX, `Bezier should end at col 3 x`);
      assert.strictEqual(parsed.endY, bottomY, `Bezier should end at bottomY`);
    });
  });

  describe('Vertical pass-through lines span full y=0 to y=rowHeight', () => {
    it('should render pass-through lines from y=0 to y=rowHeight', () => {
      // Node at column 0 with a pass-through lane at column 1
      const node = makeNode('aaa', ['bbb'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]);
      const activeLanes = new Set([0, 1]); // lane 1 is a pass-through
      const svg = renderGraphSvg(node, 1, activeLanes, config, false, false);
      const lines = extractLines(svg);

      const col1X = getColumnX(1, config);
      const passThroughLines = lines.filter(
        (l) =>
          parseFloat(l.x1) === col1X &&
          parseFloat(l.x2) === col1X &&
          parseFloat(l.y1) === 0 &&
          parseFloat(l.y2) === config.rowHeight
      );
      assert.strictEqual(
        passThroughLines.length,
        1,
        'Pass-through lane should have a full-height vertical line from y=0 to y=rowHeight'
      );
    });

    it('should render multiple pass-through lines each spanning full row height', () => {
      // Node at column 0 with pass-through lanes at columns 1 and 2
      const node = makeNode('aaa', ['bbb'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]);
      const activeLanes = new Set([0, 1, 2]); // lanes 1 and 2 are pass-throughs
      const svg = renderGraphSvg(node, 1, activeLanes, config, false, false);
      const lines = extractLines(svg);

      for (const lane of [1, 2]) {
        const laneX = getColumnX(lane, config);
        const passThroughLines = lines.filter(
          (l) =>
            parseFloat(l.x1) === laneX &&
            parseFloat(l.x2) === laneX &&
            parseFloat(l.y1) === 0 &&
            parseFloat(l.y2) === config.rowHeight
        );
        assert.strictEqual(
          passThroughLines.length,
          1,
          `Pass-through lane ${lane} should have a full-height vertical line`
        );
      }
    });
  });

  describe('Seamless row boundary connections (Req 3.8)', () => {
    it('bezier curve end Y should equal rowHeight (where next row vertical lines start at y=0)', () => {
      const node = makeNode('mmm', ['p1', 'p2'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 1, type: 'merge' },
      ]);
      const activeLanes = new Set([0, 1]);
      const svg = renderGraphSvg(node, 0, activeLanes, config, false, false);
      const paths = extractPaths(svg);
      const parsed = parseBezierPath(paths[0].d);
      assert.ok(parsed, 'Should parse bezier path');

      // The bezier ends at bottomY = rowHeight, and the next row's vertical lines start at y=0
      // This means the curve endpoint matches the next row's line start, creating seamless connection
      assert.strictEqual(
        parsed.endY,
        config.rowHeight,
        'Bezier end Y should equal rowHeight for seamless connection'
      );
    });

    it('pass-through vertical lines should start at y=0 (matching previous row bottom)', () => {
      const node = makeNode('aaa', ['bbb'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]);
      const activeLanes = new Set([0, 1]);
      const svg = renderGraphSvg(node, 1, activeLanes, config, false, false);
      const lines = extractLines(svg);

      const col1X = getColumnX(1, config);
      const passThroughLines = lines.filter(
        (l) => parseFloat(l.x1) === col1X && parseFloat(l.x2) === col1X
      );
      assert.ok(passThroughLines.length > 0, 'Should have pass-through line at lane 1');
      assert.strictEqual(
        parseFloat(passThroughLines[0].y1),
        0,
        'Pass-through line should start at y=0'
      );
      assert.strictEqual(
        parseFloat(passThroughLines[0].y2),
        config.rowHeight,
        'Pass-through line should end at y=rowHeight'
      );
    });

    it('same-lane lines should not produce bezier curves (handled by vertical segments)', () => {
      const node = makeNode('aaa', ['bbb'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]);
      const activeLanes = new Set([0]);
      const svg = renderGraphSvg(node, 1, activeLanes, config, false, false);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 0, 'Same-lane lines should not produce bezier curves');
    });
  });

  describe('Multiple bezier curves on a single row', () => {
    it('should render separate bezier curves for each cross-lane graph line', () => {
      // A merge commit with lines going to columns 1 and 2
      const node = makeNode('mmm', ['p1', 'p2', 'p3'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 1, type: 'merge' },
        { fromColumn: 0, toColumn: 2, type: 'merge' },
      ]);
      const activeLanes = new Set([0, 1, 2]);
      const svg = renderGraphSvg(node, 0, activeLanes, config, false, false);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 2, 'Should have 2 bezier paths for 2 cross-lane lines');

      const fromX = getColumnX(0, config);
      const toX1 = getColumnX(1, config);
      const toX2 = getColumnX(2, config);

      // Both paths should start at (fromX, centerY)
      for (const path of paths) {
        const parsed = parseBezierPath(path.d);
        assert.ok(parsed, 'Should parse bezier path');
        assert.strictEqual(parsed.startX, fromX, 'Each bezier should start at fromColumn x');
        assert.strictEqual(parsed.startY, centerY, 'Each bezier should start at centerY');
        assert.strictEqual(parsed.endY, bottomY, 'Each bezier should end at bottomY');
      }

      // One path should end at col 1, the other at col 2
      const endXValues = paths.map((p) => parseBezierPath(p.d)!.endX).sort((a, b) => a - b);
      assert.strictEqual(endXValues[0], toX1, 'First bezier should end at col 1 x');
      assert.strictEqual(endXValues[1], toX2, 'Second bezier should end at col 2 x');
    });
  });

  describe('Bezier curves with custom config', () => {
    it('should use custom config values for coordinates', () => {
      const customConfig: IGraphRenderConfig = {
        columnWidth: 30,
        rowHeight: 48,
        nodeRadius: 6,
        padding: 15,
        lineWidth: 3,
      };
      const customCenterY = customConfig.rowHeight / 2;
      const customBottomY = customConfig.rowHeight;

      const node = makeNode('mmm', ['p1', 'p2'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 1, type: 'merge' },
      ]);
      const activeLanes = new Set([0, 1]);
      const svg = renderGraphSvg(node, 0, activeLanes, customConfig, false, false);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 1, 'Should have 1 bezier path');

      const parsed = parseBezierPath(paths[0].d);
      assert.ok(parsed, 'Should parse bezier path');

      const expectedFromX = getColumnX(0, customConfig);
      const expectedToX = getColumnX(1, customConfig);
      assert.strictEqual(parsed.startX, expectedFromX, 'Bezier start X should use custom config');
      assert.strictEqual(parsed.startY, customCenterY, 'Bezier start Y should use custom centerY');
      assert.strictEqual(parsed.endX, expectedToX, 'Bezier end X should use custom config');
      assert.strictEqual(parsed.endY, customBottomY, 'Bezier end Y should use custom bottomY');
    });
  });
});

describe('Graph Renderer - Dashed off-window stubs (architectural fix #4)', () => {
  // The graph algorithm tags off-window-parent same-lane stubs with
  // style:'dashed'; the renderer must paint them with stroke-dasharray.
  // This is the IntelliJ-parity affordance for "history continues
  // below the loaded window" — solid lines connect to scrollable rows;
  // dashed lines flag rows the user can't reach.
  const config = DEFAULT_GRAPH_CONFIG;

  it('emits stroke-dasharray on the same-lane stub when style:"dashed"', () => {
    // Single commit whose parent is off-window; the graph algorithm
    // emits a same-lane stub with style:'dashed'.
    const nodes: ICommitNode[] = [
      makeNode('child', ['off-window-parent'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit', style: 'dashed' },
      ]),
    ];
    const activeLaneMap = computeActiveLanes(nodes);
    const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);

    assert.ok(
      /stroke-dasharray="[^"]+"/.test(svg),
      `dashed off-window stub must emit stroke-dasharray; got SVG: ${svg}`
    );
  });

  it('does NOT emit stroke-dasharray for solid (in-window) lines', () => {
    // Linear in-window history — both lines are solid (no style field).
    const nodes: ICommitNode[] = [
      makeNode('child', ['parent'], 0, [{ fromColumn: 0, toColumn: 0, type: 'commit' }]),
      makeNode('parent', [], 0),
    ];
    const activeLaneMap = computeActiveLanes(nodes);
    const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);

    assert.ok(
      !/stroke-dasharray/.test(svg),
      `solid in-window edges must NOT carry stroke-dasharray; got SVG: ${svg}`
    );
  });

  it('keeps the same-lane stub SOLID when the first parent is in-window even if a second parent is off-window', () => {
    // Merge whose parents[0] is IN-window (solid same-lane line) and
    // parents[1] is OFF-window (dashed same-lane stub). The mainline
    // continues straight down to p1 — a real, scrollable row — so the
    // vertical stub MUST be solid, not dashed. The off-window second
    // parent is visually absorbed into the solid mainline stub (it has
    // no row to land on). Regression guard: an earlier `.some(dashed)`
    // rule dashed the solid mainline here.
    const nodes: ICommitNode[] = [
      makeNode('m', ['p1', 'off-window-p2'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 0, type: 'merge', style: 'dashed' },
      ]),
      makeNode('p1', [], 0),
    ];
    const activeLaneMap = computeActiveLanes(nodes);
    const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);

    assert.ok(
      !/stroke-dasharray/.test(svg),
      `mainline stub with an in-window first parent must stay SOLID; got SVG: ${svg}`
    );
  });

  it('emits stroke-dasharray only when EVERY same-lane parent is off-window', () => {
    // The bottom row of the loaded window whose sole parent fell off the
    // slice — a single dashed same-lane stub, no in-window continuation.
    // This is the genuine "history continues below" case.
    const nodes: ICommitNode[] = [
      makeNode('child', ['off-window-parent'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit', style: 'dashed' },
      ]),
    ];
    const activeLaneMap = computeActiveLanes(nodes);
    const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);

    assert.ok(
      /stroke-dasharray="[^"]+"/.test(svg),
      `an all-off-window same-lane stub must be dashed; got SVG: ${svg}`
    );
  });
});

describe('Graph Renderer - bending-edge color matches line type (node/line color match)', () => {
  // Reported: a "squash test" commit rendered with a BLUE node but an
  // ORANGE outgoing line; a HEAD commit with a GREEN node but a BLUE+ORANGE
  // line. Root cause: the bezier renderer colored EVERY bending edge by its
  // destination lane. A commit's own first-parent ('commit') edge that
  // bends to a parent on another lane must keep the SOURCE (node) color so
  // node and its own outgoing line agree; only 'merge'/'branch' edges (a
  // 2nd+ parent joining another branch) take the destination color.
  const config = DEFAULT_GRAPH_CONFIG;

  it("a first-parent ('commit') edge that bends uses the SOURCE lane color (matches the node)", () => {
    // Node on lane 1 (blue), first-parent edge bends 1 -> 0 (green dest).
    // The edge must be drawn in the SOURCE color (lane 1 = blue), matching
    // the node, NOT the green destination.
    const nodes: ICommitNode[] = [
      makeNode('n', ['p'], 1, [{ fromColumn: 1, toColumn: 0, type: 'commit' }]),
      makeNode('p', [], 0),
    ];
    const activeLaneMap = computeActiveLanes(nodes);
    const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);

    const sourceColor = getColumnColor(1); // node / lane 1
    const destColor = getColumnColor(0); // lane 0
    // The bending <path> must carry the SOURCE color.
    const pathMatch = svg.match(/<path[^>]*stroke="(#[0-9A-Fa-f]+)"/);
    assert.ok(pathMatch, `expected a bezier <path>; got SVG: ${svg}`);
    assert.strictEqual(
      pathMatch[1],
      sourceColor,
      `first-parent bending edge must use the source/node color ${sourceColor}, not dest ${destColor}; got ${pathMatch[1]}`
    );
  });

  it("a 'merge' edge that bends uses the DESTINATION lane color (joins the merged branch)", () => {
    // Merge node on lane 0; 2nd-parent 'merge' edge bends 0 -> 1. The merge
    // edge reads as "joining branch on lane 1", so it takes the DESTINATION
    // color (lane 1), unchanged by the fix.
    const nodes: ICommitNode[] = [
      makeNode('m', ['p1', 'p2'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 1, type: 'merge' },
      ]),
      makeNode('p1', [], 0),
      makeNode('p2', [], 1),
    ];
    const activeLaneMap = computeActiveLanes(nodes);
    const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);

    const destColor = getColumnColor(1);
    const pathMatch = svg.match(/<path[^>]*stroke="(#[0-9A-Fa-f]+)"/);
    assert.ok(pathMatch, `expected a bezier <path> for the merge edge; got SVG: ${svg}`);
    assert.strictEqual(
      pathMatch[1],
      destColor,
      `merge edge must use the destination color ${destColor}; got ${pathMatch[1]}`
    );
  });
});

// ============================================================
// Phase 2 — Renderer-side invariants (spec 8 L4, L9; spec 1.1 edge-color rule;
// spec 1.2 focus highlight dim/brighten contract).
//
// These pin SVG-stage emit shapes whose drift is the bug class
// "the green node sits on a blue line" (L4), "off-window history is
// indistinguishable from in-window history" (L9), and "focused-branch
// dim contract drifts to a different opacity literal" (spec 1.2).
//
// Mutation-test rationale (kept here so a future reader sees why each
// pin is meaningful):
//   - L4 pin: if commitColor is swapped to getColumnColor(line.toColumn)
//     for the same-lane vertical, the stroke color regex no longer
//     matches getColumnColor(node.graphColumn). Pin fires.
//   - Bezier pin: if the bezier color rule flips to source-lane
//     (getColumnColor(line.fromColumn)), the path stroke regex no
//     longer matches getColumnColor(line.toColumn). Pin fires.
//   - Dashed-literal pin: if the dasharray literal changes from "4,3"
//     to "4 3" or "5,3", the substring assertion fails. Pin fires.
//   - Focus-dim pin: if opacity="0.6" drifts to "0.4" or "0.5", the
//     literal assertion fails. Pin fires.
// ============================================================

describe('Graph Renderer - Phase 2 spec 8.L4 + spec 1.1 edge-color invariants', () => {
  const config = DEFAULT_GRAPH_CONFIG;

  it('spec 8.L4: same-lane vertical stroke color === getColumnColor(node.graphColumn)', () => {
    // Build a 2-row chain on lane 2 (orange). The same-lane vertical
    // <line> from row 0's center to its bottom MUST stroke with
    // getColumnColor(2), NOT getColumnColor of any other column.
    // This is the load-bearing pin against the lane-bending artifact
    // (T53: green node sitting on a blue line).
    const lane = 2;
    const nodes: ICommitNode[] = [
      makeNode('child', ['parent'], lane, [{ fromColumn: lane, toColumn: lane, type: 'commit' }]),
      makeNode('parent', [], lane),
    ];
    const activeLaneMap = computeActiveLanes(nodes);
    const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);

    const expectedColor = getColumnColor(lane);
    const lines = extractLines(svg);
    // The same-lane vertical (centerY -> bottomY) is the line whose y1
    // equals centerY and y2 equals rowHeight, at the commit's lane x.
    const commitX = getColumnX(lane, config).toString();
    const centerY = (config.rowHeight / 2).toString();
    const bottomY = config.rowHeight.toString();
    const sameLaneVertical = lines.find(
      (l) => l.x1 === commitX && l.x2 === commitX && l.y1 === centerY && l.y2 === bottomY
    );

    assert.ok(
      sameLaneVertical,
      `expected a same-lane vertical line at x=${commitX} centerY->bottomY; got: ${svg}`
    );
    assert.strictEqual(
      sameLaneVertical.stroke,
      expectedColor,
      `spec 8.L4: same-lane vertical stroke must equal getColumnColor(${lane})=${expectedColor}; got ${sameLaneVertical.stroke}`
    );
  });

  it('spec 8.L4: same-lane vertical stroke color must-not-equal destination lane color when a sibling line bends', () => {
    // A merge commit at lane 0 with a same-lane first parent (lane 0)
    // AND a cross-lane second parent (lane 1). The same-lane vertical
    // MUST still stroke with getColumnColor(0), not getColumnColor(1) —
    // the regression class is "the bending bezier 'leaks' its color
    // back onto the same-lane vertical".
    const nodes: ICommitNode[] = [
      makeNode('m', ['p1', 'p2'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 1, type: 'merge' },
      ]),
      makeNode('p1', [], 0),
      makeNode('p2', [], 1),
    ];
    const activeLaneMap = computeActiveLanes(nodes);
    const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);

    const lane0Color = getColumnColor(0);
    const lane1Color = getColumnColor(1);
    const commitX = getColumnX(0, config).toString();
    const centerY = (config.rowHeight / 2).toString();
    const bottomY = config.rowHeight.toString();

    const lines = extractLines(svg);
    const sameLaneVertical = lines.find(
      (l) => l.x1 === commitX && l.x2 === commitX && l.y1 === centerY && l.y2 === bottomY
    );

    assert.ok(sameLaneVertical, `expected same-lane vertical; got SVG: ${svg}`);
    assert.strictEqual(
      sameLaneVertical.stroke,
      lane0Color,
      `same-lane vertical must use lane-0 color even when a sibling line bends to lane 1; got ${sameLaneVertical.stroke}, expected ${lane0Color}`
    );
    assert.notStrictEqual(
      sameLaneVertical.stroke,
      lane1Color,
      `same-lane vertical must NOT bleed the destination-lane color (${lane1Color}) onto the source-lane vertical`
    );
  });

  it('spec 1.1 edge-color rule: cross-lane bezier stroke === getColumnColor(line.toColumn)', () => {
    // Spec spec 1.1 "Edge geometry" rule 2 + "Edge color rule" bullet 2:
    // merge / branch edges (i > 0 / cross-lane) take the destination
    // lane's color (so they read as "joining the merged branch's color").
    const nodes: ICommitNode[] = [
      makeNode('m', ['p1', 'p2'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 1, type: 'merge' },
      ]),
      makeNode('p1', [], 0),
      makeNode('p2', [], 1),
    ];
    const activeLaneMap = computeActiveLanes(nodes);
    const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);

    const paths = extractPaths(svg);
    assert.strictEqual(
      paths.length,
      1,
      `expected exactly one cross-lane bezier path; got ${paths.length} in ${svg}`
    );
    assert.strictEqual(
      paths[0].stroke,
      getColumnColor(1),
      `bezier stroke must equal getColumnColor(toColumn=1)=${getColumnColor(1)}; got ${paths[0].stroke}`
    );
    // And it must NOT equal the source-lane color — flipping the rule
    // is the regression this pin guards against.
    assert.notStrictEqual(
      paths[0].stroke,
      getColumnColor(0),
      `bezier stroke must NOT equal getColumnColor(fromColumn=0); the spec spec 1.1 rule is destination-lane color`
    );
  });
});

describe('Graph Renderer - Phase 2 spec 8.L9 dashed stroke literal pin', () => {
  // Phase 1a pins the algorithm-level shape (style:'dashed' on
  // off-window stubs). The companion renderer-stage assertion
  // already checks that *some* stroke-dasharray attribute is emitted,
  // but does not pin the exact value. The IntelliJ parity contract
  // is the literal "4,3" — a 4px dash followed by a 3px gap — and
  // accidentally drifting to "4 3" (space-separated) or any other
  // value silently changes the visual without breaking any current
  // test. Pin the exact literal here.
  const config = DEFAULT_GRAPH_CONFIG;

  it('spec 8.L9: same-lane dashed stub emits exact stroke-dasharray="4,3" literal', () => {
    const nodes: ICommitNode[] = [
      makeNode('child', ['off-window-parent'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit', style: 'dashed' },
      ]),
    ];
    const activeLaneMap = computeActiveLanes(nodes);
    const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);

    assert.ok(
      svg.includes('stroke-dasharray="4,3"'),
      `expected exact literal stroke-dasharray="4,3"; got SVG: ${svg}`
    );
  });

  it('spec 8.L9: cross-lane dashed bezier emits exact stroke-dasharray="4,3" literal', () => {
    // Bezier path with style:'dashed' takes the same dash literal —
    // the renderer's two emit sites (line vs path) must stay in sync.
    const nodes: ICommitNode[] = [
      makeNode('m', ['p1', 'off-window-p2'], 0, [
        { fromColumn: 0, toColumn: 0, type: 'commit' },
        { fromColumn: 0, toColumn: 1, type: 'merge', style: 'dashed' },
      ]),
      makeNode('p1', [], 0),
    ];
    const activeLaneMap = computeActiveLanes(nodes);
    const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config, false, false);

    assert.ok(
      svg.includes('stroke-dasharray="4,3"'),
      `cross-lane dashed bezier must emit exact literal stroke-dasharray="4,3"; got SVG: ${svg}`
    );
  });
});

describe('Graph Renderer - Phase 2 spec 1.2 focus highlight dim/brighten contract', () => {
  // Spec spec 1.2 + spec 1.1 "Focus dim" row pin the literal opacity values:
  //   on-path  -> opacity="1"
  //   off-path -> opacity="0.6"
  //   no focus -> no opacity attribute at all (so unfocused appearance
  //              is byte-identical to the legacy pre-focus renderer)
  //
  // snap-6a/b/c in commitGraphSnapshots.test.ts cover the same triplet
  // for a single node. The pin below additionally asserts that *both*
  // states are visible in a single render pass driven by the same
  // hasFocusedBranch=true flag with mixed onFocusedBranchPath, which
  // is what production ships — never a single-node graph.
  const config = DEFAULT_GRAPH_CONFIG;

  function focusNode(hash: string, onFocusedBranchPath: boolean, lane: number): ICommitNode {
    return {
      commit: {
        hash,
        shortHash: hash.substring(0, 7),
        message: 'm',
        author: { name: 't', email: 't@t' },
        committer: { name: 't', email: 't@t' },
        parents: ['parent'],
        authorDate: new Date(),
        commitDate: new Date(),
      },
      graphColumn: lane,
      graphLines: [{ fromColumn: lane, toColumn: lane, color: '#000', type: 'commit' }],
      branches: [],
      tags: [],
      onFocusedBranchPath,
    };
  }

  it('spec 1.2: hasFocusedBranch=true + on-path commit -> every element carries opacity="1"', () => {
    const node = focusNode('on', true, 0);
    const svg = renderGraphSvg(node, 0, new Set([0]), config, false, false, new Set(), true);
    assert.ok(svg.includes('opacity="1"'), `on-path must emit opacity="1"; got: ${svg}`);
    assert.ok(!svg.includes('opacity="0.6"'), `on-path must NOT emit dim opacity; got: ${svg}`);
  });

  it('spec 1.2: hasFocusedBranch=true + off-path commit -> every element carries opacity="0.6"', () => {
    const node = focusNode('off', false, 0);
    const svg = renderGraphSvg(node, 0, new Set([0]), config, false, false, new Set(), true);
    assert.ok(svg.includes('opacity="0.6"'), `off-path must emit opacity="0.6"; got: ${svg}`);
    assert.ok(
      !svg.includes('opacity="1"'),
      `off-path must NOT emit on-path opacity="1"; got: ${svg}`
    );
  });

  it('spec 1.2: hasFocusedBranch=false -> NO opacity attribute on any element (unfocused parity)', () => {
    const node = focusNode('any', true, 0); // onFocusedBranchPath ignored when no focus
    const svg = renderGraphSvg(node, 0, new Set([0]), config, false, false, new Set(), false);
    assert.ok(
      !/\bopacity="/.test(svg),
      `hasFocusedBranch=false must emit zero opacity attributes; got: ${svg}`
    );
  });
});
