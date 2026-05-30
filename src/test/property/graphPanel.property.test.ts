/**
 * Property-based tests for Graph Panel rendering and multi-select toggle.
 *
 * Feature: intellig-layout
 *
 * Uses fast-check to verify universal correctness properties of the
 * Graph Panel HTML generation in GitToolWindowProvider._getGraphPanelHtml()
 * and the toggleCommitSelection() method.
 *
 * Properties tested:
 *   7 — Commit row contains required fields
 *   8 — Multi-select toggle correctness
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../ui-shell/GitToolWindowProvider';
import { ICommitNode, IGraphLine } from '../../git-core/commitGraph';
import { ICommit, IAuthor } from '../../git-core/interfaces/IGitService';
import { Uri } from '../mocks/vscode';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a full commit hash (40 hex characters).
 */
function arbitraryFullHash(): fc.Arbitrary<string> {
  return fc.stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), {
    minLength: 40,
    maxLength: 40,
  });
}

/**
 * Generate a short commit hash (7 hex characters).
 */
function arbitraryShortHash(): fc.Arbitrary<string> {
  return fc.stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), {
    minLength: 7,
    maxLength: 7,
  });
}

/**
 * Generate a non-empty author name using printable ASCII characters,
 * excluding HTML special characters to keep assertions simple.
 * The name must be non-empty after trimming.
 */
function arbitraryAuthorName(): fc.Arbitrary<string> {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.'.split('')
      ),
      { minLength: 1, maxLength: 30 }
    )
    .filter((s) => s.trim().length > 0);
}

/**
 * Generate a valid email address.
 */
function arbitraryEmail(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
        minLength: 1,
        maxLength: 10,
      }),
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
        minLength: 1,
        maxLength: 8,
      }),
      fc.constantFrom('com', 'org', 'net', 'io')
    )
    .map(([user, domain, tld]) => `${user}@${domain}.${tld}`);
}

/**
 * Generate an IAuthor with valid name and email.
 */
function arbitraryAuthor(): fc.Arbitrary<IAuthor> {
  return fc.record({
    name: arbitraryAuthorName(),
    email: arbitraryEmail(),
  });
}

/**
 * Generate a commit message (1-3 lines). The first line is the summary.
 * Uses safe characters (no HTML special chars) so we can check for
 * the text or its truncation in the HTML output.
 */
function arbitraryCommitMessage(): fc.Arbitrary<string> {
  const line = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.,:;!?()[]{}#@$%^*+=~`/'.split(
          ''
        )
      ),
      { minLength: 1, maxLength: 100 }
    )
    .filter((s) => s.trim().length > 0);

  return fc.tuple(line, fc.array(line, { minLength: 0, maxLength: 2 })).map(([first, rest]) => {
    if (rest.length === 0) {
      return first;
    }
    return first + '\n' + rest.join('\n');
  });
}

/**
 * Generate a Date within the last year (ensures _formatRelativeDate produces a valid string).
 */
function arbitraryRecentDate(): fc.Arbitrary<Date> {
  const now = Date.now();
  const oneYearMs = 365 * 24 * 3600 * 1000;
  return fc.integer({ min: 1000, max: oneYearMs }).map((ms) => new Date(now - ms));
}

/**
 * Generate a valid ICommit object.
 */
function arbitraryCommit(): fc.Arbitrary<ICommit> {
  return fc.record({
    hash: arbitraryFullHash(),
    shortHash: arbitraryShortHash(),
    message: arbitraryCommitMessage(),
    author: arbitraryAuthor(),
    committer: arbitraryAuthor(),
    parents: fc.array(arbitraryFullHash(), { minLength: 0, maxLength: 2 }),
    authorDate: arbitraryRecentDate(),
    commitDate: arbitraryRecentDate(),
  });
}

/**
 * Generate a valid IGraphLine.
 */
