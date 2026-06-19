/**
 * Real-topology graph regression — IntelliJ Community repo (north-star).
 *
 * Builds the commit graph from a deterministic 150-commit window captured from
 * the IntelliJ Community repository (see `src/test/fixtures/intellijTopo.ts`
 * for provenance) using the SAME production builder the Git tool window uses
 * (`generateCommitGraph`), and asserts the structural invariants that the
 * prior dangling-line / off-by-one-lane bugs violated:
 *
 *   1. the builder preserves the topo-ordered input (every node present, order
 *      kept) — a child never lands below its parent;
 *   2. every parent edge terminates at a real in-window node OR a documented
 *      off-window stub — no edge points at a non-existent commit;
 *   3. a merge commit gets a lane per parent — one first-parent line plus a
 *      distinct merge line (own lane) for each additional parent;
 *   4. no orphan active lane — every lane painted at a row has REAL ink there
 *      (the load-bearing "no dangling vertical stroke" invariant), checked with
 *      the same node-geometry ink oracle as the anonymized real-topo pin.
 *
 * The captured hashes are immutable history, so this is a deterministic
 * regression spec, not a smoke test — it asserts graph STRUCTURE built from
 * genuine merge-rich topology.
 */

import '../../setup';
import * as assert from 'assert';
import { generateCommitGraph, ICommitNode } from '../../../git-core/commitGraph';
import { computeActiveLanes } from '../../../utils/graphRenderer';
import type { ICommit } from '../../../git-core/interfaces/IGitService';
import { INTELLIJ_TOPO, INTELLIJ_TOPO_ANCHOR } from '../../fixtures/intellijTopo';

const HEX40 = /^[0-9a-f]{40}$/;

function mk(hash: string, parents: string[]): ICommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: hash,
    author: { name: 'a', email: 'a@a' },
    committer: { name: 'a', email: 'a@a' },
    parents,
    authorDate: new Date(0),
    commitDate: new Date(0),
  } as ICommit;
}

/**
 * Recompute, directly from the node geometry, the lanes that genuinely have
 * ink at each row. Mirrors the oracle used by the anonymized real-topo pin
 * (realTopoRegression.test.ts): a node's own column at its row; a same-lane
 * line across its whole span; a bending line's DESTINATION column across its
 * span plus its source column at the source row only; a far-parent (`endRow`)
 * line's source lane down to endRow-1. This is an INDEPENDENT cross-check of
 * computeActiveLanes — derived from topology, not from the rule under test.
 */
function groundTruthInk(nodes: ICommitNode[]): Map<number, Set<number>> {
  const rowOf = new Map<string, number>();
  nodes.forEach((n, i) => rowOf.set(n.commit.hash, i));
  const truth = new Map<number, Set<number>>();
  const mark = (row: number, lane: number): void => {
    if (!truth.has(row)) {
      truth.set(row, new Set());
    }
    truth.get(row)!.add(lane);
  };
  nodes.forEach((n, i) => {
    mark(i, n.graphColumn);
    const firstParentOffWindow =
      n.commit.parents.length > 0 && rowOf.get(n.commit.parents[0]) === undefined;
    const hasInWindowParent = n.commit.parents.some((p) => rowOf.get(p) !== undefined);
    if (firstParentOffWindow && hasInWindowParent) {
      for (let r = i; r < nodes.length; r++) {
        mark(r, n.graphColumn);
      }
    }
    for (const line of n.graphLines) {
      if (line.endRow !== undefined) {
        if (line.endRow > i) {
          for (let r = i; r <= line.endRow - 1; r++) {
            mark(r, line.fromColumn);
          }
        } else {
          mark(i, line.fromColumn);
        }
        continue;
      }
      let target = i;
      for (const p of n.commit.parents) {
        const pr = rowOf.get(p);
        if (pr !== undefined && pr > i && nodes[pr].graphColumn === line.toColumn) {
          target = pr;
          break;
        }
      }
      if (line.fromColumn === line.toColumn) {
        for (let r = i; r <= Math.max(i, target); r++) {
          mark(r, line.fromColumn);
        }
      } else {
        mark(i, line.fromColumn);
        for (let r = i; r <= Math.max(i, target); r++) {
          mark(r, line.toColumn);
        }
      }
    }
  });
  return truth;
}

