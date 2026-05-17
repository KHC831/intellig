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
import { invokePrivateHandler } from '../typed/privateHandler';

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

    // Collect all branch names with their associated hashes.
    //
    // TL-81 fix (post-Wave-135): cross-entry dedup of branch names by FIRST
    // appearance. The generator originally pushed every (name, hash) pair
    // including cross-entry duplicates, so when two distinct entries shared a
    // branch name (e.g. hashA → ["a"], hashB → ["a"]) and the random index
    // landed on the *second* copy, `expectedHash` was hashB but
    // `_handleBranchClick("a")` walks `branchMap.entries()` in insertion order
    // and returns hashA. That mismatch surfaced as a ~10% stress flake at
    // src/test/property/branchClickSelection.property.test.ts:286 (originally
    // shrunk from seed 319426092). The two pinned regression specs at the
    // bottom of this file lock down the production tie-break contract; this
    // dedup makes the generator emit `expectedHash` values that agree with
    // that contract.
    const allBranches: { name: string; hash: string }[] = [];
    const seenBranchNames = new Set<string>();
    for (const entry of finalEntries) {
      for (const branch of entry.branches) {
        if (seenBranchNames.has(branch)) {
          continue;
        }
        seenBranchNames.add(branch);
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
            void invokePrivateHandler(testProvider, '_handleBranchClick', selectedBranch);

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
                changedFiles: [],
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

  // ─── Pinned regressions ─────────────────────────────────────────────────────
  //
  // TL-81 stress-flake investigation (post-Wave-135). The original Property 3
  // generator can emit a scenario where TWO distinct commits share the SAME
  // branch name string in the branch map (e.g. hashA → ["a"], hashB → ["a"]).
  // The generator's `arbitraryBranchClickScenario` builds a flat
  // `allBranches[]` list across entries WITHOUT cross-entry name dedup, so
  // when fast-check shrinks toward small branch names it will eventually
  // sample the second copy of "a" — and `expectedHash` is set to whichever
  // entry contributed that copy. Meanwhile `_handleBranchClick` iterates
  // `branchMap.entries()` in insertion order and returns the FIRST matching
  // commit, which is the OTHER entry. That mismatch surfaces as a
  // `branchClickSelection.property.test.ts:286` failure under the 10× stress
  // runner (seed 319426092 was the originally-shrunk reproducer).
  //
  // Two pinned regression specs encode the exact contract the generator
  // assumes: when a branch name appears under multiple commit hashes,
  // `_handleBranchClick(name)` MUST select the FIRST-inserted hash (i.e.
  // map-iteration order, the "earliest commit" tie-break). The deeper
  // generator fix lives alongside — `arbitraryBranchClickScenario` now picks
  // `expectedHash` based on the same first-insertion rule, so the two layers
  // agree on tie-break semantics.
  //
  // Note: this "first-insertion-order wins" contract is fall-out-of-
  // implementation (`Map.entries()` is spec'd to iterate in insertion
  // order), NOT a deliberately-chosen UX. Real-world `git for-each-ref`
  // output never duplicates a branch name across hashes, so the scenario
  // these specs pin is hypothetical from the user's perspective. Revisit
  // the contract if a future feature ever surfaces ambiguous
  // branch-to-hash mappings — e.g. cross-worktree branches, stale fetch
  // state, or a UI that synthesizes multiple "branch-like" labels for the
  // same name. At that point the right answer might be "select most
  // recent commit by date" or "show a disambiguator," and the pinned
  // specs + generator dedup here would need a coordinated update.
  describe('Property 3: pinned regressions — shared-branch-name tie-break', () => {
    /**
     * Pinned: when two commits share the same branch name in the branch map,
     * clicking that branch selects the FIRST-inserted commit (map-iteration
     * order). This is the production contract; the property generator must
     * compute `expectedHash` consistently with this rule.
     */
    it('shared branch name across hashes — _handleBranchClick selects first-inserted hash', () => {
      const provider = createProvider();
      try {
        const hashA = '1111111111111111111111111111111111111111';
        const hashB = '2222222222222222222222222222222222222222';
        const author: IAuthor = { name: 'tester', email: 't@example.com' };
        const date = new Date(2020, 0, 1);
        const mkCommit = (h: string, msg: string): ICommit => ({
          hash: h,
          shortHash: h.substring(0, 7),
          message: msg,
          author,
          committer: author,
          parents: [],
          authorDate: date,
          commitDate: date,
        });
        const commits: ICommit[] = [mkCommit(hashA, 'first'), mkCommit(hashB, 'second')];
        // Both commits claim the SAME branch name "a". Insertion order: A first.
        const branchMap = new Map<string, string[]>();
        branchMap.set(hashA, ['a']);
        branchMap.set(hashB, ['a']);
        const tagMap = new Map<string, string[]>();
        provider.updateLogState(commits, branchMap, tagMap);

        void invokePrivateHandler(provider, '_handleBranchClick', 'a');

        const state = provider.getExtendedLogState();
        assert.strictEqual(
          state.expandedCommit,
          hashA,
          'first-inserted hash wins the tie-break when a branch name is shared'
        );
      } finally {
        provider.dispose();
      }
    });

    /**
     * Pinned: reverse insertion order — the same shared-branch-name scenario
     * but with hashB inserted first into the branch map. The first-inserted
     * commit is now hashB, so the click must select B (not A).
     *
     * This pair of specs together pins the contract: tie-break is
     * map-insertion order, not lexical-hash order, not last-write-wins.
     */
    it('shared branch name — reverse insertion order selects first-inserted hash (hashB)', () => {
      const provider = createProvider();
      try {
        const hashA = '1111111111111111111111111111111111111111';
        const hashB = '2222222222222222222222222222222222222222';
        const author: IAuthor = { name: 'tester', email: 't@example.com' };
        const date = new Date(2020, 0, 1);
        const mkCommit = (h: string, msg: string): ICommit => ({
          hash: h,
          shortHash: h.substring(0, 7),
          message: msg,
          author,
          committer: author,
          parents: [],
          authorDate: date,
          commitDate: date,
        });
        const commits: ICommit[] = [mkCommit(hashB, 'second'), mkCommit(hashA, 'first')];
        const branchMap = new Map<string, string[]>();
        branchMap.set(hashB, ['a']); // B inserted FIRST this time
        branchMap.set(hashA, ['a']);
        const tagMap = new Map<string, string[]>();
        provider.updateLogState(commits, branchMap, tagMap);

        void invokePrivateHandler(provider, '_handleBranchClick', 'a');

        const state = provider.getExtendedLogState();
        assert.strictEqual(
          state.expandedCommit,
          hashB,
          'first-inserted hash wins regardless of lexical hash order'
        );
      } finally {
        provider.dispose();
      }
    });
  });
});
