/**
 * Unit tests for guard-script tracked-path conformance with the
 * restructure plan (Requirements 9.6, 11.6, 11.7; tasks 15.3 / 15.4 /
 * 15.5).
 *
 * Four structural CI guards under `scripts/` reference source-file
 * paths under `src/` directly:
 *
 *   1. `scripts/check-action-toasts-sanitized.sh`
 *      — references `src/utils/gitError.ts` (the sanitiser the guard
 *      delegates to; mentioned in its maintenance contract).
 *   2. `scripts/check-quickpick-state-no-error.sh`
 *      — TARGETS array names the three QuickPick view-state interface
 *      files (per ADR-006).
 *   3. `scripts/check-watcher-families-registered.mjs`
 *      — TARGET_FILE constant pins `src/services/GitService.ts`
 *      (per ADR-008).
 *   4. `scripts/check-output-channel-test-surface.sh`
 *      (or `scripts/check-test-only-surface.sh` post-task-15.1 rename)
 *      — DEFINITION_FILE constant pins `src/utils/outputChannel.ts`.
 *
 * Each tracked path appears in `plan.json` either as an identity entry
 * (`from === to`) — meaning the migration leaves it in place — or as
 * a non-identity move (`from !== to`) — meaning task-15.x updates the
 * guard alongside the rename. Either way, the contract this test pins
 * is the same:
 *
 *   For every `src/...` path-shaped string `P` extracted from a guard
 *   script, `P` MUST appear in `plan.json` (as a `from` or a `to`)
 *   AND `P`'s current on-disk form (pre- or post-migration, whichever
 *   matches the working tree) MUST exist.
 *
 * Why "either pre- or post-migration is OK": at the moment task 13.10
 * lands, task 14.2 (the actual migration run) and tasks 15.3 / 15.4 /
 * 15.5 (guard-path updates) have not executed. The guards still
 * reference pre-migration paths (e.g. `src/services/GitService.ts`),
 * and the source files still live at those paths. After 14.2 runs,
 * the same guards will reference the post-migration paths (e.g.
 * `src/git-core/GitService.ts`), and the source files will live at
 * those paths. This test passes against both states because the
 * union-set membership check accepts either form.
 *
 * Out of scope:
 *
 *   - The behavioural side of each guard (its bug-class detection
 *     logic) is covered by the per-guard regression specs
 *     (`outputChannelTestSurface.test.ts`, the per-site TL-72 specs,
 *     etc.). This test only pins path conformance.
 *   - The migration script's actual rewriting of these guards (when
 *     task 14.2 lands) is covered by `migrateBoundary.property.test.ts`
 *     (Property 17 / Requirement 12.6) and `migrateBasic.test.ts`
 *     (task 13.8). Here we only check that the plan + guards are
 *     consistent with whichever state the working tree is in.
 *   - The action-toasts guard does not maintain a hard-coded TARGETS
 *     array of call sites — it walks `src/` dynamically with
 *     `find src -type f -name '*.ts'`. Its only `src/...` reference
 *     is `src/utils/gitError.ts` in the maintenance-contract
 *     comments. That single path is the one asserted below.
 */

import '../../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const PLAN_PATH = path.join(REPO_ROOT, 'scripts', 'restructure', 'plan.json');

interface Move {
  from: string;
  to: string;
  rationale: string;
}

interface BarrelShim {
  path: string;
  strategy: string;
}

interface Plan {
  version: number;
  moves: Move[];
  barrelShim: BarrelShim;
}

function loadPlan(): Plan {
  const raw = fs.readFileSync(PLAN_PATH, 'utf8');
  return JSON.parse(raw) as Plan;
}

