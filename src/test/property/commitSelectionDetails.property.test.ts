/**
 * Property-based tests for commit selection rendering details and highlighting row.
 *
 * Feature: intellig-ui-fixes, Property 4: Commit selection renders details and highlights row
 *
 * Uses fast-check to verify that for any commit node in the commit list,
 * after calling selectCommit(hash), the re-rendered HTML shall contain:
 * (a) a commit row with class="commit-row selected" and data-hash matching the selected hash, and
 * (b) a Details Panel section containing the commit's message, hash, author name, and date.
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../services/GitToolWindowProvider';
import { ICommitNode, IGraphLine } from '../../utils/commitGraph';
import { ICommit, IAuthor } from '../../services/interfaces/IGitService';
import { Uri } from '../mocks/vscode';

// ─── Generators ───────────────────────────────────────────────────────────────

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
 * Generate a non-empty author name using safe characters (no HTML special chars).
 */
function arbitraryAuthorName(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.'.split('')
    ),
    { minLength: 1, maxLength: 30 }
  ).filter(s => s.trim().length > 0);
}

/**
 * Generate a valid email address using safe characters.
 */
function arbitraryEmail(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 10 }),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 8 }),
    fc.constantFrom('com', 'org', 'net', 'io')
  ).map(([user, domain, tld]) => `${user}@${domain}.${tld}`);
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
 * Generate a commit message using safe characters (no HTML special chars).
 */
function arbitraryCommitMessage(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.,:;!?()[]{}#@$%^*+=~`/'.split('')
    ),
    { minLength: 1, maxLength: 80 }
  ).filter(s => s.trim().length > 0);
}

/**
 * Generate a Date within the last year.
 */
function arbitraryRecentDate(): fc.Arbitrary<Date> {
  const now = Date.now();
  const oneYearMs = 365 * 24 * 3600 * 1000;
  return fc.integer({ min: 1000, max: oneYearMs }).map(ms => new Date(now - ms));
}

/**
 * Generate a valid ICommit object.
 */
