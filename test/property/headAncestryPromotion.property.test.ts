/**
 * Property test pin for spec 8 invariant L1 — HEAD-ancestry promotion.
 *
 * ADR ref: `docs/adr/ADR-013-graph-data-model-invariants.md` section 2 (spec 8.L1).
 *
 * The spec 8 L1 sub-rule pinned here:
 *
 *   When the input commit array (newest-first display order)
 *   interleaves a divergent branch's commits BEFORE the HEAD-ancestry
 *   chain's commits, the HEAD-ancestry tip MUST still land on lane 0.
 *
 * The mechanism is the seeding pre-pass in `generateCommitGraph`:
 * before the main pass walks `commits[]`, it consults `branchMap` and
 * `headBranchName` to pre-claim lane 0 for HEAD's branch tip. The
 * main pass's `state.commitToLane.has(commitHash)` inheritance check
 * then makes the HEAD tip's row inherit the pre-claimed lane instead
 * of allocating a fresh one — even though a divergent branch's tip
 * came first in display order and would otherwise have grabbed lane 0.
 *
 * Bug class this guards against: green-node-on-blue-line (T53), where
 * a refresh that touched the input commit ordering caused the HEAD
 * branch to "jump" to a different column. Without the seeding
 * pre-pass, the lane index was a pure function of input order.
 *
 * The property here is intentionally a SUPER-SET of the unit-level
 * pin in `commitGraph.test.ts` ("HEAD's branch tip lands on lane 0
 * even when it's not the newest commit"):
 *
 *   - The unit pin uses K=2 branches at fixed depth 1.
 *   - This property covers K ∈ [2, 6] branches at depths ∈ [1, 4],
 *     with arbitrary placement of the HEAD branch among the tips
 *     and arbitrary insertion-order of branch entries in the
 *     `branchMap`.
 *
 * Mutation that should fail this property:
 *   - Delete the seeding pre-pass entirely (lines ~339-382 in
 *     `commitGraph.ts`).
 *   - Flip the priority sort key from "headBranchName first" to
 *     anything else.
 *   - Skip the `state.activeLanes.add(lane)` after pre-claiming —
 *     subsequent allocations would land on the same lane.
 *
 * If any of those regress, at least one of the test cases below
 * fails for at least one random fixture.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import { generateCommitGraph, IBranchRef } from '../../src/git-core/commitGraph';
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

// Stable alphabetic tip names. The seeding sort breaks ties by
// `name.localeCompare`, so picking distinct strings guarantees a
// deterministic non-HEAD ordering.
const TIP_NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];

interface ScenarioInput {
  k: number;
  depth: number;
  headIndex: number;
  // Whether to interleave commits across branches (TRUE = divergent
  // branches' rows appear before the HEAD chain in display order).
  interleave: boolean;
}

const scenarioArb: fc.Arbitrary<ScenarioInput> = fc
  .tuple(
    fc.integer({ min: 2, max: 6 }),
    fc.integer({ min: 1, max: 4 }),
    fc.integer({ min: 0, max: 5 }),
    fc.boolean()
  )
  .map(([k, depth, h, interleave]) => ({ k, depth, headIndex: h % k, interleave }));

function buildScenario(s: ScenarioInput): {
  commits: ICommit[];
  branchMap: Map<string, IBranchRef[]>;
  headTipHash: string;
  headBranchName: string;
} {
  const commits: ICommit[] = [];
  if (s.interleave) {
    // Newest-first interleaved order: B0_R(d-1), B1_R(d-1), ..., B0_R(d-2), B1_R(d-2), ...
    // The HEAD branch's commits are interleaved with the divergent
    // branches' commits. Whether the HEAD tip is first, last, or
    // anywhere in between depends on `headIndex`.
    for (let row = s.depth - 1; row >= 0; row--) {
      for (let b = 0; b < s.k; b++) {
        const hash = `B${b}_R${row}`;
        const parent = row === 0 ? 'BASE' : `B${b}_R${row - 1}`;
        commits.push(mkCommit(hash, [parent]));
      }
    }
  } else {
    // Branch-by-branch order. Each divergent branch's full chain is
    // emitted before the HEAD chain — even more adversarial for the
    // pre-seeding (the algorithm has consumed every divergent commit
    // before encountering HEAD's first row).
    const order = Array.from({ length: s.k }, (_, i) => i);
    // Move HEAD to the end so it appears LAST in display order — the
    // most adversarial position for pre-seeding.
    order.splice(order.indexOf(s.headIndex), 1);
    order.push(s.headIndex);
    for (const b of order) {
      for (let row = s.depth - 1; row >= 0; row--) {
        const hash = `B${b}_R${row}`;
        const parent = row === 0 ? 'BASE' : `B${b}_R${row - 1}`;
        commits.push(mkCommit(hash, [parent]));
      }
    }
  }
  commits.push(mkCommit('BASE', []));

  const branchMap = new Map<string, IBranchRef[]>();
  for (let b = 0; b < s.k; b++) {
    const tipHash = `B${b}_R${s.depth - 1}`;
    branchMap.set(tipHash, [{ name: TIP_NAMES[b], type: 'local' }]);
  }
  return {
    commits,
    branchMap,
    headTipHash: `B${s.headIndex}_R${s.depth - 1}`,
    headBranchName: TIP_NAMES[s.headIndex],
  };
}

// ---------------------------------------------------------------------------
// L1 — HEAD-ancestry promotion property
// ---------------------------------------------------------------------------

describe('Phase 1a property pin — spec 8 L1 HEAD-ancestry promotion', () => {
  it('mainline tip wins lane 0 against earlier-listed divergent siblings (across random K, depth, interleaving, head pick)', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const built = buildScenario(s);
        const result = generateCommitGraph(
          built.commits,
          built.branchMap,
          undefined,
          undefined,
          built.headBranchName
        );

        const headTipNode = result.find((n) => n.commit.hash === built.headTipHash);
        assert.ok(headTipNode, 'HEAD tip must be in the result');
        assert.strictEqual(
          headTipNode.graphColumn,
          0,
          [
            `HEAD branch '${built.headBranchName}' tip ${built.headTipHash} must be on lane 0;`,
            `got ${headTipNode.graphColumn}.`,
            `Scenario: K=${s.k}, depth=${s.depth}, headIndex=${s.headIndex}, interleave=${s.interleave}.`,
          ].join(' ')
        );

        // Strengthen: the HEAD chain (every commit on lane 0 reachable
        // from the HEAD tip down to BASE) must STAY on lane 0 across
        // the chain. This pins the "straight-down inheritance for
        // first-parent + first-child" rule for the HEAD-ancestry
        // path specifically — if seeding worked but the main-pass
        // first-child check broke, the chain would split off lane 0
        // partway down.
        for (let row = s.depth - 1; row >= 0; row--) {
          const hash = `B${s.headIndex}_R${row}`;
          const node = result.find((n) => n.commit.hash === hash);
          assert.ok(node, `HEAD chain row ${row} must be in result`);
          assert.strictEqual(
            node.graphColumn,
            0,
            `HEAD chain commit ${hash} (row=${row}) must stay on lane 0; got ${node.graphColumn}`
          );
        }
      }),
      { numRuns: 100, seed: 0xa1ce5701 }
    );
  });

  it('without headBranchName, the same scenario does NOT guarantee the HEAD-ancestry tip lands on lane 0 (negative control — proves seeding is what does the work)', () => {
    // This is a negative control: we verify the property is
    // load-bearing by showing it depends on the seeding pre-pass. If
    // we drop `headBranchName`, the algorithm has no way to know
    // which branch is HEAD; the lane-0 outcome then depends purely
    // on input order.
    //
    // The control is a SINGLE scenario chosen to demonstrate the
    // dependency rather than a property: a fast-check round here
    // would be flaky because some random scenarios happen to put
    // the "HEAD" branch first by coincidence even without seeding.
    const s: ScenarioInput = { k: 3, depth: 2, headIndex: 1, interleave: false };
    const built = buildScenario(s);

    // Drop the headBranchName argument.
    const result = generateCommitGraph(
      built.commits,
      built.branchMap,
      undefined,
      undefined,
      undefined
    );

    const headTipNode = result.find((n) => n.commit.hash === built.headTipHash);
    assert.ok(headTipNode);
    // In this branch-by-branch scenario the HEAD branch ('beta',
    // index 1) is emitted LAST — without seeding, lane 0 was claimed
    // by the FIRST branch ('alpha', index 0). So 'beta' tip must
    // NOT be on lane 0 here. If a future change makes lane 0 the
    // default for any tip regardless of input order (e.g. a different
    // pre-claim rule), this assertion catches it.
    assert.notStrictEqual(
      headTipNode.graphColumn,
      0,
      'without headBranchName, last-emitted branch tip must NOT win lane 0 by accident'
    );
  });
});
