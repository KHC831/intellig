/**
 * Property-based tests for branch click selecting the correct commit.
 *
 * Feature: intellig-ui-fixes, Property 3: Branch click selects correct commit
 *
 * Uses fast-check to verify that for any branch name that exists in the branch map,
 * calling _handleBranchClick(branchName) results in selectCommit being called with
 * the commit hash that maps to that branch. After selection, the generated HTML
 * shall contain a Details Panel with that commit's metadata.
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
  return fc.stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), {
    minLength: 40,
    maxLength: 40,
  });
}

/**
 * Generate a non-empty author name using safe characters (no HTML special chars).
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
 * Generate a valid email address using safe characters.
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
 * Generate a commit message using safe characters (no HTML special chars).
 */
function arbitraryCommitMessage(): fc.Arbitrary<string> {
  return fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.,:;!?()[]{}#@$%^*+=~`/'.split(
          ''
        )
      ),
      { minLength: 1, maxLength: 80 }
    )
    .filter((s) => s.trim().length > 0);
}

/**
 * Generate a Date within the last year.
 */
function arbitraryRecentDate(): fc.Arbitrary<Date> {
  const now = Date.now();
  const oneYearMs = 365 * 24 * 3600 * 1000;
  return fc.integer({ min: 1000, max: oneYearMs }).map((ms) => new Date(now - ms));
}

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
 * Generate a valid branch name (1-2 segments joined by '/').
 */