/**
 * Extract every `src/...` path-shaped string from a guard's content.
 *
 * The regex matches:
 *   - leading `src/` segment,
 *   - one or more path segments (alphanumeric + underscore + dash +
 *     dot for nested directory or filename use),
 *   - terminating extension `.ts`, `.tsx`, `.mjs`, or `.js`.
 *
 * It is anchored to a `src/` prefix on purpose: the guards mention
 * other paths (`scripts/...`, `docs/adr/...`) that are out of scope
 * for `plan.json` (which only governs files under `src/`).
 *
 * False positives (e.g. a path inside a glob like the test-suite
 * spec glob with star-star slash) are filtered by the bounded
 * character class — the regex will not cross a star or whitespace.
 */
function extractSrcPaths(content: string): string[] {
  const PATH_REGEX = /src\/[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:ts|tsx|mjs|js)/g;
  const seen = new Set<string>();
  for (const match of content.matchAll(PATH_REGEX)) {
    seen.add(match[0]);
  }
  return [...seen].sort();
}

/**
 * Resolve a guard-tracked source path against the plan + working
 * tree. Accepts either pre-migration shape (`P` is a `from` and
 * exists on disk at `P`) or post-migration shape (`P` is a `to` and
 * exists on disk at `P`). Identity entries collapse the two arms.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` on
 * failure with an actionable message.
 */
function resolveGuardTrackedPath(
  p: string,
  plan: Plan
): { ok: true } | { ok: false; reason: string } {
  const planEntry = plan.moves.find((m) => m.from === p || m.to === p);
  if (!planEntry) {
    return {
      ok: false,
      reason:
        `guard tracks path "${p}" but plan.json has no entry naming ` +
        `it (neither as a \`from\` nor as a \`to\`); add an entry to ` +
        `plan.json or remove the path from the guard`,
    };
  }

  // The path must resolve on disk in *some* form. We accept either
  // the path itself (pre-migration: `from` arm; identity entries)
  // or the migrated counterpart (post-migration: `to` arm).
  const exactAbs = path.join(REPO_ROOT, p);
  if (fs.existsSync(exactAbs)) {
    return { ok: true };
  }

  // The exact path does not exist; check the migrated counterpart.
  // If `p` is the `from` of a non-identity move, the file may now
  // be at `to`. If `p` is the `to` of a non-identity move, the
  // file may still be at `from` (pre-migration).
  if (p === planEntry.from && planEntry.from !== planEntry.to) {
    const toAbs = path.join(REPO_ROOT, planEntry.to);
    if (fs.existsSync(toAbs)) {
      return { ok: true };
    }
  }
  if (p === planEntry.to && planEntry.from !== planEntry.to) {
    const fromAbs = path.join(REPO_ROOT, planEntry.from);
    if (fs.existsSync(fromAbs)) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    reason:
      `guard tracks path "${p}" which appears in plan.json (entry: ` +
      `${planEntry.from} -> ${planEntry.to}) but neither the ` +
      `pre-migration nor the post-migration location exists on disk`,
  };
}

/**
 * Read a guard script's content if it exists; return `null` if the
 * file is absent. Used for the OutputChannel guard whose name
 * changes when task 15.1 lands.
 */
function readGuardIfExists(rel: string): string | null {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) {
    return null;
  }
  return fs.readFileSync(abs, 'utf8');
}

/** Read a guard script that MUST exist; assert otherwise. */
function readRequiredGuard(rel: string): string {
  const content = readGuardIfExists(rel);
  assert.ok(
    content !== null,
    `required guard script not found at ${rel} — has it been moved or renamed?`
  );
  return content;
}

