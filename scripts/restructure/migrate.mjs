#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// migrate.mjs — `/src` topical-restructure migration driver.
//
// Spec: .kiro/specs/logging-and-src-restructure (design.md
// "Migration script architecture", Requirements 12.1, 12.2,
// 12.3, 14.5).
//
// This file is the *initial scaffold* (task 13.1). It validates
// `plan.json`, applies the rename phase, and (task 13.2) rewrites
// import / export / dynamic-import specifiers via ts-morph. It also
// (task 13.3) walks `src/` post-rewrite and rejects any regular
// file whose repo-relative path is not covered by the plan. Task
// 13.4 adds a pre-write boundary check (`assertWriteAllowed`) that
// every rename and every ts-morph save must clear; the check is a
// hard guardrail backing Requirement 12.6 in the script itself.
// Task 13.5 adds the `--check` and `--rollback` operating modes
// (`--dry-run` was already feature-complete after 13.1–13.4):
//
//   - --dry-run prints every planned action (rename + import
//     rewrite) without writing.
//   - --check verifies the working tree matches the
//     post-migration shape and exits 1 on any divergence; this
//     is the CI structural guard.
//   - --rollback restores every plan path from HEAD~1, but only
//     when the working tree is clean and HEAD~1 exists (i.e. the
//     migration commit is the only delta on top of HEAD~1).
//
// The remaining extension points are stubbed with TODO markers and
// added in later tasks:
//
//   - (none — task 13.7 was the final 13.x extension point and is
//     now implemented; see `runTscNoEmit` + `restoreTouchedPaths`.)
//
// Task 13.6 added the services-barrel regeneration phase
// (`regenerateServicesBarrel`): after `rewriteImports` has updated
// every specifier in `src/services/index.ts` to its new home, the
// barrel is re-emitted from a deterministic template — every
// `export ... from '<path>';` line is sorted lexicographically, the
// leading comment block is preserved, and the rebuilt content is
// written only when it differs from disk (idempotent on an
// already-canonical barrel). The Public_Service_API fingerprint set
// is verified unchanged before any write (Requirement 10.3, 10.4).
//
// Task 13.7 added the `tsc --noEmit` post-step and a git-restore
// rollback path (`runTscNoEmit` + `restoreTouchedPaths`): after the
// barrel is regenerated, the script invokes `npx tsc --noEmit` from
// the repo root. On exit code 0 the migration completes normally;
// on any non-zero exit the captured tsc output is dumped to stderr
// and every plan path (both `from` and `to`) is restored from HEAD
// via `git restore --source=HEAD --staged --worktree -- <path>`.
// The post-step is skipped in `--dry-run` (no writes happened, so
// there's nothing to verify or roll back). Requirements 9.5 and
// 13.6 — `tsc` enforces the no-cycle / no-regression invariants
// that property tests cannot statically check.
//
// Future write paths added by later tasks (15.x guard-script
// updates) MUST route through `assertWriteAllowed`. Task 13.6's
// services-barrel regeneration and task 13.7's git-restore rollback
// already do so. The check is a guardrail, not an enforcement
// layer — but it's the first line of defence that turns a
// Requirement 12.6 violation into an immediate, named-path failure
// rather than a silent escape.
//
// CLI:
//   node scripts/restructure/migrate.mjs [--dry-run] [--check] [--rollback]
//
// Exit codes:
//   0 — success (or no-op when plan is fully applied)
//   1 — validation failure or rename error
// ============================================================

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Project, SyntaxKind } from 'ts-morph';

// ---------- Path resolution (cwd-independent) ----------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// `plan.json` sits beside this script. Resolve relative to the
// script's own URL so the migration is invokable from any cwd
// (Requirement 12.1; matches the existing `propertyStress.mjs`
// and `prepublish-guard.mjs` pattern).
const PLAN_PATH = join(__dirname, 'plan.json');

// Repo root is two directories up: scripts/restructure/ → scripts/ → repo.
const REPO_ROOT = resolve(__dirname, '..', '..');

// ---------- CLI flag parsing ----------

/**
 * Parse argv into a flags object. Unknown flags are rejected
 * to fail fast on typos.
 *
 * @param {string[]} argv — argv past the node + script entries
 * @returns {{ dryRun: boolean, check: boolean, rollback: boolean }}
 */
function parseFlags(argv) {
  const flags = { dryRun: false, check: false, rollback: false };
  for (const arg of argv) {
    switch (arg) {
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--check':
        flags.check = true;
        break;
      case '--rollback':
        flags.rollback = true;
        break;
      default:
        console.error(`[migrate] FAIL: unknown flag "${arg}". ` +
          'Supported flags: --dry-run, --check, --rollback.');
        process.exit(1);
    }
  }
  return flags;
}

// ---------- Plan loading + validation ----------

/**
 * Read and parse the plan JSON. Failure modes (any of these →
 * exit 1):
 *   - file missing
 *   - invalid JSON
 *   - top-level shape wrong (`version !== 1`, missing `moves` or
 *     `barrelShim`)
 *
 * @returns {{ version: 1, moves: Array<{from:string,to:string,rationale?:string}>, barrelShim: object }}
 */
function loadPlan() {
  if (!existsSync(PLAN_PATH)) {
    console.error(`[migrate] FAIL: plan.json missing at ${PLAN_PATH}.`);
    process.exit(1);
  }
  let raw;
  try {
    raw = readFileSync(PLAN_PATH, 'utf8');
  } catch (e) {
    console.error(`[migrate] FAIL: cannot read plan.json: ${e && e.message ? e.message : e}.`);
    process.exit(1);
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (e) {
    console.error(`[migrate] FAIL: plan.json is not valid JSON: ${e && e.message ? e.message : e}.`);
    process.exit(1);
  }

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    console.error('[migrate] FAIL: plan.json top-level must be an object.');
    process.exit(1);
  }
  if (plan.version !== 1) {
    console.error(`[migrate] FAIL: plan.json version must be the integer 1; got ${JSON.stringify(plan.version)}.`);
    process.exit(1);
  }
  if (!Array.isArray(plan.moves)) {
    console.error('[migrate] FAIL: plan.json `moves` must be an array.');
    process.exit(1);
  }
  if (!plan.barrelShim || typeof plan.barrelShim !== 'object' || Array.isArray(plan.barrelShim)) {
    console.error('[migrate] FAIL: plan.json `barrelShim` must be an object.');
    process.exit(1);
  }

  // Per-entry shape: each move has string `from` and string `to`.
  for (let i = 0; i < plan.moves.length; i++) {
    const m = plan.moves[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      console.error(`[migrate] FAIL: plan.moves[${i}] must be an object.`);
      process.exit(1);
    }
    if (typeof m.from !== 'string' || m.from.length === 0) {
      console.error(`[migrate] FAIL: plan.moves[${i}].from must be a non-empty string.`);
      process.exit(1);
    }
    if (typeof m.to !== 'string' || m.to.length === 0) {
      console.error(`[migrate] FAIL: plan.moves[${i}].to must be a non-empty string.`);
      process.exit(1);
    }
  }

  return plan;
}

/**
 * Validate the plan against the working tree.
 *
 * Rules:
 *   - `from` paths are unique (no two entries share a source).
 *   - `to` paths are unique (no two entries share a destination).
 *   - For each non-identity move (from !== to):
 *       * (from exists AND to absent) — pending — OK
 *       * (from absent AND to exists) — already applied — OK
 *       * (from exists AND to exists) — partial-applied — REJECT
 *       * (from absent AND to absent) — missing source — REJECT
 *   - For each identity move (from === to):
 *       * the file at `from` must exist as a regular file — otherwise REJECT.
 *
 * Exits 1 on any violation.
 *
 * @param {{ moves: Array<{from:string,to:string}> }} plan
 */
function validatePlan(plan) {
  const errors = [];

  // Uniqueness checks.
  const seenFrom = new Map();
  const seenTo = new Map();
  for (let i = 0; i < plan.moves.length; i++) {
    const { from, to } = plan.moves[i];
    if (seenFrom.has(from)) {
      errors.push(
        `duplicate \`from\` path "${from}" at moves[${i}] (first seen at moves[${seenFrom.get(from)}]).`
      );
    } else {
      seenFrom.set(from, i);
    }
    if (seenTo.has(to)) {
      errors.push(
        `duplicate \`to\` path "${to}" at moves[${i}] (first seen at moves[${seenTo.get(to)}]).`
      );
    } else {
      seenTo.set(to, i);
    }
  }

  // Per-move filesystem state.
  for (let i = 0; i < plan.moves.length; i++) {
    const { from, to } = plan.moves[i];
    const fromAbs = resolve(REPO_ROOT, from);
    const toAbs = resolve(REPO_ROOT, to);
    const fromExists = existsSync(fromAbs) && isRegularFile(fromAbs);
    const toExists = existsSync(toAbs) && isRegularFile(toAbs);

    if (from === to) {
      // Identity entry: file must exist on disk.
      if (!fromExists) {
        errors.push(
          `identity move "${from}" → "${to}" but the file does not exist as a regular file.`
        );
      }
      continue;
    }

    if (fromExists && toExists) {
      // Partial-applied state — both endpoints present for the same
      // logical file. Forbidden because the script can't tell which
      // copy is canonical.
      errors.push(
        `partial-applied state at moves[${i}]: both "${from}" and "${to}" exist on disk. ` +
          'Resolve manually before re-running migrate.'
      );
      continue;
    }

    if (!fromExists && !toExists) {
      errors.push(
        `missing source at moves[${i}]: neither "${from}" nor "${to}" exists. ` +
          'The plan references a file not present in the tree.'
      );
      continue;
    }

    // Otherwise: pending (from exists, to absent) or already-applied
    // (from absent, to exists). Both are valid plan states.
  }

  if (errors.length > 0) {
    console.error('[migrate] FAIL: plan validation:');
    for (const e of errors) {
      console.error('  - ' + e);
    }
    process.exit(1);
  }
}

/**
 * @param {string} absPath
 * @returns {boolean}
 */
