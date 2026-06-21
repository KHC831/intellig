/**
 * Lanes-pinned audit (Phase 0 meta-test).
 *
 * The `INVARIANT_PINS` table below catalogs the invariants (L1..L14)
 * that the team has paid for in production bugs. Each invariant is
 * supposed to be locked down by a named test file somewhere under
 * `test/`. This audit's table is the coverage matrix — it enumerates
 * which test file pins which invariant; the graph-data-model subset
 * (L1, L4, L9) is documented in
 * `docs/adr/ADR-013-graph-data-model-invariants.md`.
 *
 * **Failure mode this audit guards against**: a refactor (rename, file
 * move, or "this looks dead, let me delete it") quietly removes the test
 * that was the canonical pin for an invariant. The behavioral pin
 * vanishes; the next regression that touches the same code path now
 * lands silently. The bug classes L1/L2/L4 are the ones users have
 * actually filed tickets about (T52 detached HEAD, T53 lane-bending,
 * T54 dropdown auto-revert). Losing those guards is the load-bearing
 * risk this audit pins.
 *
 * **Strategy**: this test is a **static string-search** sweep over the
 * test tree. For each invariant in the L1/L2/L4 set (the load-bearing
 * Phase 0 trio — see the INVARIANT_PINS table), it asserts that:
 *
 *   1. A specific test file the table names exists.
 *   2. That file contains a regex / literal substring that uniquely
 *      identifies the test case pinning the invariant.
 *
 * If either check fails, the audit produces a message that points at
 * the invariant's INVARIANT_PINS entry, so the next contributor knows
 * which file to restore (or which table row to update if the rename was
 * deliberate).
 *
 * **Scope of this Phase 0 audit**: L1, L2, L4 only. Phase 1 + Phase 4
 * land additional pinned tests (L9 property test, L5/L11/L14 dedicated
 * suites). Each subsequent phase extends this audit's `INVARIANT_PINS`
 * table. Phase 0 deliberately stops at the three invariants whose pin
 * tests already exist on `main` — adding L9/L5/L11/L14 here would
 * predict future test files that don't yet exist, which is the wrong
 * direction for a meta-test.
 *
 * **Not** a behavioral assertion — only a structural one. The actual
 * invariant assertions live in the named test files; this audit just
 * makes sure they don't go missing.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// The pin table. Each entry maps an invariant id to a (file, marker) pair.
// `marker` is a substring or RegExp that uniquely identifies the test case;
// when matched against the file's contents it MUST hit at least once.
// ---------------------------------------------------------------------------

interface InvariantPin {
  /** Invariant id (e.g. "L1"). */
  id: string;
  /** One-line summary of the rule (mirrors the spec heading). */
  summary: string;
  /** Repo-relative POSIX path to the test file that pins this invariant. */
  file: string;
  /**
   * One or more markers — every marker MUST be present in the file's
   * contents. Markers are tested via `String.prototype.includes` (literal
   * string) or `RegExp.test` (regex). Use literals for stable test names;
   * use regex when the matrix tolerates name drift but the code shape is
   * fixed.
   */
  markers: Array<string | RegExp>;
}

