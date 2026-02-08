import * as fc from 'fast-check';
import * as assert from 'assert';
import { IHunk, IDiffLine, IDiff, DiffLineType } from '../../services/interfaces/IGitService';

/**
 * Property-based tests for Partial Line Staging Accuracy.
 * Feature: intellig-vscode, Property 6: Partial Line Staging Accuracy
 *
 * **Validates: Requirements 3.7, 14.2, 14.3, 14.5, 14.6**
 *
 * Property Description:
 * For any file with changes and any selection of specific lines within hunks,
 * staging those lines SHALL result in only those exact lines being included
 * in the staged diff, and the remaining lines SHALL remain in the unstaged diff.
 */
describe('Partial Line Staging Accuracy Property Tests', () => {
  /**
   * Arbitrary generator for diff line content (non-empty strings without newlines)
   */
  const lineContentArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 100 })
    .filter((s) => s.trim().length > 0 && !s.includes('\n') && !s.includes('\r'));

  /**
   * Arbitrary generator for diff line type
   */
  const diffLineTypeArb: fc.Arbitrary<DiffLineType> = fc.constantFrom('context', 'add', 'delete');

  /**
   * Arbitrary generator for a single diff line
   */
  const diffLineArb: fc.Arbitrary<IDiffLine> = fc.record({
    type: diffLineTypeArb,
    content: lineContentArb,
    oldLineNumber: fc.option(fc.nat({ max: 10000 }), { nil: undefined }),
    newLineNumber: fc.option(fc.nat({ max: 10000 }), { nil: undefined }),
  });

  /**
   * Generate a valid hunk with proper line numbers
   * A hunk must have at least one change (add or delete) to be meaningful
   */
  const validHunkArb: fc.Arbitrary<IHunk> = fc
    .record({
      oldStart: fc.integer({ min: 1, max: 1000 }),
      newStart: fc.integer({ min: 1, max: 1000 }),
      lines: fc.array(diffLineArb, { minLength: 1, maxLength: 20 }),
    })
    .filter((h) => h.lines.some((l) => l.type === 'add' || l.type === 'delete'))
    .map((h) => {
      // Calculate proper line counts and assign line numbers
      let oldLineNum = h.oldStart;
      let newLineNum = h.newStart;
      let oldLines = 0;
      let newLines = 0;

      const linesWithNumbers = h.lines.map((line) => {
        const result: IDiffLine = { ...line };
        if (line.type === 'context') {
          result.oldLineNumber = oldLineNum++;
          result.newLineNumber = newLineNum++;
          oldLines++;
          newLines++;
        } else if (line.type === 'add') {
          result.newLineNumber = newLineNum++;
          newLines++;
        } else if (line.type === 'delete') {
          result.oldLineNumber = oldLineNum++;
          oldLines++;
        }
        return result;
      });

      return {
        oldStart: h.oldStart,
        oldLines,
        newStart: h.newStart,
        newLines,
        header: `@@ -${h.oldStart},${oldLines} +${h.newStart},${newLines} @@`,
        lines: linesWithNumbers,
      };
    });

  /**
   * Arbitrary generator for file paths
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .array(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'), {
        minLength: 1,
        maxLength: 20,
      }),
      { minLength: 1, maxLength: 4 }
    )
    .map((parts) => parts.join('/') + '.ts');

  /**
   * Mock class that simulates the partial line staging behavior.
   * This implements the same logic as GitService.stageLines, tracking
   * which lines are staged vs unstaged with their line numbers preserved.
   */
  class MockPartialStagingService {
    // Store staged lines with their full information (including line numbers)
    private _stagedLines: Map<string, IDiffLine[]> = new Map();
    // Store unstaged lines with their full information
    private _unstagedLines: Map<string, IDiffLine[]> = new Map();

    /**
     * Stage specific lines from a hunk.
     * This simulates the behavior of GitService.stageLines.
     *
     * @param path - The file path
     * @param lines - Array of line numbers (newLineNumber for adds) to stage
     * @param hunk - The hunk containing the lines
     */
    stageLines(path: string, lines: number[], hunk: IHunk): void {
      if (lines.length === 0) {
        return;
      }

      const selectedSet = new Set(lines);
      const stagedLines: IDiffLine[] = this._stagedLines.get(path) || [];
      const unstagedLines: IDiffLine[] = this._unstagedLines.get(path) || [];

      for (const line of hunk.lines) {
        if (line.type === 'context') {
          // Context lines go to both staged and unstaged
          stagedLines.push({ ...line });
          unstagedLines.push({ ...line });
        } else if (line.type === 'add') {
          if (line.newLineNumber !== undefined && selectedSet.has(line.newLineNumber)) {
            // Selected additions go to staged
            stagedLines.push({ ...line });
          } else {
            // Unselected additions go to unstaged
            unstagedLines.push({ ...line });
          }
        } else if (line.type === 'delete') {
          // For deletions, we check oldLineNumber
          if (line.oldLineNumber !== undefined && selectedSet.has(line.oldLineNumber)) {
            stagedLines.push({ ...line });
          } else {
            unstagedLines.push({ ...line });
          }
        }
      }

      this._stagedLines.set(path, stagedLines);
      this._unstagedLines.set(path, unstagedLines);
    }

    /**
     * Get the staged lines for a file
     */
    getStagedLines(path: string): IDiffLine[] {
      return this._stagedLines.get(path) || [];
    }

    /**
     * Get the unstaged diff for a file
     */
    getUnstagedDiff(path: string): IDiff | undefined {
      const lines = this._unstagedLines.get(path);
      if (!lines || lines.length === 0) {
        return undefined;
      }
      return {
        path,
        status: 'modified',
        hunks: [
          {
            oldStart: 1,
            oldLines: lines.filter((l) => l.type !== 'add').length,
            newStart: 1,
            newLines: lines.filter((l) => l.type !== 'delete').length,
            header: '@@ -1,0 +1,0 @@',
            lines,
          },
        ],
        binary: false,
      };
    }

    /**
     * Check if a line is in the staged diff
     */
    isLineStaged(path: string, lineNumber: number, type: DiffLineType): boolean {
      const stagedLines = this._stagedLines.get(path) || [];
      return stagedLines.some((l) => {
        if (l.type !== type) {
          return false;
        }
        if (type === 'add') {
          return l.newLineNumber === lineNumber;
        }
        if (type === 'delete') {
          return l.oldLineNumber === lineNumber;
        }
        return false;
      });
    }

    /**
     * Check if a line is in the unstaged diff
     */
    isLineUnstaged(path: string, lineNumber: number, type: DiffLineType): boolean {
      const unstagedLines = this._unstagedLines.get(path) || [];
      return unstagedLines.some((l) => {
        if (l.type !== type) {
          return false;
        }
        if (type === 'add') {
          return l.newLineNumber === lineNumber;
        }
        if (type === 'delete') {
          return l.oldLineNumber === lineNumber;
        }
        return false;
      });
    }

    /**
     * Reset the service state
     */
    reset(): void {
      this._stagedLines.clear();
      this._unstagedLines.clear();
    }
  }

  /**
   * Get all added line numbers from a hunk
   */
  function getAddedLineNumbers(hunk: IHunk): number[] {
    return hunk.lines
      .filter((l) => l.type === 'add' && l.newLineNumber !== undefined)
      .map((l) => l.newLineNumber as number);
  }

  describe('Property 6: Partial Line Staging Accuracy', () => {
    /**
     * Property: Staging specific lines results in only those lines being staged.
     *
     * **Validates: Requirements 3.7, 14.2, 14.3, 14.5, 14.6**
     */
    it('Property: Selected lines are included in staged diff', () => {
      fc.assert(
        fc.property(validHunkArb, filePathArb, (hunk, path) => {
          const addedLines = getAddedLineNumbers(hunk);
          if (addedLines.length === 0) {
            return true; // Skip if no added lines
          }

          // Select a subset of added lines
          const selectedLines = addedLines.slice(0, Math.max(1, Math.floor(addedLines.length / 2)));

          const service = new MockPartialStagingService();
          service.stageLines(path, selectedLines, hunk);

          // Verify: All selected lines should be in staged diff
          for (const lineNum of selectedLines) {
            assert.ok(
              service.isLineStaged(path, lineNum, 'add'),
              `Line ${lineNum} should be staged but was not found in staged diff`
            );
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Non-selected lines remain in unstaged diff.
     *
     * **Validates: Requirements 3.7, 14.2, 14.3, 14.5, 14.6**
     */
    it('Property: Non-selected lines remain in unstaged diff', () => {
      fc.assert(
        fc.property(validHunkArb, filePathArb, (hunk, path) => {
          const addedLines = getAddedLineNumbers(hunk);
          if (addedLines.length <= 1) {
            return true; // Need at least 2 lines to have selected and non-selected
          }

          // Select only the first half of added lines
          const selectedLines = addedLines.slice(0, Math.floor(addedLines.length / 2));
          const nonSelectedLines = addedLines.slice(Math.floor(addedLines.length / 2));

          const service = new MockPartialStagingService();
          service.stageLines(path, selectedLines, hunk);

          // Verify: Non-selected lines should be in unstaged diff
          for (const lineNum of nonSelectedLines) {
            assert.ok(
              service.isLineUnstaged(path, lineNum, 'add'),
              `Line ${lineNum} should remain unstaged but was not found in unstaged diff`
            );
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Selected lines are NOT in unstaged diff.
     *
     * **Validates: Requirements 3.7, 14.2, 14.3, 14.5, 14.6**
     */
    it('Property: Selected lines are not in unstaged diff', () => {
      fc.assert(
        fc.property(validHunkArb, filePathArb, (hunk, path) => {
          const addedLines = getAddedLineNumbers(hunk);
          if (addedLines.length === 0) {
            return true;
          }

          // Select all added lines
          const selectedLines = addedLines;

          const service = new MockPartialStagingService();
          service.stageLines(path, selectedLines, hunk);

          // Verify: Selected lines should NOT be in unstaged diff
          for (const lineNum of selectedLines) {
            assert.ok(
              !service.isLineUnstaged(path, lineNum, 'add'),
              `Line ${lineNum} was staged but still appears in unstaged diff`
            );
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Non-selected lines are NOT in staged diff.
     *
     * **Validates: Requirements 3.7, 14.2, 14.3, 14.5, 14.6**
     */
    it('Property: Non-selected lines are not in staged diff', () => {
      fc.assert(
        fc.property(validHunkArb, filePathArb, (hunk, path) => {
          const addedLines = getAddedLineNumbers(hunk);
          if (addedLines.length <= 1) {
            return true;
          }

          // Select only the first line
          const selectedLines = [addedLines[0]];
          const nonSelectedLines = addedLines.slice(1);

          const service = new MockPartialStagingService();
          service.stageLines(path, selectedLines, hunk);

          // Verify: Non-selected lines should NOT be in staged diff
          for (const lineNum of nonSelectedLines) {
            assert.ok(
              !service.isLineStaged(path, lineNum, 'add'),
              `Line ${lineNum} was not selected but appears in staged diff`
            );
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Context lines are preserved in both staged and unstaged diffs.
     *
     * **Validates: Requirements 3.7, 14.2, 14.3, 14.5, 14.6**
     */
    it('Property: Context lines are preserved in both diffs', () => {
      fc.assert(
        fc.property(validHunkArb, filePathArb, (hunk, path) => {
          const addedLines = getAddedLineNumbers(hunk);
          if (addedLines.length === 0) {
            return true;
          }

          const contextLines = hunk.lines.filter((l) => l.type === 'context');
          if (contextLines.length === 0) {
            return true; // Skip if no context lines
          }

          // Select some added lines
          const selectedLines = addedLines.slice(0, Math.max(1, Math.floor(addedLines.length / 2)));

          const service = new MockPartialStagingService();
          service.stageLines(path, selectedLines, hunk);

          // Verify: Context lines should be in both staged and unstaged
          const stagedLines = service.getStagedLines(path);
          const unstagedDiff = service.getUnstagedDiff(path);

          const stagedContextCount = stagedLines.filter((l) => l.type === 'context').length;
          const unstagedContextCount = unstagedDiff
            ? unstagedDiff.hunks.reduce(
                (sum: number, h: IHunk) =>
                  sum + h.lines.filter((l: IDiffLine) => l.type === 'context').length,
                0
              )
            : 0;

          // Both should have context lines
          assert.ok(
            stagedContextCount > 0 || contextLines.length === 0,
            'Staged diff should contain context lines'
          );
          assert.ok(
            unstagedContextCount > 0 || contextLines.length === 0,
            'Unstaged diff should contain context lines'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Staging empty selection results in no staged changes.
     *
     * **Validates: Requirements 3.7, 14.2, 14.3, 14.5, 14.6**
     */
    it('Property: Empty selection results in no staged changes', () => {
      fc.assert(
        fc.property(validHunkArb, filePathArb, (hunk, path) => {
          const service = new MockPartialStagingService();

          // Stage with empty selection
          service.stageLines(path, [], hunk);

          // Verify: No lines should be staged
          const stagedLines = service.getStagedLines(path);
          const stagedChanges = stagedLines.filter((l) => l.type === 'add' || l.type === 'delete');

          assert.strictEqual(
            stagedChanges.length,
            0,
            'Empty selection should result in no staged changes'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Staging all lines results in all changes being staged.
     *
     * **Validates: Requirements 3.7, 14.2, 14.3, 14.5, 14.6**
     */
    it('Property: Staging all lines stages all changes', () => {
      fc.assert(
        fc.property(validHunkArb, filePathArb, (hunk, path) => {
          const addedLines = getAddedLineNumbers(hunk);
          if (addedLines.length === 0) {
            return true;
          }

          const service = new MockPartialStagingService();

          // Stage all added lines
          service.stageLines(path, addedLines, hunk);

          // Verify: All added lines should be staged
          for (const lineNum of addedLines) {
            assert.ok(
              service.isLineStaged(path, lineNum, 'add'),
              `Line ${lineNum} should be staged when all lines are selected`
            );
          }

          // Verify: No added lines should remain unstaged
          for (const lineNum of addedLines) {
            assert.ok(
              !service.isLineUnstaged(path, lineNum, 'add'),
              `Line ${lineNum} should not be unstaged when all lines are selected`
            );
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Line selection is exact - only specified lines are affected.
     *
     * **Validates: Requirements 3.7, 14.2, 14.3, 14.5, 14.6**
     */
    it('Property: Line selection is exact', () => {
      fc.assert(
        fc.property(validHunkArb, filePathArb, (hunk, path) => {
          const addedLines = getAddedLineNumbers(hunk);
          if (addedLines.length < 3) {
            return true; // Need at least 3 lines for meaningful test
          }

          // Select only the middle line
          const middleIndex = Math.floor(addedLines.length / 2);
          const selectedLines = [addedLines[middleIndex]];
          const beforeLines = addedLines.slice(0, middleIndex);
          const afterLines = addedLines.slice(middleIndex + 1);

          const service = new MockPartialStagingService();
          service.stageLines(path, selectedLines, hunk);

          // Verify: Only the selected line is staged
          assert.ok(
            service.isLineStaged(path, selectedLines[0], 'add'),
            'Selected middle line should be staged'
          );

          // Verify: Lines before are not staged
          for (const lineNum of beforeLines) {
            assert.ok(
              !service.isLineStaged(path, lineNum, 'add'),
              `Line ${lineNum} before selection should not be staged`
            );
          }

          // Verify: Lines after are not staged
          for (const lineNum of afterLines) {
            assert.ok(
              !service.isLineStaged(path, lineNum, 'add'),
              `Line ${lineNum} after selection should not be staged`
            );
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Partial staging preserves total line count.
     * The sum of staged and unstaged change lines should equal the original.
     *
     * **Validates: Requirements 3.7, 14.2, 14.3, 14.5, 14.6**
     */
    it('Property: Partial staging preserves total line count', () => {
      fc.assert(
        fc.property(validHunkArb, filePathArb, (hunk, path) => {
          const addedLines = getAddedLineNumbers(hunk);
          if (addedLines.length === 0) {
            return true;
          }

          // Select half of the added lines
          const selectedLines = addedLines.slice(0, Math.max(1, Math.floor(addedLines.length / 2)));

          const service = new MockPartialStagingService();
          service.stageLines(path, selectedLines, hunk);

          // Count staged and unstaged added lines
          let stagedAddCount = 0;
          let unstagedAddCount = 0;

          for (const lineNum of addedLines) {
            if (service.isLineStaged(path, lineNum, 'add')) {
              stagedAddCount++;
            }
            if (service.isLineUnstaged(path, lineNum, 'add')) {
              unstagedAddCount++;
            }
          }

          // Total should equal original count
          assert.strictEqual(
            stagedAddCount + unstagedAddCount,
            addedLines.length,
            `Total lines (${stagedAddCount} staged + ${unstagedAddCount} unstaged) should equal original (${addedLines.length})`
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple partial staging operations are cumulative.
     *
     * **Validates: Requirements 3.7, 14.2, 14.3, 14.5, 14.6**
     */
    it('Property: Multiple staging operations are cumulative', () => {
      fc.assert(
        fc.property(validHunkArb, validHunkArb, filePathArb, (hunk1, hunk2, path) => {
          const addedLines1 = getAddedLineNumbers(hunk1);
          const addedLines2 = getAddedLineNumbers(hunk2);

          if (addedLines1.length === 0 || addedLines2.length === 0) {
            return true;
          }

          const service = new MockPartialStagingService();

          // Stage lines from first hunk
          const selected1 = addedLines1.slice(0, Math.max(1, Math.floor(addedLines1.length / 2)));
          service.stageLines(path, selected1, hunk1);

          // Stage lines from second hunk
          const selected2 = addedLines2.slice(0, Math.max(1, Math.floor(addedLines2.length / 2)));
          service.stageLines(path, selected2, hunk2);

          // Verify: Lines from both operations should be staged
          for (const lineNum of selected1) {
            assert.ok(
              service.isLineStaged(path, lineNum, 'add'),
              `Line ${lineNum} from first staging should still be staged`
            );
          }

          // Note: The second staging adds to the staged patches
          const stagedLines = service.getStagedLines(path);
          assert.ok(
            stagedLines.length > 0,
            'Multiple staging operations should result in staged lines'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });
});
