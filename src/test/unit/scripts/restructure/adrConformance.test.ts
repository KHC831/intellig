/**
 * Unit tests for the migration's per-ADR conformance contract.
 *
 * Each existing ADR (`docs/adr/ADR-001` through `docs/adr/ADR-010`)
 * names specific source files / interfaces / patterns. The /src
 * restructure must preserve every one of those paths: the migration
 * may move a file, but the file's identity (and the ADR's pin on it)
 * must survive — either at its original location (pre-migration) or
 * at its new location (post-migration via `plan.json`'s `from -> to`).
 *
 * This test pins the contract by, for every ADR-tracked path P, asserting
 * that **either**:
 *
 *   1. `P` exists on disk at its current location (pre-migration), OR
 *   2. `P` appears as a `from` in `plan.json` AND the corresponding
 *      `to` exists on disk (post-migration).
 *
 * Identity entries (`from === to`) collapse the two clauses — `P`
 * exists, full stop. The same assertion therefore passes against both
 * pre-migration and post-migration trees, which is exactly what
 * Requirements 11.1–11.9 require: the migration is a pure
 * code-organization change, never a behaviour change, and every ADR's
 * tracked-path list still resolves.
 *
 * Scope and structure:
 *
 *   - One `describe` block per ADR (001..010).
 *   - The block names the ADR's tracked paths verbatim and asserts each
 *     resolves through the helper above.
 *   - ADR-007 (structural guards) tracks the guard *scripts themselves*,
 *     which live under `scripts/` (not `src/`). Those are not in
 *     `plan.json` (the plan only governs `src/`), but the migration
 *     spec also explicitly *updates* them in place rather than moving
 *     them — and Wave 15.1 may rename the OutputChannel guard to a
 *     more generic test-only-surface guard. The block accepts either
 *     pre- or post-rename name.
 *   - ADR-010 (visual parity) tracks `docs/parity/` snapshots, which
 *     the migration MUST NOT touch (Requirement 11.9). The block
 *     asserts those exist verbatim with no plan involvement.
 *
 * The behavioural / migration-mechanics side of the contract is
 * covered by tasks 13.8 (basic migration) / 13.9 (unmapped-path) /
 * 13.10 (guard fixed-path updates) and the 12.x property tests.
 * This test is the *static* per-ADR pin.
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
 * Resolve an ADR-tracked path through either the on-disk tree
 * (pre-migration) or the plan's `from -> to` mapping (post-migration).
 *
 * Returns `{ ok: true, location }` on success, where `location` is
 * the absolute path at which the file was found (useful for failure
 * messages that mention which arm of the disjunction matched).
 *
 * Returns `{ ok: false, reason }` on failure, where `reason` describes
 * why neither arm matched (so the assertion message is actionable).
 */
function resolveTrackedPath(
  trackedPath: string,
  plan: Plan
): { ok: true; location: string } | { ok: false; reason: string } {
  const directAbs = path.join(REPO_ROOT, trackedPath);
  if (fs.existsSync(directAbs)) {
    return { ok: true, location: directAbs };
  }

  const entry = plan.moves.find((m) => m.from === trackedPath);
  if (!entry) {
    return {
      ok: false,
      reason:
        `path "${trackedPath}" does not exist on disk and has no ` +
        `plan.json entry mapping it (checked plan.moves[].from)`,
    };
  }

  const movedAbs = path.join(REPO_ROOT, entry.to);
  if (fs.existsSync(movedAbs)) {
    return { ok: true, location: movedAbs };
  }

  return {
    ok: false,
    reason:
      `path "${trackedPath}" does not exist on disk; plan maps it to ` +
      `"${entry.to}" but that target also does not exist on disk`,
  };
}

/**
 * Assert helper. Wraps `resolveTrackedPath` so each it-block stays a
 * one-liner and the failure message includes both arms of the
 * resolution attempt.
 */
function assertResolves(trackedPath: string, plan: Plan): void {
  const result = resolveTrackedPath(trackedPath, plan);
  assert.ok(
    result.ok,
    result.ok ? '' : `ADR-tracked path failed to resolve: ${result.reason}`
  );
}