function arbitraryCommit(hash: string): fc.Arbitrary<ICommit> {
  return fc.record({
    hash: fc.constant(hash),
    shortHash: fc.constant(hash.substring(0, 7)),
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
 * Generate a valid ICommitNode for a given commit hash.
 */
function arbitraryCommitNode(hash: string): fc.Arbitrary<ICommitNode> {
  return fc.record({
    commit: arbitraryCommit(hash),
    graphColumn: fc.integer({ min: 0, max: 5 }),
    graphLines: fc.array(arbitraryGraphLine(), { minLength: 0, maxLength: 3 }),
    branches: fc.array(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), { minLength: 1, maxLength: 10 }),
      { minLength: 0, maxLength: 2 }
    ),
    tags: fc.array(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.'.split('')), { minLength: 1, maxLength: 10 }),
      { minLength: 0, maxLength: 2 }
    ),
  });
}

/**
 * Generate a complete test scenario: a list of 1-5 commit nodes with unique hashes,
 * and a randomly selected commit index to select.
 *
 * Returns { commitNodes, selectedIndex }
 */
function arbitraryCommitSelectionScenario(): fc.Arbitrary<{
  commitNodes: ICommitNode[];
  selectedIndex: number;
}> {
  return fc.array(arbitraryFullHash(), { minLength: 1, maxLength: 5 })
    .filter(hashes => new Set(hashes).size === hashes.length) // ensure unique hashes
    .chain(hashes => {
      const nodeArbs = hashes.map(hash => arbitraryCommitNode(hash));
      return fc.tuple(
        fc.tuple(...nodeArbs as [fc.Arbitrary<ICommitNode>, ...fc.Arbitrary<ICommitNode>[]]),
        fc.nat({ max: hashes.length - 1 })
      ).map(([nodes, selectedIndex]) => ({
        commitNodes: nodes as unknown as ICommitNode[],
        selectedIndex,
      }));
    });
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Create a GitToolWindowProvider instance for testing.
 */
function createProvider(): GitToolWindowProvider {
  const extensionUri = Uri.file('/test/extension');
  return new GitToolWindowProvider(extensionUri);
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: intellig-ui-fixes - Commit Selection Details Property Tests', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = createProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Property 4: Commit selection renders details and highlights row', () => {
    /**
     *
     * For any commit node in the commit list, after calling selectCommit(hash),
     * the re-rendered HTML shall contain:
     * (a) a commit row with class="commit-row selected" and data-hash matching
     *     the selected hash, and
     * (b) a Details Panel section containing the commit's message, hash,
     *     author name, and date.
     */
    it('Feature: intellig-ui-fixes, Property 4: Commit selection renders details and highlights row — selecting a commit highlights the row and shows details', () => {
      fc.assert(
        fc.property(
          arbitraryCommitSelectionScenario(),
          (scenario) => {
            const testProvider = createProvider();

            try {
              const { commitNodes, selectedIndex } = scenario;
              const selectedNode = commitNodes[selectedIndex];
              const selectedHash = selectedNode.commit.hash;

              // Load commit nodes into the provider
              const commits = commitNodes.map(n => n.commit);
              const branchMap = new Map<string, string[]>();
              const tagMap = new Map<string, string[]>();
              testProvider.updateLogState(commits, branchMap, tagMap);

              // Verify initial state: no commit should be expanded
              const initialState = testProvider.getExtendedLogState();
              assert.strictEqual(
                initialState.expandedCommit,
                undefined,
                'Initially, no commit should be expanded'
              );

              // Select the commit
              testProvider.selectCommit(selectedHash);

              // Verify internal state was updated
              const stateAfterSelect = testProvider.getExtendedLogState();
              assert.strictEqual(
                stateAfterSelect.expandedCommit,
                selectedHash,
                `After selectCommit("${selectedHash}"), expandedCommit should match`
              );
              assert.ok(
                stateAfterSelect.selectedCommits.has(selectedHash),
                `After selectCommit("${selectedHash}"), selectedCommits should contain the hash`
              );

              // (a) Verify Graph Panel HTML contains the selected row with correct class and data-hash
              const graphHtml = testProvider._getGraphPanelHtml(
                testProvider.getExtendedLogState().commitNodes,
                stateAfterSelect.selectedCommits
              );

              // Check that the selected commit row has class="commit-row selected" and correct data-hash
              const selectedRowPattern = new RegExp(
                `class="commit-row\\s+selected"[^>]*data-hash="${selectedHash}"`
              );
              assert.ok(
                selectedRowPattern.test(graphHtml),
                `Graph Panel HTML should contain a commit row with class="commit-row selected" and data-hash="${selectedHash}"`
              );

              // Verify non-selected commits do NOT have the selected class
              for (let i = 0; i < commitNodes.length; i++) {
                if (i !== selectedIndex) {
                  const otherHash = commitNodes[i].commit.hash;
                  const otherSelectedPattern = new RegExp(
                    `class="commit-row\\s+selected"[^>]*data-hash="${otherHash}"`
                  );
                  assert.ok(
                    !otherSelectedPattern.test(graphHtml),
                    `Commit row with hash "${otherHash}" should NOT have the selected class`
                  );
                }
              }

              // (b) Verify Details Panel HTML contains the commit's metadata
              const commitDetails = {
                hash: selectedNode.commit.hash,
                message: selectedNode.commit.message,
                author: {
                  name: selectedNode.commit.author.name,
                  email: selectedNode.commit.author.email,
                },
                date: selectedNode.commit.authorDate,
                parents: selectedNode.commit.parents || [],
                branches: selectedNode.branches || [],
                tags: selectedNode.tags || [],
                changedFiles: [] as any[],
              };

              const detailsHtml = testProvider._getDetailsPanelHtml(commitDetails);

              // Verify the details HTML contains the commit hash
              assert.ok(
                detailsHtml.includes(selectedNode.commit.hash),
                `Details Panel HTML should contain the commit hash "${selectedNode.commit.hash}"`
              );

              // Verify the details HTML contains the commit message
              assert.ok(
                detailsHtml.includes(selectedNode.commit.message),
                `Details Panel HTML should contain the commit message`
              );

              // Verify the details HTML contains the author name
              assert.ok(
                detailsHtml.includes(selectedNode.commit.author.name),
                `Details Panel HTML should contain the author name "${selectedNode.commit.author.name}"`
              );

              // Verify the details HTML contains the date
              const dateStr = selectedNode.commit.authorDate.toLocaleString();
              assert.ok(
                detailsHtml.includes(dateStr),
                `Details Panel HTML should contain the commit date "${dateStr}"`
              );
            } finally {
              testProvider.dispose();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