function arbitraryGraphLine(): fc.Arbitrary<IGraphLine> {
  return fc.record({
    fromColumn: fc.integer({ min: 0, max: 5 }),
    toColumn: fc.integer({ min: 0, max: 5 }),
    color: fc.constantFrom('#4CAF50', '#2196F3', '#FF9800', '#9C27B0'),
    type: fc.constantFrom('commit' as const, 'merge' as const, 'branch' as const),
  });
}

/**
 * Generate a valid ICommitNode with an arbitrary commit and graph data.
 */
function arbitraryCommitNode(): fc.Arbitrary<ICommitNode> {
  return fc.record({
    commit: arbitraryCommit(),
    graphColumn: fc.integer({ min: 0, max: 5 }),
    graphLines: fc.array(arbitraryGraphLine(), { minLength: 0, maxLength: 3 }),
    branches: fc.array(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz-_/'.split('')), {
        minLength: 1,
        maxLength: 15,
      }),
      { minLength: 0, maxLength: 2 }
    ),
    tags: fc.array(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.'.split('')), {
        minLength: 1,
        maxLength: 10,
      }),
      { minLength: 0, maxLength: 2 }
    ),
  });
}

/**
 * Generate a set of unique commit hashes (0-10 hashes).
 */
function arbitraryHashSet(): fc.Arbitrary<Set<string>> {
  return fc
    .array(arbitraryFullHash(), { minLength: 0, maxLength: 10 })
    .map((hashes) => new Set(hashes));
}

/**
 * Generate a single commit hash for toggling.
 */