function isRegularFile(absPath) {
  try {
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}

// ---------- Boundary discipline (task 13.4 / Requirement 12.6) ----------

/**
 * The set of guard scripts under `scripts/` (i.e. NOT under
 * `scripts/restructure/`) that the migration may legitimately
 * touch. Everything else under `scripts/` is off-limits.
 *
 * Each entry is a repo-relative POSIX path. Both the renamed and
 * pre-rename names of the test-only-surface guard are listed so
 * the boundary check passes both before and after task 15.1's
 * rename of `check-output-channel-test-surface.sh` →
 * `check-test-only-surface.sh`.
 *
 * If task 15.x adds new guard scripts that the migration touches,
 * extend this set; the boundary check is the choke point.
 */
const ALLOWED_GUARD_SCRIPTS = Object.freeze(new Set([
  'scripts/check-action-toasts-sanitized.sh',
  'scripts/check-quickpick-state-no-error.sh',
  'scripts/check-watcher-families-registered.mjs',
  // Pre-rename name (current tree, pre-task 15.1).
  'scripts/check-output-channel-test-surface.sh',
  // Post-rename name (after task 15.1).
  'scripts/check-test-only-surface.sh',
]));

/**
 * Repo-relative POSIX prefixes (with trailing `/`) under which any
 * file is a permitted write target.
 */
const ALLOWED_DIR_PREFIXES = Object.freeze([
  'src/',
  'scripts/restructure/',
  'docs/adr/',
]);

/**
 * Explicitly forbidden paths. These are flagged with a clearer
 * "specifically denied" message so a violation surfaces the actual
 * file the spec calls out (Requirement 12.6) rather than the
 * generic "outside allowed roots" message.
 *
 * The `package.json` / `.mocharc.json` / `tsconfig.json` / `README.md`
 * entries are exact-match repo-relative paths. The `docs/parity/` and
 * `media/` entries are directory prefixes (POSIX form, trailing `/`).
 */
const SPECIFICALLY_DENIED_FILES = Object.freeze(new Set([
  'package.json',
  '.mocharc.json',
  'tsconfig.json',
  'README.md',
]));

const SPECIFICALLY_DENIED_PREFIXES = Object.freeze([
  'docs/parity/',
  'media/',
]);

/**
 * Pre-write boundary check (Requirement 12.6). Every code path in
 * this script that performs a filesystem write — `applyMoves`'
 * `mkdirSync` + `renameSync`, `rewriteImports`' `project.saveSync()`,
 * and any future write added by task 13.6 / 15.x — MUST route the
 * target path through this function before touching the disk.
 *
 * The check is a guardrail, not an enforcement layer: the
 * structural-guard tests (Property 17 in
 * `migrateBoundary.property.test.ts`) provide the formal coverage.
 * What this function buys us is a fail-fast at the script's own
 * boundary, with a clear, named-path message identifying the
 * Requirement 12.6 violation rather than a silent escape.
 *
 * Allowed write locations (Requirement 12.6 + design.md "Migration
 * script architecture" §5):
 *   - any path under `src/`
 *   - any path under `scripts/restructure/` (the script's own
 *     working directory; covers `plan.json` if a future task
 *     regenerates it)
 *   - the four guard scripts in `scripts/` listed in
 *     `ALLOWED_GUARD_SCRIPTS` (action-toasts, quickpick-state,
 *     watcher-families, and the renamed test-only-surface — both
 *     the pre-rename and post-rename names are accepted)
 *   - any path under `docs/adr/` (only when an ADR's path-list
 *     section names a moved file; the boundary check itself
 *     accepts every `docs/adr/**` path because per-ADR write
 *     selectivity is the caller's job)
 *
 * Specifically forbidden (the spec calls these out by name):
 *   - `package.json`, `.mocharc.json`, `tsconfig.json`, `README.md`
 *   - any path under `docs/parity/`
 *   - any path under `media/`
 *
 * Anything else outside the allowed roots is also rejected.
 *
 * On violation: prints a clear FAIL message naming the offending
 * path and citing Requirement 12.6, then exits with code 1. The
 * function does not throw (consistent with the rest of the
 * script's failure mode — `process.exit(1)` after a `console.error`).
 *
 * @param {string} absPath — absolute filesystem path the script
 *   intends to write
 * @param {string} repoRoot — absolute path to the repo root
 * @returns {void}
 */
function assertWriteAllowed(absPath, repoRoot) {
  // Compute the repo-relative POSIX form, which is the canonical
  // shape the allow-list uses (matches plan.json's `to` format).
  const relPosix = toPosix(relative(repoRoot, absPath));

  // Reject paths that escape the repo root entirely. `path.relative`
  // returns a `..`-prefixed string when `absPath` is outside
  // `repoRoot`; absolute paths on Windows can also produce odd
  // results. Either case is a hard reject.
  if (relPosix.startsWith('..') || relPosix.startsWith('/')) {
    console.error(
      `[migrate] FAIL: Requirement 12.6 violation — refusing to write ` +
        `outside the repository root.\n` +
        `  path: ${absPath}\n` +
        `  repo: ${repoRoot}`
    );
    process.exit(1);
  }

  // 1) Specifically denied exact-match paths (called out by name in
  //    Requirement 12.6).
  if (SPECIFICALLY_DENIED_FILES.has(relPosix)) {
    console.error(
      `[migrate] FAIL: Requirement 12.6 violation — refusing to write ` +
        `to specifically forbidden file "${relPosix}". ` +
        `The migration script must never modify package.json, .mocharc.json, ` +
        `tsconfig.json, or README.md.`
    );
    process.exit(1);
  }

  // 2) Specifically denied directory prefixes (also called out by
  //    name in Requirement 12.6).
  for (const prefix of SPECIFICALLY_DENIED_PREFIXES) {
    if (relPosix === prefix.slice(0, -1) || relPosix.startsWith(prefix)) {
      console.error(
        `[migrate] FAIL: Requirement 12.6 violation — refusing to write ` +
          `under specifically forbidden directory "${prefix}". ` +
          `Offending path: "${relPosix}".`
      );
      process.exit(1);
    }
  }

  // 3) Allowed directory prefixes (src/, scripts/restructure/,
  //    docs/adr/).
  for (const prefix of ALLOWED_DIR_PREFIXES) {
    if (relPosix.startsWith(prefix)) return;
  }

  // 4) Allowed individual guard-script paths.
  if (ALLOWED_GUARD_SCRIPTS.has(relPosix)) return;

  // Anything else falls through to the generic "outside allowed
  // roots" rejection.
  console.error(
    `[migrate] FAIL: Requirement 12.6 violation — write path is ` +
      `outside the allowed roots.\n` +
      `  offending path: "${relPosix}"\n` +
      `  allowed: src/**, scripts/restructure/**, docs/adr/**, ` +
      `or one of the four guard scripts under scripts/ ` +
      `(action-toasts, quickpick-state, watcher-families, ` +
      `test-only-surface).`
  );
  process.exit(1);
}

// ---------- Apply phase ----------

/**
 * Categorize each plan entry by its current state.
 *
 * @param {{ moves: Array<{from:string,to:string}> }} plan
 * @returns {{ pending: Array<{from:string,to:string}>, applied: number, identity: number }}
 */
function categorizeMoves(plan) {
  const pending = [];
  let applied = 0;
  let identity = 0;
  for (const move of plan.moves) {
    if (move.from === move.to) {
      identity++;
      continue;
    }
    const fromAbs = resolve(REPO_ROOT, move.from);
    const toAbs = resolve(REPO_ROOT, move.to);
    if (existsSync(fromAbs) && !existsSync(toAbs)) {
      pending.push(move);
    } else if (!existsSync(fromAbs) && existsSync(toAbs)) {
      applied++;
    }
    // Other combinations were rejected by validatePlan; defensive
    // skip here keeps the categorizer total.
  }
  return { pending, applied, identity };
}

/**
 * Apply pending moves. In `--dry-run`, print planned actions
 * without writing.
 *
 * Each pending move is `fs.renameSync(from, to)` after
 * `mkdir -p` of the target directory.
 *
 * Boundary discipline (task 13.4 / Requirement 12.6): every target
 * path is run through `assertWriteAllowed` before either the
 * `mkdirSync` or the `renameSync` is invoked. The source path is
 * not checked — `rename` reads from `fromAbs` but writes only to
 * `toAbs`, and the boundary applies to writes. The check runs in
 * dry-run too, because a dry-run move that would violate the
 * boundary is still a planning bug worth surfacing immediately.
 *
 * @param {Array<{from:string,to:string}>} pending
 * @param {boolean} dryRun
 */
function applyMoves(pending, dryRun) {
  for (const move of pending) {
    const fromAbs = resolve(REPO_ROOT, move.from);
    const toAbs = resolve(REPO_ROOT, move.to);
    // Boundary check: refuse to write outside the allowed roots.
    // Runs in dry-run too — a dry-run rename targeting, say,
    // `package.json` is still a planning bug.
    assertWriteAllowed(toAbs, REPO_ROOT);
    if (dryRun) {
      console.log(`[migrate] would rename: ${move.from} -> ${move.to}`);
      continue;
    }
    const targetDir = dirname(toAbs);
    mkdirSync(targetDir, { recursive: true });
    renameSync(fromAbs, toAbs);
    console.log(`[migrate] renamed: ${move.from} -> ${move.to}`);
  }
}

// ---------- Import-rewrite phase ----------

/**
 * Normalize an absolute filesystem path to POSIX-style forward slashes.
 * The plan is authored with POSIX separators (`src/...`); the migration
 * script must work on Windows too. ts-morph already returns POSIX-style
 * `StandardizedFilePath`, but `node:path.resolve` returns native
 * separators. This helper unifies the two.
 *
 * @param {string} p
 * @returns {string}
 */
function toPosix(p) {
  if (sep === '/') return p;
  return p.split(sep).join('/');
}

/**
 * Probe a candidate absolute path against the plan's `from` set,
 * trying common TS/TSX extension permutations to mirror Node-style
 * resolution. Specifiers in TS code are normally extensionless, so
 * `'./foo'` matches `<dir>/foo.ts`, `<dir>/foo.tsx`, or
 * `<dir>/foo/index.ts`.
 *
 * Returned value is the *POSIX-form* absolute path that the plan
 * keys on, or `undefined` if no candidate matches.
 *
 * @param {string} candidateAbsPosix — POSIX-form absolute path of the
 *   resolved specifier WITHOUT extension probing applied
 * @param {Map<string, string>} fromSetPosix — Set keyed by POSIX-form
 *   absolute `from` paths
 * @returns {string | undefined} the matched key, or undefined
 */
function probeFromKey(candidateAbsPosix, fromSetPosix) {
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
 * Probe a candidate absolute POSIX path against a Set of valid
 * post-migration absolute POSIX paths, trying Node-style extension
 * permutations. Mirror of `probeFromKey` but checking against the
 * `to`-side (post-migration) path set used by the post-rewrite
 * self-check (task 13.2.2 / Requirement 12.5).
 *
 * Returns `true` when any extension permutation of
 * `candidateAbsPosix` is present in `validTargetSet`; `false`
 * otherwise.
 *
 * @param {string} candidateAbsPosix — POSIX-form absolute path of
 *   the resolved specifier WITHOUT extension probing applied
 * @param {Set<string>} validTargetSet — Set of POSIX-form absolute
 *   paths that will exist post-migration (every plan entry's `to`,
 *   including identity entries where `to === from`)
 * @returns {boolean}
 */
function probeValidTarget(candidateAbsPosix, validTargetSet) {
  // 1) literal match (specifier already has an extension, e.g. './foo.ts')
  if (validTargetSet.has(candidateAbsPosix)) return true;
  // 2) extensionless → try .ts / .tsx
  if (validTargetSet.has(candidateAbsPosix + '.ts')) return true;
  if (validTargetSet.has(candidateAbsPosix + '.tsx')) return true;
  // 3) directory → try /index.ts / /index.tsx
  if (validTargetSet.has(candidateAbsPosix + '/index.ts')) return true;
  if (validTargetSet.has(candidateAbsPosix + '/index.tsx')) return true;
  return false;
}

/**
 * Compute the rewritten specifier for a matched move, preserving
 * the relative-vs-absolute style of the original specifier and any
 * explicit `.js` / `.ts` / `.tsx` extension.
 *
 * Style preservation rules:
 *   - Original starts with `./` or `../`  → emit a relative path
 *     from the source file's directory to the new target, prefixed
 *     with `./` for siblings.
 *   - Otherwise (absolute / package-style, e.g. `'src/utils/foo'`)
 *     → preserve that bare-prefix form by substituting the leading
 *     `from`-prefix with the `to`-prefix at the path level.
 *
 * Extension handling: if the original specifier ended in an
 * explicit `.js`, `.ts`, or `.tsx`, that same extension is
 * re-applied to the result; otherwise the result is extensionless.
 * `index.ts` / `index.tsx` directory targets collapse the trailing
 * `/index` (matching Node's resolution).
 *
 * @param {string} originalSpecifier
 * @param {string} sourceFileDirAbsPosix — directory of the source
 *   file in POSIX form
 * @param {string} toAbsPosix — POSIX-form absolute path of the
 *   plan's `to` location (with .ts/.tsx extension)
 * @returns {string}
 */
function computeNewSpecifier(originalSpecifier, sourceFileDirAbsPosix, toAbsPosix) {
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

  let result;
  if (isRelative) {
    // Build a fresh relative path from the source file's directory
    // to the new target, ensuring the `./` sibling prefix is added
    // when needed (Node `path.relative` returns `'foo'` for
    // siblings, which is invalid as a TS module specifier).
    const rel = toPosix(relative(sourceFileDirAbsPosix, toLogical));
    result = rel.startsWith('.') ? rel : './' + rel;
  } else {
    // Absolute / project-rooted form: the original was something
    // like `'src/utils/foo'`. Reconstruct the same shape from the
    // new target by stripping the repo-root prefix.
    const rootPosix = toPosix(REPO_ROOT) + '/';
    if (toLogical.startsWith(rootPosix)) {
      result = toLogical.slice(rootPosix.length);
    } else {
      // Fallback (unreachable for in-tree targets): emit the absolute
      // POSIX path. The plan's `to` paths are always inside the repo
      // root, so this branch should never execute in practice.
      result = toLogical;
    }
  }

  return result + explicitExt;
}

/**
 * Rewrite every relative or project-rooted module specifier whose
 * resolved target appears as a `from` in the plan to its
 * corresponding `to`. Walks every `ImportDeclaration`,
 * `ExportDeclaration`, dynamic `import('...')` `CallExpression`,
 * and `ImportTypeNode` (`import('./path').T`) across all `.ts` /
 * `.tsx` files under `src/`.
 *
 * Idempotence: ts-morph only flushes a source file to disk when its
 * AST text has changed since load. A second invocation against a
 * fully-applied tree therefore produces zero file-system mutations
 * (Requirement 12.3, 12.5, 14.5).
 *
 * Dry-run vs. real-run handling: this function is invoked AFTER
 * `applyMoves` in `main()`. In a real run, `applyMoves` has already
 * renamed each pending file from its `from` path to its `to` path
 * on disk; ts-morph therefore loads files at their `to` paths. In
 * `--dry-run`, `applyMoves` was a no-op, so files are still at
 * their `from` paths. To produce the correct rewrite in both cases:
 *
 *   - Specifier resolution uses the file's *logical FROM* directory
 *     (the pre-move dir), because the unchanged module specifier
 *     was authored relative to that location.
 *   - New-specifier emission uses the file's *logical TO* directory
 *     (the post-move dir), because the rewritten specifier must
 *     resolve correctly once both file and target sit at their
 *     post-migration paths.
 *
 * The two coincide for files that don't move (identity entries) and
 * differ only for files the plan itself moves.
 *
 * Skip rules:
 *   - Identity entries (from === to) — no rewrite needed.
 *   - Imports of files outside `src/` (e.g. `'vscode'`, `'node:fs'`)
 *     — no plan entry will match; specifier passed through.
 *   - Dynamic `import(expr)` where `expr` is not a single string
 *     literal — cannot statically resolve; specifier passed through.
 *   - Imports that already point at a `to` path — no rewrite (the
 *     source file's text doesn't change, ts-morph won't re-write).
 *
 * @param {{ moves: Array<{from:string,to:string}> }} plan
 * @param {boolean} dryRun
 * @param {string} repoRoot — absolute path to the repo root
 */
function rewriteImports(plan, dryRun, repoRoot) {
  // Build forward map (from→to) and reverse map (to→from) for every
  // plan entry — INCLUDING identity entries (from === to).
  //
  // Why identity entries MUST be in `forwardMap` (Requirement 12.5):
  // when a source file moves but its import target is an identity
  // entry (e.g. `src/services/gitToolWindow/GitToolWindowProvider.ts`
  // moves to `src/git-core/gitToolWindow/` while importing
  // `'../interfaces'`, which resolves to the unchanged
  // `src/services/interfaces/index.ts`), the relative specifier
  // from the source still needs rewriting because the source's
  // directory changed. `probeFromKey` must match the identity
  // target so `computeNewSpecifier` can recompute the relative
  // geometry from the source's *new* directory to the unchanged
  // target. `computeNewSpecifier` already handles `from === to`
  // correctly — it relativises against `sourceFileDirAbsPosix`
  // (which the caller passes as `toDirPosix`, i.e. the source's
  // post-migration dir), so the math is right; the only thing
  // missing was getting the probe to match in the first place.
  //
  // `reverseMap` is used to detect "file is at its TO path on disk
  // (real-run after applyMoves)". Identity entries' to-path equals
  // their from-path, so including them is harmless: the lookup
  // resolves to the same path either way and the downstream
  // `fromDirPosix === toDirPosix` makes the rewrite path a no-op
  // for identity *sources* (only identity *targets* of moving
  // sources need the new behaviour). Including them keeps the two
  // maps symmetric.
  /** @type {Map<string, string>} */
  const forwardMap = new Map();
  /** @type {Map<string, string>} */
  const reverseMap = new Map();
  for (const m of plan.moves) {
    const fromAbsPosix = toPosix(resolve(repoRoot, m.from));
    const toAbsPosix = toPosix(resolve(repoRoot, m.to));
    forwardMap.set(fromAbsPosix, toAbsPosix);
    reverseMap.set(toAbsPosix, fromAbsPosix);
  }

  // Post-rewrite self-check support (task 13.2.2 / Requirement 12.5).
  //
  // Build the set of POSIX-form absolute paths that will exist
  // post-migration: every plan entry's `to` (which equals `from`
  // for identity entries). This is the authoritative
  // "post-migration valid path set" the integration self-check
  // resolves rewritten / unchanged specifiers against.
  //
  // The check is a defensive guardrail: it should never trigger
  // when the rewriter is correct (which it now is, post-13.2.1).
  // Its purpose is to surface breakage from a future plan change
  // or rewriter modification at the migration script's own
  // boundary — earlier than `tsc --noEmit` would, and with a
  // per-specifier `file:line:specifier` offender message rather
  // than a TS diagnostic.
  /** @type {Set<string>} */
  const validTargetSet = new Set();
  for (const m of plan.moves) {
    validTargetSet.add(toPosix(resolve(repoRoot, m.to)));
  }

  // ts-morph project: prefer the existing tsconfig so module
  // resolution settings (target, lib, paths) match the actual build.
  // We disable file addition from tsconfig so we can control which
  // files the project sees explicitly (only `src/**/*.{ts,tsx}` —
  // nothing under `out/`, no `.d.ts` from `node_modules/`, etc.).
  const tsConfigPath = join(repoRoot, 'tsconfig.json');
  const project = new Project({
    tsConfigFilePath: existsSync(tsConfigPath) ? tsConfigPath : undefined,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });

  const srcGlob = toPosix(join(repoRoot, 'src')) + '/**/*.{ts,tsx}';
  project.addSourceFilesAtPaths(srcGlob);

  // Boundary discipline (task 13.4 / Requirement 12.6): pre-validate
  // every source file's absolute path before any rewrite can happen.
  // `project.saveSync()` below only writes files in this set, so a
  // single fail-fast pass here covers every potential write target
  // for the import-rewrite phase. The glob is `src/**/*.{ts,tsx}` so
  // every path should already lie inside `src/` and pass — but the
  // check is cheap, defensive, and turns any future glob mistake
  // into a named-path failure.
  for (const sourceFile of project.getSourceFiles()) {
    assertWriteAllowed(sourceFile.getFilePath(), repoRoot);
  }

  let rewriteCount = 0;
  let touchedFileCount = 0;

  // Post-rewrite integration self-check (task 13.2.2 / Requirement
  // 12.5). For every matched specifier, after `computeNewSpecifier`
  // runs, we verify that the rewritten (or unchanged-because-already-
  // correct) specifier resolves under the source file's POST-migration
  // directory to a path that will exist post-migration. This is a
  // round-trip correctness property of the rewriter — it catches a
  // bug class the property tests might miss (e.g. a future plan
  // change or rewriter modification that desynchronises
  // computeNewSpecifier's emitted relative geometry from the
  // forwardMap target).
  //
  // We only check matched specifiers. probeFromKey-skipped
  // specifiers either (a) start with bare/external prefixes
  // (already gated out at the top of tryRewrite), or (b) resolve
  // outside the plan's `from`-key set — meaning they did NOT
  // resolve to any in-plan file pre-migration. Per Requirement
  // 12.4 + the unmapped-path guard below, every regular file under
  // `src/` IS in the plan, so a probeFromKey miss for a relative
  // / project-rooted specifier means the specifier targets
  // something outside `src/` (test fixtures, scripts/, repo-root
  // files, or a typo). Flagging those would generate false
  // positives without surfacing real rewriter bugs (the spec asks
  // for low FP rate). Hence: matched-case-only check.
  /** @type {Array<{ file: string, line: number, specifier: string, resolved: string }>} */
  const selfCheckFailures = [];
  let selfCheckCount = 0;

  // Emitted-text self-check support (task 13.2.2 / Requirement 12.5).
  //
  // The path-resolution self-check above validates the *computed*
  // `newSpecifier` string, but it never inspects what the setter
  // actually emitted into the AST. A setter that mis-quotes — e.g.
  // manually wrapping a value that ts-morph's API already quotes —
  // emits text like `import('\'foo\'')`, whose effective module
  // specifier embeds a quote pair (`'foo'`). `getLiteralValue()`
  // strips only the OUTER quote pair, so the embedded quotes survive
  // into the read-back value and tsc reports TS2307 "Cannot find
  // module ''foo''". A valid module specifier is a bare path
  // (`./foo`, `../bar`, `src/baz`) and never contains a quote
  // character, so any `'`, `"`, or backtick in the emitted value is
  // proof of quote-corruption. This array collects every offender so
  // the operator sees the full set in one pass.
  /** @type {Array<{ file: string, line: number, specifier: string, emitted: string }>} */
  const emittedCheckFailures = [];

  for (const sourceFile of project.getSourceFiles()) {
    const filePathPosix = toPosix(sourceFile.getFilePath());

    // Determine the file's logical FROM and TO paths. The on-disk
    // path may be either the FROM (dry-run) or the TO (real run
    // post-applyMoves); the maps disambiguate which.
    let fromAbs;
    let toAbs;
    if (forwardMap.has(filePathPosix)) {
      // File is at its FROM path on disk (dry-run case).
      fromAbs = filePathPosix;
      toAbs = /** @type {string} */ (forwardMap.get(filePathPosix));
    } else if (reverseMap.has(filePathPosix)) {
      // File is at its TO path on disk (real-run after applyMoves).
      fromAbs = /** @type {string} */ (reverseMap.get(filePathPosix));
      toAbs = filePathPosix;
    } else {
      // Identity entry, or a file outside the plan's non-identity
      // moves. Logical FROM and TO both equal the on-disk path.
      fromAbs = filePathPosix;
      toAbs = filePathPosix;
    }

    const fromDirPosix = fromAbs.substring(0, fromAbs.lastIndexOf('/'));
    const toDirPosix = toAbs.substring(0, toAbs.lastIndexOf('/'));
    const fileRel = toPosix(relative(repoRoot, sourceFile.getFilePath()));
    let fileChanged = false;

    /**
     * Try to rewrite a single specifier. Returns true when a rewrite
     * occurred (so callers can update counters / log).
     *
     * @param {string} specifier
     * @param {(newSpecifier: string) => void} setter
     * @param {number} line
     * @param {() => (string | undefined)} [readBack] — returns the
     *   module-specifier value the setter actually emitted into the
     *   AST (quotes stripped, as ts-morph's `getLiteralValue` /
     *   `getModuleSpecifierValue` report it). Used by the emitted-
     *   text self-check to detect quote-corruption. Optional only so
     *   the signature stays backwards-tolerant; every call site
     *   supplies it.
     * @returns {boolean}
     */
    const tryRewrite = (specifier, setter, line, readBack) => {
      // Only relative or project-rooted (`src/...`) specifiers can
      // possibly reference an in-tree file. Bare package specifiers
      // like `'vscode'` or `'node:fs'` are skipped early.
      const isRelative =
        specifier.startsWith('./') || specifier.startsWith('../');
      const isProjectRooted = specifier.startsWith('src/');
      if (!isRelative && !isProjectRooted) return false;

      // Resolve the specifier against the file's *logical FROM*
      // directory (the location the unchanged specifier text was
      // authored against) and strip any explicit extension before
      // probing the plan map.
      const baseDir = isRelative ? fromDirPosix : toPosix(repoRoot);
      const resolvedAbs = toPosix(resolve(baseDir, specifier));
      const noExt = resolvedAbs.replace(/\.(js|ts|tsx)$/, '');
      const matchedFromKey = probeFromKey(noExt, forwardMap);
      if (!matchedFromKey) return false;

      const targetToAbsPosix = forwardMap.get(matchedFromKey);
      // Emit the new specifier relative to the file's *logical TO*
      // directory so the result resolves correctly once both file
      // and target are at their post-migration paths.
      const newSpecifier = computeNewSpecifier(
        specifier,
        toDirPosix,
        targetToAbsPosix
      );

      // Post-rewrite self-check (task 13.2.2 / Requirement 12.5):
      // resolve the EFFECTIVE specifier (whether changed or not)
      // against the source file's POST-migration directory and
      // verify it lands on a path in the validTargetSet via
      // Node-style extension probing. This is the round-trip
      // correctness property the rewriter must satisfy: every
      // matched specifier, once rewritten, must point to a real
      // post-migration file.
      //
      // We use `newSpecifier` (which equals `specifier` when no
      // textual rewrite is needed — e.g. an identity-target import
      // from a non-moving file) so the check covers both rewritten
      // and intentionally-preserved specifiers.
      selfCheckCount++;
      const checkBaseDir = isRelative ? toDirPosix : toPosix(repoRoot);
      const resolvedNewAbs = toPosix(resolve(checkBaseDir, newSpecifier));
      const resolvedNewNoExt = resolvedNewAbs.replace(/\.(js|ts|tsx)$/, '');
      if (!probeValidTarget(resolvedNewNoExt, validTargetSet)) {
        selfCheckFailures.push({
          file: fileRel,
          line,
          specifier: newSpecifier,
          resolved: resolvedNewAbs,
        });
      }

      if (newSpecifier === specifier) return false;

      // Apply the rewrite to the in-memory AST in BOTH modes. In
      // dry-run nothing is persisted — `rewriteImports` returns
      // before `project.saveSync()`, so the working tree is never
      // touched — but mutating the AST lets us read back the value
      // the setter actually emitted and run the emitted-text self-
      // check below. This is what lets `--dry-run` catch quote-
      // corruption BEFORE the real run ever writes a byte.
      setter(newSpecifier);

      // Emitted-text self-check (task 13.2.2 / Requirement 12.5):
      // read back the module specifier the setter produced and
      // assert it is a clean, quote-free path. A residual quote
      // character (`'`, `"`, or backtick) means the setter double-
      // quoted the value (e.g. `import('\'foo\'')`), which tsc
      // rejects as TS2307. See `emittedCheckFailures` for rationale.
      if (typeof readBack === 'function') {
        const emitted = readBack();
        if (typeof emitted === 'string' && /['"`]/.test(emitted)) {
          emittedCheckFailures.push({
            file: fileRel,
            line,
            specifier: newSpecifier,
            emitted,
          });
        }
      }

      if (dryRun) {
        console.log(
          `[migrate] would rewrite: ${fileRel}:${line} '${specifier}' -> '${newSpecifier}'`
        );
      }
      return true;
    };

    // ImportDeclaration: `import x from './path'`, `import * as x ...`,
    // `import { x } from ...`, side-effect `import './path'`.
    for (const decl of sourceFile.getImportDeclarations()) {
      const specifier = decl.getModuleSpecifierValue();
      if (typeof specifier !== 'string') continue;
      const line = decl.getStartLineNumber();
      if (
        tryRewrite(
          specifier,
          (s) => decl.setModuleSpecifier(s),
          line,
          () => decl.getModuleSpecifierValue()
        )
      ) {
        rewriteCount++;
        fileChanged = true;
      }
    }

    // ExportDeclaration: `export * from './path'`, `export { x } from ...`.
    for (const decl of sourceFile.getExportDeclarations()) {
      const specifier = decl.getModuleSpecifierValue();
      if (typeof specifier !== 'string') continue;
      const line = decl.getStartLineNumber();
      if (
        tryRewrite(
          specifier,
          (s) => decl.setModuleSpecifier(s),
          line,
          () => decl.getModuleSpecifierValue()
        )
      ) {
        rewriteCount++;
        fileChanged = true;
      }
    }

    // Dynamic `import('./path')` — locate every CallExpression whose
    // callee is the `import` keyword and whose sole argument is a
    // string literal. Non-literal arguments (template strings,
    // variables) are skipped because they cannot be statically
    // analysed.
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.ImportKeyword) continue;
      const args = call.getArguments();
      if (args.length !== 1) continue;
      const arg = args[0];
      if (arg.getKind() !== SyntaxKind.StringLiteral) continue;
      const lit = /** @type {import('ts-morph').StringLiteral} */ (arg);
      const specifier = lit.getLiteralValue();
      const line = call.getStartLineNumber();
      if (
        tryRewrite(
          specifier,
          (s) => lit.setLiteralValue(s),
          line,
          () => lit.getLiteralValue()
        )
      ) {
        rewriteCount++;
        fileChanged = true;
      }
    }

    // ImportTypeNode: `import('./path').Type` used in TS type
    // positions (e.g. `Promise<import('./foo').Bar>`). These occur
    // in `src/services/GitService.ts` and would otherwise slip past
    // the CallExpression walk above.
    for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.ImportType)) {
      const arg = node.getArgument();
      const lit = arg.getFirstDescendantByKind(SyntaxKind.StringLiteral);
      if (!lit) continue;
      const specifier = lit.getLiteralValue();
      const line = node.getStartLineNumber();
      if (
        tryRewrite(
          specifier,
          (s) => {
            // ts-morph's `setArgument` already wraps the value in
            // quotes (preserving the node's existing quote kind), so
            // we pass the BARE specifier. Manually re-quoting here
            // would double the quotes — `import('\'foo\'')` — which
            // tsc reports as TS2307 "Cannot find module ''foo''".
            node.setArgument(s);
          },
          line,
          () => {
            // `setArgument` replaces the argument node, so the
            // original `lit` reference is stale — re-query the new
            // string literal under the (possibly rebuilt) argument
            // and report its quote-stripped value for the emitted-
            // text self-check.
            const newLit = node
              .getArgument()
              .getFirstDescendantByKind(SyntaxKind.StringLiteral);
            return newLit ? newLit.getLiteralValue() : undefined;
          }
        )
      ) {
        rewriteCount++;
        fileChanged = true;
      }
    }

    if (fileChanged) touchedFileCount++;
  }

  // Post-rewrite integration self-check (task 13.2.2 / Requirement
  // 12.5). Report any specifier that — after the rewriter computed
  // its effective output — does not resolve to a path in the
  // post-migration valid-target set. The check ran inline above
  // for every matched specifier; we only report here.
  //
  // On any failure we exit 1 with one offender per line so the
  // operator sees the full picture in a single pass. The error
  // identifies the offending file:line:specifier and the absolute
  // path that did not resolve, so the diagnosis path is direct.
  // This surfaces the breakage earlier and more specifically than
  // `tsc --noEmit` would (tsc reports module-resolution failures
  // by import location but without naming the rewriter as the
  // cause — this self-check makes the proximate cause explicit).
  //
  // Runs in BOTH dry-run and real-run. In dry-run no writes have
  // happened, but the check verifies the rewriter's logical
  // output, which is independent of disk state. Surfacing the
  // failure during dry-run lets the operator catch a planning bug
  // without ever touching the working tree.
  // Emitted-text self-check (task 13.2.2 / Requirement 12.5).
  // Report any rewritten specifier whose EMITTED module-specifier
  // text contains a quote character — proof that the setter double-
  // quoted the value (e.g. `import('\'foo\'')`). This is a distinct
  // failure mode from the path-resolution check below: the computed
  // `newSpecifier` string can be perfectly valid while the emitted
  // AST text is corrupt, because the resolution check never inspects
  // what the setter produced. tsc reports such corruption as TS2307
  // "Cannot find module ''foo''"; this check names the proximate
  // cause (the rewriter's quoting) at the script's own boundary.
  //
  // Runs in BOTH dry-run and real-run: the setter mutates the
  // in-memory AST in dry-run too (nothing is persisted — the dry-run
  // branch returns before `project.saveSync()`), so the read-back
  // reflects exactly what a real run would write. This lets the
  // operator catch quote-corruption during `--dry-run`, before any
  // byte is written.
  if (emittedCheckFailures.length > 0) {
    console.error(
      '[migrate] FAIL: post-rewrite self-check: one or more ' +
        'rewritten specifiers emitted corrupt (embedded-quote) ' +
        'module-specifier text (Requirement 12.5):'
    );
    for (const f of emittedCheckFailures) {
      console.error(
        `  - ${f.file}:${f.line} specifier '${f.specifier}' ` +
          `emitted module text with embedded quote(s): ` +
          `"${f.emitted}" (would produce TS2307 "Cannot find module")`
      );
    }
    process.exit(1);
  }

  if (selfCheckFailures.length > 0) {
    console.error(
      '[migrate] FAIL: post-rewrite self-check: one or more ' +
        'rewritten specifiers do not resolve to a path that will ' +
        'exist post-migration (Requirement 12.5):'
    );
    for (const f of selfCheckFailures) {
      console.error(
        `  - ${f.file}:${f.line} specifier '${f.specifier}' ` +
          `resolves to ${f.resolved} which does not exist post-migration`
      );
    }
    process.exit(1);
  }

  console.log(
    `[migrate] post-rewrite self-check: OK ` +
      `(${selfCheckCount} specifier(s) verified).`
  );

  if (dryRun) {
    console.log(
      `[migrate] would rewrite ${rewriteCount} import specifier(s) ` +
        `across ${touchedFileCount} file(s).`
    );
    return;
  }

  // ts-morph only writes files whose AST changed since load. A
  // second run against a fully-applied tree produces zero
  // mutations.
  project.saveSync();
  console.log(
    `[migrate] rewrote ${rewriteCount} import specifier(s) ` +
      `across ${touchedFileCount} file(s).`
  );
}