describe('scripts/check-*.{sh,mjs} — tracked-path conformance with plan.json', () => {
  let plan: Plan;

  before(() => {
    plan = loadPlan();
  });

  describe('check-action-toasts-sanitized.sh (Requirement 9.6)', () => {
    const GUARD_REL = 'scripts/check-action-toasts-sanitized.sh';

    it('exists', () => {
      assert.ok(
        readGuardIfExists(GUARD_REL) !== null,
        `${GUARD_REL} is missing — the action-toast sanitisation guard ` +
          `(TL-72) is part of the structural-guard floor and must remain ` +
          `present`
      );
    });

    it('every src/ path-shape it references resolves (pre- or post-migration)', () => {
      const content = readRequiredGuard(GUARD_REL);
      const tracked = extractSrcPaths(content);
      assert.ok(
        tracked.length > 0,
        `expected ${GUARD_REL} to reference at least one src/ path ` +
          `(its sanitiser-delegation comment names src/utils/gitError.ts); ` +
          `the regex extracted none — has the guard's content drifted?`
      );
      for (const p of tracked) {
        const result = resolveGuardTrackedPath(p, plan);
        assert.ok(result.ok, result.ok ? '' : `${GUARD_REL}: ${result.reason}`);
      }
    });
  });

  describe('check-quickpick-state-no-error.sh (Requirement 11.6)', () => {
    const GUARD_REL = 'scripts/check-quickpick-state-no-error.sh';

    it('exists', () => {
      assert.ok(
        readGuardIfExists(GUARD_REL) !== null,
        `${GUARD_REL} is missing — the QuickPick view-state guard ` +
          `(TL-74 / ADR-006) is part of the structural-guard floor and ` +
          `must remain present`
      );
    });

    it('every src/ path-shape it references resolves (pre- or post-migration)', () => {
      const content = readRequiredGuard(GUARD_REL);
      const tracked = extractSrcPaths(content);
      // The TARGETS array hard-codes three view-state interface files;
      // the regex must find at least those three.
      assert.ok(
        tracked.length >= 3,
        `expected ${GUARD_REL} to reference at least 3 src/ paths ` +
          `(the three QuickPick view-state interfaces); the regex ` +
          `extracted ${tracked.length}: ${JSON.stringify(tracked)}`
      );
      for (const p of tracked) {
        const result = resolveGuardTrackedPath(p, plan);
        assert.ok(result.ok, result.ok ? '' : `${GUARD_REL}: ${result.reason}`);
      }
    });
  });

  describe('check-watcher-families-registered.mjs (Requirement 11.7)', () => {
    const GUARD_REL = 'scripts/check-watcher-families-registered.mjs';

    it('exists', () => {
      assert.ok(
        readGuardIfExists(GUARD_REL) !== null,
        `${GUARD_REL} is missing — the watcher-families registration ` +
          `guard (TL-91 / ADR-008) is part of the structural-guard floor ` +
          `and must remain present`
      );
    });

    it('every src/ path-shape it references resolves (pre- or post-migration)', () => {
      const content = readRequiredGuard(GUARD_REL);
      const tracked = extractSrcPaths(content);
      // The TARGET_FILE constant pins one path; comments may reference
      // it again. Either way, the regex must find at least one.
      assert.ok(
        tracked.length >= 1,
        `expected ${GUARD_REL} to reference at least one src/ path ` +
          `(TARGET_FILE pins src/services/GitService.ts pre-migration, ` +
          `src/git-core/GitService.ts post-migration); the regex ` +
          `extracted ${tracked.length}: ${JSON.stringify(tracked)}`
      );
      for (const p of tracked) {
        const result = resolveGuardTrackedPath(p, plan);
        assert.ok(result.ok, result.ok ? '' : `${GUARD_REL}: ${result.reason}`);
      }
    });
  });

  describe(
    'check-output-channel-test-surface.sh / check-test-only-surface.sh ' +
      '(Requirement 9.6, task 15.1)',
    () => {
      // Task 15.1 renames `check-output-channel-test-surface.sh` to
      // `check-test-only-surface.sh` and broadens it to also forbid
      // production references to `__resetLoggerForTest`. Pre-rename the
      // first name is on disk; post-rename the second is. The test
      // reads whichever is present.
      const PRE_RENAME = 'scripts/check-output-channel-test-surface.sh';
      const POST_RENAME = 'scripts/check-test-only-surface.sh';

      it('exactly one of the two names exists on disk', () => {
        const pre = readGuardIfExists(PRE_RENAME) !== null;
        const post = readGuardIfExists(POST_RENAME) !== null;
        assert.ok(
          pre || post,
          `Neither ${PRE_RENAME} nor ${POST_RENAME} exists. The TL-58 ` +
            `(pre-rename) / task-15.1 (post-rename) guard pins ` +
            `__resetOutputChannelForTest (and post-rename also ` +
            `__resetLoggerForTest) as test-only seams; the migration ` +
            `must keep one of the two names live.`
        );
        // Either-or, not both: a stale rename would leave both files
        // and split the contract across two scripts.
        assert.ok(
          !(pre && post),
          `Both ${PRE_RENAME} and ${POST_RENAME} exist; task 15.1 ` +
            `should rename the guard, not duplicate it. Remove the ` +
            `stale copy.`
        );
      });

      it('every src/ path-shape the live guard references resolves', () => {
        const content = readGuardIfExists(POST_RENAME) ?? readGuardIfExists(PRE_RENAME);
        assert.ok(
          content !== null,
          `Neither pre- nor post-rename guard exists; cannot extract ` + `tracked paths`
        );
        const tracked = extractSrcPaths(content);
        // The DEFINITION_FILE constant pins one path; comments
        // reference it as well. Either way, the regex must find at
        // least one.
        assert.ok(
          tracked.length >= 1,
          `expected the live test-only-surface guard to reference at ` +
            `least one src/ path (DEFINITION_FILE pins ` +
            `src/utils/outputChannel.ts); the regex extracted ` +
            `${tracked.length}: ${JSON.stringify(tracked)}`
        );
        for (const p of tracked) {
          const result = resolveGuardTrackedPath(p, plan);
          assert.ok(result.ok, result.ok ? '' : `live test-only-surface guard: ${result.reason}`);
        }
      });
    }
  );

  describe('extractSrcPaths helper sanity', () => {
    // The regex is the load-bearing component of this whole test —
    // a permissive regex would spuriously pass; a too-strict one
    // would silently miss tracked paths. These sanity assertions
    // pin the regex's expected inputs/outputs against known shapes
    // so a future refactor cannot quietly weaken it.

    it('extracts a simple path under src/', () => {
      assert.deepStrictEqual(extractSrcPaths('see src/utils/gitError.ts for details'), [
        'src/utils/gitError.ts',
      ]);
    });

    it('extracts a deeply-nested path with hyphens and underscores', () => {
      assert.deepStrictEqual(extractSrcPaths('TARGET = "src/services/interfaces/IShelfView.ts"'), [
        'src/services/interfaces/IShelfView.ts',
      ]);
    });

    it('extracts multiple distinct paths from one input', () => {
      assert.deepStrictEqual(
        extractSrcPaths('a:src/foo/Bar.ts; b:src/baz/Qux.ts; c:src/foo/Bar.ts'),
        // Deduped + sorted; the duplicate `src/foo/Bar.ts` collapses.
        ['src/baz/Qux.ts', 'src/foo/Bar.ts']
      );
    });

    it('does not extract a glob like src/test/**/*.ts as a literal path', () => {
      // The bounded character class stops at `*` so a glob is not
      // mistaken for a real file path.
      const out = extractSrcPaths('files: src/test/**/*.ts');
      // The regex may capture a subset like `src/test/` not present
      // because the char class does not include `*`; the assertion
      // only requires the literal glob is not in the result.
      assert.ok(
        !out.includes('src/test/**/*.ts'),
        `expected glob "src/test/**/*.ts" not to be extracted as a ` +
          `literal path; got ${JSON.stringify(out)}`
      );
    });

    it('extracts .mjs paths (script extension)', () => {
      assert.deepStrictEqual(extractSrcPaths('see src/scripts/foo.mjs'), ['src/scripts/foo.mjs']);
    });

    it('does not extract path-like text without a recognised extension', () => {
      // The terminating `.(ts|tsx|mjs|js)` group is mandatory; bare
      // directory references should not be captured.
      assert.deepStrictEqual(extractSrcPaths('the src/services/ directory holds…'), []);
    });
  });
});
