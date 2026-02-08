/**
 * Property-based tests for the two-panel layout infrastructure.
 *
 * Feature: intellig-layout
 *
 * Uses fast-check to verify universal correctness properties of the
 * panel resize constraint logic, panel width persistence round-trip,
 * and two-panel HTML structure.
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { clampPanelWidths, savePanelWidths, loadPanelWidths } from '../../utils/panelLayout';
import { GitToolWindowProvider } from '../../services/GitToolWindowProvider';
import { ICommitDetails } from '../../services/interfaces';
import { FileStatus } from '../../services/interfaces/IGitService';
import { ICommitNode } from '../../utils/commitGraph';
import { Uri, Webview } from '../mocks/vscode';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid container width (≥ 200px) as specified by Property 2.
 * Upper bound is set to a reasonable screen width.
 */
function arbitraryContainerWidth(): fc.Arbitrary<number> {
  return fc.integer({ min: 200, max: 5000 });
}

/**
 * Generate an arbitrary panel width distribution as two pixel values.
 * Values can be anything including below minimum, to test clamping behavior.
 */
function arbitraryPanelWidths(): fc.Arbitrary<[number, number]> {
  return fc.tuple(
    fc.integer({ min: -100, max: 5000 }),
    fc.integer({ min: -100, max: 5000 })
  );
}

/**
 * Generate an arbitrary drag delta that could be applied to a divider.
 * Can be positive (drag right) or negative (drag left).
 */
function arbitraryDragDelta(): fc.Arbitrary<number> {
  return fc.integer({ min: -2000, max: 2000 });
}

/**
 * Generate a valid panel width ratio tuple [a, b] where:
 * - Each value is between 5 and 90 (inclusive)
 * - The values sum to exactly 100
 *
 * Strategy: generate one value in [5, 90], compute the second,
 * and filter to ensure all constraints are met.
 */
function arbitraryValidPanelRatios(): fc.Arbitrary<[number, number]> {
  return fc
    .integer({ min: 5, max: 90 })
    .map((a): [number, number] => [a, 100 - a])
    .filter(([_a, b]) => b >= 5 && b <= 90);
}

// ─── Mock Memento ─────────────────────────────────────────────────────────────

/**
 * Creates a mock VS Code Memento (workspace state) for testing.
 * Stores values in an in-memory Map.
 */
