/**
 * Unit tests for graph renderer core types, config, and helpers.
 *
 * Tests cover:
 * - IGraphRenderConfig default values meet minimum spacing requirements
 * - DEFAULT_GRAPH_CONFIG constant correctness
 * - getColumnX() helper function
 * - ActiveLaneMap type usage
 *
 * Requirements: 4.1, 4.2, 4.4, 5.1
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
import { ICommitNode, getColumnColor } from '../../../utils/commitGraph';
import { ICommit } from '../../../services/interfaces/IGitService';

describe('Graph Renderer - Core Types and Config', () => {
  describe('DEFAULT_GRAPH_CONFIG', () => {
    it('should have columnWidth of 20 (Requirement 4.1: at least 20px)', () => {
      assert.strictEqual(DEFAULT_GRAPH_CONFIG.columnWidth, 20);
    });

    it('should have rowHeight of 32 (Requirement 4.2: at least 32px)', () => {
      assert.strictEqual(DEFAULT_GRAPH_CONFIG.rowHeight, 32);
    });

    it('should have nodeRadius of 4', () => {
      assert.strictEqual(DEFAULT_GRAPH_CONFIG.nodeRadius, 4);
    });

    it('should have padding of 10 (Requirement 4.4: at least 10px)', () => {
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

    it('should meet minimum rowHeight requirement (>= 32)', () => {
      assert.ok(
        DEFAULT_GRAPH_CONFIG.rowHeight >= 32,
        `rowHeight ${DEFAULT_GRAPH_CONFIG.rowHeight} should be >= 32`
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
  graphLines: { fromColumn: number; toColumn: number; type: 'commit' | 'merge' | 'branch' }[] = []
): ICommitNode {
  return {
    commit: makeCommit(hash, parents),
    graphColumn,
    graphLines: graphLines.map((l) => ({
      fromColumn: l.fromColumn,
      toColumn: l.toColumn,
      color: '#000',
      type: l.type,
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
      makeNode('aaa', ['bbb'], 0, [
        { fromColumn: 0, toColumn: 1, type: 'merge' },
      ]),
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
    const nodes: ICommitNode[] = [
      makeNode('aaa', [], 0),
      makeNode('bbb', [], 3),
    ];
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
  const regex = /<circle\s+cx="([^"]+)"\s+cy="([^"]+)"\s+r="([^"]+)"\s+fill="([^"]+)"\s+stroke="([^"]+)"\s+stroke-width="[^"]+"\s*\/>/g;
  const circles: Array<{ cx: string; cy: string; r: string; fill: string; stroke: string }> = [];
  let match;
  while ((match = regex.exec(svg)) !== null) {
    circles.push({ cx: match[1], cy: match[2], r: match[3], fill: match[4], stroke: match[5] });
  }
  return circles;
}

function extractPaths(svg: string) {
  const regex = /<path\s+d="([^"]+)"\s+stroke="([^"]+)"\s+fill="[^"]+"\s+stroke-width="[^"]+"\s+stroke-linecap="[^"]+"\s*\/>/g;
  const paths: Array<{ d: string; stroke: string }> = [];
  let match;
  while ((match = regex.exec(svg)) !== null) {
    paths.push({ d: match[1], stroke: match[2] });
  }
  return paths;
}

function extractLines(svg: string) {
  const regex = /<line\s+x1="([^"]+)"\s+y1="([^"]+)"\s+x2="([^"]+)"\s+y2="([^"]+)"\s+stroke="([^"]+)"\s+stroke-width="[^"]+"\s+stroke-linecap="[^"]+"\s*\/>/g;
  const lines: Array<{ x1: string; y1: string; x2: string; y2: string; stroke: string }> = [];
  let match;
  while ((match = regex.exec(svg)) !== null) {
    lines.push({ x1: match[1], y1: match[2], x2: match[3], y2: match[4], stroke: match[5] });
  }
  return lines;
}

// ============================================================
// Unit tests for known graph topologies (Task 2.4)
// Requirements: 1.1, 1.2, 2.1, 3.1, 4.1, 4.2, 4.4, 5.2
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
        const svg = renderGraphSvg(nodes[i], i, activeLaneMap.get(i)!, config);
        const circles = extractCircles(svg);
        assert.strictEqual(circles.length, 1, `Row ${i} should have exactly 1 circle`);
        assert.strictEqual(circles[0].cx, col0X, `Row ${i} circle should be at column 0 x`);
        assert.strictEqual(circles[0].cy, centerY, `Row ${i} circle should be at center y`);
      }
    });

    it('should not have any bezier paths (no merges)', () => {
      for (let i = 0; i < nodes.length; i++) {
        const svg = renderGraphSvg(nodes[i], i, activeLaneMap.get(i)!, config);
        const paths = extractPaths(svg);
        assert.strictEqual(paths.length, 0, `Row ${i} should have no bezier paths`);
      }
    });

    it('should have vertical line segments for lane continuity', () => {
      // Row 0 (first row): should have center-to-bottom segment (has parents)
      const svg0 = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config);
      const lines0 = extractLines(svg0);
      assert.ok(lines0.length > 0, 'Row 0 should have vertical line segments');

      // Row 1 (middle row): should have top-to-center and center-to-bottom segments
      const svg1 = renderGraphSvg(nodes[1], 1, activeLaneMap.get(1)!, config);
      const lines1 = extractLines(svg1);
      assert.ok(lines1.length >= 2, 'Row 1 should have at least 2 vertical line segments (top-to-center and center-to-bottom)');

      // Row 2 (root): should have top-to-center segment (rowIndex > 0) but no center-to-bottom (no parents)
      const svg2 = renderGraphSvg(nodes[2], 2, activeLaneMap.get(2)!, config);
      const lines2 = extractLines(svg2);
      assert.ok(lines2.length >= 1, 'Row 2 should have at least 1 vertical line segment (top-to-center)');
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
      const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 1, 'Merge commit should have exactly 1 bezier path');
      // The path should connect from col 0 x to col 1 x
      assert.ok(paths[0].d.includes(col0X), 'Path should start at column 0 x');
      assert.ok(paths[0].d.includes(col1X), 'Path should end at column 1 x');
    });

    it('should render the merge commit circle with a contrasting stroke (Req 1.2)', () => {
      const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config);
      const circles = extractCircles(svg);
      assert.strictEqual(circles.length, 1, 'Should have exactly 1 circle');
      // Merge commits have a white stroke (#ffffff) different from fill
      assert.notStrictEqual(circles[0].fill, circles[0].stroke,
        'Merge commit circle should have contrasting stroke (fill !== stroke)');
    });

    it('should render non-merge parent commits without contrasting stroke', () => {
      const svgP1 = renderGraphSvg(nodes[1], 1, activeLaneMap.get(1)!, config);
      const circlesP1 = extractCircles(svgP1);
      assert.strictEqual(circlesP1.length, 1);
      assert.strictEqual(circlesP1[0].fill, circlesP1[0].stroke,
        'Non-merge commit should have matching fill and stroke');

      const svgP2 = renderGraphSvg(nodes[2], 2, activeLaneMap.get(2)!, config);
      const circlesP2 = extractCircles(svgP2);
      assert.strictEqual(circlesP2.length, 1);
      assert.strictEqual(circlesP2[0].fill, circlesP2[0].stroke,
        'Non-merge commit should have matching fill and stroke');
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
      const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 1, 'M should have 1 bezier path (merge line)');
    });

    it('should render a branch bezier path on C (col 1 → col 0)', () => {
      const svg = renderGraphSvg(nodes[2], 2, activeLaneMap.get(2)!, config);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 1, 'C should have 1 bezier path (branch line back to col 0)');
      // The path should connect from col 1 x to col 0 x
      assert.ok(paths[0].d.includes(col1X), 'Path should include column 1 x');
      assert.ok(paths[0].d.includes(col0X), 'Path should include column 0 x');
    });

    it('should have no bezier paths on B (same-lane commit line)', () => {
      const svg = renderGraphSvg(nodes[1], 1, activeLaneMap.get(1)!, config);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 0, 'B should have no bezier paths (same-lane line)');
    });

    it('should render a circle on every row', () => {
      for (let i = 0; i < nodes.length; i++) {
        const svg = renderGraphSvg(nodes[i], i, activeLaneMap.get(i)!, config);
        const circles = extractCircles(svg);
        assert.strictEqual(circles.length, 1, `Row ${i} should have exactly 1 circle`);
      }
    });
  });

  describe('Root commit (no parents) - Req 1.1', () => {
    const nodes: ICommitNode[] = [makeNode('root', [], 0)];
    const activeLaneMap = computeActiveLanes(nodes);

    it('should produce valid SVG wrapping', () => {
      const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config);
      assert.ok(svg.startsWith('<svg'), 'SVG should start with <svg');
      assert.ok(svg.endsWith('</svg>'), 'SVG should end with </svg>');
    });

    it('should render a circle for the root commit', () => {
      const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config);
      const circles = extractCircles(svg);
      assert.strictEqual(circles.length, 1, 'Root commit should have exactly 1 circle');
      assert.strictEqual(circles[0].cx, col0X);
      assert.strictEqual(circles[0].cy, centerY);
    });

    it('should not have a center-to-bottom vertical line (no parents)', () => {
      const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config);
      const lines = extractLines(svg);
      // Root commit at row 0: no top-to-center (rowIndex === 0) and no center-to-bottom (no parents)
      assert.strictEqual(lines.length, 0, 'Root commit at row 0 should have no vertical line segments');
    });

    it('should not have any bezier paths', () => {
      const svg = renderGraphSvg(nodes[0], 0, activeLaneMap.get(0)!, config);
      const paths = extractPaths(svg);
      assert.strictEqual(paths.length, 0, 'Root commit should have no bezier paths');
    });
  });

  describe('Default config minimum spacing requirements - Req 4.1, 4.2, 4.4', () => {
    it('should have columnWidth >= 20 (Req 4.1)', () => {
      assert.ok(DEFAULT_GRAPH_CONFIG.columnWidth >= 20,
        `columnWidth ${DEFAULT_GRAPH_CONFIG.columnWidth} should be >= 20`);
    });

    it('should have rowHeight >= 32 (Req 4.2)', () => {
      assert.ok(DEFAULT_GRAPH_CONFIG.rowHeight >= 32,
        `rowHeight ${DEFAULT_GRAPH_CONFIG.rowHeight} should be >= 32`);
    });

    it('should have padding >= 10 (Req 4.4)', () => {
      assert.ok(DEFAULT_GRAPH_CONFIG.padding >= 10,
        `padding ${DEFAULT_GRAPH_CONFIG.padding} should be >= 10`);
    });
  });

  describe('Color palette has at least 8 entries - Req 5.2', () => {
    it('should return at least 8 distinct colors for indices 0-7', () => {
      const colors = new Set<string>();
      for (let i = 0; i < 8; i++) {
        colors.add(getColumnColor(i));
      }
      assert.ok(colors.size >= 8,
        `Expected at least 8 distinct colors, got ${colors.size}: ${[...colors].join(', ')}`);
    });

    it('should return hex color strings starting with #', () => {
      for (let i = 0; i < 8; i++) {
        const color = getColumnColor(i);
        assert.ok(color.startsWith('#'),
          `Color at index ${i} should start with #, got: ${color}`);
      }
    });
  });
});
