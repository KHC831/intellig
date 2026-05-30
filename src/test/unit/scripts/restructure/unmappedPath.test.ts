/**
 * Unit test for the `assertNoUnmappedPaths` guard in
 * `scripts/restructure/migrate.mjs` (task 13.9 / Requirement 12.4).
 *
 * Contract under test (`migrate.mjs` lines 961-1051):
 *
 *   After processing the plan, walk `src/` and assert every
 *   regular file's repo-relative POSIX path appears as either a
 *   non-identity `to` or an identity-entry `from` in the plan. On
 *   any unmapped path, exit non-zero naming the offending path.
 *
 * Approach: this test pins the GUARD CONTRACT (the algorithm) by
 * replicating the guard's recursive-walk + set-membership logic
 * against a synthetic in-tmpdir fixture rather than spawning the
 * real `migrate.mjs` script. Three constraints drive this choice:
 *
 *   1. `migrate.mjs` auto-invokes `main()` on import, so
 *      `assertNoUnmappedPaths` is not directly importable.
 *   2. Real-mode execution of the script writes to the on-disk
 *      tree, which we deliberately avoid (this test must be safe
 *      to run repeatedly without mutating the workspace).
 *   3. The `--check` mode only reaches `assertNoUnmappedPaths`
 *      after every per-move invariant passes; the live tree is
 *      pre-migration, so `--check` aborts for "destination
 *      missing" reasons before the unmapped-path guard ever runs.
 *
 * The migration script's end-to-end behaviour (including the
 * literal exit-code + stderr formatting of the unmapped-path
 * failure) is the responsibility of task 13.8's
 * `migrateBasic.test.ts`. This file focuses on Requirement 12.4
 * specifically: the algorithmic invariant that a stray file under
 * `src/` is detected and named.
 *
 * The replica below mirrors the guard's algorithm verbatim:
 *
 *   - Build the union set
 *       valid = { m.to | m.from !== m.to } ∪ { m.from | m.from === m.to }
 *   - Recursively walk `<repoRoot>/src/`, skipping non-regular
 *     entries (symlinks, sockets) and the defensive
 *     `node_modules` / `out` / `build` directory names.
 *   - Normalize each file's repo-relative path to POSIX form.
 *   - Collect any path not in `valid` as an offender.
 *   - Sort offenders lexicographically for deterministic output.
 *
 * Any drift between the replica and the real guard would be
 * surfaced by the integration coverage above (task 13.8) and by
 * the property-based migration tests (task 13.12 / Property 15:
 * idempotence — which executes the real script).
 */

import '../../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface PlanMove {
  readonly from: string;
  readonly to: string;
}

interface Plan {
  readonly moves: readonly PlanMove[];
}

/**
 * Replica of `assertNoUnmappedPaths` from
 * `scripts/restructure/migrate.mjs`. Returns the sorted list of
 * offending repo-relative POSIX paths instead of calling
 * `process.exit` so the test can assert against them directly.
 *
 * Throws if `<repoRoot>/src/` does not exist (mirrors the guard's
 * "src/ directory missing" failure mode at lines 1027-1029 of the
 * real script — there it's a `console.error` + `process.exit(1)`).
 */
function findUnmappedPaths(plan: Plan, repoRoot: string): string[] {
  const validPaths = new Set<string>();
  for (const m of plan.moves) {
    if (m.from === m.to) {
      // Identity entry: include `from` (which equals `to`).
      validPaths.add(m.from);
    } else {
      // Non-identity move: only the `to` is valid post-migration.
      validPaths.add(m.to);
    }
  }

  const srcRoot = path.join(repoRoot, 'src');
  if (!fs.existsSync(srcRoot)) {
    throw new Error(`src/ directory missing at ${srcRoot}`);
  }

  const offenders: string[] = [];
  const SKIP_DIRS = new Set(['node_modules', 'out', 'build']);

  const walk = (dirAbs: string): void => {
    const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    for (const ent of entries) {
      const fullAbs = path.join(dirAbs, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) {
          continue;
        }
        walk(fullAbs);
        continue;
      }
      if (!ent.isFile()) {
        // Skip symlinks, sockets, FIFOs, etc. — the plan only
        // tracks regular files (matches the guard's contract at
        // lines 1014-1019).
        continue;
      }
      const relPosix = path.relative(repoRoot, fullAbs).split(path.sep).join('/');
      if (!validPaths.has(relPosix)) {
        offenders.push(relPosix);
      }
    }
  };

  walk(srcRoot);
  offenders.sort();
  return offenders;
}

