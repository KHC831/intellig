/**
 * Task 13.14 — Property 17: Migration boundary discipline.
 *
 * **Validates: Requirement 12.6**
 *
 * Property 17 (per design.md §"Property 17: Migration boundary discipline"
 * and Requirement 12.6):
 *
 *   For every file outside the allowed write boundary
 *   (`src/`, `scripts/restructure/`, the four guard scripts in
 *   `scripts/` listed in 9.6, and `docs/adr/`), running `migrate.mjs`
 *   SHALL leave the file byte-identical to its pre-run state.
 *   Specifically, `package.json`, `.mocharc.json`, `tsconfig.json`,
 *   `README.md`, and all files under `docs/parity/` and `media/`
 *   SHALL be byte-identical pre and post.
 *
 * The migration script's first-line defence for this requirement is
 * its `assertWriteAllowed(absPath, repoRoot)` function in
 * `scripts/restructure/migrate.mjs`: every code path that performs a
 * filesystem write (rename, ts-morph save, barrel regeneration,
 * git-restore rollback) routes its target path through this gate
 * before touching disk. The function logs a FAIL and exits 1 on
 * violation; this test exercises its boolean predicate directly.
 *
 * ### Why we duplicate the boundary-check logic
 *
 * `scripts/restructure/migrate.mjs` invokes its own `main()` at
 * module-load time, so importing the script from a test process
 * would execute the migration on the live working tree. The
 * boundary-check constants and predicate logic are therefore
 * duplicated here in a TESTABLE form (returning a `boolean` instead
 * of calling `process.exit`). A future refactor could extract them
 * into a shared `scripts/restructure/boundary.mjs` module that both
 * `migrate.mjs` and this test consume; today they live in two places
 * and any change to the script's allow/deny lists MUST be mirrored
 * here.
 *
 * ### Sub-properties exercised
 *
 * - **17a (Allow-list completeness):** every `from` and every `to`
 *   path in `plan.json` MUST pass `assertWriteAllowed`. The
 *   migration's union of write targets is exactly the plan's path
 *   set (renames operate on `to`; ts-morph saves operate on `to` for
 *   moved files and `from === to` for identity entries; the
 *   regenerated services barrel is already `src/services/index.ts`,
 *   which is in the plan).
 *
 * - **17b (Deny-list rejection):** every path the spec calls out by
 *   name (the four root files and any path under `docs/parity/` or
 *   `media/`) MUST be rejected.
 *
 * - **17c (Outside-roots rejection):** any repo-relative path that
 *   does not start with one of the allowed directory prefixes and
 *   is not one of the five permitted guard-script names MUST be
 *   rejected.
 *
 * @see scripts/restructure/migrate.mjs → `assertWriteAllowed`
 * @see Requirement 12.6 — the spec's enumerated boundary
 * @see design.md → "Migration script architecture" §5
 * @see design.md → "Property 17: Migration boundary discipline"
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';

// ─── Plan fixture ───────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PLAN_PATH = path.join(REPO_ROOT, 'scripts', 'restructure', 'plan.json');

interface IMove {
  readonly from: string;
  readonly to: string;
  readonly rationale: string;
}

interface IPlan {
  readonly version: number;
  readonly moves: readonly IMove[];
  readonly barrelShim: { readonly path: string; readonly strategy: string };
}

function loadPlan(): IPlan {
  const raw = fs.readFileSync(PLAN_PATH, 'utf8');
  return JSON.parse(raw) as IPlan;
}

// ─── Boundary-check duplication (mirrors migrate.mjs `assertWriteAllowed`) ──
//
// The constants below are a verbatim duplication of those declared in
// `scripts/restructure/migrate.mjs` (see the "Boundary discipline" section
// of that file). A future refactor could promote them into a shared
// `scripts/restructure/boundary.mjs` module so this test imports the same
// source the script uses; today migrate.mjs auto-invokes `main()` on
// load and is not test-importable, so duplication is the pragmatic
// choice. Any modification to the script's allow/deny lists MUST be
// reflected here, otherwise this test silently drifts out of sync.

/**
 * The set of guard scripts under `scripts/` that the migration may
 * legitimately touch. Matches `ALLOWED_GUARD_SCRIPTS` in migrate.mjs.
 * Both the pre-rename (`check-output-channel-test-surface.sh`) and
 * post-rename (`check-test-only-surface.sh`) names are listed so the
 * boundary check passes both before and after task 15.1 lands.
 */