function arbitraryToggleHash(): fc.Arbitrary<string> {
  return arbitraryFullHash();
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Create a GitToolWindowProvider instance for testing.
 */
function createProvider(): GitToolWindowProvider {
  const extensionUri = Uri.file('/test/extension');
  return new GitToolWindowProvider(extensionUri);
}

/**
 * Compute the expected message summary for the row HTML.
 *
 * Wave E (E2-bonus): the row template no longer pre-truncates the
 * message — `.commit-title { overflow:hidden; text-overflow:ellipsis }`
 * does the responsive ellipsis, and the host emits the full first
 * line so screen readers and find-in-page see complete text. Property
 * 7 now asserts the FULL first line lands in the row HTML.
 */
function expectedMessageSummary(message: string): string {
  return message.split('\n')[0];
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: intellig-layout - Graph Panel Property Tests', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = createProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Property 7: Commit row contains required fields', () => {
    /**
     *
     * For any ICommitNode, the generated commit row HTML SHALL contain the
     * commit's short hash, the first line of the commit message (or a
     * truncation thereof), the author name, and a date string.
     */
    it('Feature: intellig-layout, Property 7: Commit row contains required fields — HTML contains short hash, message summary, author name, and date string', () => {
      fc.assert(
        fc.property(arbitraryCommitNode(), (node) => {
          const html = provider._getGraphPanelHtml([node]);

          const commit = node.commit;

          // 1. Full hash must be present (used in data-hash attribute)
          assert.ok(
            html.includes(commit.hash),
            `HTML should contain the full hash "${commit.hash}" in data-hash attribute`
          );

          // 2. Message summary (first line, possibly truncated) must be present
          const summary = expectedMessageSummary(commit.message);
          // The summary is HTML-escaped in the output, but since we use safe
          // characters in our generator, escaping is a no-op.
          assert.ok(html.includes(summary), `HTML should contain the message summary "${summary}"`);

          // 3. Author name must be present
          assert.ok(
            html.includes(commit.author.name),
            `HTML should contain the author name "${commit.author.name}"`
          );

          // 4. A date string must be present (the commit-date span should contain text)
          // The _formatRelativeDate method produces strings like "just now", "X minutes ago", etc.
          // We verify the commit-date span exists and contains non-empty text.
          const datePattern = /class="commit-date"[^>]*>([^<]+)</;
          const dateMatch = html.match(datePattern);
          assert.ok(
            dateMatch && dateMatch[1].trim().length > 0,
            'HTML should contain a non-empty date string in the commit-date span'
          );

          // Additionally verify the date string matches the expected absolute date format
          // The _formatAbsoluteDate method produces strings like "2024-01-15 3:30 PM"
          const dateText = dateMatch[1].trim();
          const absoluteDatePattern = /^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+(AM|PM)$/;
          assert.ok(
            absoluteDatePattern.test(dateText),
            `Date string "${dateText}" should match absolute date format YYYY-MM-DD H:MM AM/PM`
          );
        }),
        { numRuns: 150 }
      );
    });
  });

  describe('Property 8: Multi-select toggle correctness', () => {
    /**
     *
     * For any set of currently selected commit hashes and any commit hash,
     * toggling that hash SHALL add it to the set if it was not present, or
     * remove it if it was present, and the resulting set size SHALL differ
     * from the original by exactly 1.
     */
    it('Feature: intellig-layout, Property 8: Multi-select toggle correctness — toggling a hash changes set size by exactly 1', () => {
      fc.assert(
        fc.property(arbitraryHashSet(), arbitraryToggleHash(), (initialSet, toggleHash) => {
          // Create a fresh provider for each test to avoid state leakage
          const testProvider = createProvider();

          try {
            // Wave A R3-9 — `getSelectedCommits` projects through
            // `commitNodes`, so the rendered commit list must contain
            // every hash this property might toggle. Seed `commitNodes`
            // with `initialSet ∪ {toggleHash}` before any toggle so the
            // projection sees the hashes the property is mutating.
            //
            // R4-8 (Senior L-4) — fixture coupling note for future
            // property additions: any new property that introduces hash
            // relationships (parent chains, branch maps, merge graphs)
            // must ALSO seed those into `commitNodes` here, or the
            // projection will silently drop them — the property would
            // appear to pass while actually exercising an empty
            // selection. If you add a new arbitrary that produces
            // hashes, audit this seeding block too.
            const allHashes = new Set<string>(initialSet);
            allHashes.add(toggleHash);
            const commits: ICommit[] = Array.from(allHashes).map((h, i) => ({
              hash: h,
              shortHash: h.slice(0, 7),
              message: `commit ${i}`,
              author: { name: 'a', email: 'a@x' },
              committer: { name: 'a', email: 'a@x' },
              parents: [],
              authorDate: new Date(0),
              commitDate: new Date(0),
            }));
            testProvider.updateLogState(commits);

            // Set up the initial selection state by toggling each hash in
            for (const hash of initialSet) {
              testProvider.toggleCommitSelection(hash);
            }

            // Verify initial state matches
            const beforeToggle = new Set(testProvider.getSelectedCommits());
            assert.strictEqual(
              beforeToggle.size,
              initialSet.size,
              `Initial selection size should be ${initialSet.size}`
            );

            const wasPresent = beforeToggle.has(toggleHash);
            const originalSize = beforeToggle.size;

            // Toggle the target hash
            testProvider.toggleCommitSelection(toggleHash);

            const afterToggle = new Set(testProvider.getSelectedCommits());
            const newSize = afterToggle.size;

            // Size should differ by exactly 1
            assert.strictEqual(
              Math.abs(newSize - originalSize),
              1,
              `Set size should change by exactly 1 (was ${originalSize}, now ${newSize})`
            );

            if (wasPresent) {
              // Was present → should be removed
              assert.ok(
                !afterToggle.has(toggleHash),
                `Hash "${toggleHash}" was present and should be removed after toggle`
              );
              assert.strictEqual(
                newSize,
                originalSize - 1,
                'Set size should decrease by 1 when removing'
              );
            } else {
              // Was not present → should be added
              assert.ok(
                afterToggle.has(toggleHash),
                `Hash "${toggleHash}" was not present and should be added after toggle`
              );
              assert.strictEqual(
                newSize,
                originalSize + 1,
                'Set size should increase by 1 when adding'
              );
            }
          } finally {
            testProvider.dispose();
          }
        }),
        { numRuns: 150 }
      );
    });
  });
});