/**
 * Build a fake repo under `<tmpRoot>/repo/`. Returns the absolute
 * `repoRoot` plus a cleanup function. Each created file is a small
 * non-empty TS stub (the guard only inspects directory entries via
 * `readdirSync` — content is irrelevant — but realistic fixtures
 * make debugging easier if the guard's contract ever drifts).
 */
function makeFakeRepo(filesUnderSrc: readonly string[]): {
  repoRoot: string;
  cleanup: () => void;
} {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unmapped-path-'));
  const repoRoot = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });

  for (const relPath of filesUnderSrc) {
    const fullPath = path.join(repoRoot, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, `// fixture: ${relPath}\n`, 'utf8');
  }

  return {
    repoRoot,
    cleanup: () => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe('scripts/restructure/migrate.mjs — unmapped-path guard (Requirement 12.4)', () => {
  describe('synthetic fixture: stray file under src/ not in the plan', () => {
    let repoRoot: string;
    let cleanup: () => void;

    beforeEach(() => {
      // Fixture: two plan-listed files plus one stray file.
      const fixture = makeFakeRepo([
        'src/topical-a/file-a.ts',
        'src/topical-b/file-b.ts',
        'src/stray/leftover.ts',
      ]);
      repoRoot = fixture.repoRoot;
      cleanup = fixture.cleanup;
    });

    afterEach(() => {
      cleanup();
    });

    it('returns the stray path as an offender (single file outside the plan)', () => {
      const plan: Plan = {
        moves: [
          // Both plan-listed files appear as identity entries
          // (`from === to`) — i.e. covered by the union set's
          // identity branch.
          { from: 'src/topical-a/file-a.ts', to: 'src/topical-a/file-a.ts' },
          { from: 'src/topical-b/file-b.ts', to: 'src/topical-b/file-b.ts' },
        ],
      };

      const offenders = findUnmappedPaths(plan, repoRoot);

      // The stray file's repo-relative POSIX path is the single
      // offender; no other file in the fixture falls outside the
      // plan's union set.
      assert.deepStrictEqual(
        offenders,
        ['src/stray/leftover.ts'],
        `expected exactly one offender (the stray file); got: ${JSON.stringify(offenders)}`
      );
    });

    it('returns the stray path as an offender when plan covers files via non-identity `to`', () => {
      // Same fixture, but this time the plan-listed files appear
      // as non-identity moves with the `to` matching the on-disk
      // path. This exercises the union set's non-identity branch.
      const plan: Plan = {
        moves: [
          {
            // Non-identity move: `from` is a pre-migration path
            // that is no longer on disk; `to` is the current on-
            // disk path (post-migration shape).
            from: 'src/services/file-a.ts',
            to: 'src/topical-a/file-a.ts',
          },
          {
            from: 'src/services/file-b.ts',
            to: 'src/topical-b/file-b.ts',
          },
        ],
      };

      const offenders = findUnmappedPaths(plan, repoRoot);

      assert.deepStrictEqual(
        offenders,
        ['src/stray/leftover.ts'],
        `expected exactly one offender (the stray file); got: ${JSON.stringify(offenders)}`
      );
    });

    it('reports every stray when multiple files lie outside the plan', () => {
      // Add a second stray file at a different path so the test
      // exercises the offender-collection (vs. fail-fast) shape:
      // the guard reports the *full set* in one pass.
      fs.mkdirSync(path.join(repoRoot, 'src/extra'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'src/extra/another.ts'), '// extra stray\n', 'utf8');

      const plan: Plan = {
        moves: [
          { from: 'src/topical-a/file-a.ts', to: 'src/topical-a/file-a.ts' },
          { from: 'src/topical-b/file-b.ts', to: 'src/topical-b/file-b.ts' },
        ],
      };

      const offenders = findUnmappedPaths(plan, repoRoot);

      // Sorted lexicographically (matches the real guard's
      // deterministic-output contract at lines 1037-1041 of
      // migrate.mjs).
      assert.deepStrictEqual(
        offenders,
        ['src/extra/another.ts', 'src/stray/leftover.ts'],
        `expected both stray files reported in sorted order; got: ${JSON.stringify(offenders)}`
      );
    });

    it('reports zero offenders when every src/ file is in the plan', () => {
      // Add the stray file as an identity entry so the plan now
      // covers every on-disk file. The guard must report no
      // offenders.
      const plan: Plan = {
        moves: [
          { from: 'src/topical-a/file-a.ts', to: 'src/topical-a/file-a.ts' },
          { from: 'src/topical-b/file-b.ts', to: 'src/topical-b/file-b.ts' },
          { from: 'src/stray/leftover.ts', to: 'src/stray/leftover.ts' },
        ],
      };

      const offenders = findUnmappedPaths(plan, repoRoot);

      assert.deepStrictEqual(
        offenders,
        [],
        `expected no offenders; got: ${JSON.stringify(offenders)}`
      );
    });
  });

  describe('walker rules', () => {
    it('skips nested node_modules / out / build directories', () => {
      // The guard defensively ignores these directory names
      // anywhere under `src/` so a build artefact that leaks in
      // does not trip the unmapped-path check (lines 999-1004 of
      // migrate.mjs). Build a fixture that contains files inside
      // each skip directory and assert none are flagged.
      const fixture = makeFakeRepo([
        'src/topical/file.ts',
        'src/node_modules/some-pkg/index.ts',
        'src/out/compiled.ts',
        'src/build/artifact.ts',
      ]);
      try {
        const plan: Plan = {
          moves: [{ from: 'src/topical/file.ts', to: 'src/topical/file.ts' }],
        };

        const offenders = findUnmappedPaths(plan, fixture.repoRoot);

        // Nothing should be flagged: the topical file is in the
        // plan, and the three skip-directory files are excluded
        // from the walk entirely.
        assert.deepStrictEqual(
          offenders,
          [],
          `expected the walker to skip node_modules/out/build; got: ${JSON.stringify(offenders)}`
        );
      } finally {
        fixture.cleanup();
      }
    });

    it('produces POSIX-form repo-relative paths regardless of host separator', () => {
      // The guard normalizes every walked file to POSIX form
      // (lines 1011-1013 of migrate.mjs) so the lookup matches
      // plan.json's `to` field shape. Verify a deeply-nested path
      // produces forward-slash-only output.
      const fixture = makeFakeRepo(['src/very/deeply/nested/path/file.ts', 'src/another/stray.ts']);
      try {
        const plan: Plan = {
          moves: [
            {
              from: 'src/very/deeply/nested/path/file.ts',
              to: 'src/very/deeply/nested/path/file.ts',
            },
          ],
        };

        const offenders = findUnmappedPaths(plan, fixture.repoRoot);

        assert.deepStrictEqual(offenders, ['src/another/stray.ts']);
        // Belt-and-braces: confirm no backslashes leaked into the
        // output (would happen if the walker forgot to normalize
        // on Windows).
        for (const p of offenders) {
          assert.ok(
            !p.includes('\\'),
            `offender contained a backslash: "${p}" — POSIX form expected`
          );
        }
      } finally {
        fixture.cleanup();
      }
    });
  });

  // Note: a "live src/ tree" positive-coverage case was considered
  // and rejected. The unmapped-path guard's contract is to verify
  // the *post-migration* tree (Requirement 12.4); the live tree at
  // the moment this task lands is pre-migration (files still at
  // their `from` paths, with non-identity `from` paths excluded
  // from the guard's union set). The integration coverage in
  // `migrateBasic.test.ts` (task 13.8) and the `--check` CI gate
  // both exercise the post-migration shape against the real script.
});