const ALLOWED_GUARD_SCRIPTS: ReadonlySet<string> = new Set<string>([
  'scripts/check-action-toasts-sanitized.sh',
  'scripts/check-quickpick-state-no-error.sh',
  'scripts/check-watcher-families-registered.mjs',
  'scripts/check-output-channel-test-surface.sh',
  'scripts/check-test-only-surface.sh',
]);

/** Allowed directory prefixes (POSIX form, trailing `/`). */
const ALLOWED_DIR_PREFIXES: readonly string[] = [
  'src/',
  'scripts/restructure/',
  'docs/adr/',
];

/** Specifically denied exact-match repo-relative paths. */
const SPECIFICALLY_DENIED_FILES: ReadonlySet<string> = new Set<string>([
  'package.json',
  '.mocharc.json',
  'tsconfig.json',
  'README.md',
]);

/** Specifically denied directory prefixes (POSIX form, trailing `/`). */
const SPECIFICALLY_DENIED_PREFIXES: readonly string[] = [
  'docs/parity/',
  'media/',
];

function toPosix(p: string): string {
  if (path.sep === '/') return p;
  return p.split(path.sep).join('/');
}

/**
 * Boolean test-equivalent of `assertWriteAllowed` in migrate.mjs.
 * The script's version logs FAIL and calls `process.exit(1)` on
 * violation; here we return `false` so the property test can assert
 * the predicate result without crashing the test process.
 *
 * The decision tree mirrors the script exactly:
 *
 *   1. If the repo-relative POSIX form starts with `..` or `/`, the
 *      path escapes the repo root → reject.
 *   2. If the repo-relative path matches a specifically-denied exact
 *      file → reject.
 *   3. If the repo-relative path equals a denied prefix (with or
 *      without trailing slash) or starts with one → reject.
 *   4. If the repo-relative path starts with any allowed prefix →
 *      accept.
 *   5. If the repo-relative path matches a permitted guard-script →
 *      accept.
 *   6. Otherwise → reject (fall-through "outside allowed roots").
 *
 * @param absPath absolute filesystem path the script intends to write
 * @param repoRoot absolute path to the repo root
 * @returns true when the write is permitted; false otherwise
 */
function isWriteAllowed(absPath: string, repoRoot: string): boolean {
  const relPosix = toPosix(path.relative(repoRoot, absPath));

  // 0) Outside the repo root entirely.
  if (relPosix.startsWith('..') || relPosix.startsWith('/')) {
    return false;
  }

  // 1) Specifically denied exact-match paths.
  if (SPECIFICALLY_DENIED_FILES.has(relPosix)) {
    return false;
  }

  // 2) Specifically denied directory prefixes (with or without trailing /).
  for (const prefix of SPECIFICALLY_DENIED_PREFIXES) {
    if (relPosix === prefix.slice(0, -1) || relPosix.startsWith(prefix)) {
      return false;
    }
  }

  // 3) Allowed directory prefixes.
  for (const prefix of ALLOWED_DIR_PREFIXES) {
    if (relPosix.startsWith(prefix)) return true;
  }

  // 4) Allowed individual guard-script paths.
  if (ALLOWED_GUARD_SCRIPTS.has(relPosix)) return true;

  // 5) Fall-through: outside allowed roots.
  return false;
}

// ─── Generators ─────────────────────────────────────────────────────────────

/**
 * Path-segment alphabet: lowercase ASCII, digits, dash, underscore,
 * and dot. Avoids `/` so we can join segments deterministically and
 * avoids characters that would change the path's leading prefix
 * (which would invalidate the "outside-roots" intent of the
 * arbitrary).
 */
const PATH_SEG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789-_.';

const pathSegmentArb: fc.Arbitrary<string> = fc
  .stringOf(fc.constantFrom(...PATH_SEG_ALPHABET.split('')), {
    minLength: 1,
    maxLength: 16,
  })
  // Reject `.` and `..` so generated trees can't escape upward.
  .filter((s) => s !== '.' && s !== '..');

/**
 * A multi-segment relative path of 1-4 segments, joined with `/`.
 * E.g. `'foo'`, `'foo/bar.txt'`, `'a/b/c/d.ts'`.
 */
const relativeSubpathArb: fc.Arbitrary<string> = fc
  .array(pathSegmentArb, { minLength: 1, maxLength: 4 })
  .map((segs) => segs.join('/'));

