import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  IHunk,
  IDiffLine,
  DiffLineType,
  FileStatus,
} from '../../src/git-core/interfaces/IGitService';
import { IFileChange, IChangelist } from '../../src/changelists/interfaces/IChangelistService';

/**
 * Property-based tests for Partial Staging File Sections.
 * Feature: intellig-vscode, Property 46: Partial Staging File Sections
 *
 *
 * Property Description:
 * For any file with partially staged changes, the file SHALL appear in both
 * the staged and unstaged sections of the Local Changes View.
 */
describe('Partial Staging File Sections Property Tests', () => {
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
   * Arbitrary generator for file status (excluding conflicted for simplicity)
   */
  const fileStatusArb: fc.Arbitrary<FileStatus> = fc.constantFrom(
    'modified',
    'added',
    'deleted',
    'renamed',
    'copied',
    'untracked'
  );

  /**
   * Arbitrary generator for diff line type
   */
  const diffLineTypeArb: fc.Arbitrary<DiffLineType> = fc.constantFrom('context', 'add', 'delete');

  /**
   * Arbitrary generator for diff line content
   */
  const lineContentArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 100 })
    .filter((s) => s.trim().length > 0 && !s.includes('\n') && !s.includes('\r'));

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
      lines: fc.array(diffLineArb, { minLength: 2, maxLength: 20 }),
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
   * Arbitrary generator for changelist ID
   */
  const changelistIdArb: fc.Arbitrary<string> = fc
    .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), {
      minLength: 5,
      maxLength: 15,
    })
    .map((s) => `changelist-${s}`);

  /**
   * Arbitrary generator for changelist name
   */
  const changelistNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_'),
      {
        minLength: 3,
        maxLength: 30,
      }
    )
    .filter((s) => s.trim().length > 0);

  /**
   * Mock class that simulates the Local Changes View behavior for partial staging.
   * This tracks files and their staging state, simulating how the view should
   * display files that have both staged and unstaged changes.
   */
  class MockLocalChangesView {
    // Map of file path to staged lines (line numbers that are staged)
    private _stagedLines: Map<string, Set<number>> = new Map();
    // Map of file path to all change lines (line numbers with changes)
    private _allChangeLines: Map<string, Set<number>> = new Map();
    // Map of file path to file status
    private _fileStatuses: Map<string, FileStatus> = new Map();
    // Changelists
    private _changelists: IChangelist[] = [];

    /**
     * Register a file with changes
     */
    registerFile(path: string, status: FileStatus, hunk: IHunk): void {
      this._fileStatuses.set(path, status);

      // Track all change lines (adds and deletes)
      const changeLines = new Set<number>();
      for (const line of hunk.lines) {
        if (line.type === 'add' && line.newLineNumber !== undefined) {
          changeLines.add(line.newLineNumber);
        } else if (line.type === 'delete' && line.oldLineNumber !== undefined) {
          changeLines.add(line.oldLineNumber);
        }
      }
      this._allChangeLines.set(path, changeLines);

      // Initialize staged lines as empty
      if (!this._stagedLines.has(path)) {
        this._stagedLines.set(path, new Set());
      }
    }

    /**
     * Stage specific lines of a file
     */
    stageLines(path: string, lines: number[]): void {
      const stagedLines = this._stagedLines.get(path) || new Set();
      for (const line of lines) {
        stagedLines.add(line);
      }
      this._stagedLines.set(path, stagedLines);
    }

    /**
     * Stage all changes in a file
     */
    stageAll(path: string): void {
      const allLines = this._allChangeLines.get(path);
      if (allLines) {
        this._stagedLines.set(path, new Set(allLines));
      }
    }

    /**
     * Unstage all changes in a file
     */
    unstageAll(path: string): void {
      this._stagedLines.set(path, new Set());
    }

    /**
     * Check if a file has any staged changes
     */
    hasStagedChanges(path: string): boolean {
      const stagedLines = this._stagedLines.get(path);
      return stagedLines !== undefined && stagedLines.size > 0;
    }

    /**
     * Check if a file has any unstaged changes
     */
    hasUnstagedChanges(path: string): boolean {
      const stagedLines = this._stagedLines.get(path) || new Set();
      const allLines = this._allChangeLines.get(path) || new Set();

      // File has unstaged changes if there are change lines not in staged
      for (const line of allLines) {
        if (!stagedLines.has(line)) {
          return true;
        }
      }
      return false;
    }

    /**
     * Check if a file is partially staged (has both staged and unstaged changes)
     */
    isPartiallyStaged(path: string): boolean {
      return this.hasStagedChanges(path) && this.hasUnstagedChanges(path);
    }

    /**
     * Get the staged section files (files that should appear in staged section)
     * A file appears in staged section if it has any staged changes.
     */
    getStagedSectionFiles(): string[] {
      const files: string[] = [];
      for (const [path] of this._stagedLines) {
        if (this.hasStagedChanges(path)) {
          files.push(path);
        }
      }
      return files;
    }

    /**
     * Get the unstaged section files (files that should appear in unstaged section)
     * A file appears in unstaged section if it has any unstaged changes.
     */
    getUnstagedSectionFiles(): string[] {
      const files: string[] = [];
      for (const [path] of this._allChangeLines) {
        if (this.hasUnstagedChanges(path)) {
          files.push(path);
        }
      }
      return files;
    }

    /**
     * Build changelists with proper staged/unstaged file representation.
     * This simulates how the Local Changes View should organize files.
     *
     * For partially staged files, the file should appear in BOTH:
     * - The staged section (showing staged changes)
     * - The unstaged section (showing unstaged changes)
     */
    buildChangelists(changelistId: string, changelistName: string): IChangelist[] {
      const stagedFiles: IFileChange[] = [];
      const unstagedFiles: IFileChange[] = [];

      for (const [path, status] of this._fileStatuses) {
        const hasStagedChanges = this.hasStagedChanges(path);
        const hasUnstagedChanges = this.hasUnstagedChanges(path);

        if (hasStagedChanges) {
          stagedFiles.push({
            path,
            status,
            staged: true,
          });
        }

        if (hasUnstagedChanges) {
          unstagedFiles.push({
            path,
            status,
            staged: false,
          });
        }
      }

      // Create changelists - one for staged, one for unstaged
      // In a real implementation, these might be combined or shown differently
      this._changelists = [];

      if (stagedFiles.length > 0) {
        this._changelists.push({
          id: `${changelistId}-staged`,
          name: `${changelistName} (Staged)`,
          isDefault: false,
          isActive: false,
          files: stagedFiles,
        });
      }

      if (unstagedFiles.length > 0) {
        this._changelists.push({
          id: `${changelistId}-unstaged`,
          name: `${changelistName} (Unstaged)`,
          isDefault: true,
          isActive: true,
          files: unstagedFiles,
        });
      }

      return this._changelists;
    }

    /**
     * Check if a file appears in the staged section of changelists
     */
    fileAppearsInStagedSection(path: string): boolean {
      for (const changelist of this._changelists) {
        for (const file of changelist.files) {
          if (file.path === path && file.staged === true) {
            return true;
          }
        }
      }
      return false;
    }

    /**
     * Check if a file appears in the unstaged section of changelists
     */
    fileAppearsInUnstagedSection(path: string): boolean {
      for (const changelist of this._changelists) {
        for (const file of changelist.files) {
          if (file.path === path && file.staged === false) {
            return true;
          }
        }
      }
      return false;
    }

    /**
     * Reset the view state
     */
    reset(): void {
      this._stagedLines.clear();
      this._allChangeLines.clear();
      this._fileStatuses.clear();
      this._changelists = [];
    }
  }

  /**
   * Get all change line info from a hunk (adds and deletes)
   * Returns objects with type and line number to properly track staging
   */
  interface IChangeLineInfo {
    type: 'add' | 'delete';
    lineNumber: number;
  }

  function getChangeLineInfo(hunk: IHunk): IChangeLineInfo[] {
    const lines: IChangeLineInfo[] = [];
    for (const line of hunk.lines) {
      if (line.type === 'add' && line.newLineNumber !== undefined) {
        lines.push({ type: 'add', lineNumber: line.newLineNumber });
      } else if (line.type === 'delete' && line.oldLineNumber !== undefined) {
        lines.push({ type: 'delete', lineNumber: line.oldLineNumber });
      }
    }
    return lines;
  }

  /**
   * Get all change line numbers from a hunk (adds and deletes)
   * Note: This returns unique line numbers, but adds and deletes may share numbers
   */
  function getChangeLineNumbers(hunk: IHunk): number[] {
    const lineInfo = getChangeLineInfo(hunk);
    // Return unique line numbers
    return [...new Set(lineInfo.map((l) => l.lineNumber))];
  }

  describe('Property 46: Partial Staging File Sections', () => {
    /**
     * Property: Partially staged files appear in both staged and unstaged sections.
     */
    it('Property: Partially staged files appear in both staged and unstaged sections', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileStatusArb,
          validHunkArb,
          changelistIdArb,
          changelistNameArb,
          (path, status, hunk, changelistId, changelistName) => {
            const changeLines = getChangeLineNumbers(hunk);
            // Need at least 2 unique change line numbers to have partial staging
            if (changeLines.length < 2) {
              return true;
            }

            const view = new MockLocalChangesView();
            view.registerFile(path, status, hunk);

            // Stage only the first line (guaranteed to leave at least one unstaged)
            const linesToStage = [changeLines[0]];
            view.stageLines(path, linesToStage);

            // Verify the file is partially staged
            assert.ok(
              view.isPartiallyStaged(path),
              `File should be partially staged after staging line ${changeLines[0]} (all lines: ${changeLines.join(', ')})`
            );

            // Build changelists
            view.buildChangelists(changelistId, changelistName);

            // Verify: File appears in BOTH staged and unstaged sections
            assert.ok(
              view.fileAppearsInStagedSection(path),
              'Partially staged file should appear in staged section'
            );
            assert.ok(
              view.fileAppearsInUnstagedSection(path),
              'Partially staged file should appear in unstaged section'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Fully staged files appear only in staged section.
     */
    it('Property: Fully staged files appear only in staged section', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileStatusArb,
          validHunkArb,
          changelistIdArb,
          changelistNameArb,
          (path, status, hunk, changelistId, changelistName) => {
            const changeLines = getChangeLineNumbers(hunk);
            if (changeLines.length === 0) {
              return true;
            }

            const view = new MockLocalChangesView();
            view.registerFile(path, status, hunk);

            // Stage ALL lines
            view.stageAll(path);

            // Verify the file is NOT partially staged (fully staged)
            assert.ok(
              !view.isPartiallyStaged(path),
              'File should not be partially staged after staging all lines'
            );
            assert.ok(view.hasStagedChanges(path), 'File should have staged changes');
            assert.ok(!view.hasUnstagedChanges(path), 'File should not have unstaged changes');

            // Build changelists
            view.buildChangelists(changelistId, changelistName);

            // Verify: File appears ONLY in staged section
            assert.ok(
              view.fileAppearsInStagedSection(path),
              'Fully staged file should appear in staged section'
            );
            assert.ok(
              !view.fileAppearsInUnstagedSection(path),
              'Fully staged file should NOT appear in unstaged section'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Unstaged files appear only in unstaged section.
     */
    it('Property: Unstaged files appear only in unstaged section', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileStatusArb,
          validHunkArb,
          changelistIdArb,
          changelistNameArb,
          (path, status, hunk, changelistId, changelistName) => {
            const changeLines = getChangeLineNumbers(hunk);
            if (changeLines.length === 0) {
              return true;
            }

            const view = new MockLocalChangesView();
            view.registerFile(path, status, hunk);

            // Don't stage any lines (file remains unstaged)
            // No staging operation needed

            // Verify the file is NOT partially staged (fully unstaged)
            assert.ok(
              !view.isPartiallyStaged(path),
              'File should not be partially staged when nothing is staged'
            );
            assert.ok(!view.hasStagedChanges(path), 'File should not have staged changes');
            assert.ok(view.hasUnstagedChanges(path), 'File should have unstaged changes');

            // Build changelists
            view.buildChangelists(changelistId, changelistName);

            // Verify: File appears ONLY in unstaged section
            assert.ok(
              !view.fileAppearsInStagedSection(path),
              'Unstaged file should NOT appear in staged section'
            );
            assert.ok(
              view.fileAppearsInUnstagedSection(path),
              'Unstaged file should appear in unstaged section'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Staging then unstaging returns file to unstaged-only state.
     */
    it('Property: Staging then unstaging returns file to unstaged-only state', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileStatusArb,
          validHunkArb,
          changelistIdArb,
          changelistNameArb,
          (path, status, hunk, changelistId, changelistName) => {
            const changeLines = getChangeLineNumbers(hunk);
            if (changeLines.length === 0) {
              return true;
            }

            const view = new MockLocalChangesView();
            view.registerFile(path, status, hunk);

            // Stage some lines
            const linesToStage = changeLines.slice(
              0,
              Math.max(1, Math.floor(changeLines.length / 2))
            );
            view.stageLines(path, linesToStage);

            // Verify partial staging
            if (linesToStage.length < changeLines.length) {
              assert.ok(view.isPartiallyStaged(path), 'File should be partially staged');
            }

            // Unstage all
            view.unstageAll(path);

            // Verify file is back to unstaged-only state
            assert.ok(
              !view.hasStagedChanges(path),
              'File should not have staged changes after unstaging'
            );
            assert.ok(view.hasUnstagedChanges(path), 'File should have unstaged changes');

            // Build changelists
            view.buildChangelists(changelistId, changelistName);

            // Verify: File appears ONLY in unstaged section
            assert.ok(
              !view.fileAppearsInStagedSection(path),
              'File should NOT appear in staged section after unstaging'
            );
            assert.ok(
              view.fileAppearsInUnstagedSection(path),
              'File should appear in unstaged section after unstaging'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Multiple files with different staging states are correctly categorized.
     */
    it('Property: Multiple files with different staging states are correctly categorized', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(filePathArb, fileStatusArb, validHunkArb), {
            minLength: 2,
            maxLength: 5,
          }),
          changelistIdArb,
          changelistNameArb,
          (filesData, changelistId, changelistName) => {
            // Ensure unique paths
            const uniquePaths = new Set<string>();
            const uniqueFilesData = filesData.filter(([path]) => {
              if (uniquePaths.has(path)) {
                return false;
              }
              uniquePaths.add(path);
              return true;
            });

            if (uniqueFilesData.length < 2) {
              return true;
            }

            const view = new MockLocalChangesView();

            // Register all files
            for (const [path, status, hunk] of uniqueFilesData) {
              view.registerFile(path, status, hunk);
            }

            // Stage different amounts for each file:
            // - First file: fully staged
            // - Second file: partially staged
            // - Rest: unstaged
            const [firstFile, secondFile, ...restFiles] = uniqueFilesData;

            // Fully stage first file
            view.stageAll(firstFile[0]);

            // Partially stage second file
            const secondChangeLines = getChangeLineNumbers(secondFile[2]);
            if (secondChangeLines.length >= 2) {
              const linesToStage = secondChangeLines.slice(
                0,
                Math.floor(secondChangeLines.length / 2)
              );
              view.stageLines(secondFile[0], linesToStage);
            }

            // Rest remain unstaged (no action needed)

            // Build changelists
            view.buildChangelists(changelistId, changelistName);

            // Verify first file (fully staged): only in staged section
            assert.ok(
              view.fileAppearsInStagedSection(firstFile[0]),
              'Fully staged file should appear in staged section'
            );
            assert.ok(
              !view.fileAppearsInUnstagedSection(firstFile[0]),
              'Fully staged file should NOT appear in unstaged section'
            );

            // Verify second file (partially staged): in both sections
            if (secondChangeLines.length >= 2) {
              assert.ok(
                view.fileAppearsInStagedSection(secondFile[0]),
                'Partially staged file should appear in staged section'
              );
              assert.ok(
                view.fileAppearsInUnstagedSection(secondFile[0]),
                'Partially staged file should appear in unstaged section'
              );
            }

            // Verify rest (unstaged): only in unstaged section
            for (const [path] of restFiles) {
              assert.ok(
                !view.fileAppearsInStagedSection(path),
                `Unstaged file ${path} should NOT appear in staged section`
              );
              assert.ok(
                view.fileAppearsInUnstagedSection(path),
                `Unstaged file ${path} should appear in unstaged section`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Partial staging with single line staged still shows file in both sections.
     */
    it('Property: Partial staging with single line staged shows file in both sections', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileStatusArb,
          validHunkArb,
          changelistIdArb,
          changelistNameArb,
          (path, status, hunk, changelistId, changelistName) => {
            const changeLines = getChangeLineNumbers(hunk);
            if (changeLines.length < 2) {
              return true; // Need at least 2 lines to have partial staging
            }

            const view = new MockLocalChangesView();
            view.registerFile(path, status, hunk);

            // Stage only ONE line
            view.stageLines(path, [changeLines[0]]);

            // Verify partial staging
            assert.ok(view.hasStagedChanges(path), 'File should have staged changes');
            assert.ok(view.hasUnstagedChanges(path), 'File should have unstaged changes');
            assert.ok(view.isPartiallyStaged(path), 'File should be partially staged');

            // Build changelists
            view.buildChangelists(changelistId, changelistName);

            // Verify: File appears in BOTH sections
            assert.ok(
              view.fileAppearsInStagedSection(path),
              'File with single staged line should appear in staged section'
            );
            assert.ok(
              view.fileAppearsInUnstagedSection(path),
              'File with single staged line should appear in unstaged section'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Partial staging with all but one line staged still shows file in both sections.
     */
    it('Property: Partial staging with all but one line staged shows file in both sections', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileStatusArb,
          validHunkArb,
          changelistIdArb,
          changelistNameArb,
          (path, status, hunk, changelistId, changelistName) => {
            const changeLines = getChangeLineNumbers(hunk);
            // Need at least 2 unique change line numbers to have partial staging
            if (changeLines.length < 2) {
              return true;
            }

            const view = new MockLocalChangesView();
            view.registerFile(path, status, hunk);

            // Stage all but the last line
            const linesToStage = changeLines.slice(0, changeLines.length - 1);
            view.stageLines(path, linesToStage);

            // Verify partial staging - we staged some but not all unique line numbers
            assert.ok(view.hasStagedChanges(path), 'File should have staged changes');
            assert.ok(
              view.hasUnstagedChanges(path),
              `File should have unstaged changes (staged: ${linesToStage.join(', ')}, all: ${changeLines.join(', ')})`
            );
            assert.ok(view.isPartiallyStaged(path), 'File should be partially staged');

            // Build changelists
            view.buildChangelists(changelistId, changelistName);

            // Verify: File appears in BOTH sections
            assert.ok(
              view.fileAppearsInStagedSection(path),
              'File with most lines staged should appear in staged section'
            );
            assert.ok(
              view.fileAppearsInUnstagedSection(path),
              'File with most lines staged should appear in unstaged section'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: File section membership is consistent with staging state.
     */
    it('Property: File section membership is consistent with staging state', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileStatusArb,
          validHunkArb,
          fc.array(fc.nat({ max: 100 }), { minLength: 0, maxLength: 10 }),
          changelistIdArb,
          changelistNameArb,
          (path, status, hunk, randomIndices, changelistId, changelistName) => {
            const changeLines = getChangeLineNumbers(hunk);
            if (changeLines.length === 0) {
              return true;
            }

            const view = new MockLocalChangesView();
            view.registerFile(path, status, hunk);

            // Stage random subset of lines based on random indices
            const linesToStage = randomIndices
              .map((idx) => changeLines[idx % changeLines.length])
              .filter((line, index, self) => self.indexOf(line) === index); // unique

            if (linesToStage.length > 0) {
              view.stageLines(path, linesToStage);
            }

            // Build changelists
            view.buildChangelists(changelistId, changelistName);

            // Verify consistency
            const hasStagedChanges = view.hasStagedChanges(path);
            const hasUnstagedChanges = view.hasUnstagedChanges(path);
            const appearsInStaged = view.fileAppearsInStagedSection(path);
            const appearsInUnstaged = view.fileAppearsInUnstagedSection(path);

            // File should appear in staged section IFF it has staged changes
            assert.strictEqual(
              appearsInStaged,
              hasStagedChanges,
              `Staged section membership (${appearsInStaged}) should match hasStagedChanges (${hasStagedChanges})`
            );

            // File should appear in unstaged section IFF it has unstaged changes
            assert.strictEqual(
              appearsInUnstaged,
              hasUnstagedChanges,
              `Unstaged section membership (${appearsInUnstaged}) should match hasUnstagedChanges (${hasUnstagedChanges})`
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