// ---------- Unmapped-path guard ----------

/**
 * Walk every regular file under `src/` and assert each one's
 * repo-relative POSIX path appears in the plan's union set of
 * "valid post-migration paths":
 *
 *     valid = { m.to | m ∈ moves, m.from !== m.to }
 *           ∪ { m.from | m ∈ moves, m.from === m.to }   // identity entries
 *
 * Identity-entry `from` equals `to` by definition, so the second
 * union term is the same as `{ m.to | m ∈ moves, m.from === m.to }`
 * — it's spelled with `from` here to mirror the task description
 * (Requirement 12.4).
 *
 * On any unmapped path, collects every offender and exits 1 with
 * one path per line so the caller sees the full set in a single
 * pass (rather than fixing-and-re-running once per file).
 *
 * Walker rules:
 *   - Recursive descent rooted at `<repoRoot>/src`.
 *   - Skip non-regular entries (symlinks, sockets, etc.) — same
 *     contract as task 12.3's walker in
 *     `restructurePlanTotality.property.test.ts`.
 *   - Defensive: skip any nested `node_modules` / `out` / `build`
 *     directories. None should appear under `src/` in this repo,
 *     but if a build artefact ever leaks in we don't want it to
 *     trip the guard.
 *
 * Intended invocation: AFTER `applyMoves` and `rewriteImports`,
 * and ONLY in real-run mode. In `--dry-run`, files are still at
 * their pre-migration FROM paths, so the guard would falsely flag
 * every pending move's source as unmapped (the FROM path is in
 * `from` but not `to` for non-identity moves). The caller is
 * responsible for skipping this check when `dryRun` is true; see
 * `main()`.
 *
 * @param {{ moves: Array<{from:string,to:string}> }} plan
 * @param {string} repoRoot — absolute path to the repo root
 */