/**
 * Repo-relative paths that should be rejected by the
 * "specifically denied directory prefixes" branch.
 *
 * For each denied prefix (e.g. `'docs/parity/'`), generates:
 *   - the prefix's stripped form (`'docs/parity'` — bare directory)
 *   - the prefix itself (`'docs/parity/'` — trailing-slash form;
 *     after `path.relative` round-tripping this is normalized away,
 *     but we test the predicate directly so it still hits the
 *     `relPosix.startsWith(prefix)` arm)
 *   - the prefix concatenated with a random sub-path.
 */
const deniedPrefixPathArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...SPECIFICALLY_DENIED_PREFIXES), relativeSubpathArb)
  .chain(([prefix, sub]) =>
    fc.constantFrom(prefix.slice(0, -1), prefix + sub)
  );

/**
 * Repo-relative paths that should be rejected because they fall
 * "outside allowed roots" — i.e. they are not under `src/`,
 * `scripts/restructure/`, `docs/adr/`, are not one of the 5
 * permitted guard-script names, and are not specifically denied
 * (those have their own arbitrary).
 *
 * The arbitrary picks a top-level "outside" prefix (an existing
 * top-level directory or a synthesized fresh one) and appends a
 * random sub-path. The post-generation filter then drops any value
 * that accidentally matches an allowed/denied case so each iteration
 * targets the fall-through branch precisely.
 */
const outsideRootsTopArb: fc.Arbitrary<string> = fc.constantFrom(
  'images',
  'resources',
  '.github',
  'node_modules',
  'out',
  'build',
  'docs', // bare 'docs' is fine as long as it's not docs/adr/, docs/parity/
  'scripts', // bare scripts/<other> is fine as long as not the 5 guard names or scripts/restructure/
);

const outsideRootsPathArb: fc.Arbitrary<string> = fc
  .tuple(outsideRootsTopArb, relativeSubpathArb)
  .map(([top, sub]) => `${top}/${sub}`)
  .filter((p) => {
    // Exclude any value that accidentally hits an allowed prefix,
    // a denied prefix, an allowed guard-script, or a specifically
    // denied file. Such a value would still be a correct boundary
    // test but in a different branch — and we want this arbitrary
    // to exercise the fall-through specifically.
    if (SPECIFICALLY_DENIED_FILES.has(p)) return false;
    if (ALLOWED_GUARD_SCRIPTS.has(p)) return false;
    for (const a of ALLOWED_DIR_PREFIXES) {
      if (p.startsWith(a)) return false;
    }
    for (const d of SPECIFICALLY_DENIED_PREFIXES) {
      if (p === d.slice(0, -1) || p.startsWith(d)) return false;
    }
    return true;
  });

/**
 * Random repo-relative file at the repo root level (no subdirectory)
 * that is NOT one of the four specifically-denied root files.
 * Exercises the fall-through reject for "loose root files".
 */
const looseRootFileArb: fc.Arbitrary<string> = pathSegmentArb.filter(
  (s) => !SPECIFICALLY_DENIED_FILES.has(s)
);

// ─── Property tests ─────────────────────────────────────────────────────────

