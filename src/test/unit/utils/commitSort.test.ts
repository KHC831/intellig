/**
 * Unit tests for {@link sortCommitsStable} (src/utils/commitSort.ts).
 *
 * Covers the TR-5 / SR-R3 LOW contract:
 * - Primary sort is `commitDate` ascending (oldest first).
 * - Date ties break topologically: if A is in B.parents, A sorts before B.
 * - Unrelated date-tied commits break alphabetically on hash, deterministically.
 * - Sort is stable across input orderings (shuffled input → same output).
 * - Cycles in fuzz/mock input don't throw; leftovers are appended.
 *
 * The helper is shared by:
 * - `GitService.getMultiCommitDiff` (production)
 * - `MockMultiCommitDiffService.getMultiCommitDiff` (property test)
 */

import * as assert from 'assert';
import { sortCommitsStable, ISortableCommit } from '../../../utils/commitSort';

describe('sortCommitsStable', () => {
  function c(
    hash: string,
    isoDate: string,
    parents: string[] = []
  ): ISortableCommit {
    return { hash, commitDate: new Date(isoDate), parents };
  }

  it('returns an empty array when given an empty input', () => {
    assert.deepStrictEqual(sortCommitsStable([]), []);
  });

  it('returns a copy (does not mutate the input array)', () => {
    const input = [c('b', '2024-01-02T00:00:00Z'), c('a', '2024-01-01T00:00:00Z')];
    const snapshot = input.slice();
    sortCommitsStable(input);
    assert.deepStrictEqual(input, snapshot, 'input array was mutated');
  });

  it('sorts by commit date ascending (oldest first) when no ties exist', () => {
    const cs = [
      c('b', '2024-01-02T00:00:00Z'),
      c('a', '2024-01-01T00:00:00Z'),
      c('c', '2024-01-03T00:00:00Z'),
    ];
    const sorted = sortCommitsStable(cs);
    assert.deepStrictEqual(sorted.map((x) => x.hash), ['a', 'b', 'c']);
  });

  it('places a parent before its child when both share a commit date (TR-5 core)', () => {
    // Delete-commit has hash "0000" (sorts first alphabetically), modify
    // parent has hash "b000" — the Round-2 hash tie-break placed delete
    // BEFORE its parent. Topological tie-break must put parent first.
    const parent = c('b000', '2024-01-01T00:00:00Z', []);
    const child = c('0000', '2024-01-01T00:00:00Z', ['b000']);

    const sortedForward = sortCommitsStable([parent, child]);
    assert.deepStrictEqual(sortedForward.map((x) => x.hash), ['b000', '0000']);

    const sortedReverse = sortCommitsStable([child, parent]);
    assert.deepStrictEqual(
      sortedReverse.map((x) => x.hash),
      ['b000', '0000'],
      'order should be independent of input permutation'
    );
  });

  it('falls back to hash-alphabetical among unrelated date-tied commits', () => {
    const a = c('aaa', '2024-01-01T00:00:00Z', []);
    const b = c('bbb', '2024-01-01T00:00:00Z', []);
    const cc = c('ccc', '2024-01-01T00:00:00Z', []);

    const out1 = sortCommitsStable([b, cc, a]);
    const out2 = sortCommitsStable([cc, a, b]);
    assert.deepStrictEqual(out1.map((x) => x.hash), ['aaa', 'bbb', 'ccc']);
    assert.deepStrictEqual(out2.map((x) => x.hash), ['aaa', 'bbb', 'ccc']);
  });

  it('respects a parent chain across multiple date-tied commits', () => {
    // Chain: a (root) ← b ← c, all tied at the same timestamp.
    // Hashes deliberately reversed ("zzz" ← "mmm" ← "aaa") so that a naive
    // alphabetical sort would place them in the wrong causal order.
    const a = c('zzz', '2024-06-01T00:00:00Z', []);
    const b = c('mmm', '2024-06-01T00:00:00Z', ['zzz']);
    const cc = c('aaa', '2024-06-01T00:00:00Z', ['mmm']);

    const sorted = sortCommitsStable([cc, a, b]);
    assert.deepStrictEqual(sorted.map((x) => x.hash), ['zzz', 'mmm', 'aaa']);
  });

  it('ignores parent edges pointing outside the selection', () => {
    // "c" lists "outside" as its parent, but "outside" isn't in the input.
    // The edge must not add a phantom in-degree; "c" should sort alongside
    // other roots by hash order.
    const a = c('aaa', '2024-01-01T00:00:00Z', []);
    const cc = c('ccc', '2024-01-01T00:00:00Z', ['outside']);
    const sorted = sortCommitsStable([cc, a]);
    assert.deepStrictEqual(sorted.map((x) => x.hash), ['aaa', 'ccc']);
  });

  it('degenerates to hash-alphabetical when `parents` is undefined on every commit', () => {
    // Without parent data, the helper must still produce a deterministic
    // order (same as Round-2's hash tie-break).
    const withoutParents: ISortableCommit[] = [
      { hash: 'c', commitDate: new Date('2024-01-01T00:00:00Z') },
      { hash: 'a', commitDate: new Date('2024-01-01T00:00:00Z') },
      { hash: 'b', commitDate: new Date('2024-01-01T00:00:00Z') },
    ];
    const sorted = sortCommitsStable(withoutParents);
    assert.deepStrictEqual(sorted.map((x) => x.hash), ['a', 'b', 'c']);
  });

  it('is stable across arbitrary input permutations', () => {
    const commits = [
      c('x1', '2024-01-01T00:00:00Z', []),
      c('x2', '2024-01-01T00:00:00Z', ['x1']),
      c('x3', '2024-01-02T00:00:00Z', ['x2']),
      c('x4', '2024-01-02T00:00:00Z', ['x3']),
      c('x5', '2024-01-03T00:00:00Z', ['x4']),
    ];
    const expected = ['x1', 'x2', 'x3', 'x4', 'x5'];

    // A handful of deterministic permutations.
    const perms = [
      [0, 1, 2, 3, 4],
      [4, 3, 2, 1, 0],
      [2, 0, 4, 1, 3],
      [1, 3, 0, 4, 2],
    ];
    for (const perm of perms) {
      const input = perm.map((i) => commits[i]);
      const sorted = sortCommitsStable(input);
      assert.deepStrictEqual(
        sorted.map((x) => x.hash),
        expected,
        `perm ${JSON.stringify(perm)} produced wrong order`
      );
    }
  });

  it('does not lose commits when the intra-group parent graph contains a cycle', () => {
    // Fuzz-style input: a ↔ b (cycle). Helper must return both commits,
    // not loop forever or drop a node.
    const a = c('a', '2024-01-01T00:00:00Z', ['b']);
    const b = c('b', '2024-01-01T00:00:00Z', ['a']);
    const sorted = sortCommitsStable([a, b]);
    assert.strictEqual(sorted.length, 2);
    const hashes = sorted.map((x) => x.hash).sort();
    assert.deepStrictEqual(hashes, ['a', 'b']);
  });

  it('produces the same output across 50 consecutive runs on the same input (non-determinism smoke test)', () => {
    const input = [
      c('b000', '2024-01-01T00:00:00Z', []),
      c('0000', '2024-01-01T00:00:00Z', ['b000']),
      c('a500', '2024-01-01T00:00:00Z', []),
      c('ff00', '2024-01-02T00:00:00Z', ['0000']),
    ];
    const first = sortCommitsStable(input).map((x) => x.hash);
    for (let i = 0; i < 50; i++) {
      const next = sortCommitsStable(input).map((x) => x.hash);
      assert.deepStrictEqual(next, first, `run #${i} diverged`);
    }
  });
});