function assertNoUnmappedPaths(plan, repoRoot) {
  // Build the union set of valid post-migration paths, keyed by
  // repo-relative POSIX path (matching plan.json's `to` format,
  // e.g. 'src/services/index.ts').
  const validPaths = new Set();
  for (const m of plan.moves) {
    if (m.from === m.to) {
      // Identity entry: include `from` (which equals `to`).
      validPaths.add(m.from);
    } else {
      // Non-identity move: only the `to` is valid post-migration.
      validPaths.add(m.to);
    }
  }

  const srcRoot = join(repoRoot, 'src');
  const offenders = [];

  /**
   * Recursive walker. Skips symlinks / non-regular entries and
   * any nested `node_modules` / `out` / `build` directories.
   *
   * @param {string} dirAbs
   */
  const walk = (dirAbs) => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch (e) {
      console.error(
        `[migrate] FAIL: cannot read directory ${dirAbs}: ` +
          `${e && e.message ? e.message : e}.`
      );
      process.exit(1);
    }
    for (const ent of entries) {
      const fullAbs = join(dirAbs, ent.name);
      if (ent.isDirectory()) {
        if (
          ent.name === 'node_modules' ||
          ent.name === 'out' ||
          ent.name === 'build'
        ) {
          continue;
        }
        walk(fullAbs);
        continue;
      }
      if (!ent.isFile()) {
        // Skip symbolic links, sockets, FIFOs, etc. — the plan
        // only tracks regular files (consistent with task 12.3's
        // walker contract).
        continue;
      }
      // Normalize to repo-relative POSIX path so the lookup
      // matches plan.json's `to` field format exactly.
      const relPosix = toPosix(relative(repoRoot, fullAbs));
      if (!validPaths.has(relPosix)) {
        offenders.push(relPosix);
      }
    }
  };

  if (!existsSync(srcRoot)) {
    console.error(`[migrate] FAIL: src/ directory missing at ${srcRoot}.`);
    process.exit(1);
  }
  walk(srcRoot);

  if (offenders.length > 0) {
    console.error(
      '[migrate] FAIL: unmapped path(s) found under src/. ' +
        'Each path below exists on disk but does not appear in the ' +
        'plan as either a `to` (non-identity move) or a `from` ' +
        '(identity entry). Add a plan entry or remove the file ' +
        '(Requirement 12.4):'
    );
    // Sorted for deterministic output across runs / platforms.
    offenders.sort();
    for (const p of offenders) {
      console.error('  - ' + p);
    }
    process.exit(1);
  }

  console.log(
    `[migrate] unmapped-path guard: OK ` +
      `(${validPaths.size} valid post-migration path(s) checked).`
  );
}

