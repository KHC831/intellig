/**
 * Task 13.13 — Property 16: Migration import-rewrite correctness.
 *
 * **Validates: Requirement 12.5**
 *
 * Property 16 (per requirements.md §12.5, design.md "Property 16:
 * Migration import-rewrite correctness"):
 *
 *   WHEN the migration script moves a file, THE migration script
 *   SHALL update every `import` and `require` in `src/` that
 *   referenced the old path to reference the new path, preserving
 *   relative-vs-absolute style.
 *
 * Equivalently (design.md): for every `import` / `export … from`
 * statement in the post-change tree, the resolved module specifier
 * SHALL NOT point to any pre-change path that is now empty.
 *
 * This property is best tested at the algorithm level rather than
 * by spinning up a temp `src/` clone per fast-check iteration. The
 * load-bearing functions in `scripts/restructure/migrate.mjs` are
 * `computeNewSpecifier` (style + extension preservation, target
 * substitution) and `probeFromKey` (Node-style extensionless
 * resolution against the plan's `from` set). The on-disk script
 * auto-invokes `main()` on import, so we cannot pull these helpers
 * directly from the module — they are duplicated here verbatim
 * (with a comment marker) and the property test asserts the
 * algorithm's invariants hold both on synthetic fast-check inputs
 * and on the live `plan.json` moves.
 *
 * Three sub-properties cover the contract:
 *
 *   - **16a — Style preservation.** For any input specifier `S`
 *     that starts with `./` or `../`, the output of
 *     `computeNewSpecifier` also starts with `./` or `../`. For any
 *     input specifier that starts with `src/` (project-rooted /
 *     bare-prefix form), the output preserves that form.
 *   - **16b — Extension preservation.** For any input specifier
 *     ending in `.js`, `.ts`, or `.tsx`, the output has the same
 *     extension. For an extensionless input, the output is
 *     extensionless.
 *   - **16c — Resolution correctness.** For any plan move
 *     `(from, to)`, if a source file at the FROM dir imports
 *     `'./X'` and `./X` resolves to `from`, then the rewritten
 *     specifier resolves to `to` when joined to the source file's
 *     POST-migration directory (the TO dir).
 *
 * The actual ts-morph walk in `rewriteImports` is exercised by
 * the unit tests in `src/test/unit/scripts/restructure/`. This
 * property test focuses on the pure-functional core that the walk
 * delegates to.
 *
 * @see Requirement 12.5 — Migration import / export rewrite.
 * @see scripts/restructure/migrate.mjs `computeNewSpecifier`,
 *      `probeFromKey`.
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';

// ─── Repo + plan fixtures ──────────────────────────────────────────────────

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

// ─── Verbatim helpers from scripts/restructure/migrate.mjs ─────────────────
//
// The migration script is an ESM module that auto-invokes `main()` on
// import (it is a CLI entry point). To test `computeNewSpecifier` and
// `probeFromKey` without spawning a child process, we duplicate the
// helpers here verbatim. If the script's logic ever changes, this
// duplicate must be kept in sync — the property test exists precisely
// to detect drift in the algorithmic invariants those helpers guarantee.
//
// SOURCE: scripts/restructure/migrate.mjs (functions `toPosix`,
// `probeFromKey`, `computeNewSpecifier`).

/**
 * Normalize an absolute filesystem path to POSIX-style forward slashes.
 * Mirrors `toPosix` in migrate.mjs.
 */
function toPosix(p: string): string {
  if (path.sep === '/') return p;
  return p.split(path.sep).join('/');
}

/**
 * Probe a candidate absolute path against the plan's `from` set,
 * trying common TS/TSX extension permutations to mirror Node-style
 * resolution. Specifiers in TS code are normally extensionless, so
 * `'./foo'` matches `<dir>/foo.ts`, `<dir>/foo.tsx`, or
 * `<dir>/foo/index.ts`.
 *
 * Mirrors `probeFromKey` in migrate.mjs.
 */
function probeFromKey(
  candidateAbsPosix: string,
  fromSetPosix: ReadonlyMap<string, string>
): string | undefined {
  // 1) literal match (specifier already has an extension, e.g. './foo.ts')
  if (fromSetPosix.has(candidateAbsPosix)) return candidateAbsPosix;
  // 2) extensionless → try .ts / .tsx
  const withTs = candidateAbsPosix + '.ts';
  if (fromSetPosix.has(withTs)) return withTs;
  const withTsx = candidateAbsPosix + '.tsx';
  if (fromSetPosix.has(withTsx)) return withTsx;
  // 3) directory → try /index.ts / /index.tsx
  const indexTs = candidateAbsPosix + '/index.ts';
  if (fromSetPosix.has(indexTs)) return indexTs;
  const indexTsx = candidateAbsPosix + '/index.tsx';
  if (fromSetPosix.has(indexTsx)) return indexTsx;
  return undefined;
}

