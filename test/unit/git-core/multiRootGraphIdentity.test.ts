/**
 * Merged multi-root log: commit identity is (hash, repoRoot), never hash
 * alone — IntelliJ vcs-log parity (CommitId = Hash + root). Two checkouts of
 * the same repository interleaved into one log must render as independent
 * strands: same-hash commits from different roots share no lanes, no edges,
 * and no ref labels. Keying by bare hash stitched the copies into one
 * apparent linear chain and pooled every root's branch labels onto one row.
 */

import '../../setup';
import * as assert from 'assert';
import {
  generateCommitGraph,
  computeChildCountMap,
  computeTerminalNodes,
  commitNodeKey,
  IBranchRef,
} from '../../../src/git-core/commitGraph';
import type { ICommit } from '../../../src/git-core/interfaces/IGitService';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const ROOT_1 = '/work/checkout-one';
const ROOT_2 = '/work/checkout-two';

function commit(
  hash: string,
  parents: string[],
  repoRoot: string,
  when: string
): ICommit & { repoRoot: string } {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: `commit ${hash.slice(0, 4)}`,
    author: { name: 'A', email: 'a@x' },
    committer: { name: 'A', email: 'a@x' },
    parents,
    authorDate: new Date(when),
    commitDate: new Date(when),
    repoRoot,
  };
}

/** Two identical one-parent histories (B → A), date-interleaved newest-first. */
function interleavedRows(): Array<ICommit & { repoRoot: string }> {
  return [
    commit(HASH_B, [HASH_A], ROOT_1, '2026-01-02T10:00:01Z'),
    commit(HASH_B, [HASH_A], ROOT_2, '2026-01-02T10:00:00Z'),
    commit(HASH_A, [], ROOT_1, '2026-01-01T10:00:01Z'),
    commit(HASH_A, [], ROOT_2, '2026-01-01T10:00:00Z'),
  ];
}

describe('multi-root graph identity — (hash, root), not hash', () => {
  it('renders same-hash histories from different roots as independent strands', () => {
    const nodes = generateCommitGraph(interleavedRows());
    assert.strictEqual(nodes.length, 4);
    const [b1, b2, a1, a2] = nodes;
    assert.notStrictEqual(b1.graphColumn, b2.graphColumn, 'the two copies must not share a lane');
    assert.strictEqual(a1.graphColumn, b1.graphColumn, "root 1's strand is connected");
    assert.strictEqual(a2.graphColumn, b2.graphColumn, "root 2's strand is connected");
    // No cross-root edge: each B's first-parent line stays in its own lane
    // (straight-down inheritance), never bending into the other copy's lane.
    for (const [child, own] of [
      [b1, b1.graphColumn],
      [b2, b2.graphColumn],
    ] as const) {
      for (const line of child.graphLines) {
        assert.strictEqual(line.toColumn, own, 'edge must stay within its root');
      }
    }
  });

  it('attaches a ref label only to the row of the root that carries the ref', () => {
    const rows = interleavedRows();
    const branchMap = new Map<string, IBranchRef[]>([
      [commitNodeKey(rows[0]), [{ name: 'main', type: 'local' }]],
    ]);
    const nodes = generateCommitGraph(rows, branchMap);
    assert.strictEqual(nodes[0].branches.length, 1, "root 1's tip carries its ref");
    assert.strictEqual(nodes[1].branches.length, 0, "root 2's copy must not inherit it");
  });

  it('keys the child/terminal helpers by (hash, root) so copies do not pool', () => {
    const nodes = generateCommitGraph(interleavedRows());
    const childCount = computeChildCountMap(nodes);
    assert.strictEqual(
      childCount.get(commitNodeKey(nodes[2].commit)),
      1,
      "root 1's A has exactly one child — the copies must not pool into a fake branch split"
    );
    const terminals = computeTerminalNodes(nodes);
    assert.ok(terminals.has(commitNodeKey(nodes[0].commit)), "root 1's B is a tip");
    assert.ok(terminals.has(commitNodeKey(nodes[1].commit)), "root 2's B is a tip too");
  });

  it('keeps plain single-repo behavior unchanged (key degenerates to the hash)', () => {
    const plain: ICommit[] = interleavedRows()
      .filter((c) => c.repoRoot === ROOT_1)
      .map(({ repoRoot: _ignored, ...c }) => c as ICommit);
    assert.strictEqual(commitNodeKey(plain[0]), HASH_B, 'no root → key IS the hash');
    const nodes = generateCommitGraph(plain);
    assert.strictEqual(nodes[0].graphColumn, nodes[1].graphColumn, 'linear chain, one lane');
  });
});