// ---------- Services barrel regeneration (task 13.6 / Requirement 10) ----------

/**
 * Extract a structured representation of an `ExportDeclaration` so
 * we can re-emit it deterministically without losing information.
 *
 * Captures the four orthogonal axes of an `export ... from '<path>';`
 * statement:
 *   - `isTypeOnly` — the leading `type` keyword (`export type ...`)
 *   - `namespaceExportName` — set when the form is
 *     `export * as Foo from '...';`; otherwise null
 *   - `namedExports` — the `{ A, B as C, type T }` clause; empty
 *     array for `export *` and `export * as Foo` forms. Each
 *     element captures the name, optional alias, and per-specifier
 *     type-only marker (TS allows `export { type T }` inline).
 *   - `moduleSpecifier` — the `from '<path>'` portion's literal
 *     value
 *
 * @param {import('ts-morph').ExportDeclaration} decl
 * @returns {{
 *   isTypeOnly: boolean,
 *   namespaceExportName: string | null,
 *   namedExports: Array<{ name: string, alias: string | null, isTypeOnly: boolean }>,
 *   moduleSpecifier: string | null,
 * }}
 */
function extractExportEntry(decl) {
  const ns = decl.getNamespaceExport();
  return {
    isTypeOnly: decl.isTypeOnly(),
    namespaceExportName: ns ? ns.getName() : null,
    namedExports: decl.getNamedExports().map((ne) => {
      const aliasNode = ne.getAliasNode();
      return {
        name: ne.getNameNode().getText(),
        alias: aliasNode ? aliasNode.getText() : null,
        isTypeOnly: ne.isTypeOnly(),
      };
    }),
    moduleSpecifier: decl.getModuleSpecifierValue() ?? null,
  };
}