const INVARIANT_PINS: InvariantPin[] = [
  {
    id: 'L1',
    summary: 'Lane assignment is stable across reloads and reflects HEAD ancestry',
    file: 'test/unit/utils/commitGraph.test.ts',
    markers: [
      // Cross-render stability — pins the byte-identical reload guarantee.
      'cross-render stability',
      // HEAD-only seeding behavior — the load-bearing piece of L1.
      /headBranchName/,
    ],
  },
  {
    id: 'L2',
    summary: 'HEAD remains attached after every checkout-and-rebase variant',
    file: 'test/unit/commands/branchContextMenu.fixes.test.ts',
    markers: [
      // The `describe` block that owns the post-checkout-and-rebase guarantee.
      'BranchContextMenuCommands — checkoutAndRebase',
      // The happy-path test name that asserts the branch carries through.
      'happy path: checkout then rebaseBranch',
    ],
  },
  {
    id: 'L4',
    summary: "A commit's outgoing same-lane stroke uses the commit's own lane color",
    file: 'test/unit/utils/graphRenderer.test.ts',
    markers: [
      // Same-lane lines bypass the bezier path — pins the renderer's
      // segment selection logic that L4 depends on.
      'same-lane lines should not produce bezier curves',
      // Color-palette pinned to >= 8 distinct entries (L4 depends on
      // `getColumnColor` returning a per-lane color, not a constant).
      'should return at least 8 distinct colors',
      // Phase 2 renderer pin: same-lane vertical stroke equals the
      // node's own lane color (the green-node-on-blue-line guard).
      'same-lane vertical stroke color',
    ],
  },
  {
    id: 'L5',
    summary: 'Repo selector identity is by normalized path, not array index',
    file: 'test/unit/services/repositorySelectorIdentity.test.ts',
    markers: [
      // The index-shifting reload guard — the core L5 behavior.
      'selector survives a repo-list rebuild that shifts indexes',
    ],
  },
  {
    id: 'L9',
    summary: 'Off-window parents emit a dashed same-lane stub, no new lane',
    file: 'test/unit/utils/commitGraph.test.ts',
    markers: [
      // The algorithm-level dashed-stub pin from Phase 1a.
      /off-window parent/,
    ],
  },
  {
    id: 'L11',
    summary: 'Detached-HEAD SHA is read via getDetachedHeadSha(), never label parsing',
    file: 'test/unit/audit/detachedHeadShaSource.audit.test.ts',
    markers: ['getDetachedHeadSha'],
  },
  {
    id: 'L14',
    summary: 'Repo identity comparisons go through normalizeRepoPath',
    file: 'test/unit/utils/normalizeRepoPath.test.ts',
    markers: [
      // Windows drive-case collapse — the canonical L14 case.
      'collapses upper- and lower-case drive letters',
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoRoot(): string {
  // This audit lives at test/unit/audit/lanesPinned.audit.test.ts.
  // Walk four levels up to land at the repo root.
  return path.resolve(__dirname, '../../..');
}

function readIfExists(absPath: string): string | undefined {
  try {
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return undefined;
  }
}

function describeMarker(marker: string | RegExp): string {
  if (marker instanceof RegExp) {
    return `/${marker.source}/${marker.flags}`;
  }
  return JSON.stringify(marker);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Meta-audit — catalogued invariants are pinned by named tests', () => {
  for (const pin of INVARIANT_PINS) {
    describe(`${pin.id} — ${pin.summary}`, () => {
      const absFile = path.join(repoRoot(), pin.file);

      it(`pin file exists: ${pin.file}`, () => {
        const exists = fs.existsSync(absFile);
        assert.ok(
          exists,
          [
            `Invariant ${pin.id} pin file is missing: ${pin.file}.`,
            `If the file was renamed, update the INVARIANT_PINS table in this audit`,
            `(it is the canonical coverage matrix for these invariants).`,
            `If the file was deleted, restore the test — see`,
            `docs/adr/ADR-013-graph-data-model-invariants.md (invariant ${pin.id}: ${pin.summary}) for the rule.`,
          ].join('\n  ')
        );
      });

      for (const marker of pin.markers) {
        it(`pin marker present: ${describeMarker(marker)}`, () => {
          const contents = readIfExists(absFile);
          assert.ok(
            contents !== undefined,
            `Cannot check marker because the pin file is missing: ${pin.file}`
          );
          const matched =
            marker instanceof RegExp ? marker.test(contents) : contents.includes(marker);
          assert.ok(
            matched,
            [
              `Invariant ${pin.id} pin marker missing in ${pin.file}:`,
              `  marker: ${describeMarker(marker)}`,
              `If the test was intentionally renamed, update INVARIANT_PINS in this audit.`,
              `If the test was deleted, restore it — see`,
              `docs/adr/ADR-013-graph-data-model-invariants.md (invariant ${pin.id}: ${pin.summary}) for the rule.`,
            ].join('\n  ')
          );
        });
      }
    });
  }
});