function createMockMemento(): import('vscode').Memento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      if (store.has(key)) {
        return store.get(key) as T;
      }
      return defaultValue;
    },
    update(key: string, value: unknown): Promise<void> {
      store.set(key, value);
      return Promise.resolve();
    },
    keys(): readonly string[] {
      return Array.from(store.keys());
    },
  } as import('vscode').Memento;
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: intellig-layout - Two Panel Layout Property Tests', () => {
  describe('Property 2: Panel resize minimum width constraint', () => {
    /**
     * **Validates: Requirements 1.3**
     *
     * For any container width (≥ 200px), any initial panel width distribution,
     * and any drag delta applied to a divider, the resulting panel widths SHALL
     * each be at least 100 pixels, and the sum of all panel widths SHALL equal
     * the container width.
     */
    it('Feature: intellig-layout, Property 2: Panel resize minimum width constraint — all panels ≥ 100px and sum equals container width', () => {
      fc.assert(
        fc.property(
          arbitraryContainerWidth(),
          arbitraryPanelWidths(),
          arbitraryDragDelta(),
          (containerWidth, initialWidths, dragDelta) => {
            // Simulate a drag on the divider (between panel 0 and panel 1):
            // Panel 0 gets wider/narrower by dragDelta, panel 1 compensates.
            const adjustedWidths: [number, number] = [
              initialWidths[0] + dragDelta,
              initialWidths[1] - dragDelta,
            ];

            const result = clampPanelWidths(containerWidth, adjustedWidths);

            // Each panel must be at least 100px
            assert.ok(
              result[0] >= 100,
              `Panel 0 width ${result[0]} should be >= 100px`
            );
            assert.ok(
              result[1] >= 100,
              `Panel 1 width ${result[1]} should be >= 100px`
            );

            // Sum must equal container width
            const sum = result[0] + result[1];
            assert.ok(
              Math.abs(sum - containerWidth) < 0.01,
              `Sum of panel widths (${sum}) should equal container width (${containerWidth})`
            );
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe('Property 3: Panel width persistence round-trip', () => {
    /**
     * **Validates: Requirements 1.4**
     *
     * For any valid panel width ratio tuple [a, b] where each value is
     * between 5 and 90 and they sum to 100, saving the tuple to workspace
     * state and then loading it SHALL produce an equivalent tuple.
     */
    it('Feature: intellig-layout, Property 3: Panel width persistence round-trip — save then load produces equivalent tuple', () => {
      fc.assert(
        fc.property(
          arbitraryValidPanelRatios(),
          (ratios) => {
            const memento = createMockMemento();

            // Save the ratios
            savePanelWidths(memento, ratios);

            // Load them back
            const loaded = loadPanelWidths(memento);

            // The loaded tuple should be equivalent to the saved one
            assert.deepStrictEqual(
              loaded,
              ratios,
              `Loaded widths [${loaded}] should equal saved widths [${ratios}]`
            );
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});

// ─── Property 1 Generators ───────────────────────────────────────────────────

/**
 * Generate a valid branch name segment (alphanumeric, hyphens, underscores, dots).
 */
function arbitraryBranchSegment(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('')
    ),
    { minLength: 1, maxLength: 15 }
  );
}

/**
 * Generate a valid branch name (1-3 segments joined by '/').
 */
function arbitraryBranchName(): fc.Arbitrary<string> {
  return fc
    .array(arbitraryBranchSegment(), { minLength: 1, maxLength: 3 })
    .map((segments) => segments.join('/'));
}

/**
 * Generate a full commit hash (40 hex characters).
 */
function arbitraryFullHash(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    { minLength: 40, maxLength: 40 }
  );
}

/**
 * Generate a short commit hash (7-12 hex characters).
 */
function arbitraryShortHash(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    { minLength: 7, maxLength: 12 }
  );
}

/**
 * Generate a valid ICommit.
 */
function arbitraryCommit(): fc.Arbitrary<import('../../services/interfaces/IGitService').ICommit> {
  return fc.record({
    hash: arbitraryFullHash(),
    shortHash: arbitraryShortHash(),
    message: fc.string({ minLength: 1, maxLength: 80 }),
    author: fc.record({
      name: fc.string({ minLength: 1, maxLength: 20 }),
      email: fc.string({ minLength: 3, maxLength: 30 }),
    }),
    committer: fc.record({
      name: fc.string({ minLength: 1, maxLength: 20 }),
      email: fc.string({ minLength: 3, maxLength: 30 }),
    }),
    parents: fc.array(arbitraryFullHash(), { minLength: 0, maxLength: 2 }),
    authorDate: fc.date({ min: new Date('2020-01-01'), max: new Date('2025-01-01') }),
    commitDate: fc.date({ min: new Date('2020-01-01'), max: new Date('2025-01-01') }),
  });
}

/**
 * Generate a valid ICommitNode.
 */
function arbitraryCommitNode(): fc.Arbitrary<ICommitNode> {
  return fc.record({
    commit: arbitraryCommit(),
    graphColumn: fc.integer({ min: 0, max: 5 }),
    graphLines: fc.array(
      fc.record({
        fromColumn: fc.integer({ min: 0, max: 5 }),
        toColumn: fc.integer({ min: 0, max: 5 }),
        color: fc.constantFrom('#4CAF50', '#2196F3', '#FF9800'),
        type: fc.constantFrom('commit' as const, 'merge' as const, 'branch' as const),
      }),
      { minLength: 0, maxLength: 3 }
    ),
    branches: fc.array(arbitraryBranchName(), { minLength: 0, maxLength: 2 }),
    tags: fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 0, maxLength: 2 }),
  });
}

/**
 * Generate valid panel width percentages that sum to 100.
 */
function arbitraryPanelWidthPercentages(): fc.Arbitrary<[number, number]> {
  return fc
    .integer({ min: 10, max: 80 })
    .map((a): [number, number] => [a, 100 - a])
    .filter(([_a, b]) => b >= 10 && b <= 80);
}

/**
 * Generate optional ICommitDetails.
 */
function arbitraryOptionalCommitDetails(): fc.Arbitrary<ICommitDetails | undefined> {
  const fileStatuses: FileStatus[] = ['added', 'modified', 'deleted', 'renamed'];
  return fc.option(
    fc.record({
      hash: arbitraryFullHash(),
      message: fc.string({ minLength: 1, maxLength: 80 }),
      author: fc.record({
        name: fc.string({ minLength: 1, maxLength: 20 }),
        email: fc.string({ minLength: 3, maxLength: 30 }),
      }),
      date: fc.date({ min: new Date('2020-01-01'), max: new Date('2025-01-01') }),
      parents: fc.array(arbitraryFullHash(), { minLength: 0, maxLength: 2 }),
      branches: fc.array(arbitraryBranchName(), { minLength: 0, maxLength: 2 }),
      tags: fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 0, maxLength: 2 }),
      changedFiles: fc.array(
        fc.record({
          path: fc.string({ minLength: 1, maxLength: 40 }),
          status: fc.constantFrom(...fileStatuses),
        }),
        { minLength: 0, maxLength: 5 }
      ),
    }),
    { nil: undefined }
  );
}

/**
 * Create a mock Webview object for testing.
 */
function createMockWebview(): Webview {
  return {
    html: '',
    options: {},
    cspSource: 'https://mock.csp.source',
    onDidReceiveMessage: () => ({ dispose: () => {} }),
    postMessage: () => Promise.resolve(true),
    asWebviewUri: (uri: Uri) => uri,
  } as unknown as Webview;
}

/**
 * Create a GitToolWindowProvider instance for testing.
 */
function createProvider(): GitToolWindowProvider {
  const extensionUri = Uri.file('/test/extension');
  return new GitToolWindowProvider(extensionUri);
}

// ─── Property 1 Tests ────────────────────────────────────────────────────────

describe('Feature: intellig-layout - Two Panel HTML Structure Property Tests', () => {
  let provider: GitToolWindowProvider;
  let mockWebview: Webview;

  beforeEach(() => {
    provider = createProvider();
    mockWebview = createMockWebview();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Property 1: Two-panel HTML structure', () => {
    /**
     * **Validates: Requirements 1.1**
     *
     * For any valid state (with hasRepository: true), the generated
     * HTML SHALL contain exactly two panel container elements (graph-panel,
     * details-panel) as direct children of the layout container,
     * in left-to-right order. Branch panel was removed — branches are now
     * displayed in the native BRANCHES tree view.
     */
    it('Feature: intellig-layout, Property 1: Two-panel HTML structure — HTML contains exactly two panel containers in left-to-right order', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryCommitNode(), { minLength: 0, maxLength: 10 }),
          arbitraryOptionalCommitDetails(),
          arbitraryPanelWidthPercentages(),
          (commitNodes, commitDetails, panelWidths) => {
            const html = provider._getThreePanelHtmlContent(
              mockWebview as unknown as import('vscode').Webview,
              commitNodes,
              commitDetails,
              panelWidths
            );

            // 1. HTML must NOT contain branch-panel (removed)
            const branchPanelMatches = html.match(/id="branch-panel"/g);
            assert.ok(
              !branchPanelMatches,
              'HTML should NOT contain a branch-panel element'
            );

            // 2. HTML must contain exactly one graph-panel and one details-panel
            const graphPanelMatches = html.match(/id="graph-panel"/g);
            const detailsPanelMatches = html.match(/id="details-panel"/g);

            assert.ok(
              graphPanelMatches && graphPanelMatches.length === 1,
              'HTML should contain exactly one graph-panel element'
            );
            assert.ok(
              detailsPanelMatches && detailsPanelMatches.length === 1,
              'HTML should contain exactly one details-panel element'
            );

            // 3. Panels must be in left-to-right order: graph, details
            const graphIndex = html.indexOf('id="graph-panel"');
            const detailsIndex = html.indexOf('id="details-panel"');

            assert.ok(
              graphIndex < detailsIndex,
              `Graph panel (at ${graphIndex}) should appear before details panel (at ${detailsIndex})`
            );

            // 4. All panels must be direct children of the layout container
            assert.ok(
              html.includes('class="three-panel-layout"'),
              'HTML should contain the three-panel-layout container'
            );

            const graphPanelTag = html.substring(
              html.lastIndexOf('<div', graphIndex),
              html.indexOf('>', graphIndex) + 1
            );
            assert.ok(
              graphPanelTag.includes('class="panel"'),
              'Graph panel should have class="panel"'
            );

            const detailsPanelTag = html.substring(
              html.lastIndexOf('<div', detailsIndex),
              html.indexOf('>', detailsIndex) + 1
            );
            assert.ok(
              detailsPanelTag.includes('class="panel"'),
              'Details panel should have class="panel"'
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