describe('scripts/restructure — per-ADR path conformance', () => {
  let plan: Plan;

  before(() => {
    plan = loadPlan();
  });

  describe('ADR-001 — IGitService composite freeze', () => {
    // The composite interface is the single API surface every git
    // capability flows through. The ADR pins the *file* (path may
    // move; the type body stays byte-identical per Requirement 11.1).
    it('src/services/interfaces/IGitService.ts resolves', () => {
      assertResolves('src/services/interfaces/IGitService.ts', plan);
    });
  });

  describe('ADR-002 — module-level singletons in src/utils/', () => {
    // The OutputChannel singleton is the motivating example; the new
    // Logger module is the second adopter (design.md §Components).
    // Both must satisfy the four ADR-002 criteria post-migration; the
    // test only asserts the *path* survives — behaviour is covered by
    // adr002Conformance.test.ts (task 3.8).
    it('src/utils/outputChannel.ts resolves', () => {
      assertResolves('src/utils/outputChannel.ts', plan);
    });

    it('src/utils/logger/index.ts resolves (Logger barrel)', () => {
      assertResolves('src/utils/logger/index.ts', plan);
    });

    it('src/utils/logger/logger.ts resolves (Logger facade)', () => {
      assertResolves('src/utils/logger/logger.ts', plan);
    });

    it('src/utils/logger/levels.ts resolves', () => {
      assertResolves('src/utils/logger/levels.ts', plan);
    });

    it('src/utils/logger/correlation.ts resolves', () => {
      assertResolves('src/utils/logger/correlation.ts', plan);
    });

    it('src/utils/logger/sanitize.ts resolves', () => {
      assertResolves('src/utils/logger/sanitize.ts', plan);
    });

    it('src/utils/logger/render.ts resolves', () => {
      assertResolves('src/utils/logger/render.ts', plan);
    });

    it('src/utils/logger/sinks/types.ts resolves', () => {
      assertResolves('src/utils/logger/sinks/types.ts', plan);
    });

    it('src/utils/logger/sinks/OutputChannelSink.ts resolves', () => {
      assertResolves('src/utils/logger/sinks/OutputChannelSink.ts', plan);
    });

    it('src/utils/logger/sinks/ConsoleSink.ts resolves', () => {
      assertResolves('src/utils/logger/sinks/ConsoleSink.ts', plan);
    });
  });

  describe('ADR-003 — storage forward-compat round-trip', () => {
    // The two adopters of the unknown-bag pattern. The ADR pins the
    // round-trip *behaviour*; this test pins the file paths.
    it('src/services/ChangelistService.ts resolves', () => {
      assertResolves('src/services/ChangelistService.ts', plan);
    });

    it('src/services/ShelfService.ts resolves', () => {
      assertResolves('src/services/ShelfService.ts', plan);
    });
  });

  describe('ADR-004 — atomic-write routing policy', () => {
    // The helper module that the routing rule selects into. Pinning
    // the file makes "atomicWriteFile call sites still resolve" a
    // direct corollary (their import targets must exist).
    it('src/utils/atomicWrite.ts resolves', () => {
      assertResolves('src/utils/atomicWrite.ts', plan);
    });
  });

  describe('ADR-005 — sanitizer pass ordering', () => {
    // `sanitizeGitError` lives here. The Logger sanitizer (per ADR-002
    // and design.md) *delegates* to this helper rather than re-deriving
    // the four-pass order — so the path must resolve for the Logger
    // sanitizer's import to compile.
    it('src/utils/gitError.ts resolves', () => {
      assertResolves('src/utils/gitError.ts', plan);
    });
  });

  describe('ADR-006 — error-state binding by view type', () => {
    // The three QuickPick view-state interfaces tracked by
    // `scripts/check-quickpick-state-no-error.sh`. The guard's
    // tracked-paths list moves with the files (Requirement 11.6 + task
    // 15.4); this test just pins the files themselves.
    it('src/services/interfaces/IShelfView.ts resolves', () => {
      assertResolves('src/services/interfaces/IShelfView.ts', plan);
    });

    it('src/services/interfaces/IStashView.ts resolves', () => {
      assertResolves('src/services/interfaces/IStashView.ts', plan);
    });

    it('src/services/interfaces/IBranchComparisonView.ts resolves', () => {
      assertResolves(
        'src/services/interfaces/IBranchComparisonView.ts',
        plan
      );
    });
  });

  describe('ADR-007 — structural guards as a complementary tool', () => {
    // The guard scripts live under `scripts/`, not `src/`, so they
    // are NOT governed by `plan.json`. The migration script updates
    // their tracked-paths lists in place rather than moving them
    // (design.md §Migration script architecture, "boundary discipline").
    //
    // Wave 15.1 renames `check-output-channel-test-surface.sh` to
    // `check-test-only-surface.sh` to generalize across both
    // `__resetOutputChannelForTest` and `__resetLoggerForTest`. The
    // assertions below accept either name so the test passes against
    // both pre- and post-rename trees.
    function scriptExists(rel: string): boolean {
      return fs.existsSync(path.join(REPO_ROOT, rel));
    }

    it('scripts/check-quickpick-state-no-error.sh exists', () => {
      assert.ok(
        scriptExists('scripts/check-quickpick-state-no-error.sh'),
        'ADR-007 guard `check-quickpick-state-no-error.sh` is missing'
      );
    });

    it('scripts/check-action-toasts-sanitized.sh exists', () => {
      assert.ok(
        scriptExists('scripts/check-action-toasts-sanitized.sh'),
        'ADR-007 guard `check-action-toasts-sanitized.sh` is missing'
      );
    });

    it('scripts/check-watcher-families-registered.mjs exists', () => {
      assert.ok(
        scriptExists('scripts/check-watcher-families-registered.mjs'),
        'ADR-007 guard `check-watcher-families-registered.mjs` is missing'
      );
    });

    it(
      'OutputChannel test-surface guard exists ' +
        '(pre-rename: check-output-channel-test-surface.sh, ' +
        'post-rename: check-test-only-surface.sh)',
      () => {
        const preRename = scriptExists(
          'scripts/check-output-channel-test-surface.sh'
        );
        const postRename = scriptExists(
          'scripts/check-test-only-surface.sh'
        );
        assert.ok(
          preRename || postRename,
          'Neither `scripts/check-output-channel-test-surface.sh` nor ' +
            '`scripts/check-test-only-surface.sh` exists. The TL-58 / ' +
            'task-15.1 guard is the one that pins ' +
            '`__resetOutputChannelForTest` (and post-rename also ' +
            '`__resetLoggerForTest`) as test-only seams; the migration ' +
            'must keep one of the two names live.'
        );
      }
    );
  });

  describe('ADR-008 — watcher families and the cleanup-registry pattern', () => {
    // The `_watcherMaps` registry plus `setupRepositoryWatcher` /
    // `removeRepositoryWatcher` / `dispose()` walker all live in
    // `GitService.ts`. The ADR's path list is one file.
    it('src/services/GitService.ts resolves', () => {
      assertResolves('src/services/GitService.ts', plan);
    });
  });

  describe('ADR-009 — webview state ownership: host leads, JS follows', () => {
    // The host-as-source-of-truth pattern is per-class behaviour. The
    // ADR's tracked paths are the webview-host classes that
    // implement it (MergeView, CommitToolWindow) plus the dialog hosts
    // that share the same registration shape (CommitDialog,
    // MergeDialog, the Pull/Push dialogs, etc.). Each must resolve.
    it('src/services/MergeView.ts resolves', () => {
      assertResolves('src/services/MergeView.ts', plan);
    });

    it('src/services/CommitToolWindow.ts resolves', () => {
      assertResolves('src/services/CommitToolWindow.ts', plan);
    });

    it('src/services/CommitDialog.ts resolves', () => {
      assertResolves('src/services/CommitDialog.ts', plan);
    });

    it('src/services/MergeDialog.ts resolves', () => {
      assertResolves('src/services/MergeDialog.ts', plan);
    });

    it('src/services/PullDialog.ts resolves', () => {
      assertResolves('src/services/PullDialog.ts', plan);
    });

    it('src/services/PushDialog.ts resolves', () => {
      assertResolves('src/services/PushDialog.ts', plan);
    });
  });

  describe('ADR-010 — visual parity discipline', () => {
    // Per Requirement 11.9, no snapshot fixture under `docs/parity/`
    // or its referenced media may be moved or renamed by this
    // restructure. The plan.json scope is `src/`; `docs/parity/`
    // is explicitly outside the migration script's allowed write
    // roots (design.md §Migration script architecture, "boundary
    // discipline"). The assertion is therefore plain existence —
    // no plan-resolution arm — because plan.json must not touch
    // these paths.
    function existsVerbatim(rel: string): boolean {
      return fs.existsSync(path.join(REPO_ROOT, rel));
    }

    function isNotInPlan(rel: string): boolean {
      return !plan.moves.some((m) => m.from === rel || m.to === rel);
    }

    it('docs/parity/git-log-graph.md exists and is not in plan.json', () => {
      assert.ok(
        existsVerbatim('docs/parity/git-log-graph.md'),
        '`docs/parity/git-log-graph.md` must remain at its current path'
      );
      assert.ok(
        isNotInPlan('docs/parity/git-log-graph.md'),
        '`docs/parity/git-log-graph.md` must NOT appear in plan.json ' +
          '(Requirement 11.9: visual-parity snapshots must not move)'
      );
    });

    it('docs/parity/repo-states.md exists and is not in plan.json', () => {
      assert.ok(
        existsVerbatim('docs/parity/repo-states.md'),
        '`docs/parity/repo-states.md` must remain at its current path'
      );
      assert.ok(
        isNotInPlan('docs/parity/repo-states.md'),
        '`docs/parity/repo-states.md` must NOT appear in plan.json'
      );
    });

    it('docs/parity/accessibility.md exists and is not in plan.json', () => {
      assert.ok(
        existsVerbatim('docs/parity/accessibility.md'),
        '`docs/parity/accessibility.md` must remain at its current path'
      );
      assert.ok(
        isNotInPlan('docs/parity/accessibility.md'),
        '`docs/parity/accessibility.md` must NOT appear in plan.json'
      );
    });

    it('no plan.json move touches anything under docs/parity/', () => {
      const offending = plan.moves.filter(
        (m) =>
          m.from.startsWith('docs/parity/') ||
          m.to.startsWith('docs/parity/')
      );
      assert.deepStrictEqual(
        offending,
        [],
        'plan.json must not contain entries under docs/parity/ ' +
          '(Requirement 11.9). Offending entries:\n' +
          offending.map((m) => `  ${m.from} -> ${m.to}`).join('\n')
      );
    });
  });
});