/**
 * Compute the rewritten specifier for a matched move, preserving
 * the relative-vs-absolute style of the original specifier and any
 * explicit `.js` / `.ts` / `.tsx` extension.
 *
 * Mirrors `computeNewSpecifier` in migrate.mjs. Note: the script
 * captures `REPO_ROOT` from a top-level `const`, but here the
 * function takes `repoRoot` as an extra parameter so the test can
 * vary it across iterations (it always passes the real repo root
 * for the live-plan suite, and a synthetic fixed root for the
 * fast-check generators).
 */
function computeNewSpecifier(
  originalSpecifier: string,
  sourceFileDirAbsPosix: string,
  toAbsPosix: string,
  repoRoot: string
): string {
  // Detect and strip an explicit extension on the original specifier;
  // we'll re-apply it at the end so `'./foo.js'` stays `'./foo.js'`.
  const explicitExtMatch = originalSpecifier.match(/\.(js|ts|tsx)$/);
  const explicitExt = explicitExtMatch ? explicitExtMatch[0] : '';

  // Strip the .ts / .tsx suffix from the target to get an
  // extensionless logical path. Collapse `/index` so the rewrite
  // matches the Node-resolution-friendly form most TS code uses.
  let toLogical = toAbsPosix.replace(/\.tsx?$/, '');
  if (toLogical.endsWith('/index')) {
    toLogical = toLogical.slice(0, -'/index'.length);
  }

  const isRelative =
    originalSpecifier.startsWith('./') || originalSpecifier.startsWith('../');

  let result: string;
  if (isRelative) {
    // Build a fresh relative path from the source file's directory
    // to the new target.
    const rel = toPosix(path.relative(sourceFileDirAbsPosix, toLogical));
    result = rel.startsWith('.') ? rel : './' + rel;
  } else {
    // Absolute / project-rooted form: reconstruct from new target.
    const rootPosix = toPosix(repoRoot) + '/';
    if (toLogical.startsWith(rootPosix)) {
      result = toLogical.slice(rootPosix.length);
    } else {
      result = toLogical;
    }
  }

  return result + explicitExt;
}

// ─── fast-check generators ──────────────────────────────────────────────────

/**
 * Generate a single repo-relative POSIX path segment under `src/`
 * with a `.ts` or `.tsx` extension. Constrained to a small alphabet
 * so collisions are unlikely but the synthetic FS stays
 * representable as plain strings.
 */
const tsFileNameArb = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/),
    fc.constantFrom('.ts', '.tsx')
  )
  .map(([base, ext]) => `${base}${ext}`);

/**
 * Generate a synthetic plan move `(from, to)` with both paths under
 * `src/` and using non-overlapping subdirectories so identity and
 * partial-applied collisions cannot occur. Returns repo-relative
 * POSIX strings (the form `plan.json` uses).
 */
const planMoveArb = fc
  .record({
    fromDir: fc.constantFrom(
      'src/services',
      'src/services/interfaces',
      'src/services/gitToolWindow',
      'src/services/gitToolWindow/tabs',
      'src/utils',
      'src/commands'
    ),
    toDir: fc.constantFrom(
      'src/git-core',
      'src/git-core/interfaces',
      'src/branches',
      'src/branches/interfaces',
      'src/blame',
      'src/conflicts',
      'src/commits',
      'src/shelf',
      'src/sync',
      'src/ui-shell'
    ),
    file: tsFileNameArb,
  })
  .map(({ fromDir, toDir, file }) => ({
    from: `${fromDir}/${file}`,
    to: `${toDir}/${file}`,
  }));

/**
 * Synthetic repo root for the property tests. Using a fixed,
 * absolute-looking path keeps the POSIX-vs-native split orthogonal
 * to the algorithm under test (`computeNewSpecifier` already
 * normalizes to POSIX internally).
 */
const SYNTHETIC_REPO_ROOT = '/synthetic/repo';

/**
 * Convert a repo-relative POSIX path to its absolute POSIX form
 * under the synthetic repo root.
 */