/**
 * Render an export entry to its canonical single-line form. The
 * output is exactly one line, terminated with a semicolon, no
 * trailing newline.
 *
 * Output shapes (matching every form present in
 * `src/services/index.ts` today):
 *   - `export * from 'p';`
 *   - `export * as Foo from 'p';`
 *   - `export { A } from 'p';`
 *   - `export { A, B } from 'p';`
 *   - `export { A as B } from 'p';`
 *   - `export type { T } from 'p';`
 *   - `export type * from 'p';`
 *   - `export { type T } from 'p';` (per-specifier type-only)
 *
 * Quote style: single-quotes (matches the existing barrel file).
 *
 * @param {ReturnType<typeof extractExportEntry>} entry
 * @returns {string}
 */
function renderExportLine(entry) {
  const head = entry.isTypeOnly ? 'export type ' : 'export ';
  let body;
  if (entry.namespaceExportName !== null) {
    body = `* as ${entry.namespaceExportName}`;
  } else if (entry.namedExports.length === 0) {
    body = '*';
  } else {
    const parts = entry.namedExports.map((ne) => {
      // Per-specifier `type` keyword only emitted when the
      // declaration itself is NOT type-only (otherwise it would be
      // redundant: `export type { type T }` is invalid TS).
      const typeKw = ne.isTypeOnly && !entry.isTypeOnly ? 'type ' : '';
      return ne.alias
        ? `${typeKw}${ne.name} as ${ne.alias}`
        : `${typeKw}${ne.name}`;
    });
    body = `{ ${parts.join(', ')} }`;
  }
  return entry.moduleSpecifier !== null
    ? `${head}${body} from '${entry.moduleSpecifier}';`
    : `${head}${body};`;
}

/**
 * Compute a canonical fingerprint for an export entry. Two barrels
 * with the same fingerprint set export the same Public_Service_API
 * surface (Requirement 10.3, 10.5).
 *
 * The fingerprint deliberately INCLUDES the module specifier: a
 * symbol moving from `'./X'` to `'../topic/X'` is a legitimate
 * change governed by task 13.2's import-rewrite pass, and the
 * fingerprint must remain stable across regeneration (which only
 * sorts; it does not re-resolve specifiers). Comparing fingerprints
 * before and after regeneration verifies that `renderExportLine`
 * round-trips losslessly through ts-morph re-parsing.
 *
 * @param {ReturnType<typeof extractExportEntry>} entry
 * @returns {string}
 */
function fingerprintExportEntry(entry) {
  const namedPart = entry.namedExports
    .map((ne) => {
      const t = ne.isTypeOnly ? 't:' : 'v:';
      const a = ne.alias === null ? '' : `=>${ne.alias}`;
      return `${t}${ne.name}${a}`;
    })
    .sort()
    .join(',');
  return [
    entry.isTypeOnly ? 'type' : 'value',
    entry.namespaceExportName ?? '',
    namedPart,
    entry.moduleSpecifier ?? '',
  ].join('|');
}

/**
 * Regenerate `src/services/index.ts` from a deterministic template
 * (task 13.6 / Requirement 10).
 *
 * Steps:
 *   1. Read the current barrel from disk. Task 13.2's
 *      `rewriteImports` has already updated every `from '<path>'`
 *      specifier to point at the new module homes (`../git-core/...`,
 *      `../branches/...`, etc.); this function only re-orders.
 *   2. Use ts-morph to extract every top-level `ExportDeclaration`
 *      into a structured entry.
 *   3. Sort entries lexicographically by their rendered single-line
 *      form. The sort key is the entire `export ... from '...';`
 *      line, so the order is fully deterministic and stable across
 *      runs / platforms.
 *   4. Preserve the leading comment block (everything before the
 *      first export declaration) verbatim — typically the JSDoc
 *      module banner.
 *   5. Verify the SET of entry fingerprints matches the pre-sort
 *      set: this guards `renderExportLine` against silent
 *      information loss (Requirement 10.3, 10.4).
 *   6. Compare the rebuilt content to the on-disk content. Skip the
 *      write if they're byte-identical — regenerating an
 *      already-canonical barrel must be a no-op (Requirement 12.3,
 *      12.5, 14.5 idempotence).
 *
 * Boundary discipline (Requirement 12.6): the only write is gated
 * by `assertWriteAllowed`. The barrel path
 * (`src/services/index.ts`) lies under the `src/` allow-prefix, so
 * the check passes; if a future refactor moves the barrel, the
 * check will surface the violation by named path.
 *
 * Dry-run handling: in `--dry-run`, this function logs a single
 * "would regenerate" line and returns. The on-disk file at this
 * point still has its pre-rewrite specifiers (because
 * `rewriteImports` was a no-op in dry-run), but the export
 * COUNT is identical regardless, so the log line is correct in
 * both modes.
 *
 * @param {{ moves: Array<{from:string,to:string}> }} _plan — kept
 *   for signature symmetry with the other phase functions; the
 *   barrel's destination path is fixed by Requirement 10.1
 * @param {boolean} dryRun
 * @param {string} repoRoot — absolute path to the repo root
 */
function regenerateServicesBarrel(_plan, dryRun, repoRoot) {
  const barrelAbs = resolve(repoRoot, 'src', 'services', 'index.ts');
  if (!existsSync(barrelAbs) || !isRegularFile(barrelAbs)) {
    console.error(
      `[migrate] FAIL: services barrel missing at ${barrelAbs}; ` +
        `cannot regenerate (Requirement 10.1).`
    );
    process.exit(1);
  }

  const currentContent = readFileSync(barrelAbs, 'utf8');

  // Fresh ts-morph project so we don't disturb the one used by
  // `rewriteImports`. We don't need tsconfig resolution here — the
  // barrel is a leaf with no internal type queries.
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    useInMemoryFileSystem: false,
  });
  const sourceFile = project.addSourceFileAtPath(barrelAbs);

  const exportDecls = sourceFile.getExportDeclarations();
  if (exportDecls.length === 0) {
    // Defensive: a barrel with zero exports is a Requirement 10
    // violation in spirit (the public API surface would be empty).
    // Bail loudly rather than silently writing a comment-only file.
    console.error(
      `[migrate] FAIL: services barrel at ${barrelAbs} has zero ` +
        `top-level export declarations. Refusing to regenerate ` +
        `(Requirement 10.1, 10.3 violation).`
    );
    process.exit(1);
  }

  const exportEntries = exportDecls.map(extractExportEntry);

  // Pre-regeneration fingerprint set. Sorted so the equality check
  // below is order-insensitive (the regeneration WILL reorder).
  const beforeFingerprints = exportEntries.map(fingerprintExportEntry).sort();

  // Sort entries deterministically by their rendered single-line
  // form. Lexicographic order on the full line is stable across
  // platforms and tolerant of any future entry shape we don't yet
  // emit.
  const sortedEntries = [...exportEntries].sort((a, b) => {
    const la = renderExportLine(a);
    const lb = renderExportLine(b);
    return la < lb ? -1 : la > lb ? 1 : 0;
  });

  // Preserve the leading comment block: everything from the start
  // of the file up to (but not including) the first export
  // declaration. ts-morph reports zero-based offsets in characters.
  const firstExportStart = exportDecls[0].getStart();
  const headerRaw = currentContent.slice(0, firstExportStart);
  // Strip trailing whitespace/newlines from the header so we can
  // re-attach a single canonical separator below.
  const header = headerRaw.replace(/\s+$/, '');

  const exportLines = sortedEntries.map(renderExportLine).join('\n');
  const newContent =
    (header.length > 0 ? header + '\n\n' : '') + exportLines + '\n';

  // Self-check: re-parse the rebuilt content and verify the
  // fingerprint set is byte-identical to the original. This catches
  // any silent information loss in renderExportLine (e.g. a missed
  // export form) before it can corrupt the public API surface.
  const verifyFile = project.createSourceFile(
    '/__barrel_regen_check__.ts',
    newContent,
    { overwrite: true }
  );
  const afterFingerprints = verifyFile
    .getExportDeclarations()
    .map(extractExportEntry)
    .map(fingerprintExportEntry)
    .sort();
  // Drop the synthetic file so the project's source-file set stays
  // clean (defensive — the project is local to this function and
  // discarded on return, but explicit teardown documents intent).
  project.removeSourceFile(verifyFile);

  if (
    beforeFingerprints.length !== afterFingerprints.length ||
    beforeFingerprints.some((fp, i) => fp !== afterFingerprints[i])
  ) {
    console.error(
      `[migrate] FAIL: services barrel regeneration would change ` +
        `the Public_Service_API export set (Requirement 10.3, 10.4 ` +
        `violation). Before: ${beforeFingerprints.length} entry/entries; ` +
        `after: ${afterFingerprints.length}.`
    );
    // Surface the first divergence to make the failure actionable.
    const beforeSet = new Set(beforeFingerprints);
    const afterSet = new Set(afterFingerprints);
    for (const fp of beforeFingerprints) {
      if (!afterSet.has(fp)) {
        console.error(`  - missing after regen: ${fp}`);
      }
    }
    for (const fp of afterFingerprints) {
      if (!beforeSet.has(fp)) {
        console.error(`  - introduced by regen: ${fp}`);
      }
    }
    process.exit(1);
  }

  if (dryRun) {
    console.log(
      `[migrate] would regenerate src/services/index.ts barrel ` +
        `(${exportEntries.length} export(s)).`
    );
    return;
  }

  // Idempotence (Requirement 12.3, 12.5, 14.5): a second run on
  // already-canonical content must produce zero filesystem
  // mutations. Skip the write if the rebuilt content is
  // byte-identical to disk.
  if (newContent === currentContent) {
    console.log(
      `[migrate] services barrel: already canonical ` +
        `(${exportEntries.length} export(s); no write).`
    );
    return;
  }

  // Boundary check (Requirement 12.6) — the barrel sits under
  // `src/`, so this passes trivially today; the check is the
  // guardrail that catches any future relocation.
  assertWriteAllowed(barrelAbs, repoRoot);
  writeFileSync(barrelAbs, newContent, 'utf8');
  console.log(
    `[migrate] regenerated src/services/index.ts barrel ` +
      `(${exportEntries.length} export(s)).`
  );
}

// ---------- Verification (--check) ----------

