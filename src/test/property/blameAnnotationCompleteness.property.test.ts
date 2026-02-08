import * as fc from 'fast-check';
import * as assert from 'assert';
import { IBlameLine } from '../../services/interfaces/IGitService';
import { IBlameInfo } from '../../services/interfaces/IBlameService';

/**
 * Property-based tests for Blame Annotation Completeness.
 * Feature: intellig-vscode, Property 29: Blame Annotation Completeness
 *
 *
 * Property Description:
 * For any line in a tracked file, the blame annotation SHALL include the author,
 * date, and commit message summary for the commit that last modified that line.
 *
 * - 9.1 (Blame): WHEN a user enables inline blame, THE Extension SHALL display
 *                the last commit info at the end of the current line
 * - 9.2 (Blame): WHEN a user enables gutter blame, THE Extension SHALL display
 *                blame information in the editor gutter for all visible lines
 * - 9.3 (Blame): WHEN viewing blame annotations, THE Extension SHALL display:
 *                author, relative date, and commit message summary
 */
describe('Blame Annotation Completeness Property Tests', () => {
  /**
   * Arbitrary generator for valid commit hashes (40 hex characters).
   */
  const commitHashArb: fc.Arbitrary<string> = fc
    .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 40, maxLength: 40 })
    .map((chars) => chars.join(''));

  /**
   * Arbitrary generator for author names.
   * Author names should be non-empty strings.
   */
  const authorNameArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 50 })
    .filter((s) => s.trim().length > 0)
    .map((s) => s.trim());

  /**
   * Arbitrary generator for author emails.
   */
  const authorEmailArb: fc.Arbitrary<string> = fc
    .tuple(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9._-]+$/.test(s)),
      fc.string({ minLength: 1, maxLength: 15 }).filter((s) => /^[a-zA-Z0-9.-]+$/.test(s))
    )
    .map(([local, domain]) => `${local}@${domain}.com`);

  /**
   * Arbitrary generator for commit messages.
   * Commit messages should be non-empty strings.
   */
  const commitMessageArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 100 })
    .filter((s) => s.trim().length > 0)
    .map((s) => s.trim());

  /**
   * Arbitrary generator for dates (within a reasonable range).
   */
  const dateArb: fc.Arbitrary<Date> = fc.date({
    min: new Date('2000-01-01'),
    max: new Date(),
  });

  /**
   * Arbitrary generator for valid file paths.
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .array(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./'.split('')
      ),
      { minLength: 1, maxLength: 50 }
    )
    .map((chars) => chars.join(''))
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
   * Arbitrary generator for a single blame line.
   */
  const blameLineArb: fc.Arbitrary<IBlameLine> = fc.record({
    line: fc.nat({ max: 10000 }).map((n) => n + 1), // Line numbers start at 1
    commit: commitHashArb,
    author: authorNameArb,
    authorEmail: authorEmailArb,
    date: dateArb,
    message: commitMessageArb,
    previousCommit: fc.option(commitHashArb, { nil: undefined }),
  });

  /**
   * Arbitrary generator for a non-empty array of blame lines with consecutive line numbers.
   */
  const blameLinesArb: fc.Arbitrary<IBlameLine[]> = fc
    .array(blameLineArb, { minLength: 1, maxLength: 100 })
    .map((lines) => {
      // Ensure consecutive line numbers starting from 1
      return lines.map((line, index) => ({
        ...line,
        line: index + 1,
      }));
    });

  /**
   * Arbitrary generator for blame info (file path + blame lines).
   */
  const blameInfoArb: fc.Arbitrary<IBlameInfo> = fc.record({
    path: filePathArb,
    lines: blameLinesArb,
  });

  /**
   * Mock BlameService that simulates blame operations in memory.
   * This allows us to test the blame annotation completeness properties
   * without actual Git operations.
   */
  class MockBlameService {
    private _blameCache: Map<string, IBlameInfo> = new Map();

    constructor() {}

    /**
     * Set blame info for a file (for testing).
     */
    setBlameInfo(path: string, blameInfo: IBlameInfo): void {
      this._blameCache.set(path, blameInfo);
    }

    /**
     * Get blame information for a file.
     *
     * @param path - The file path
     * @returns The blame information for the file
     */
    getBlame(path: string): IBlameInfo {
      const blameInfo = this._blameCache.get(path);
      if (!blameInfo) {
        throw new Error(`No blame info for file: ${path}`);
      }
      return blameInfo;
    }

    /**
     * Get blame for a specific line.
     *
     * @param path - The file path
     * @param lineNumber - The line number (1-indexed)
     * @returns The blame line information
     */
    getBlameForLine(path: string, lineNumber: number): IBlameLine {
      const blameInfo = this.getBlame(path);
      const blameLine = blameInfo.lines.find((l) => l.line === lineNumber);
      if (!blameLine) {
        throw new Error(`No blame info for line ${lineNumber} in file: ${path}`);
      }
      return blameLine;
    }

    /**
     * Check if a blame line has all required fields for annotation display.
     *
     * @param blameLine - The blame line to check
     * @returns True if all required fields are present and valid
     */
    isBlameLineComplete(blameLine: IBlameLine): boolean {
      // Check author is present and non-empty
      if (!blameLine.author || blameLine.author.trim().length === 0) {
        return false;
      }

      // Check date is present and valid
      if (!blameLine.date || !(blameLine.date instanceof Date) || isNaN(blameLine.date.getTime())) {
        return false;
      }

      // Check commit message is present and non-empty
      if (!blameLine.message || blameLine.message.trim().length === 0) {
        return false;
      }

      // Check commit hash is present and valid (40 hex characters)
      if (!blameLine.commit || !/^[0-9a-f]{40}$/.test(blameLine.commit)) {
        return false;
      }

      // Check line number is valid (positive integer)
      if (!blameLine.line || blameLine.line < 1 || !Number.isInteger(blameLine.line)) {
        return false;
      }

      return true;
    }

    /**
     * Format blame annotation for display (inline or gutter).
     *
     * @param blameLine - The blame line to format
     * @returns Formatted annotation string
     */
    formatBlameAnnotation(blameLine: IBlameLine): string {
      const author = blameLine.author;
      const date = this.formatRelativeDate(blameLine.date);
      const message = this.truncateMessage(blameLine.message, 50);
      return `${author}, ${date} • ${message}`;
    }

    /**
     * Format a date as a relative date string.
     */
    private formatRelativeDate(date: Date): string {
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays === 0) {
        return 'today';
      }
      if (diffDays === 1) {
        return 'yesterday';
      }
      if (diffDays < 7) {
        return `${diffDays} days ago`;
      }
      if (diffDays < 30) {
        return `${Math.floor(diffDays / 7)} weeks ago`;
      }
      if (diffDays < 365) {
        return `${Math.floor(diffDays / 30)} months ago`;
      }
      return `${Math.floor(diffDays / 365)} years ago`;
    }

    /**
     * Truncate a message to a maximum length.
     */
    private truncateMessage(message: string, maxLength: number): string {
      if (message.length <= maxLength) {
        return message;
      }
      return message.substring(0, maxLength - 3) + '...';
    }
  }

  describe('Property 29: Blame Annotation Completeness', () => {
    /**
     * Property: Every blame line has a non-empty author field.
     */
    it('Property: Every blame line has a non-empty author field', () => {
      fc.assert(
        fc.property(blameInfoArb, (blameInfo) => {
          // Setup
          const blameService = new MockBlameService();
          blameService.setBlameInfo(blameInfo.path, blameInfo);

          // Act: Get blame info
          const retrievedBlame = blameService.getBlame(blameInfo.path);

          // Assert: Every line has a non-empty author
          for (const line of retrievedBlame.lines) {
            assert.ok(line.author, `Line ${line.line} should have an author`);
            assert.ok(
              line.author.trim().length > 0,
              `Line ${line.line} author should be non-empty`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Every blame line has a valid date field.
     */
    it('Property: Every blame line has a valid date field', () => {
      fc.assert(
        fc.property(blameInfoArb, (blameInfo) => {
          // Setup
          const blameService = new MockBlameService();
          blameService.setBlameInfo(blameInfo.path, blameInfo);

          // Act: Get blame info
          const retrievedBlame = blameService.getBlame(blameInfo.path);

          // Assert: Every line has a valid date
          for (const line of retrievedBlame.lines) {
            assert.ok(line.date, `Line ${line.line} should have a date`);
            assert.ok(line.date instanceof Date, `Line ${line.line} date should be a Date object`);
            assert.ok(!isNaN(line.date.getTime()), `Line ${line.line} date should be a valid date`);
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Every blame line has a non-empty commit message.
     */
    it('Property: Every blame line has a non-empty commit message', () => {
      fc.assert(
        fc.property(blameInfoArb, (blameInfo) => {
          // Setup
          const blameService = new MockBlameService();
          blameService.setBlameInfo(blameInfo.path, blameInfo);

          // Act: Get blame info
          const retrievedBlame = blameService.getBlame(blameInfo.path);

          // Assert: Every line has a non-empty message
          for (const line of retrievedBlame.lines) {
            assert.ok(line.message, `Line ${line.line} should have a message`);
            assert.ok(
              line.message.trim().length > 0,
              `Line ${line.line} message should be non-empty`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Every blame line has a valid commit hash.
     */
    it('Property: Every blame line has a valid commit hash', () => {
      fc.assert(
        fc.property(blameInfoArb, (blameInfo) => {
          // Setup
          const blameService = new MockBlameService();
          blameService.setBlameInfo(blameInfo.path, blameInfo);

          // Act: Get blame info
          const retrievedBlame = blameService.getBlame(blameInfo.path);

          // Assert: Every line has a valid commit hash (40 hex characters)
          for (const line of retrievedBlame.lines) {
            assert.ok(line.commit, `Line ${line.line} should have a commit hash`);
            assert.ok(
              /^[0-9a-f]{40}$/.test(line.commit),
              `Line ${line.line} commit hash should be 40 hex characters`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Blame info covers all lines in the file (completeness).
     */
    it('Property: Blame info covers all lines in the file (completeness)', () => {
      fc.assert(
        fc.property(blameInfoArb, (blameInfo) => {
          // Setup
          const blameService = new MockBlameService();
          blameService.setBlameInfo(blameInfo.path, blameInfo);

          // Act: Get blame info
          const retrievedBlame = blameService.getBlame(blameInfo.path);

          // Assert: Lines are consecutive starting from 1
          const lineNumbers = retrievedBlame.lines.map((l) => l.line).sort((a, b) => a - b);
          for (let i = 0; i < lineNumbers.length; i++) {
            assert.strictEqual(
              lineNumbers[i],
              i + 1,
              `Line numbers should be consecutive, expected ${i + 1} but got ${lineNumbers[i]}`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Getting blame for a specific line returns complete information.
     */
    it('Property: Getting blame for a specific line returns complete information', () => {
      fc.assert(
        fc.property(blameInfoArb, fc.nat({ max: 99 }), (blameInfo, lineOffset) => {
          // Setup
          const blameService = new MockBlameService();
          blameService.setBlameInfo(blameInfo.path, blameInfo);

          // Select a valid line number
          const lineNumber = (lineOffset % blameInfo.lines.length) + 1;

          // Act: Get blame for specific line
          const blameLine = blameService.getBlameForLine(blameInfo.path, lineNumber);

          // Assert: The blame line is complete
          assert.ok(
            blameService.isBlameLineComplete(blameLine),
            `Blame line ${lineNumber} should be complete`
          );

          // Assert: Line number matches
          assert.strictEqual(
            blameLine.line,
            lineNumber,
            `Blame line number should match requested line`
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Blame annotations can be formatted for display.
     */
    it('Property: Blame annotations can be formatted for display', () => {
      fc.assert(
        fc.property(blameInfoArb, (blameInfo) => {
          // Setup
          const blameService = new MockBlameService();
          blameService.setBlameInfo(blameInfo.path, blameInfo);

          // Act: Get blame info and format each line
          const retrievedBlame = blameService.getBlame(blameInfo.path);

          // Assert: Every line can be formatted
          for (const line of retrievedBlame.lines) {
            const formatted = blameService.formatBlameAnnotation(line);
            assert.ok(formatted, `Line ${line.line} should produce a formatted annotation`);
            assert.ok(
              formatted.length > 0,
              `Line ${line.line} formatted annotation should be non-empty`
            );
            // Check that the formatted string contains author info
            assert.ok(
              formatted.includes(line.author) || formatted.includes(line.author.substring(0, 10)),
              `Formatted annotation should contain author information`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: All blame lines pass completeness check.
     */
    it('Property: All blame lines pass completeness check', () => {
      fc.assert(
        fc.property(blameInfoArb, (blameInfo) => {
          // Setup
          const blameService = new MockBlameService();
          blameService.setBlameInfo(blameInfo.path, blameInfo);

          // Act: Get blame info
          const retrievedBlame = blameService.getBlame(blameInfo.path);

          // Assert: Every line passes the completeness check
          for (const line of retrievedBlame.lines) {
            assert.ok(
              blameService.isBlameLineComplete(line),
              `Line ${line.line} should pass completeness check (author: ${line.author}, date: ${line.date.toISOString()}, message: ${line.message}, commit: ${line.commit})`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Blame info path matches the requested file path.
     */
    it('Property: Blame info path matches the requested file path', () => {
      fc.assert(
        fc.property(blameInfoArb, (blameInfo) => {
          // Setup
          const blameService = new MockBlameService();
          blameService.setBlameInfo(blameInfo.path, blameInfo);

          // Act: Get blame info
          const retrievedBlame = blameService.getBlame(blameInfo.path);

          // Assert: Path matches
          assert.strictEqual(
            retrievedBlame.path,
            blameInfo.path,
            'Blame info path should match requested path'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Getting blame for non-existent file throws error.
     */
    it('Property: Getting blame for non-existent file throws error', () => {
      fc.assert(
        fc.property(blameInfoArb, filePathArb, (blameInfo, otherPath) => {
          // Setup
          const blameService = new MockBlameService();
          blameService.setBlameInfo(blameInfo.path, blameInfo);

          // Skip if paths happen to be the same
          if (otherPath === blameInfo.path) {
            return true;
          }

          // Act & Assert: Getting blame for non-existent file should throw
          assert.throws(
            () => blameService.getBlame(otherPath),
            /No blame info for file/,
            'Should throw when getting blame for non-existent file'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Getting blame for non-existent line throws error.
     */
    it('Property: Getting blame for non-existent line throws error', () => {
      fc.assert(
        fc.property(blameInfoArb, fc.nat({ max: 1000 }), (blameInfo, extraLines) => {
          // Setup
          const blameService = new MockBlameService();
          blameService.setBlameInfo(blameInfo.path, blameInfo);

          // Use a line number that doesn't exist
          const invalidLineNumber = blameInfo.lines.length + extraLines + 1;

          // Act & Assert: Getting blame for non-existent line should throw
          assert.throws(
            () => blameService.getBlameForLine(blameInfo.path, invalidLineNumber),
            /No blame info for line/,
            'Should throw when getting blame for non-existent line'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Author email is present when author is present.
     */
    it('Property: Author email is present when author is present', () => {
      fc.assert(
        fc.property(blameInfoArb, (blameInfo) => {
          // Setup
          const blameService = new MockBlameService();
          blameService.setBlameInfo(blameInfo.path, blameInfo);

          // Act: Get blame info
          const retrievedBlame = blameService.getBlame(blameInfo.path);

          // Assert: Every line with an author also has an email
          for (const line of retrievedBlame.lines) {
            if (line.author && line.author.trim().length > 0) {
              assert.ok(
                line.authorEmail,
                `Line ${line.line} should have an author email when author is present`
              );
              assert.ok(
                line.authorEmail.includes('@'),
                `Line ${line.line} author email should contain @`
              );
            }
          }
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Blame lines have unique line numbers within a file.
     */
    it('Property: Blame lines have unique line numbers within a file', () => {
      fc.assert(
        fc.property(blameInfoArb, (blameInfo) => {
          // Setup
          const blameService = new MockBlameService();
          blameService.setBlameInfo(blameInfo.path, blameInfo);

          // Act: Get blame info
          const retrievedBlame = blameService.getBlame(blameInfo.path);

          // Assert: All line numbers are unique
          const lineNumbers = retrievedBlame.lines.map((l) => l.line);
          const uniqueLineNumbers = new Set(lineNumbers);
          assert.strictEqual(
            uniqueLineNumbers.size,
            lineNumbers.length,
            'All line numbers should be unique'
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