describe('IntelliJ real topology — graph regression pins', () => {
  const commits = INTELLIJ_TOPO.map((c) => mk(c.hash, c.parents));

  function build(): ICommitNode[] {
    return generateCommitGraph(
      commits,
      undefined,
      undefined,
      undefined,
      undefined,
      commits[0].hash
    );
  }

  it('fixture sanity: anchored at the captured merge, merge-rich, all hashes valid', () => {
    assert.strictEqual(commits.length, 150, 'fixed 150-commit window');
    assert.strictEqual(
      commits[0].hash,
      INTELLIJ_TOPO_ANCHOR,
      'window anchored at the capture point'
    );
    const mergeCount = commits.filter((c) => c.parents.length >= 2).length;
    assert.ok(mergeCount >= 3, `expected merge-rich topology; got ${mergeCount} merges`);
    for (const c of commits) {
      assert.ok(HEX40.test(c.hash), `commit hash must be a 40-hex sha: ${c.hash}`);
      for (const p of c.parents) {
        assert.ok(HEX40.test(p), `parent hash must be a 40-hex sha: ${p}`);
      }
    }
  });

  it('builds every node and preserves the topo-ordered input', () => {
    const nodes = build();
    assert.strictEqual(nodes.length, commits.length, 'no node dropped or duplicated');
    for (let i = 0; i < commits.length; i++) {
      assert.strictEqual(nodes[i].commit.hash, commits[i].hash, `row ${i} preserves input order`);
    }
  });

  it('topo-order holds: every in-window parent appears strictly below its child', () => {
    const nodes = build();
    const rowOf = new Map<string, number>(nodes.map((n, i) => [n.commit.hash, i]));
    for (let i = 0; i < nodes.length; i++) {
      for (const p of nodes[i].commit.parents) {
        const pr = rowOf.get(p);
        if (pr !== undefined) {
          assert.ok(
            pr > i,
            `parent ${p.slice(0, 8)} (row ${pr}) of ${nodes[i].commit.hash.slice(0, 8)} ` +
              `(row ${i}) must appear BELOW its child`
          );
        }
      }
    }
  });

  it('every EMITTED graph line terminates at the parent’s real lane or a documented off-window stub', () => {
    // Asserts on the builder OUTPUT (graphLines), not the fixture input: one
    // line per parent in parent order, each either landing on the lane the
    // in-window parent actually occupies (no off-by-one / dangling lane) or a
    // dashed stub on the node's own lane for an off-window parent.
    const nodes = build();
    const rowOf = new Map<string, number>(nodes.map((n, i) => [n.commit.hash, i]));
    let realTerminations = 0;
    let offWindowStubs = 0;

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const parents = n.commit.parents;
      assert.strictEqual(
        n.graphLines.length,
        parents.length,
        `${n.commit.hash.slice(0, 8)}: exactly one graph line per parent (no spurious/dropped edge)`
      );

      for (let p = 0; p < parents.length; p++) {
        const line = n.graphLines[p];
        const parentRow = rowOf.get(parents[p]);

        if (parentRow === undefined) {
          // Off-window parent → documented dashed stub on the node's own lane.
          assert.strictEqual(
            line.style,
            'dashed',
            `${n.commit.hash.slice(0, 8)}: off-window parent edge must be a dashed stub`
          );
          assert.strictEqual(
            line.toColumn,
            n.graphColumn,
            `${n.commit.hash.slice(0, 8)}: off-window stub must stay on the node's own lane`
          );
          assert.ok(HEX40.test(parents[p]), `off-window parent must be a valid sha: ${parents[p]}`);
          offWindowStubs++;
        } else {
          // In-window parent → the line must land on the lane the parent node
          // genuinely occupies, strictly below this row.
          assert.ok(
            parentRow > i,
            `${n.commit.hash.slice(0, 8)}: parent ${parents[p].slice(0, 8)} must sit below`
          );
          assert.strictEqual(
            line.toColumn,
            nodes[parentRow].graphColumn,
            `${n.commit.hash.slice(0, 8)}: parent edge must land on the parent's real lane ` +
              `(${parents[p].slice(0, 8)} @ row ${parentRow}, lane ${nodes[parentRow].graphColumn}); ` +
              `dangling/off-by-one lane otherwise`
          );
          realTerminations++;
        }
      }
    }

    // Both routing paths must be exercised by this real window.
    assert.ok(realTerminations > 0, 'expected in-window parent edges (real terminations)');
    assert.ok(offWindowStubs > 0, 'expected documented off-window stubs');
  });

  it('merge commits get a lane per parent (one first-parent line + a distinct lane per extra parent)', () => {
    const nodes = build();
    const merges = nodes.filter((n) => n.commit.parents.length >= 2);
    assert.ok(
      merges.length >= 3,
      `expected several merges to assert against; got ${merges.length}`
    );
    for (const m of merges) {
      const firstParentLines = m.graphLines.filter((l) => l.type === 'commit');
      const mergeLines = m.graphLines.filter((l) => l.type === 'merge');
      assert.strictEqual(
        firstParentLines.length,
        1,
        `${m.commit.hash.slice(0, 8)}: exactly one first-parent line`
      );
      assert.strictEqual(
        mergeLines.length,
        m.commit.parents.length - 1,
        `${m.commit.hash.slice(0, 8)}: one merge line per additional parent`
      );
      // Each merge line departs the node's own lane and lands on a DISTINCT
      // lane (a lane per parent — never two parents collapsed onto one).
      const destLanes = mergeLines.map((l) => l.toColumn);
      assert.strictEqual(
        new Set(destLanes).size,
        destLanes.length,
        `${m.commit.hash.slice(0, 8)}: each parent gets its own lane (no collapsed parents)`
      );
      for (const l of mergeLines) {
        assert.strictEqual(
          l.fromColumn,
          m.graphColumn,
          `${m.commit.hash.slice(0, 8)}: merge line must leave the node's own lane`
        );
      }
    }
  });

  it('no orphan active lane — every painted lane has real node-geometry ink there', () => {
    const nodes = build();
    const active = computeActiveLanes(nodes);
    const truth = groundTruthInk(nodes);
    const orphans: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const al = active.get(i) ?? new Set<number>();
      const legit = truth.get(i) ?? new Set<number>();
      for (const lane of al) {
        if (!legit.has(lane)) {
          orphans.push(`row ${i} (${nodes[i].commit.hash.slice(0, 8)}): orphan lane ${lane}`);
        }
      }
    }
    assert.deepStrictEqual(
      orphans.slice(0, 20),
      [],
      `${orphans.length} orphan active-lane(s) — a dangling vertical stroke through a row with no ink`
    );
  });
});