describe('Migration boundary discipline (Property 17 / Requirement 12.6)', () => {
  let plan: IPlan;
  let allPlanPaths: readonly string[];

  before(() => {
    plan = loadPlan();
    // Union of every `from` and every `to` — the migration's full
    // set of write targets. Identity entries dedupe naturally via
    // the Set.
    const set = new Set<string>();
    for (const m of plan.moves) {
      set.add(m.from);
      set.add(m.to);
    }
    allPlanPaths = [...set].sort();
    // Sanity check on the fixture itself: a non-empty plan is
    // required for the property to be meaningful.
    assert.ok(
      allPlanPaths.length > 0,
      'plan.json contains zero moves — fixture is broken',
    );
  });

  // ─── 17a: allow-list completeness ─────────────────────────────────────────

  describe('17a: allow-list completeness — every plan path passes assertWriteAllowed', () => {
    it('Property 17a: ∀ path P ∈ plan.moves.{from, to} . assertWriteAllowed(P) === true', () => {
      fc.assert(
        fc.property(fc.constantFrom(...allPlanPaths), (planPath) => {
          const abs = path.resolve(REPO_ROOT, planPath);
          assert.strictEqual(
            isWriteAllowed(abs, REPO_ROOT),
            true,
            `Requirement 12.6 violation: plan path '${planPath}' was ` +
              `rejected by assertWriteAllowed. Every \`from\` and \`to\` ` +
              `path in scripts/restructure/plan.json must be a permitted ` +
              `write target — otherwise the migration script cannot ` +
              `execute its own plan.`,
          );
        }),
        // Drive the property across every plan path. The plan has
        // ~200+ entries; numRuns=plan size lets fast-check pick each
        // value at least once with high probability.
        { numRuns: allPlanPaths.length },
      );
    });

    it('17a (regenerated services barrel): src/services/index.ts is permitted', () => {
      // The barrel-regeneration phase writes to src/services/index.ts.
      // It is also a plan entry (identity move), so the assertion
      // above already covers it; this is a named smoke test that
      // surfaces the specific path on regression rather than a
      // shrunk plan-iteration counterexample.
      const abs = path.resolve(REPO_ROOT, 'src', 'services', 'index.ts');
      assert.strictEqual(
        isWriteAllowed(abs, REPO_ROOT),
        true,
        'Requirement 12.6 violation: src/services/index.ts (the ' +
          'regenerated services barrel) was rejected by ' +
          'assertWriteAllowed. The barrel-regeneration phase in ' +
          'migrate.mjs would fail to run.',
      );
    });
  });

  // ─── 17b: deny-list rejection ─────────────────────────────────────────────

  describe('17b: deny-list rejection — specifically forbidden paths are rejected', () => {
    it('Property 17b (named files): each of {package.json, .mocharc.json, tsconfig.json, README.md} is rejected', () => {
      const denied = [...SPECIFICALLY_DENIED_FILES];
      fc.assert(
        fc.property(fc.constantFrom(...denied), (relPath) => {
          const abs = path.resolve(REPO_ROOT, relPath);
          assert.strictEqual(
            isWriteAllowed(abs, REPO_ROOT),
            false,
            `Requirement 12.6 violation: '${relPath}' is specifically ` +
              `forbidden by Requirement 12.6 but was accepted by ` +
              `assertWriteAllowed. The migration script must never ` +
              `modify package.json, .mocharc.json, tsconfig.json, or ` +
              `README.md.`,
          );
        }),
        { numRuns: denied.length },
      );
    });

    it('Property 17b (denied prefixes): every path under docs/parity/ or media/ is rejected', () => {
      fc.assert(
        fc.property(deniedPrefixPathArb, (relPath) => {
          const abs = path.resolve(REPO_ROOT, relPath);
          assert.strictEqual(
            isWriteAllowed(abs, REPO_ROOT),
            false,
            `Requirement 12.6 violation: '${relPath}' lies under a ` +
              `specifically forbidden directory (docs/parity/ or ` +
              `media/) but was accepted by assertWriteAllowed.`,
          );
        }),
        { numRuns: 200 },
      );
    });

    it('17b (concrete examples): docs/parity/git-log-graph.md and media/codicon.ttf are rejected', () => {
      // Pin the exact paths the spec calls out by name in
      // Requirement 12.6, so a regression that special-cases the
      // generic prefix without covering these still fails.
      const examples = [
        'docs/parity/git-log-graph.md',
        'docs/parity/repo-states.md',
        'docs/parity/accessibility.md',
        'media/codicon.ttf',
      ];
      for (const ex of examples) {
        const abs = path.resolve(REPO_ROOT, ex);
        assert.strictEqual(
          isWriteAllowed(abs, REPO_ROOT),
          false,
          `Requirement 12.6 violation: '${ex}' is one of the named ` +
            `forbidden files but was accepted by assertWriteAllowed.`,
        );
      }
    });
  });

  // ─── 17c: outside-roots rejection ─────────────────────────────────────────

  describe('17c: outside-roots rejection — paths outside allowed roots are rejected', () => {
    it('Property 17c (subtree): random paths under non-allowed top-level directories are rejected', () => {
      fc.assert(
        fc.property(outsideRootsPathArb, (relPath) => {
          const abs = path.resolve(REPO_ROOT, relPath);
          assert.strictEqual(
            isWriteAllowed(abs, REPO_ROOT),
            false,
            `Requirement 12.6 violation: '${relPath}' is outside ` +
              `the allowed write roots (src/, scripts/restructure/, ` +
              `docs/adr/, and the 5 permitted guard scripts) but was ` +
              `accepted by assertWriteAllowed.`,
          );
        }),
        { numRuns: 300 },
      );
    });

    it('Property 17c (loose root files): random repo-root files (other than the 4 named-deny ones) are rejected', () => {
      fc.assert(
        fc.property(looseRootFileArb, (relPath) => {
          const abs = path.resolve(REPO_ROOT, relPath);
          assert.strictEqual(
            isWriteAllowed(abs, REPO_ROOT),
            false,
            `Requirement 12.6 violation: loose repo-root file ` +
              `'${relPath}' was accepted by assertWriteAllowed. ` +
              `Only files under src/, scripts/restructure/, docs/adr/, ` +
              `or the 5 permitted guard scripts may be written.`,
          );
        }),
        { numRuns: 100 },
      );
    });

    it('Property 17c (outside repo root): paths that escape via `..` or absolute prefix are rejected', () => {
      // `path.relative(repoRoot, absPath)` returns a `..`-prefixed
      // string when absPath is outside repoRoot. Build such cases by
      // resolving relative to the parent of REPO_ROOT.
      const parent = path.dirname(REPO_ROOT);
      fc.assert(
        fc.property(relativeSubpathArb, (sub) => {
          const abs = path.resolve(parent, sub);
          // Skip the rare collision where `path.resolve(parent, sub)`
          // falls back inside REPO_ROOT (e.g. sub starts with
          // path.basename(REPO_ROOT)).
          if (abs === REPO_ROOT || abs.startsWith(REPO_ROOT + path.sep)) {
            return;
          }
          assert.strictEqual(
            isWriteAllowed(abs, REPO_ROOT),
            false,
            `Requirement 12.6 violation: path '${abs}' lies outside ` +
              `the repo root '${REPO_ROOT}' but was accepted by ` +
              `assertWriteAllowed.`,
          );
        }),
        { numRuns: 100 },
      );
    });

    it('17c (concrete examples): scripts/<non-allowed>.sh and other-top-level dirs are rejected', () => {
      // Pin the most likely regression vectors — paths just outside
      // the allow-list that a careless edit might accidentally let
      // through.
      const examples = [
        'scripts/some-other-script.sh',
        'scripts/check-100-gate.sh', // exists in the tree but is NOT in the allow-list
        'scripts/prepublish-guard.mjs', // exists but not in allow-list
        'scripts/propertyStress.mjs', // exists but not in allow-list
        'images/icon.png',
        'resources/git-icon-branch.svg',
        '.github/workflows/ci.yml',
        'LICENSE',
        'CHANGELOG.md',
        'CONTRIBUTING.md',
        'SECURITY.md',
        'docs/testing.md', // 'docs/' prefix exists, but only docs/adr/ is allowed
      ];
      for (const ex of examples) {
        const abs = path.resolve(REPO_ROOT, ex);
        assert.strictEqual(
          isWriteAllowed(abs, REPO_ROOT),
          false,
          `Requirement 12.6 violation: '${ex}' is outside the allowed ` +
            `write roots but was accepted by assertWriteAllowed.`,
        );
      }
    });
  });

  // ─── Cross-checks ─────────────────────────────────────────────────────────

  describe('cross-checks: allow/deny lists are mutually disjoint', () => {
    it('no allowed guard-script lies under a specifically denied prefix', () => {
      for (const guard of ALLOWED_GUARD_SCRIPTS) {
        for (const denied of SPECIFICALLY_DENIED_PREFIXES) {
          assert.ok(
            !guard.startsWith(denied),
            `Allow/deny conflict: guard script '${guard}' lies under ` +
              `denied prefix '${denied}'.`,
          );
        }
        assert.ok(
          !SPECIFICALLY_DENIED_FILES.has(guard),
          `Allow/deny conflict: guard script '${guard}' is also in ` +
            `the specifically-denied files set.`,
        );
      }
    });

    it('no allowed directory prefix overlaps with a specifically denied prefix', () => {
      for (const allowed of ALLOWED_DIR_PREFIXES) {
        for (const denied of SPECIFICALLY_DENIED_PREFIXES) {
          assert.ok(
            !allowed.startsWith(denied) && !denied.startsWith(allowed),
            `Allow/deny conflict: prefixes '${allowed}' and '${denied}' ` +
              `overlap.`,
          );
        }
      }
    });

    it('every allowed guard-script is a path under scripts/ (sanity)', () => {
      for (const guard of ALLOWED_GUARD_SCRIPTS) {
        assert.ok(
          guard.startsWith('scripts/') &&
            !guard.startsWith('scripts/restructure/'),
          `Guard script '${guard}' must live directly under scripts/ ` +
            `(scripts/restructure/ is covered by ALLOWED_DIR_PREFIXES).`,
        );
      }
    });
  });
});