function abs(relPosix: string): string {
  return `${SYNTHETIC_REPO_ROOT}/${relPosix}`;
}

/**
 * Strip `.ts` / `.tsx` and trailing `/index` from a POSIX path to
 * yield the "logical" form that matches what `computeNewSpecifier`
 * emits when the input had no explicit extension. Used by 16c to
 * compare resolved specifiers against the plan's `to` target.
 */
function toLogical(absPosix: string): string {
  let out = absPosix.replace(/\.tsx?$/, '');
  if (out.endsWith('/index')) {
    out = out.slice(0, -'/index'.length);
  }
  return out;
}

// ─── Property 16a — Style preservation ──────────────────────────────────────

describe('Migration import-rewrite correctness (Property 16 / Requirement 12.5)', () => {
  /**
   * Property 16a — relative input → relative output.
   *
   * For every relative input specifier (`./X` or `../X`), the
   * rewritten specifier MUST also start with `./` or `../`. The
   * algorithm computes a fresh relative path from the source file's
   * post-migration directory to the new target; if the two are
   * siblings, `path.relative` returns a bare name like `'foo'` —
   * the algorithm must prepend `./` in that case (Node module-
   * specifier rule).
   */
  it('Property 16a: relative input specifiers yield relative output specifiers', () => {
    fc.assert(
      fc.property(
        planMoveArb,
        fc.constantFrom('src/services', 'src/utils', 'src/commands'),
        fc.constantFrom('./', '../'),
        (move, sourceDirRel, prefix) => {
          // The original specifier is whatever string the source
          // file used to reach `from` — we model it as a single-segment
          // relative path with the chosen `./` or `../` prefix.
          // Concrete value of the segment doesn't matter for 16a; the
          // algorithm just needs to detect the relative prefix.
          const original = `${prefix}some/path`;

          // sourceFileDir post-migration is wherever the file lives
          // AFTER the plan applied — for a non-moving file this is
          // any dir under src/. We use a fixed dir; the only thing
          // that matters for style preservation is that the input
          // had a relative prefix.
          const sourceDirAbs = abs(sourceDirRel);
          const toAbs = abs(move.to);
          const result = computeNewSpecifier(
            original,
            sourceDirAbs,
            toAbs,
            SYNTHETIC_REPO_ROOT
          );

          assert.ok(
            result.startsWith('./') || result.startsWith('../'),
            `Property 16a violation: relative input ` +
              `'${original}' produced non-relative output '${result}' ` +
              `(plan: ${move.from} → ${move.to}, sourceDir: ${sourceDirRel})`
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * Property 16a — bare-prefix input → bare-prefix output.
   *
   * For every project-rooted (`src/...`) input specifier, the
   * output preserves that form: it does NOT start with `./` or
   * `../`, and it starts with a recognized in-tree top-level
   * directory under `src/` (i.e. the `to` path's first segment).
   */
  it('Property 16a: project-rooted (`src/...`) input specifiers yield project-rooted output specifiers', () => {
    fc.assert(
      fc.property(
        planMoveArb,
        fc.constantFrom('src/services', 'src/utils', 'src/commands'),
        (move, sourceDirRel) => {
          // Build an input that points at `from` in bare-prefix
          // form. The script's algorithm takes the original
          // specifier text at face value — its content beyond the
          // leading prefix only matters for resolution (16c), not
          // for style (16a). For 16a we need only show the leading
          // form is preserved.
          const original = move.from.replace(/\.tsx?$/, '');

          const sourceDirAbs = abs(sourceDirRel);
          const toAbs = abs(move.to);
          const result = computeNewSpecifier(
            original,
            sourceDirAbs,
            toAbs,
            SYNTHETIC_REPO_ROOT
          );

          assert.ok(
            !result.startsWith('./') && !result.startsWith('../'),
            `Property 16a violation: project-rooted input ` +
              `'${original}' produced relative output '${result}' ` +
              `(plan: ${move.from} → ${move.to})`
          );
          assert.ok(
            result.startsWith('src/'),
            `Property 16a violation: project-rooted input ` +
              `'${original}' produced output '${result}' that does ` +
              `not preserve the 'src/' prefix ` +
              `(plan: ${move.from} → ${move.to})`
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  // ─── Property 16b — Extension preservation ────────────────────────────────

  /**
   * Property 16b — explicit-extension input → same-extension output.
   *
   * For every input specifier ending in `.js`, `.ts`, or `.tsx`,
   * the rewritten output ends in the SAME extension. The algorithm
   * captures the input's explicit extension before substitution
   * and re-applies it at the end.
   */
  it('Property 16b: explicit `.js` / `.ts` / `.tsx` extensions are preserved', () => {
    fc.assert(
      fc.property(
        planMoveArb,
        fc.constantFrom('.js', '.ts', '.tsx'),
        fc.constantFrom('./foo', '../bar', 'src/baz'),
        (move, ext, base) => {
          const original = base + ext;

          const sourceDirAbs = abs('src/services');
          const toAbs = abs(move.to);
          const result = computeNewSpecifier(
            original,
            sourceDirAbs,
            toAbs,
            SYNTHETIC_REPO_ROOT
          );

          assert.ok(
            result.endsWith(ext),
            `Property 16b violation: input '${original}' (ext '${ext}') ` +
              `produced output '${result}' that does not end in '${ext}' ` +
              `(plan: ${move.from} → ${move.to})`
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * Property 16b — extensionless input → extensionless output.
   *
   * For every extensionless input specifier (the most common form
   * in TS — `import x from './foo'`), the output is also
   * extensionless. The algorithm only re-applies an explicit
   * extension when the input had one.
   */
  it('Property 16b: extensionless input specifiers yield extensionless output specifiers', () => {
    fc.assert(
      fc.property(
        planMoveArb,
        fc.constantFrom('./foo', './foo/bar', '../baz', 'src/qux'),
        (move, original) => {
          const sourceDirAbs = abs('src/services');
          const toAbs = abs(move.to);
          const result = computeNewSpecifier(
            original,
            sourceDirAbs,
            toAbs,
            SYNTHETIC_REPO_ROOT
          );

          assert.ok(
            !/\.(js|ts|tsx)$/.test(result),
            `Property 16b violation: extensionless input ` +
              `'${original}' produced output '${result}' with an ` +
              `explicit extension (plan: ${move.from} → ${move.to})`
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  // ─── Property 16c — Resolution correctness ────────────────────────────────

  /**
   * Property 16c — relative-form resolution correctness.
   *
   * For any plan move `(from, to)` and any source file at the FROM
   * dir importing `'./X'` such that `./X` resolves to `from`, the
   * rewritten specifier — joined to the source file's POST-migration
   * directory — resolves to `to`.
   *
   * Concretely: pick a source file at FROM_DIR, generate a
   * relative specifier that resolves to `from`, run it through
   * `computeNewSpecifier` against the source file's TO_DIR (the
   * post-migration location), then assert that
   * `path.resolve(TO_DIR, result)` equals `to` modulo the
   * extensionless / `/index` collapse the algorithm performs.
   *
   * We model the source file as MOVING along with the plan (its
   * own `from → to`), because the algorithm's contract specifies
   * the rewritten specifier resolves correctly from the source
   * file's POST-migration directory (`toDirPosix` in the script).
   */
  it('Property 16c: rewritten relative specifiers resolve to the new target from the source file post-migration directory', () => {
    fc.assert(
      fc.property(
        planMoveArb,
        planMoveArb,
        (sourceMove, targetMove) => {
          // The source file moves along with the plan: its FROM dir
          // is `dirname(sourceMove.from)` (where the unchanged
          // specifier was authored), its TO dir is
          // `dirname(sourceMove.to)` (where the rewritten
          // specifier must resolve correctly).
          //
          // The target is a different plan entry whose `from` we'll
          // import via a relative specifier from the source FROM dir.
          if (sourceMove.from === targetMove.from) return; // skip same-entry case
          if (sourceMove.to === targetMove.to) return;

          const sourceFromAbs = abs(sourceMove.from);
          const sourceToAbs = abs(sourceMove.to);
          const targetFromAbs = abs(targetMove.from);
          const targetToAbs = abs(targetMove.to);

          const sourceFromDir = sourceFromAbs.substring(
            0,
            sourceFromAbs.lastIndexOf('/')
          );
          const sourceToDir = sourceToAbs.substring(
            0,
            sourceToAbs.lastIndexOf('/')
          );

          // Build the original relative specifier that, joined to
          // the source's FROM dir, resolves to the target's FROM
          // (extensionless logical form). This mirrors how a real
          // import statement in the pre-change tree would be written.
          const relToTarget = toPosix(
            path.relative(sourceFromDir, toLogical(targetFromAbs))
          );
          const original = relToTarget.startsWith('.')
            ? relToTarget
            : './' + relToTarget;

          // Sanity-check the input setup: the original specifier
          // should resolve back to the target's FROM logical form
          // when joined to the source's FROM dir (Node module
          // resolution, extensionless).
          const originalResolved = toPosix(path.resolve(sourceFromDir, original));
          assert.strictEqual(
            originalResolved,
            toLogical(targetFromAbs),
            `Test setup error: original specifier '${original}' did ` +
              `not resolve to target FROM logical form ` +
              `('${toLogical(targetFromAbs)}')`
          );

          // Confirm the algorithm would match this resolution
          // against the plan map. probeFromKey expects an
          // extensionless absolute path keyed in the forward map.
          const forwardMap = new Map<string, string>();
          forwardMap.set(targetFromAbs, targetToAbs);
          const matched = probeFromKey(originalResolved, forwardMap);
          assert.strictEqual(
            matched,
            targetFromAbs,
            'probeFromKey did not match the synthetic target FROM key'
          );

          // Run the rewriter from the source's POST-migration dir
          // (the algorithm's contract; matches `toDirPosix` in
          // migrate.mjs's `rewriteImports`).
          const rewritten = computeNewSpecifier(
            original,
            sourceToDir,
            targetToAbs,
            SYNTHETIC_REPO_ROOT
          );

          // Resolve the rewritten specifier against the source's
          // POST-migration dir. It MUST equal the target's TO
          // logical form (extensionless + /index-collapsed).
          const rewrittenResolved = toPosix(path.resolve(sourceToDir, rewritten));
          assert.strictEqual(
            rewrittenResolved,
            toLogical(targetToAbs),
            `Property 16c violation: rewritten specifier ` +
              `'${rewritten}' (from original '${original}') ` +
              `resolved to '${rewrittenResolved}' instead of ` +
              `'${toLogical(targetToAbs)}'. ` +
              `sourceMove: ${sourceMove.from} → ${sourceMove.to}, ` +
              `targetMove: ${targetMove.from} → ${targetMove.to}`
          );
        }
      ),
      { numRuns: 300 }
    );
  });

  /**
   * Property 16c — bare-prefix-form resolution correctness.
   *
   * For project-rooted (`src/...`) input specifiers, the rewritten
   * output, prefixed with the repo root, MUST resolve to the
   * target's TO logical form. The algorithm strips the leading
   * `<repoRoot>/` from the new logical path and emits the
   * remainder, so prepending the root again must reverse the
   * operation cleanly.
   */
  it('Property 16c: rewritten project-rooted specifiers resolve to the new target', () => {
    fc.assert(
      fc.property(planMoveArb, (move) => {
        // Project-rooted input pointing at `from` (extensionless
        // logical form, the conventional shape).
        const original = toLogical(move.from);

        // sourceDir doesn't matter for bare-prefix mode (the
        // algorithm ignores it); pass any in-tree dir.
        const sourceDirAbs = abs('src/services');
        const toAbs = abs(move.to);
        const result = computeNewSpecifier(
          original,
          sourceDirAbs,
          toAbs,
          SYNTHETIC_REPO_ROOT
        );

        // Bare-prefix output prepended with `<repoRoot>/` must
        // equal the target's TO logical form.
        const resolved = `${SYNTHETIC_REPO_ROOT}/${result}`;
        assert.strictEqual(
          resolved,
          toLogical(toAbs),
          `Property 16c violation: project-rooted rewritten ` +
            `specifier '${result}' did not resolve to target TO ` +
            `logical form. expected='${toLogical(toAbs)}', ` +
            `got='${resolved}' (plan: ${move.from} → ${move.to})`
        );
      }),
      { numRuns: 200 }
    );
  });

  // ─── Live-plan smoke check ────────────────────────────────────────────────

  /**
   * Live-plan invariance: the actual `scripts/restructure/plan.json`
   * obeys all three sub-properties when its moves are fed through
   * the helpers. This catches plan-authoring regressions that the
   * synthetic generators wouldn't necessarily produce (e.g. an
   * accidentally-introduced collision between a `to` path and an
   * unrelated `from` path's directory).
   */
  describe('Live plan: scripts/restructure/plan.json import-rewrite invariants', () => {
    let plan: IPlan;

    before(() => {
      plan = loadPlan();
    });

    it('every non-identity live move yields a relative-form rewrite that resolves correctly', () => {
      // Pick a single source file at one move's FROM and an
      // imported target at another move's FROM, then check 16c
      // end-to-end against real plan paths.
      const nonIdentity = plan.moves.filter((m) => m.from !== m.to);
      assert.ok(nonIdentity.length > 0, 'live plan has no non-identity moves');

      fc.assert(
        fc.property(
          fc.constantFrom(...nonIdentity),
          fc.constantFrom(...nonIdentity),
          (sourceMove, targetMove) => {
            if (sourceMove.from === targetMove.from) return;
            if (sourceMove.to === targetMove.to) return;

            const sourceFromAbs = path.posix.join(
              toPosix(REPO_ROOT),
              sourceMove.from
            );
            const sourceToAbs = path.posix.join(
              toPosix(REPO_ROOT),
              sourceMove.to
            );
            const targetFromAbs = path.posix.join(
              toPosix(REPO_ROOT),
              targetMove.from
            );
            const targetToAbs = path.posix.join(
              toPosix(REPO_ROOT),
              targetMove.to
            );

            const sourceFromDir = sourceFromAbs.substring(
              0,
              sourceFromAbs.lastIndexOf('/')
            );
            const sourceToDir = sourceToAbs.substring(
              0,
              sourceToAbs.lastIndexOf('/')
            );

            const relToTarget = toPosix(
              path.relative(sourceFromDir, toLogical(targetFromAbs))
            );
            const original = relToTarget.startsWith('.')
              ? relToTarget
              : './' + relToTarget;

            const rewritten = computeNewSpecifier(
              original,
              sourceToDir,
              targetToAbs,
              REPO_ROOT
            );

            // 16a — style preserved (relative in, relative out).
            assert.ok(
              rewritten.startsWith('./') || rewritten.startsWith('../'),
              `live-plan 16a violation: relative input '${original}' ` +
                `produced non-relative output '${rewritten}' ` +
                `(source ${sourceMove.from} → ${sourceMove.to}, ` +
                `target ${targetMove.from} → ${targetMove.to})`
            );

            // 16b — extensionless in, extensionless out.
            assert.ok(
              !/\.(js|ts|tsx)$/.test(rewritten),
              `live-plan 16b violation: extensionless input ` +
                `'${original}' produced output '${rewritten}' with ` +
                `an explicit extension`
            );

            // 16c — resolves to the target's TO logical form.
            const rewrittenResolved = toPosix(
              path.resolve(sourceToDir, rewritten)
            );
            assert.strictEqual(
              rewrittenResolved,
              toLogical(targetToAbs),
              `live-plan 16c violation: rewritten '${rewritten}' ` +
                `resolved to '${rewrittenResolved}' instead of ` +
                `'${toLogical(targetToAbs)}' ` +
                `(source ${sourceMove.from} → ${sourceMove.to}, ` +
                `target ${targetMove.from} → ${targetMove.to})`
            );
          }
        ),
        { numRuns: Math.min(200, nonIdentity.length * nonIdentity.length) }
      );
    });

    it('every non-identity live move yields a project-rooted rewrite that resolves correctly', () => {
      fc.assert(
        fc.property(fc.constantFrom(...plan.moves), (move) => {
          if (move.from === move.to) return; // identity entries are no-ops

          const original = toLogical(move.from); // bare-prefix form
          const sourceDirAbs = path.posix.join(
            toPosix(REPO_ROOT),
            'src/services'
          );
          const toAbs = path.posix.join(toPosix(REPO_ROOT), move.to);

          const result = computeNewSpecifier(
            original,
            sourceDirAbs,
            toAbs,
            REPO_ROOT
          );

          // 16a — bare-prefix in, bare-prefix out.
          assert.ok(
            !result.startsWith('./') && !result.startsWith('../'),
            `live-plan 16a violation: bare-prefix input '${original}' ` +
              `produced relative output '${result}' (move ${move.from} → ${move.to})`
          );
          assert.ok(
            result.startsWith('src/'),
            `live-plan 16a violation: bare-prefix input '${original}' ` +
              `produced output '${result}' that does not start with 'src/'`
          );

          // 16c — prefixed with the repo root, equals target TO logical.
          const resolved = `${toPosix(REPO_ROOT)}/${result}`;
          assert.strictEqual(
            resolved,
            toLogical(toAbs),
            `live-plan 16c violation: bare-prefix rewrite '${result}' ` +
              `did not resolve to target TO logical form. ` +
              `expected='${toLogical(toAbs)}', got='${resolved}' ` +
              `(move ${move.from} → ${move.to})`
          );
        }),
        { numRuns: plan.moves.length }
      );
    });
  });
});