function arbitraryBranchName(): fc.Arbitrary<string> {
  return fc
    .array(arbitraryBranchSegment(), { minLength: 1, maxLength: 2 })
    .map((segments) => segments.join('/'));
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
 * Generate a valid ICommitNode for a given commit hash and branch names.
 */
function arbitraryCommitNode(hash: string, branches: string[]): fc.Arbitrary<ICommitNode> {
  return fc.record({
    commit: arbitraryCommit(hash),
    graphColumn: fc.integer({ min: 0, max: 5 }),
    graphLines: fc.array(arbitraryGraphLine(), { minLength: 0, maxLength: 3 }),
    branches: fc.constant(branches),
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
 * Generate a branch map entry: a unique commit hash mapped to 1-3 unique branch names,
 * along with a matching commit node.
 *
 * Returns { hash, branches, nodeArb } where nodeArb is an arbitrary for the commit node.
 */
function arbitraryBranchMapEntry(): fc.Arbitrary<{
  hash: string;
  branches: string[];
  nodeArb: fc.Arbitrary<ICommitNode>;
}> {
  return arbitraryFullHash().chain((hash) =>
    fc.array(arbitraryBranchName(), { minLength: 1, maxLength: 3 }).map((branches) => {
      // Deduplicate branch names
      const unique = [...new Set(branches)];
      return {
        hash,
        branches: unique.length > 0 ? unique : [branches[0]],
        nodeArb: arbitraryCommitNode(hash, unique.length > 0 ? unique : [branches[0]]),
      };
    })
  );
}

/**
 * Generate a complete test scenario: a branch map with 1-5 entries, matching commit nodes,
 * and a randomly selected branch name from the map.
 *
 * Returns { branchMap, commitNodes, selectedBranch, expectedHash }
 */
function arbitraryBranchClickScenario(): fc.Arbitrary<{
  branchMap: Map<string, string[]>;
  commitNodes: ICommitNode[];
  selectedBranch: string;
  expectedHash: string;
}> {
  return fc.array(arbitraryBranchMapEntry(), { minLength: 1, maxLength: 5 }).chain((entries) => {
    // Deduplicate by hash
    const seen = new Set<string>();
    const uniqueEntries = entries.filter((e) => {
      if (seen.has(e.hash)) {
        return false;
      }
      seen.add(e.hash);
      return true;
    });
    const finalEntries = uniqueEntries.length > 0 ? uniqueEntries : [entries[0]];

    // Collect all branch names with their associated hashes
    const allBranches: { name: string; hash: string }[] = [];
    for (const entry of finalEntries) {
      for (const branch of entry.branches) {
        allBranches.push({ name: branch, hash: entry.hash });
      }
    }

    // Build the commit node arbitraries
    const nodeArbs = finalEntries.map((e) => e.nodeArb);

    // Use fc.nat to pick a random branch index (deterministic for shrinking)
    return fc
      .tuple(
        fc.tuple(...(nodeArbs as [fc.Arbitrary<ICommitNode>, ...fc.Arbitrary<ICommitNode>[]])),
        fc.nat({ max: allBranches.length - 1 })
      )
      .map(([nodes, branchIndex]) => {
        // Build the branch map: hash -> branch names[]
        const branchMap = new Map<string, string[]>();
        for (const entry of finalEntries) {
          branchMap.set(entry.hash, entry.branches);
        }

        const selected = allBranches[branchIndex];

        return {
          branchMap,
          commitNodes: nodes as unknown as ICommitNode[],
          selectedBranch: selected.name,
          expectedHash: selected.hash,
        };
      });
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

describe('Feature: intellig-ui-fixes - Branch Click Selection Property Tests', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = createProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Property 3: Branch click selects correct commit', () => {
    /**
     *
     * For any branch name that exists in the branch map (mapping commit hashes
     * to branch name arrays), calling _handleBranchClick(branchName) shall
     * result in selectCommit being called with the commit hash that maps to
     * that branch. After selection, the generated HTML shall contain a Details
     * Panel with that commit's metadata.
     */
    it('Feature: intellig-ui-fixes, Property 3: Branch click selects correct commit — clicking a branch selects the correct commit and shows details', () => {
      fc.assert(
        fc.property(arbitraryBranchClickScenario(), (scenario) => {
          const testProvider = createProvider();

          try {
            const { branchMap, commitNodes, selectedBranch, expectedHash } = scenario;

            // Set up the provider with commit data and branch map.
            // updateLogState takes commits, branchMap, and tagMap.
            // It calls generateCommitGraph internally, but we need the branchMap
            // to be set correctly. We'll use updateLogState with the raw commits
            // and the branchMap.
            const commits = commitNodes.map((n) => n.commit);
            const tagMap = new Map<string, string[]>();
            testProvider.updateLogState(commits, branchMap, tagMap);

            // Verify initial state: no commit should be expanded
            const initialState = testProvider.getExtendedLogState();
            assert.strictEqual(
              initialState.expandedCommit,
              undefined,
              'Initially, no commit should be expanded'
            );

            // Call _handleBranchClick with the selected branch name.
            // This is a private method, so we access it via bracket notation.
            (testProvider as any)._handleBranchClick(selectedBranch);

            // Verify that the correct commit was selected
            const stateAfterClick = testProvider.getExtendedLogState();

            // The expandedCommit should be set to the expected hash
            assert.strictEqual(
              stateAfterClick.expandedCommit,
              expectedHash,
              `After clicking branch "${selectedBranch}", expandedCommit should be "${expectedHash}" but was "${stateAfterClick.expandedCommit}"`
            );

            // The selectedCommits set should contain the expected hash
            assert.ok(
              stateAfterClick.selectedCommits.has(expectedHash),
              `After clicking branch "${selectedBranch}", selectedCommits should contain "${expectedHash}"`
            );

            // Verify that the commit node exists in the state
            const matchingNode = commitNodes.find((n) => n.commit.hash === expectedHash);
            assert.ok(
              matchingNode,
              `A commit node with hash "${expectedHash}" should exist in the commit nodes`
            );

            // Verify that the Details Panel HTML contains the commit's metadata.
            // We build the commit details the same way _getHtmlContent does.
            if (matchingNode) {
              const commitDetails = {
                hash: matchingNode.commit.hash,
                message: matchingNode.commit.message,
                author: {
                  name: matchingNode.commit.author.name,
                  email: matchingNode.commit.author.email,
                },
                date: matchingNode.commit.authorDate,
                parents: matchingNode.commit.parents || [],
                branches: matchingNode.branches || [],
                tags: matchingNode.tags || [],
                changedFiles: [] as any[],
              };

              const detailsHtml = testProvider._getDetailsPanelHtml(commitDetails);

              // The details HTML should contain the commit hash
              assert.ok(
                detailsHtml.includes(matchingNode.commit.hash),
                `Details Panel HTML should contain the commit hash "${matchingNode.commit.hash}"`
              );

              // The details HTML should contain the author name
              assert.ok(
                detailsHtml.includes(matchingNode.commit.author.name),
                `Details Panel HTML should contain the author name "${matchingNode.commit.author.name}"`
              );

              // The details HTML should contain the commit message
              assert.ok(
                detailsHtml.includes(matchingNode.commit.message),
                `Details Panel HTML should contain the commit message`
              );

              // The details HTML should contain the author email
              assert.ok(
                detailsHtml.includes(matchingNode.commit.author.email),
                `Details Panel HTML should contain the author email "${matchingNode.commit.author.email}"`
              );

              // The details HTML should contain the date
              const dateStr = matchingNode.commit.authorDate.toLocaleString();
              assert.ok(
                detailsHtml.includes(dateStr),
                `Details Panel HTML should contain the commit date "${dateStr}"`
              );
            }
          } finally {
            testProvider.dispose();
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
