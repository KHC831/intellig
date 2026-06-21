/**
 * Property test pins for spec 8 invariant L1 — lane assignment must be
 * stable across reloads.
 *
 * ADR ref: `docs/adr/ADR-013-graph-data-model-invariants.md` section 2 (spec 8.L1).
 *
 * The spec 8 L1 rule:
 *
 *   1. HEAD's branch tip pre-seeds lane 0 (and ONLY HEAD's tip).
 *   2. The two-pass children-map algorithm assigns subsequent lanes
 *      deterministically from the input commit order.
 *
 * Bug class this guards against: refresh-shifts-lanes (T53),
 * divergent-sibling-collapse, green-node-on-blue-line. Any of those
 * regressions breaks the byte-identical-reload guarantee — that's
 * exactly what these properties verify.
 *
 * The baseline pin in `commitGraph.test.ts` ("cross-render stability:
 * same branchMap → same lane assignments") locks a single fixed input.
 * The properties below cover the same invariant across the random
 * input space:
 *
 *   - **A — same input, same output** (byte-identical reload). For an
 *     arbitrary commit DAG and an arbitrary `branchMap`, calling
 *     `generateCommitGraph` twice with identical arguments must
 *     produce deeply-equal `ICommitNode[]` outputs.
 *   - **B — branchMap iteration order is irrelevant**. The algorithm
 *     hands a `Map` to a sort that's keyed by HEAD-priority, then
 *     branch type, then alphabetic name — the iteration order of the
 *     input `Map` MUST NOT leak into the output. Build the same map
 *     twice with different insertion orders and assert lane
 *     assignments match.
 *   - **C — HEAD's branch tip lands on lane 0**. Whatever the input
 *     commit order, when `headBranchName` is set and that branch's tip
 *     is in the loaded window, the tip's `graphColumn` is 0.
 *
 * Each property here is paired with a focused-counter-example unit
 * test in `commitGraph.test.ts`; the property forms catch the long
 * tail of inputs that the unit-level pins don't cover.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import { generateCommitGraph, IBranchRef, ICommitNode } from '../../src/git-core/commitGraph';
import { ICommit } from '../../src/git-core/interfaces/IGitService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkCommit(hash: string, parents: string[]): ICommit {
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message: `commit ${hash}`,
    author: { name: 'a', email: 'a@a' },
    committer: { name: 'a', email: 'a@a' },
    parents,
    authorDate: new Date('2024-01-01T00:00:00Z'),
    commitDate: new Date('2024-01-01T00:00:00Z'),
  };
}

/**
 * Random DAG arbitrary.
 *
 * Generates K parallel branches anchored at a common base. Each
 * branch has a random depth in [1, maxDepth]. The newest commit of
 * each branch is the branch tip.
 *
 * The shape is restricted to "K branches sharing one root" because
 * that's the canonical lane-allocation shape: it produces K
 * divergent terminals on K distinct lanes, and the seeding pre-pass
 * has to decide which tip lands on lane 0 (HEAD) and which alphabetic
 * order claims lanes 1, 2, ...
 *
 * The arbitrary returns:
 *   - `commits`: newest-first display order (matches what the host
 *     gives `generateCommitGraph`).
 *   - `tips`: array of `{name, type, commit}` describing each
 *     branch tip — used by the test to build a branchMap.
 *   - `headIndex`: which tip is HEAD (0..K-1). Always 0 for the
 *     simplest arbitrary; randomized for the iteration-order
 *     property to vary which name takes lane 0.
 */
interface RandomDag {
  commits: ICommit[];
  tips: Array<{ name: string; type: 'local' | 'remote'; commit: string }>;
  headIndex: number;
}

const dagArb: fc.Arbitrary<RandomDag> = fc
  .tuple(
    fc.integer({ min: 2, max: 6 }), // K branches
    fc.integer({ min: 1, max: 4 }), // max depth per branch
    fc.integer({ min: 0, max: 5 })
  )
  .map(([k, maxDepth, headIdxRaw]) => {
    const commits: ICommit[] = [];
    // Newest-first display order, interleaving branch tips first.
    for (let row = maxDepth - 1; row >= 0; row--) {
      for (let b = 0; b < k; b++) {
        const hash = `B${b}_R${row}`;
        const parent = row === 0 ? 'BASE' : `B${b}_R${row - 1}`;
        commits.push(mkCommit(hash, [parent]));
      }
    }
    commits.push(mkCommit('BASE', []));

    // Tip of each branch is the row=maxDepth-1 commit for that
    // branch. Names are alphabetic so the alphabetic seeding sort
    // is deterministic and easy to reason about.
    const tipNames = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    const tips = [];
    for (let b = 0; b < k; b++) {
      tips.push({
        name: tipNames[b],
        type: 'local' as const,
        commit: `B${b}_R${maxDepth - 1}`,
      });
    }

    return {
      commits,
      tips,
      headIndex: headIdxRaw % k,
    };
  });