/**
 * `--check` mode (Requirement 12.1, design.md "CLI interface"):
 * verify that the on-disk working tree exactly matches the
 * post-migration shape described by `plan.json`, and exit non-zero
 * with a clear message naming each divergent path on any mismatch.
 *
 * `--check` is the CI structural guard. It performs NO writes. It
 * is the operational counterpart of the property-test boundary
 * check: while Property 17 verifies `assertWriteAllowed`'s contract
 * statically, `--check` verifies the live working tree post-migration.
 *
 * Verification rules (each violation collected, then reported in
 * a single batch — caller sees the full picture in one pass):
 *
 *   - For every non-identity move (`from !== to`):
 *       * `to` MUST exist as a regular file.
 *       * `from` MUST NOT exist (any state — file, directory, link
 *         — counts as a violation; the rename should have removed
 *         it).
 *
 *   - For every identity move (`from === to`):
 *       * the path MUST exist as a regular file (no rename was
 *         expected; we just want the file to still be there).
 *
 *   - Every regular file under `src/` MUST appear in the plan as
 *     either a `to` (non-identity) or an identity entry — i.e. the
 *     existing `assertNoUnmappedPaths` invariant. We delegate to
 *     that helper directly so the two callers (real-run main and
 *     `--check`) share a single implementation.
 *
 * Exit codes:
 *   0 — every check passes.
 *   1 — one or more checks failed. Each failure is printed on its
 *       own line so the operator can fix the entire batch in a
 *       single edit cycle.
 *
 * @param {{ moves: Array<{from:string,to:string}> }} plan
 * @param {string} repoRoot — absolute path to the repo root
 * @returns {never}
 */
function runCheck(plan, repoRoot) {
  /** @type {string[]} */
  const violations = [];

  let nonIdentity = 0;
  let identity = 0;

  for (let i = 0; i < plan.moves.length; i++) {
    const { from, to } = plan.moves[i];
    const fromAbs = resolve(repoRoot, from);
    const toAbs = resolve(repoRoot, to);

    if (from === to) {
      identity++;
      if (!isRegularFile(toAbs)) {
        violations.push(
          `identity entry "${to}" missing — expected a regular file at this path.`
        );
      }
      continue;
    }

    nonIdentity++;
    const toOk = isRegularFile(toAbs);
    const fromAbsent = !existsSync(fromAbs);

    if (!toOk) {
      violations.push(
        `move "${from}" -> "${to}": destination "${to}" missing or not a regular file.`
      );
    }
    if (!fromAbsent) {
      violations.push(
        `move "${from}" -> "${to}": source "${from}" still exists on disk; the rename did not complete.`
      );
    }
  }

  if (violations.length > 0) {
    console.error(
      '[migrate] FAIL: --check: working tree does not match the ' +
        'post-migration shape. Violations:'
    );
    for (const v of violations) {
      console.error('  - ' + v);
    }
    process.exit(1);
  }

  // Every non-identity move's endpoints look right and every
  // identity entry exists. Now verify the converse: that there is
  // no file under `src/` outside the plan's union set. Reuse the
  // existing helper, which prints its own FAIL message and exits 1
  // on any unmapped path. On success it logs an OK line.
  assertNoUnmappedPaths(plan, repoRoot);

  console.log(
    `[migrate] --check: tree matches post-migration shape ` +
      `(${nonIdentity} non-identity move(s), ${identity} identity ` +
      `entry/entries verified).`
  );
  process.exit(0);
}

// ---------- Undo (--rollback) ----------

/**
 * `--rollback` mode (Requirement 12.1, design.md "CLI interface"):
 * undo the migration commit by restoring every plan path from
 * `HEAD~1`. Documented but not relied on — the canonical undo is
 * `git revert`. This mode exists for the maintainer who has just
 * run the migration locally, hasn't pushed, and wants a fast
 * one-command undo before the migration commit graduates.
 *
 * Preconditions (any failure → exit 1, no writes performed):
 *
 *   1. The current working directory must be inside a git repo;
 *      `git status --porcelain` must succeed.
 *   2. The working tree must be clean for tracked files. Any
 *      modified / staged / deleted entry in `git status --porcelain`
 *      with a status code other than `??` (untracked) is a hard
 *      reject — rollback would clobber in-flight work. Untracked
 *      files are warned about but allowed (they aren't affected by
 *      `git restore`).
 *   3. `HEAD~1` must resolve. A repository with only one commit
 *      cannot be rolled back — there is no prior state to restore
 *      to.
 *
 * Operation: for every non-identity move's `to` path AND every
 * identity entry's path, run `git restore --source=HEAD~1 --
 * <path>`. Restoring at `HEAD~1` recreates the file at its
 * pre-migration location (the rename in HEAD becomes "the file
 * appeared at `to` and disappeared at `from`"; restoring `to` from
 * HEAD~1 restores its prior content if it existed, or removes it
 * if it did not exist at HEAD~1; restoring `from` from HEAD~1
 * recreates the file at its old location). We restore both
 * endpoints to be exhaustive and correct in either pending or
 * already-applied states.
 *
 * One `git restore` invocation per path keeps the failure mode
 * granular: if one path fails to restore (e.g. it existed at HEAD
 * but not at HEAD~1 because a later commit added it), the operator
 * sees that path's stderr and can resume the others manually.
 *
 * Exit codes:
 *   0 — every restore succeeded.
 *   1 — preconditions failed, or one or more `git restore` calls
 *       failed.
 *
 * @param {{ moves: Array<{from:string,to:string}> }} plan
 * @param {string} repoRoot — absolute path to the repo root
 * @returns {never}
 */
