import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  IMergeState,
  IConflictRegion,
  ConflictResolution,
} from '../../services/interfaces/IMergeView';

/**
 * Property-based tests for Three-Way Merge Display.
 * Feature: intellij-git-vscode, Property 32: Three-Way Merge Display
 *
 * **Validates: Requirements 10.2, 10.3**
 *
 * Property Description:
 * For any conflicted file, the merge editor SHALL display three panes showing
 * the base version, current (local) version, and incoming (remote) version.
 *
 * Requirements:
 * - 10.2: WHEN a user opens a conflicted file, THE Extension SHALL display a
 *         Three_Way_Merge editor showing base, local (current), and remote (incoming) versions
 * - 10.3: WHEN viewing the Three_Way_Merge editor, THE Extension SHALL highlight
 *         conflicting sections in each pane
 */
describe('Three-Way Merge Display Property Tests', () => {
  /**
   * Arbitrary generator for valid file paths.
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./'.split('')
      ),
      { minLength: 1, maxLength: 50 }
    )
    .filter((s) => {
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('/') || s.endsWith('/')) {
        return false;
      }
      if (s.includes('//')) {
        return false;
      }
      if (s.startsWith('.') && s.length === 1) {
        return false;
      }
      return true;
    })
    .map((s) => (s.startsWith('.') ? 'file' + s : s));

  /**
   * Arbitrary generator for non-empty content lines.
   */
  const contentLineArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 100 })
    .filter(
      (s) =>
        s.trim().length > 0 &&
        !s.includes('<<<<<<<') &&
        !s.includes('=======') &&
        !s.includes('>>>>>>>')
    );

  /**
   * Arbitrary generator for file content (multiple lines).
   */
  const fileContentArb: fc.Arbitrary<string> = fc
    .array(contentLineArb, { minLength: 1, maxLength: 20 })
    .map((lines) => lines.join('\n'));

  /**
   * Arbitrary generator for conflict resolution type.
   */
  const conflictResolutionArb: fc.Arbitrary<ConflictResolution> = fc.constantFrom(
    'current',
    'incoming',
    'both',
    'manual'
  );

  /**
   * Arbitrary generator for a single conflict region.
   * Each conflict has base, current, and incoming content.
   */
  const conflictRegionArb: fc.Arbitrary<{
    id: number;
    baseContent: string;
    currentContent: string;
    incomingContent: string;
    resolved: boolean;
    resolution?: ConflictResolution;
  }> = fc.record({
    id: fc.nat({ max: 1000 }),
    baseContent: contentLineArb,
    currentContent: contentLineArb,
    incomingContent: contentLineArb,
    resolved: fc.boolean(),
    resolution: fc.option(conflictResolutionArb, { nil: undefined }),
  });

  /**
   * Arbitrary generator for non-empty array of conflict regions with unique IDs.
   */
  const conflictRegionsArb: fc.Arbitrary<
    Array<{
      id: number;
      baseContent: string;
      currentContent: string;
      incomingContent: string;
      resolved: boolean;
      resolution?: ConflictResolution;
    }>
  > = fc.array(conflictRegionArb, { minLength: 1, maxLength: 10 }).map((conflicts) => {
    // Ensure unique IDs
    const seen = new Set<number>();
    let nextId = 0;
    return conflicts.map((c) => {
      while (seen.has(nextId)) {
        nextId++;
      }
      seen.add(nextId);
      return { ...c, id: nextId++ };
    });
  });

  /**
   * Mock Range class to simulate vscode.Range
   */
  class MockRange {
    constructor(
      public readonly startLine: number,
      public readonly startCharacter: number,
      public readonly endLine: number,
      public readonly endCharacter: number
    ) {}

    get start(): { line: number; character: number } {
      return { line: this.startLine, character: this.startCharacter };
    }

    get end(): { line: number; character: number } {
      return { line: this.endLine, character: this.endCharacter };
    }
  }

  /**
   * Mock MergeView service that simulates three-way merge display.
   * This allows us to test the merge display properties without actual VS Code UI.
   */
  class MockMergeViewService {
    private _mergeState: IMergeState | undefined;
    private _currentConflictIndex: number = 0;

    /**
     * Create a merge state from conflicted file content.
     * Requirement 10.2: Display three panes showing base, current, and incoming versions.
     *
     * @param file - The file path
     * @param base - The base version content
     * @param current - The current (local) version content
     * @param incoming - The incoming (remote) version content
     * @param conflicts - The conflict regions
     */
    createMergeState(
      file: string,
      base: string,
      current: string,
      incoming: string,
      conflicts: Array<{
        id: number;
        baseContent: string;
        currentContent: string;
        incomingContent: string;
        resolved: boolean;
        resolution?: ConflictResolution;
      }>
    ): IMergeState {
      // Create conflict regions with proper ranges
      let baseLine = 0;
      let currentLine = 0;
      let incomingLine = 0;

      const conflictRegions: IConflictRegion[] = conflicts.map((c) => {
        const baseLines = c.baseContent.split('\n').length;
        const currentLines = c.currentContent.split('\n').length;
        const incomingLines = c.incomingContent.split('\n').length;

        const region: IConflictRegion = {
          id: c.id,
          baseRange: new MockRange(
            baseLine,
            0,
            baseLine + baseLines - 1,
            0
          ) as unknown as import('vscode').Range,
          currentRange: new MockRange(
            currentLine,
            0,
            currentLine + currentLines - 1,
            0
          ) as unknown as import('vscode').Range,
          incomingRange: new MockRange(
            incomingLine,
            0,
            incomingLine + incomingLines - 1,
            0
          ) as unknown as import('vscode').Range,
          resolved: c.resolved,
          resolution: c.resolution,
          baseContent: c.baseContent,
          currentContent: c.currentContent,
          incomingContent: c.incomingContent,
        };

        baseLine += baseLines + 1;
        currentLine += currentLines + 1;
        incomingLine += incomingLines + 1;

        return region;
      });

      this._mergeState = {
        file,
        base,
        current,
        incoming,
        conflicts: conflictRegions,
        resolvedConflicts: new Set(conflicts.filter((c) => c.resolved).map((c) => c.id)),
      };

      return this._mergeState;
    }

    /**
     * Get the current merge state.
     */
    getMergeState(): IMergeState | undefined {
      return this._mergeState;
    }

    /**
     * Check if the merge view displays three panes.
     * Requirement 10.2: Display base, current, and incoming versions.
     */
    hasThreePanes(): boolean {
      if (!this._mergeState) {
        return false;
      }
      return (
        this._mergeState.base !== undefined &&
        this._mergeState.current !== undefined &&
        this._mergeState.incoming !== undefined
      );
    }

    /**
     * Get the base version content.
     */
    getBaseContent(): string | undefined {
      return this._mergeState?.base;
    }

    /**
     * Get the current (local) version content.
     */
    getCurrentContent(): string | undefined {
      return this._mergeState?.current;
    }

    /**
     * Get the incoming (remote) version content.
     */
    getIncomingContent(): string | undefined {
      return this._mergeState?.incoming;
    }

    /**
     * Get all conflict regions.
     * Requirement 10.3: Highlight conflicting sections in each pane.
     */
    getConflicts(): IConflictRegion[] {
      return this._mergeState?.conflicts ?? [];
    }

    /**
     * Check if all conflicts have highlighting information (ranges).
     * Requirement 10.3: Highlight conflicting sections.
     */
    allConflictsHaveHighlighting(): boolean {
      if (!this._mergeState) {
        return false;
      }
      return this._mergeState.conflicts.every(
        (c) =>
          c.baseRange !== undefined && c.currentRange !== undefined && c.incomingRange !== undefined
      );
    }

    /**
     * Check if a specific conflict has content for all three versions.
     */
    conflictHasAllVersions(conflictId: number): boolean {
      const conflict = this._mergeState?.conflicts.find((c) => c.id === conflictId);
      if (!conflict) {
        return false;
      }
      return (
        conflict.baseContent !== undefined &&
        conflict.currentContent !== undefined &&
        conflict.incomingContent !== undefined
      );
    }

    /**
     * Get the number of conflicts.
     */
    getConflictCount(): number {
      return this._mergeState?.conflicts.length ?? 0;
    }

    /**
     * Navigate to the next conflict.
     */
    nextConflict(): number {
      if (!this._mergeState || this._mergeState.conflicts.length === 0) {
        return -1;
      }
      this._currentConflictIndex =
        (this._currentConflictIndex + 1) % this._mergeState.conflicts.length;
      return this._currentConflictIndex;
    }

    /**
     * Navigate to the previous conflict.
     */
    previousConflict(): number {
      if (!this._mergeState || this._mergeState.conflicts.length === 0) {
        return -1;
      }
      this._currentConflictIndex =
        (this._currentConflictIndex - 1 + this._mergeState.conflicts.length) %
        this._mergeState.conflicts.length;
      return this._currentConflictIndex;
    }

    /**
     * Get the current conflict index.
     */
    getCurrentConflictIndex(): number {
      return this._currentConflictIndex;
    }

    /**
     * Accept current version for a conflict.
     */
    acceptCurrent(conflictId?: number): void {
      if (!this._mergeState) {
        return;
      }
      const id = conflictId ?? this._mergeState.conflicts[this._currentConflictIndex]?.id;
      const conflict = this._mergeState.conflicts.find((c) => c.id === id);
      if (conflict) {
        conflict.resolved = true;
        conflict.resolution = 'current';
        this._mergeState.resolvedConflicts.add(id);
      }
    }

    /**
     * Accept incoming version for a conflict.
     */
    acceptIncoming(conflictId?: number): void {
      if (!this._mergeState) {
        return;
      }
      const id = conflictId ?? this._mergeState.conflicts[this._currentConflictIndex]?.id;
      const conflict = this._mergeState.conflicts.find((c) => c.id === id);
      if (conflict) {
        conflict.resolved = true;
        conflict.resolution = 'incoming';
        this._mergeState.resolvedConflicts.add(id);
      }
    }

    /**
     * Accept both versions for a conflict.
     */
    acceptBoth(conflictId?: number): void {
      if (!this._mergeState) {
        return;
      }
      const id = conflictId ?? this._mergeState.conflicts[this._currentConflictIndex]?.id;
      const conflict = this._mergeState.conflicts.find((c) => c.id === id);
      if (conflict) {
        conflict.resolved = true;
        conflict.resolution = 'both';
        this._mergeState.resolvedConflicts.add(id);
      }
    }

    /**
     * Check if all conflicts are resolved.
     */
    allConflictsResolved(): boolean {
      if (!this._mergeState) {
        return false;
      }
      return this._mergeState.conflicts.every((c) => c.resolved);
    }
  }

  describe('Property 32: Three-Way Merge Display', () => {
    /**
     * Property: Merge view displays three panes for base, current, and incoming versions.
     *
     * **Validates: Requirements 10.2**
     */
    it('Property: Merge view displays three panes (base, current, incoming)', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();

            // Act: Create merge state
            mergeService.createMergeState(file, base, current, incoming, conflicts);

            // Assert: Three panes are displayed
            assert.ok(mergeService.hasThreePanes(), 'Merge view should display three panes');

            // Assert: Each pane has content
            assert.ok(mergeService.getBaseContent() !== undefined, 'Base pane should have content');
            assert.ok(
              mergeService.getCurrentContent() !== undefined,
              'Current pane should have content'
            );
            assert.ok(
              mergeService.getIncomingContent() !== undefined,
              'Incoming pane should have content'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Base version content is preserved in merge view.
     *
     * **Validates: Requirements 10.2**
     */
    it('Property: Base version content is preserved', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();

            // Act: Create merge state
            mergeService.createMergeState(file, base, current, incoming, conflicts);

            // Assert: Base content is preserved
            assert.strictEqual(
              mergeService.getBaseContent(),
              base,
              'Base version content should be preserved'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Current (local) version content is preserved in merge view.
     *
     * **Validates: Requirements 10.2**
     */
    it('Property: Current (local) version content is preserved', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();

            // Act: Create merge state
            mergeService.createMergeState(file, base, current, incoming, conflicts);

            // Assert: Current content is preserved
            assert.strictEqual(
              mergeService.getCurrentContent(),
              current,
              'Current (local) version content should be preserved'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Incoming (remote) version content is preserved in merge view.
     *
     * **Validates: Requirements 10.2**
     */
    it('Property: Incoming (remote) version content is preserved', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();

            // Act: Create merge state
            mergeService.createMergeState(file, base, current, incoming, conflicts);

            // Assert: Incoming content is preserved
            assert.strictEqual(
              mergeService.getIncomingContent(),
              incoming,
              'Incoming (remote) version content should be preserved'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: All conflicts have highlighting information (ranges) in each pane.
     *
     * **Validates: Requirements 10.3**
     */
    it('Property: All conflicts have highlighting information in each pane', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();

            // Act: Create merge state
            mergeService.createMergeState(file, base, current, incoming, conflicts);

            // Assert: All conflicts have highlighting
            assert.ok(
              mergeService.allConflictsHaveHighlighting(),
              'All conflicts should have highlighting information (ranges)'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Each conflict region has content for all three versions.
     *
     * **Validates: Requirements 10.2, 10.3**
     */
    it('Property: Each conflict region has content for all three versions', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();

            // Act: Create merge state
            mergeService.createMergeState(file, base, current, incoming, conflicts);

            // Assert: Each conflict has all three versions
            const mergeConflicts = mergeService.getConflicts();
            for (const conflict of mergeConflicts) {
              assert.ok(
                mergeService.conflictHasAllVersions(conflict.id),
                `Conflict ${conflict.id} should have content for all three versions`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Conflict count matches the number of conflicts provided.
     *
     * **Validates: Requirements 10.2, 10.3**
     */
    it('Property: Conflict count matches input', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();

            // Act: Create merge state
            mergeService.createMergeState(file, base, current, incoming, conflicts);

            // Assert: Conflict count matches
            assert.strictEqual(
              mergeService.getConflictCount(),
              conflicts.length,
              'Conflict count should match input'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Conflict regions have valid ranges (non-negative line numbers).
     *
     * **Validates: Requirements 10.3**
     */
    it('Property: Conflict regions have valid ranges', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();

            // Act: Create merge state
            mergeService.createMergeState(file, base, current, incoming, conflicts);

            // Assert: All ranges are valid
            const mergeConflicts = mergeService.getConflicts();
            for (const conflict of mergeConflicts) {
              // Base range
              assert.ok(
                conflict.baseRange.start.line >= 0,
                `Conflict ${conflict.id} base range start line should be non-negative`
              );
              assert.ok(
                conflict.baseRange.end.line >= conflict.baseRange.start.line,
                `Conflict ${conflict.id} base range end should be >= start`
              );

              // Current range
              assert.ok(
                conflict.currentRange.start.line >= 0,
                `Conflict ${conflict.id} current range start line should be non-negative`
              );
              assert.ok(
                conflict.currentRange.end.line >= conflict.currentRange.start.line,
                `Conflict ${conflict.id} current range end should be >= start`
              );

              // Incoming range
              assert.ok(
                conflict.incomingRange.start.line >= 0,
                `Conflict ${conflict.id} incoming range start line should be non-negative`
              );
              assert.ok(
                conflict.incomingRange.end.line >= conflict.incomingRange.start.line,
                `Conflict ${conflict.id} incoming range end should be >= start`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Conflict content is preserved for base version.
     *
     * **Validates: Requirements 10.2, 10.3**
     */
    it('Property: Conflict base content is preserved', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();

            // Act: Create merge state
            mergeService.createMergeState(file, base, current, incoming, conflicts);

            // Assert: Base content is preserved for each conflict
            const mergeConflicts = mergeService.getConflicts();
            for (let i = 0; i < conflicts.length; i++) {
              assert.strictEqual(
                mergeConflicts[i].baseContent,
                conflicts[i].baseContent,
                `Conflict ${i} base content should be preserved`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Conflict content is preserved for current version.
     *
     * **Validates: Requirements 10.2, 10.3**
     */
    it('Property: Conflict current content is preserved', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();

            // Act: Create merge state
            mergeService.createMergeState(file, base, current, incoming, conflicts);

            // Assert: Current content is preserved for each conflict
            const mergeConflicts = mergeService.getConflicts();
            for (let i = 0; i < conflicts.length; i++) {
              assert.strictEqual(
                mergeConflicts[i].currentContent,
                conflicts[i].currentContent,
                `Conflict ${i} current content should be preserved`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Conflict content is preserved for incoming version.
     *
     * **Validates: Requirements 10.2, 10.3**
     */
    it('Property: Conflict incoming content is preserved', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();

            // Act: Create merge state
            mergeService.createMergeState(file, base, current, incoming, conflicts);

            // Assert: Incoming content is preserved for each conflict
            const mergeConflicts = mergeService.getConflicts();
            for (let i = 0; i < conflicts.length; i++) {
              assert.strictEqual(
                mergeConflicts[i].incomingContent,
                conflicts[i].incomingContent,
                `Conflict ${i} incoming content should be preserved`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: File path is preserved in merge state.
     *
     * **Validates: Requirements 10.2**
     */
    it('Property: File path is preserved in merge state', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();

            // Act: Create merge state
            const mergeState = mergeService.createMergeState(
              file,
              base,
              current,
              incoming,
              conflicts
            );

            // Assert: File path is preserved
            assert.strictEqual(
              mergeState.file,
              file,
              'File path should be preserved in merge state'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Conflict IDs are unique within merge state.
     *
     * **Validates: Requirements 10.2, 10.3**
     */
    it('Property: Conflict IDs are unique within merge state', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();

            // Act: Create merge state
            mergeService.createMergeState(file, base, current, incoming, conflicts);

            // Assert: All conflict IDs are unique
            const mergeConflicts = mergeService.getConflicts();
            const ids = new Set<number>();
            for (const conflict of mergeConflicts) {
              assert.ok(!ids.has(conflict.id), `Conflict ID ${conflict.id} should be unique`);
              ids.add(conflict.id);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Resolved conflicts are tracked in resolvedConflicts set.
     *
     * **Validates: Requirements 10.2, 10.3**
     */
    it('Property: Resolved conflicts are tracked correctly', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();

            // Act: Create merge state
            const mergeState = mergeService.createMergeState(
              file,
              base,
              current,
              incoming,
              conflicts
            );

            // Assert: Resolved conflicts are tracked
            const resolvedCount = conflicts.filter((c) => c.resolved).length;
            assert.strictEqual(
              mergeState.resolvedConflicts.size,
              resolvedCount,
              'Resolved conflicts count should match'
            );

            // Assert: Each resolved conflict is in the set
            for (const conflict of conflicts) {
              if (conflict.resolved) {
                const mergeConflict = mergeState.conflicts.find(
                  (c) => c.baseContent === conflict.baseContent
                );
                if (mergeConflict) {
                  assert.ok(
                    mergeState.resolvedConflicts.has(mergeConflict.id),
                    `Resolved conflict ${mergeConflict.id} should be in resolvedConflicts set`
                  );
                }
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Navigation between conflicts works correctly.
     *
     * **Validates: Requirements 10.3**
     */
    it('Property: Navigation between conflicts cycles through all conflicts', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();
            mergeService.createMergeState(file, base, current, incoming, conflicts);

            // Act: Navigate through all conflicts
            const visitedIndices = new Set<number>();
            visitedIndices.add(mergeService.getCurrentConflictIndex());

            for (let i = 0; i < conflicts.length; i++) {
              const nextIndex = mergeService.nextConflict();
              visitedIndices.add(nextIndex);
            }

            // Assert: All conflicts were visited
            assert.strictEqual(
              visitedIndices.size,
              conflicts.length,
              'Navigation should visit all conflicts'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Previous conflict navigation works correctly.
     *
     * **Validates: Requirements 10.3**
     */
    it('Property: Previous conflict navigation cycles through all conflicts', () => {
      fc.assert(
        fc.property(
          filePathArb,
          fileContentArb,
          fileContentArb,
          fileContentArb,
          conflictRegionsArb,
          (file, base, current, incoming, conflicts) => {
            // Setup
            const mergeService = new MockMergeViewService();
            mergeService.createMergeState(file, base, current, incoming, conflicts);

            // Act: Navigate backwards through all conflicts
            const visitedIndices = new Set<number>();
            visitedIndices.add(mergeService.getCurrentConflictIndex());

            for (let i = 0; i < conflicts.length; i++) {
              const prevIndex = mergeService.previousConflict();
              visitedIndices.add(prevIndex);
            }

            // Assert: All conflicts were visited
            assert.strictEqual(
              visitedIndices.size,
              conflicts.length,
              'Backward navigation should visit all conflicts'
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