function buildBranchMap(
  tips: Array<{ name: string; type: 'local' | 'remote'; commit: string }>,
  insertionOrder: number[]
): Map<string, IBranchRef[]> {
  const m = new Map<string, IBranchRef[]>();
  for (const i of insertionOrder) {
    const t = tips[i];
    m.set(t.commit, [{ name: t.name, type: t.type }]);
  }
  return m;
}

function laneSnapshot(nodes: ICommitNode[]): Array<[string, number]> {
  return nodes.map((n) => [n.commit.hash, n.graphColumn] as [string, number]);
}

// ---------------------------------------------------------------------------
// L1 — Byte-identical reload property
// ---------------------------------------------------------------------------

describe('Phase 1a property pin — spec 8 L1 lane stability across reloads', () => {
  it('property A — same input ⇒ deeply-equal output (lane assignment is byte-identical across no-op reloads)', () => {
    fc.assert(
      fc.property(dagArb, (dag) => {
        const insertion = dag.tips.map((_, i) => i);
        const branchMap = buildBranchMap(dag.tips, insertion);
        const headName = dag.tips[dag.headIndex].name;

        const r1 = generateCommitGraph(dag.commits, branchMap, undefined, undefined, headName);
        const r2 = generateCommitGraph(dag.commits, branchMap, undefined, undefined, headName);

        // Lane assignments and graph-line shape must be byte-identical.
        // Use lane snapshots (hash → column) instead of full deep-equal
        // because Date instances on `commit.authorDate` are stable but
        // `===`-compared by reference; the algorithm produces the same
        // node objects each time so this is a strict structural check
        // on what the renderer actually consumes.
        assert.deepStrictEqual(laneSnapshot(r2), laneSnapshot(r1));

        // Per-row graphLines too — the renderer keys off these for
        // every stroke.
        for (let i = 0; i < r1.length; i++) {
          assert.deepStrictEqual(r2[i].graphLines, r1[i].graphLines);
        }
      }),
      { numRuns: 100, seed: 0xa11ca171 }
    );
  });

  it('property B — branchMap iteration order does NOT change lane assignments (sort-determinism guard)', () => {
    fc.assert(
      fc.property(
        dagArb,
        // A permutation of [0..K-1] expressed as a stream of indices.
        // We use shuffledSubarray on the tip indices to draw a
        // permutation; fall back to identity if the result is shorter
        // than K (shouldn't happen with the contract below, but
        // belt-and-braces).
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 6, maxLength: 6 }),
        (dag, permRaw) => {
          // Build an honest permutation of [0..K-1] by stable-sorting
          // [0..K-1] using permRaw[i] as the key. This guarantees a
          // valid permutation regardless of permRaw's contents.
          const k = dag.tips.length;
          const order1 = Array.from({ length: k }, (_, i) => i);
          const order2 = [...order1].sort(
            (a, b) => permRaw[a % permRaw.length] - permRaw[b % permRaw.length]
          );

          const headName = dag.tips[dag.headIndex].name;
          const m1 = buildBranchMap(dag.tips, order1);
          const m2 = buildBranchMap(dag.tips, order2);

          const r1 = generateCommitGraph(dag.commits, m1, undefined, undefined, headName);
          const r2 = generateCommitGraph(dag.commits, m2, undefined, undefined, headName);

          assert.deepStrictEqual(
            laneSnapshot(r2),
            laneSnapshot(r1),
            'branchMap insertion order must not affect lane assignments'
          );
        }
      ),
      { numRuns: 100, seed: 0xa11ca172 }
    );
  });

  it("property C — HEAD's branch tip ALWAYS lands on lane 0 when in the window (regardless of which branch is HEAD)", () => {
    fc.assert(
      fc.property(dagArb, (dag) => {
        // Run K times, once per possible HEAD pick. Each run pins a
        // different branch onto lane 0 — proves the pre-seeding sort
        // is keyed off `headBranchName`, not on hidden tip-name
        // ordering.
        for (let h = 0; h < dag.tips.length; h++) {
          const headName = dag.tips[h].name;
          const branchMap = buildBranchMap(
            dag.tips,
            dag.tips.map((_, i) => i)
          );
          const r = generateCommitGraph(dag.commits, branchMap, undefined, undefined, headName);
          const headTipNode = r.find((n) => n.commit.hash === dag.tips[h].commit);
          assert.ok(headTipNode, `HEAD tip commit must be in result; missing for head=${headName}`);
          assert.strictEqual(
            headTipNode.graphColumn,
            0,
            `HEAD branch '${headName}' tip ${dag.tips[h].commit} must be on lane 0; got ${headTipNode.graphColumn}`
          );
        }
      }),
      { numRuns: 80, seed: 0xa11ca173 }
    );
  });
});