function runRollback(plan, repoRoot) {
  // Precondition 1 + 2: working tree cleanliness. `git status
  // --porcelain` is the machine-readable form; one line per
  // changed file with a two-character status code in columns 1-2.
  // `??` marks untracked, anything else (`MM`, ` M`, `M `, `A `,
  // `D `, `R `, etc.) is a tracked modification.
  let porcelain;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch (e) {
    console.error(
      `[migrate] FAIL: --rollback: cannot run \`git status --porcelain\` ` +
        `(is this a git checkout?): ${e && e.message ? e.message : e}.`
    );
    process.exit(1);
  }

  /** @type {string[]} */
  const tracked = [];
  /** @type {string[]} */
  const untracked = [];
  for (const line of porcelain.split('\n')) {
    if (line.length === 0) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3);
    if (code === '??') {
      untracked.push(path);
    } else {
      tracked.push(`${code} ${path}`);
    }
  }
  if (tracked.length > 0) {
    console.error(
      '[migrate] FAIL: --rollback: working tree has tracked ' +
        'modifications. Commit or stash them first; rollback only ' +
        'proceeds when the migration commit is the only delta on top ' +
        'of HEAD~1. Offending entries:'
    );
    for (const t of tracked) {
      console.error('  - ' + t);
    }
    process.exit(1);
  }
  if (untracked.length > 0) {
    console.warn(
      '[migrate] --rollback: warning — untracked file(s) present ' +
        '(unaffected by rollback, but listed for transparency):'
    );
    for (const u of untracked) {
      console.warn('  - ' + u);
    }
  }

  // Precondition 3: HEAD~1 must resolve.
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD~1'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    console.error(
      `[migrate] FAIL: --rollback: HEAD~1 does not resolve. ` +
        `--rollback requires a prior commit to restore from; the ` +
        `repository appears to have only one commit.`
    );
    process.exit(1);
  }

  // Build the set of paths to restore — every non-identity move's
  // `from` AND `to`, plus every identity entry's path. Using a Set
  // dedupes the (rare) case where `from === to`.
  /** @type {Set<string>} */
  const restorePaths = new Set();
  for (const m of plan.moves) {
    restorePaths.add(m.to);
    if (m.from !== m.to) restorePaths.add(m.from);
  }

  // Sort for deterministic output.
  const sortedPaths = Array.from(restorePaths).sort();

  console.log(
    `[migrate] --rollback: restoring ${sortedPaths.length} path(s) ` +
      `from HEAD~1.`
  );

  /** @type {Array<{ path: string, error: string }>} */
  const failures = [];
  for (const p of sortedPaths) {
    try {
      execFileSync('git', ['restore', '--source=HEAD~1', '--', p], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      console.log(`[migrate] restored: ${p}`);
    } catch (e) {
      const msg = e && e.stderr ? String(e.stderr).trim() : (e && e.message ? e.message : String(e));
      failures.push({ path: p, error: msg });
      console.error(`[migrate] FAIL: could not restore ${p}: ${msg}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `[migrate] FAIL: --rollback: ${failures.length} path(s) failed ` +
        `to restore. Inspect the per-path errors above and resolve ` +
        `manually (e.g. with \`git restore --source=HEAD~1 -- <path>\`).`
    );
    process.exit(1);
  }

  console.log(
    `[migrate] OK — --rollback complete; ${sortedPaths.length} path(s) ` +
      `restored from HEAD~1.`
  );
  process.exit(0);
}

// ---------- tsc --noEmit post-step + rollback (task 13.7) ----------

/**
 * Run `npx tsc --noEmit` from `repoRoot` and capture both stdout
 * and stderr. The TypeScript compiler emits diagnostics to stdout
 * (one per line) and uses stderr for tooling-level errors (e.g.
 * "tsc: command not found", invalid CLI flags). We capture both,
 * concatenate them in stdout-then-stderr order, and return the
 * combined buffer alongside the exit-code-derived `ok` flag so the
 * caller can dump the full picture on failure.
 *
 * Implementation note: `child_process.execFileSync` throws on a
 * non-zero exit and exposes stdout/stderr on the thrown Error. We
 * catch that, distinguish "tsc ran and reported errors" (the
 * normal failure mode) from "tsc could not be invoked at all"
 * (npx/tsc missing, ENOENT, EACCES), and surface the latter with
 * a clear FAIL message before exiting 1.
 *
 * Timeout: 180_000 ms (3 minutes). The full project type-check
 * takes ~30-60s on this codebase today; 3 minutes is a generous
 * upper bound that catches the "tsc hung" failure mode without
 * flagging slow-but-progressing builds.
 *
 * @param {string} repoRoot — absolute path to the repo root
 * @returns {{ ok: boolean, output: string }} ok=true when tsc
 *   exited 0; otherwise output contains the captured diagnostics
 *   that the caller should print to stderr before rolling back.
 */
function runTscNoEmit(repoRoot) {
  // Use `npx --no-install tsc` so we fail fast if the local
  // typescript dependency is missing rather than silently fetching
  // a transient version from the registry. The `--no-install` flag
  // makes the contract explicit: tsc MUST be present in the local
  // node_modules (it is — typescript is a devDependency).
  /** @type {string} */
  let stdout = '';
  /** @type {string} */
  let stderr = '';
  /** @type {number} */
  let exitCode = 0;

  try {
    const buf = execFileSync(
      'npx',
      ['--no-install', 'tsc', '--noEmit'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        // Capture stdout+stderr; stdio:'pipe' for both so neither
        // streams to the terminal until we decide what to do.
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180_000,
        // Generous output buffer — full-project tsc output on a
        // failing run can run to several thousand lines on a worst-
        // case incompatibility.
        maxBuffer: 64 * 1024 * 1024,
      }
    );
    stdout = typeof buf === 'string' ? buf : buf.toString('utf8');
  } catch (e) {
    // execFileSync's thrown error carries the partial stdout/stderr
    // plus an exit `status` (or `signal` for timeouts). When tsc
    // itself reported diagnostics, status is non-zero and stdout
    // is the diagnostic text — that's the normal failure path.
    const err = /** @type {NodeJS.ErrnoException & { status?: number, signal?: NodeJS.Signals, stdout?: string | Buffer, stderr?: string | Buffer }} */ (e);

    // ENOENT / EACCES: tsc could not be invoked at all. That's a
    // tooling failure, not a type-check failure — surface it
    // distinctly and exit 1 without attempting rollback (no writes
    // happened in the post-step yet).
    if (err.code === 'ENOENT' || err.code === 'EACCES') {
      console.error(
        `[migrate] FAIL: cannot invoke \`npx tsc --noEmit\` ` +
          `(${err.code}): ${err.message}. Ensure typescript is ` +
          `installed in node_modules and npx is on PATH.`
      );
      process.exit(1);
    }

    // Timeout: signal will be set to 'SIGTERM' (or similar). The
    // partial output is still useful — surface it as a normal tsc
    // failure so the rollback runs.
    stdout = err.stdout
      ? typeof err.stdout === 'string'
        ? err.stdout
        : err.stdout.toString('utf8')
      : '';
    stderr = err.stderr
      ? typeof err.stderr === 'string'
        ? err.stderr
        : err.stderr.toString('utf8')
      : '';
    exitCode = typeof err.status === 'number' ? err.status : 1;

    if (err.signal) {
      // Augment the captured output with a clear timeout marker
      // so the operator sees why the run was terminated.
      stderr += `\n[migrate] tsc terminated by signal ${err.signal} ` +
        `(likely 3-minute timeout exceeded).\n`;
    }
  }

  if (exitCode === 0) {
    console.log('[migrate] tsc --noEmit: passed');
    return { ok: true, output: '' };
  }

  // Concatenate stdout + stderr in the natural reading order: tsc
  // diagnostics first (stdout), then any tooling-level errors
  // (stderr).
  const combined = stdout + (stderr.length > 0 ? stderr : '');
  return { ok: false, output: combined };
}

/**
 * Restore every plan path from HEAD to undo the migration's writes
 * after a `tsc --noEmit` failure. The migration is invoked on a
 * clean working tree, so HEAD is the pre-migration state — the
 * exact state we want to recover.
 *
 * For each plan entry we restore BOTH `from` AND `to` (deduped):
 *   - The `to` path picks up any post-rename rewrite (the renamed
 *     file with updated import specifiers, or — for files that
 *     don't move — the in-place rewrite produced by ts-morph).
 *   - The `from` path recreates the file at its pre-migration
 *     location for non-identity moves where the rename has already
 *     run.
 *
 * Identity entries (from === to) deduplicate naturally via the
 * Set. The barrel `src/services/index.ts` is also covered because
 * it is a plan entry (an identity entry in the post-migration
 * tree, or a `to` path for the pre-migration tree).
 *
 * Each path is restored individually with
 * `git restore --source=HEAD --staged --worktree -- <path>`. The
 * per-path invocation keeps the failure mode granular: one
 * restore failure does not block the others. Boundary discipline
 * (Requirement 12.6) is respected by routing every restored
 * absolute path through `assertWriteAllowed` before invoking git.
 *
 * @param {{ moves: Array<{from:string,to:string}> }} plan
 * @param {string} repoRoot — absolute path to the repo root
 * @returns {string[]} list of repo-relative paths that failed to
 *   restore; empty array on full success
 */
function restoreTouchedPaths(plan, repoRoot) {
  /** @type {Set<string>} */
  const restorePaths = new Set();
  for (const m of plan.moves) {
    restorePaths.add(m.to);
    if (m.from !== m.to) restorePaths.add(m.from);
  }

  // Sort for deterministic output order.
  const sortedPaths = Array.from(restorePaths).sort();

  console.log(
    `[migrate] rollback: restoring ${sortedPaths.length} plan path(s) ` +
      `from HEAD.`
  );

  /** @type {string[]} */
  const failed = [];
  for (const p of sortedPaths) {
    // Boundary check — every restore is a write to the working
    // tree. The plan paths all live under `src/` (or are the
    // services barrel under `src/services/`), so the check passes
    // trivially today; it is here as the guardrail per
    // Requirement 12.6 in case a future plan iteration adds an
    // entry outside `src/`.
    const absPath = resolve(repoRoot, p);
    assertWriteAllowed(absPath, repoRoot);
    try {
      execFileSync(
        'git',
        ['restore', '--source=HEAD', '--staged', '--worktree', '--', p],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'ignore', 'pipe'],
        }
      );
      console.log(`[migrate] restored: ${p}`);
    } catch (e) {
      const errAny = /** @type {{ stderr?: string | Buffer, message?: string }} */ (e);
      const msg = errAny.stderr
        ? String(errAny.stderr).trim()
        : errAny.message
        ? errAny.message
        : String(e);
      console.error(`[migrate] FAIL: could not restore ${p}: ${msg}`);
      failed.push(p);
    }
  }

  return failed;
}

// ---------- Main ----------

function main() {
  const flags = parseFlags(process.argv.slice(2));

  const plan = loadPlan();
  validatePlan(plan);

  // --check and --rollback are verification / undo modes that must
  // run BEFORE the dryRun branch and BEFORE applyMoves /
  // rewriteImports. Both terminate the process directly.
  if (flags.check) {
    runCheck(plan, REPO_ROOT);
    return; // unreachable — runCheck calls process.exit
  }
  if (flags.rollback) {
    runRollback(plan, REPO_ROOT);
    return; // unreachable — runRollback calls process.exit
  }

  const { pending, applied, identity } = categorizeMoves(plan);
  const nonIdentity = plan.moves.length - identity;

  if (pending.length === 0 && applied === nonIdentity) {
    // Every non-identity move has its `to` in place and `from`
    // absent. Re-running on a fully-applied tree is a no-op
    // (Requirement 12.3, 14.5).
    console.log(
      `[migrate] OK — already applied; no-op ` +
        `(${applied} non-identity move(s), ${identity} identity entry/entries).`
    );
    process.exit(0);
  }

  console.log(
    `[migrate] plan: ${plan.moves.length} entry/entries ` +
      `(${pending.length} pending, ${applied} already-applied, ${identity} identity).`
  );

  applyMoves(pending, flags.dryRun);

  // ts-morph import-rewriter pass — rewrites every relative or absolute
  // module specifier whose resolved target is a `from` path in the plan
  // to its corresponding `to`. ts-morph writes only when the file's text
  // actually changes, so a second run on a fully-applied tree produces
  // zero filesystem mutations (Requirement 12.3, 12.5, 14.5).
  rewriteImports(plan, flags.dryRun, REPO_ROOT);

  // Unmapped-path guard (task 13.3 / Requirement 12.4) — walks src/
  // and asserts every regular file's repo-relative POSIX path
  // appears in the plan's union set { non-identity `to` } ∪
  // { identity `from` }. Skipped in --dry-run because applyMoves
  // was a no-op there: pending moves' files are still at their
  // FROM paths, which are in `from` but not `to` for non-identity
  // entries — the guard would falsely flag every pending source as
  // unmapped. The guard's contract is post-migration verification
  // of the on-disk tree, which only holds in a real run.
  if (flags.dryRun) {
    console.log(
      '[migrate] dry-run: skipping unmapped-path guard ' +
        '(verifies post-migration tree only).'
    );
  } else {
    assertNoUnmappedPaths(plan, REPO_ROOT);
  }

  // Services barrel regeneration (task 13.6 / Requirement 10) —
  // re-emits `src/services/index.ts` from a deterministic template
  // (sorted `export ... from` lines). The function self-verifies
  // that the Public_Service_API fingerprint set is unchanged, then
  // writes only when the rebuilt content differs from disk
  // (idempotent on a fully-applied tree). The write path is
  // routed through `assertWriteAllowed` per Requirement 12.6.
  // Runs in dry-run too, where it logs a "would regenerate" line
  // without writing.
  regenerateServicesBarrel(plan, flags.dryRun, REPO_ROOT);

  // tsc --noEmit post-step (task 13.7 / Requirement 9.5, 13.6) —
  // run the TypeScript compiler against the rewritten tree to
  // confirm no cyclic import was introduced (Requirement 9.5) and
  // no behavioural-regression class of error slipped past the
  // import-rewrite + barrel-regeneration pipeline (Requirement
  // 13.6). On any non-zero exit, we restore every plan path from
  // HEAD via `git restore` and exit 1 with the captured tsc output
  // already on stderr. Skipped in --dry-run because no writes
  // happened — there is nothing to verify or roll back.
  if (flags.dryRun) {
    console.log(
      '[migrate] dry-run: skipping tsc --noEmit post-step ' +
        '(verifies post-write tree only).'
    );
  } else {
    const tscResult = runTscNoEmit(REPO_ROOT);
    if (!tscResult.ok) {
      // Stream the captured tsc output to stderr so the operator
      // sees the actual diagnostics that triggered the rollback.
      process.stderr.write(tscResult.output);
      if (!tscResult.output.endsWith('\n')) process.stderr.write('\n');
      console.error(
        '[migrate] FAIL: tsc --noEmit reported errors after the ' +
          'restructure rewrite. Rolling back every plan path from ' +
          'HEAD (Requirement 9.5, 13.6).'
      );
      const failedRestores = restoreTouchedPaths(plan, REPO_ROOT);
      if (failedRestores.length > 0) {
        console.error(
          `[migrate] FAIL: rollback completed with ` +
            `${failedRestores.length} restore failure(s); inspect ` +
            `the per-path errors above and resolve manually.`
        );
      } else {
        console.error(
          '[migrate] rollback: every plan path restored from HEAD.'
        );
      }
      process.exit(1);
    }
  }

  if (flags.dryRun) {
    console.log('[migrate] OK — --dry-run complete; no files modified.');
  } else {
    console.log(`[migrate] OK — applied ${pending.length} pending move(s).`);
  }
  process.exit(0);
}

main();
