import * as fc from 'fast-check';
import * as assert from 'assert';
import { RepositoryState } from '../../services/interfaces/IGitService';
import { IConflictResolutionResult } from '../../services/interfaces/IConflictResolutionService';
import { IConflictRegion, ConflictResolution } from '../../services/interfaces/IMergeView';

/**
 * Property-based tests for Accept All Resolution.
 * Feature: intellig-vscode, Property 34: Accept All Resolution
 *
 *
 * Property Description:
 * For any file with multiple conflicts, "Accept All Current" or "Accept All Incoming"
 * SHALL resolve all conflicts in that file with the chosen resolution.
 *
 * - 10.8: WHEN a user selects "Accept All Current" or "Accept All Incoming",
 *         THE Extension SHALL apply that resolution to all conflicts in the file
 */
describe('Accept All Resolution Property Tests', () => {
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
   * Arbitrary generator for repository states that can have conflicts.
   */
  const conflictableStateArb: fc.Arbitrary<RepositoryState> = fc.constantFrom(
    'merging',
    'rebasing'
  );

  /**
   * Arbitrary generator for a single conflict region with content.
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
    resolved: fc.constant(false), // Start with unresolved conflicts
    resolution: fc.constant(undefined),
  });

  /**
   * Arbitrary generator for array of conflict regions with unique IDs.
   * Ensures at least 2 conflicts to test "accept all" functionality.
   */
  const multipleConflictsArb: fc.Arbitrary<
    Array<{
      id: number;
      baseContent: string;
      currentContent: string;
      incomingContent: string;
      resolved: boolean;
      resolution?: ConflictResolution;
    }>
  > = fc.array(conflictRegionArb, { minLength: 2, maxLength: 10 }).map((conflicts) => {
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
    readonly startLine: number;
    readonly startCharacter: number;
    readonly endLine: number;
    readonly endCharacter: number;

    constructor(
      startLine: number,
      startCharacter: number,
      endLine: number,
      endCharacter: number
    ) {
      this.startLine = startLine;
      this.startCharacter = startCharacter;
      this.endLine = endLine;
      this.endCharacter = endCharacter;
    }

    get start(): { line: number; character: number } {
      return { line: this.startLine, character: this.startCharacter };
    }

    get end(): { line: number; character: number } {
      return { line: this.endLine, character: this.endCharacter };
    }
  }

  /**
   * Mock Accept All Resolution Service that simulates conflict resolution.
   * This allows us to test the accept all resolution properties without actual Git operations.
   */
  class MockAcceptAllResolutionService {
    private _repositoryState: RepositoryState = 'idle';
    private _conflictedFiles: Map<string, IConflictRegion[]> = new Map();
    private _resolvedContent: Map<string, string> = new Map();

    /**
     * Set up the mock repository with a specific state.
     */
    setRepositoryState(state: RepositoryState): void {
      this._repositoryState = state;
    }

    /**
     * Get the repository state.
     */
    getRepositoryState(): RepositoryState {
      return this._repositoryState;
    }

    /**
     * Set conflicts for a file.
     */
    setFileConflicts(
      filePath: string,
      conflicts: Array<{
        id: number;
        baseContent: string;
        currentContent: string;
        incomingContent: string;
        resolved: boolean;
        resolution?: ConflictResolution;
      }>
    ): void {
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

      this._conflictedFiles.set(filePath, conflictRegions);
    }

    /**
     * Get conflicts for a file.
     */
    getFileConflicts(filePath: string): IConflictRegion[] {
      return this._conflictedFiles.get(filePath) ?? [];
    }

    /**
     * Get the count of unresolved conflicts for a file.
     */
    getUnresolvedConflictCount(filePath: string): number {
      const conflicts = this._conflictedFiles.get(filePath) ?? [];
      return conflicts.filter((c) => !c.resolved).length;
    }

    /**
     * Get the count of resolved conflicts for a file.
     */
    getResolvedConflictCount(filePath: string): number {
      const conflicts = this._conflictedFiles.get(filePath) ?? [];
      return conflicts.filter((c) => c.resolved).length;
    }

    /**
     * Check if all conflicts in a file are resolved.
     */
    allConflictsResolved(filePath: string): boolean {
      const conflicts = this._conflictedFiles.get(filePath) ?? [];
      return conflicts.length > 0 && conflicts.every((c) => c.resolved);
    }

    /**
     * Accept current version for a single conflict.
     */
    acceptCurrent(filePath: string, conflictId: number): IConflictResolutionResult {
      const conflicts = this._conflictedFiles.get(filePath);
      if (!conflicts) {
        return { success: false, error: `File ${filePath} not found` };
      }
      const conflict = conflicts.find((c) => c.id === conflictId);
      if (!conflict) {
        return { success: false, error: `Conflict ${conflictId} not found` };
      }
      conflict.resolved = true;
      conflict.resolution = 'current';
      return { success: true };
    }

    /**
     * Accept incoming version for a single conflict.
     */
    acceptIncoming(filePath: string, conflictId: number): IConflictResolutionResult {
      const conflicts = this._conflictedFiles.get(filePath);
      if (!conflicts) {
        return { success: false, error: `File ${filePath} not found` };
      }
      const conflict = conflicts.find((c) => c.id === conflictId);
      if (!conflict) {
        return { success: false, error: `Conflict ${conflictId} not found` };
      }
      conflict.resolved = true;
      conflict.resolution = 'incoming';
      return { success: true };
    }

    /**
     * Accept All Current - resolve all conflicts in a file with current version.
     */
    acceptAllCurrent(filePath: string): IConflictResolutionResult {
      const conflicts = this._conflictedFiles.get(filePath);
      if (!conflicts) {
        return { success: false, error: `File ${filePath} not found` };
      }
      if (conflicts.length === 0) {
        return { success: false, error: `No conflicts in file ${filePath}` };
      }

      // Resolve all conflicts with current version
      for (const conflict of conflicts) {
        conflict.resolved = true;
        conflict.resolution = 'current';
      }

      // Build resolved content from current versions
      const resolvedContent = conflicts.map((c) => c.currentContent).join('\n');
      this._resolvedContent.set(filePath, resolvedContent);

      return { success: true };
    }

    /**
     * Accept All Incoming - resolve all conflicts in a file with incoming version.
     */
    acceptAllIncoming(filePath: string): IConflictResolutionResult {
      const conflicts = this._conflictedFiles.get(filePath);
      if (!conflicts) {
        return { success: false, error: `File ${filePath} not found` };
      }
      if (conflicts.length === 0) {
        return { success: false, error: `No conflicts in file ${filePath}` };
      }

      // Resolve all conflicts with incoming version
      for (const conflict of conflicts) {
        conflict.resolved = true;
        conflict.resolution = 'incoming';
      }

      // Build resolved content from incoming versions
      const resolvedContent = conflicts.map((c) => c.incomingContent).join('\n');
      this._resolvedContent.set(filePath, resolvedContent);

      return { success: true };
    }

    /**
     * Get the resolved content for a file.
     */
    getResolvedContent(filePath: string): string | undefined {
      return this._resolvedContent.get(filePath);
    }

    /**
     * Check if all conflicts have the same resolution type.
     */
    allConflictsHaveResolution(filePath: string, resolution: ConflictResolution): boolean {
      const conflicts = this._conflictedFiles.get(filePath) ?? [];
      return conflicts.every((c) => c.resolution === resolution);
    }

    /**
     * Get the resolution type for a specific conflict.
     */
    getConflictResolution(filePath: string, conflictId: number): ConflictResolution | undefined {
      const conflicts = this._conflictedFiles.get(filePath) ?? [];
      const conflict = conflicts.find((c) => c.id === conflictId);
      return conflict?.resolution;
    }
  }

  describe('Property 34: Accept All Resolution', () => {
    /**
     * Property: Accept All Current resolves all conflicts in a file.
     */
    it('Property: Accept All Current resolves all conflicts in a file', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          filePathArb,
          multipleConflictsArb,
          (state, filePath, conflicts) => {
            // Setup
            const service = new MockAcceptAllResolutionService();
            service.setRepositoryState(state);
            service.setFileConflicts(filePath, conflicts);

            // Assert: Initially no conflicts are resolved
            assert.strictEqual(
              service.getResolvedConflictCount(filePath),
              0,
              'Initially no conflicts should be resolved'
            );

            // Act: Accept all current
            const result = service.acceptAllCurrent(filePath);

            // Assert: Operation succeeded
            assert.ok(result.success, 'Accept All Current should succeed');

            // Assert: All conflicts are now resolved
            assert.ok(
              service.allConflictsResolved(filePath),
              'All conflicts should be resolved after Accept All Current'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Accept All Incoming resolves all conflicts in a file.
     */
    it('Property: Accept All Incoming resolves all conflicts in a file', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          filePathArb,
          multipleConflictsArb,
          (state, filePath, conflicts) => {
            // Setup
            const service = new MockAcceptAllResolutionService();
            service.setRepositoryState(state);
            service.setFileConflicts(filePath, conflicts);

            // Assert: Initially no conflicts are resolved
            assert.strictEqual(
              service.getResolvedConflictCount(filePath),
              0,
              'Initially no conflicts should be resolved'
            );

            // Act: Accept all incoming
            const result = service.acceptAllIncoming(filePath);

            // Assert: Operation succeeded
            assert.ok(result.success, 'Accept All Incoming should succeed');

            // Assert: All conflicts are now resolved
            assert.ok(
              service.allConflictsResolved(filePath),
              'All conflicts should be resolved after Accept All Incoming'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Accept All Current sets resolution type to 'current' for all conflicts.
     */
    it('Property: Accept All Current sets resolution type to current for all conflicts', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          filePathArb,
          multipleConflictsArb,
          (state, filePath, conflicts) => {
            // Setup
            const service = new MockAcceptAllResolutionService();
            service.setRepositoryState(state);
            service.setFileConflicts(filePath, conflicts);

            // Act: Accept all current
            service.acceptAllCurrent(filePath);

            // Assert: All conflicts have 'current' resolution
            assert.ok(
              service.allConflictsHaveResolution(filePath, 'current'),
              'All conflicts should have current resolution after Accept All Current'
            );

            // Assert: Each individual conflict has 'current' resolution
            for (const conflict of conflicts) {
              assert.strictEqual(
                service.getConflictResolution(filePath, conflict.id),
                'current',
                `Conflict ${conflict.id} should have current resolution`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Accept All Incoming sets resolution type to 'incoming' for all conflicts.
     */
    it('Property: Accept All Incoming sets resolution type to incoming for all conflicts', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          filePathArb,
          multipleConflictsArb,
          (state, filePath, conflicts) => {
            // Setup
            const service = new MockAcceptAllResolutionService();
            service.setRepositoryState(state);
            service.setFileConflicts(filePath, conflicts);

            // Act: Accept all incoming
            service.acceptAllIncoming(filePath);

            // Assert: All conflicts have 'incoming' resolution
            assert.ok(
              service.allConflictsHaveResolution(filePath, 'incoming'),
              'All conflicts should have incoming resolution after Accept All Incoming'
            );

            // Assert: Each individual conflict has 'incoming' resolution
            for (const conflict of conflicts) {
              assert.strictEqual(
                service.getConflictResolution(filePath, conflict.id),
                'incoming',
                `Conflict ${conflict.id} should have incoming resolution`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Accept All Current produces content from current versions.
     */
    it('Property: Accept All Current produces content from current versions', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          filePathArb,
          multipleConflictsArb,
          (state, filePath, conflicts) => {
            // Setup
            const service = new MockAcceptAllResolutionService();
            service.setRepositoryState(state);
            service.setFileConflicts(filePath, conflicts);

            // Act: Accept all current
            service.acceptAllCurrent(filePath);

            // Assert: Resolved content contains current versions
            const resolvedContent = service.getResolvedContent(filePath);
            assert.ok(resolvedContent !== undefined, 'Resolved content should exist');

            // Assert: Each current content is in the resolved content
            for (const conflict of conflicts) {
              assert.ok(
                resolvedContent.includes(conflict.currentContent),
                `Resolved content should include current content from conflict ${conflict.id}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Accept All Incoming produces content from incoming versions.
     */
    it('Property: Accept All Incoming produces content from incoming versions', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          filePathArb,
          multipleConflictsArb,
          (state, filePath, conflicts) => {
            // Setup
            const service = new MockAcceptAllResolutionService();
            service.setRepositoryState(state);
            service.setFileConflicts(filePath, conflicts);

            // Act: Accept all incoming
            service.acceptAllIncoming(filePath);

            // Assert: Resolved content contains incoming versions
            const resolvedContent = service.getResolvedContent(filePath);
            assert.ok(resolvedContent !== undefined, 'Resolved content should exist');

            // Assert: Each incoming content is in the resolved content
            for (const conflict of conflicts) {
              assert.ok(
                resolvedContent.includes(conflict.incomingContent),
                `Resolved content should include incoming content from conflict ${conflict.id}`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Accept All Current resolves exactly the number of conflicts in the file.
     */
    it('Property: Accept All Current resolves exactly the number of conflicts in the file', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          filePathArb,
          multipleConflictsArb,
          (state, filePath, conflicts) => {
            // Setup
            const service = new MockAcceptAllResolutionService();
            service.setRepositoryState(state);
            service.setFileConflicts(filePath, conflicts);

            const initialConflictCount = conflicts.length;

            // Act: Accept all current
            service.acceptAllCurrent(filePath);

            // Assert: Resolved count equals initial conflict count
            assert.strictEqual(
              service.getResolvedConflictCount(filePath),
              initialConflictCount,
              `Resolved conflict count should equal initial count (${initialConflictCount})`
            );

            // Assert: No unresolved conflicts remain
            assert.strictEqual(
              service.getUnresolvedConflictCount(filePath),
              0,
              'No unresolved conflicts should remain'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Accept All Incoming resolves exactly the number of conflicts in the file.
     */
    it('Property: Accept All Incoming resolves exactly the number of conflicts in the file', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          filePathArb,
          multipleConflictsArb,
          (state, filePath, conflicts) => {
            // Setup
            const service = new MockAcceptAllResolutionService();
            service.setRepositoryState(state);
            service.setFileConflicts(filePath, conflicts);

            const initialConflictCount = conflicts.length;

            // Act: Accept all incoming
            service.acceptAllIncoming(filePath);

            // Assert: Resolved count equals initial conflict count
            assert.strictEqual(
              service.getResolvedConflictCount(filePath),
              initialConflictCount,
              `Resolved conflict count should equal initial count (${initialConflictCount})`
            );

            // Assert: No unresolved conflicts remain
            assert.strictEqual(
              service.getUnresolvedConflictCount(filePath),
              0,
              'No unresolved conflicts should remain'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Accept All operations fail gracefully for non-existent files.
     */
    it('Property: Accept All operations fail gracefully for non-existent files', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          filePathArb,
          filePathArb,
          multipleConflictsArb,
          (state, existingPath, nonExistentPath, conflicts) => {
            // Ensure paths are different
            fc.pre(existingPath !== nonExistentPath);

            // Setup
            const service = new MockAcceptAllResolutionService();
            service.setRepositoryState(state);
            service.setFileConflicts(existingPath, conflicts);

            // Act: Try to accept all current on non-existent file
            const currentResult = service.acceptAllCurrent(nonExistentPath);

            // Assert: Operation fails
            assert.ok(
              !currentResult.success,
              'Accept All Current should fail for non-existent file'
            );

            // Act: Try to accept all incoming on non-existent file
            const incomingResult = service.acceptAllIncoming(nonExistentPath);

            // Assert: Operation fails
            assert.ok(
              !incomingResult.success,
              'Accept All Incoming should fail for non-existent file'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Accept All Current and Accept All Incoming are mutually exclusive.
     */
    it('Property: Accept All Current and Accept All Incoming produce different resolutions', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          filePathArb,
          multipleConflictsArb,
          (state, filePath, conflicts) => {
            // Setup two services with same initial state
            const service1 = new MockAcceptAllResolutionService();
            service1.setRepositoryState(state);
            service1.setFileConflicts(
              filePath,
              JSON.parse(JSON.stringify(conflicts)) as IConflictRegion[]
            );

            const service2 = new MockAcceptAllResolutionService();
            service2.setRepositoryState(state);
            service2.setFileConflicts(
              filePath,
              JSON.parse(JSON.stringify(conflicts)) as IConflictRegion[]
            );

            // Act: Accept all current on service1
            service1.acceptAllCurrent(filePath);

            // Act: Accept all incoming on service2
            service2.acceptAllIncoming(filePath);

            // Assert: Both services have all conflicts resolved
            assert.ok(
              service1.allConflictsResolved(filePath),
              'Service1 should have all conflicts resolved'
            );
            assert.ok(
              service2.allConflictsResolved(filePath),
              'Service2 should have all conflicts resolved'
            );

            // Assert: Resolution types are different
            assert.ok(
              service1.allConflictsHaveResolution(filePath, 'current'),
              'Service1 should have current resolution'
            );
            assert.ok(
              service2.allConflictsHaveResolution(filePath, 'incoming'),
              'Service2 should have incoming resolution'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Accept All operations work regardless of repository state (merging or rebasing).
     */
    it('Property: Accept All operations work in both merging and rebasing states', () => {
      fc.assert(
        fc.property(filePathArb, multipleConflictsArb, (filePath, conflicts) => {
          // Test with merging state
          const mergingService = new MockAcceptAllResolutionService();
          mergingService.setRepositoryState('merging');
          mergingService.setFileConflicts(
            filePath,
            JSON.parse(JSON.stringify(conflicts)) as IConflictRegion[]
          );

          const mergingResult = mergingService.acceptAllCurrent(filePath);
          assert.ok(mergingResult.success, 'Accept All Current should work in merging state');
          assert.ok(
            mergingService.allConflictsResolved(filePath),
            'All conflicts should be resolved in merging state'
          );

          // Test with rebasing state
          const rebasingService = new MockAcceptAllResolutionService();
          rebasingService.setRepositoryState('rebasing');
          rebasingService.setFileConflicts(
            filePath,
            JSON.parse(JSON.stringify(conflicts)) as IConflictRegion[]
          );

          const rebasingResult = rebasingService.acceptAllIncoming(filePath);
          assert.ok(rebasingResult.success, 'Accept All Incoming should work in rebasing state');
          assert.ok(
            rebasingService.allConflictsResolved(filePath),
            'All conflicts should be resolved in rebasing state'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Accept All operations are idempotent.
     */
    it('Property: Accept All operations are idempotent', () => {
      fc.assert(
        fc.property(
          conflictableStateArb,
          filePathArb,
          multipleConflictsArb,
          (state, filePath, conflicts) => {
            // Setup
            const service = new MockAcceptAllResolutionService();
            service.setRepositoryState(state);
            service.setFileConflicts(filePath, conflicts);

            // Act: Accept all current twice
            const result1 = service.acceptAllCurrent(filePath);
            const resolvedCount1 = service.getResolvedConflictCount(filePath);
            const content1 = service.getResolvedContent(filePath);

            const result2 = service.acceptAllCurrent(filePath);
            const resolvedCount2 = service.getResolvedConflictCount(filePath);
            const content2 = service.getResolvedContent(filePath);

            // Assert: Both operations succeed
            assert.ok(result1.success, 'First Accept All Current should succeed');
            assert.ok(result2.success, 'Second Accept All Current should succeed');

            // Assert: State is the same after both operations
            assert.strictEqual(
              resolvedCount1,
              resolvedCount2,
              'Resolved count should be the same after idempotent operation'
            );
            assert.strictEqual(
              content1,
              content2,
              'Resolved content should be the same after idempotent operation'
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
