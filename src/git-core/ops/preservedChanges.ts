/**
 * Save-local-changes bracket for operations that need a clean working tree —
 * the git4idea `GitPreservingProcess` counterpart (save → run → restore).
 *
 * Several features need this bracket: HEAD-rewrite flows (drop/squash/
 * reword/drop-selected-changes), dirty-tree checkout ("Stash & Switch"),
 * and any future op that git refuses on a dirty tree. Each previously
 * re-implemented it privately (or forgot it — Drop Selected Changes
 * silently absorbed staged work into the rewritten commit), so the save/
 * restore pieces live here as the single source of truth.
 *
 * Split into `saveLocalChanges` / `restoreLocalChanges` rather than only a
 * closure bracket because real flows have branch-dependent restore points:
 * a rebase that PAUSES must keep the stash parked (popping onto a mid-rebase
 * tree would be wrong), while an aborted or completed one restores
 * immediately. {@link withSavedChanges} is the convenience bracket for the
 * simple always-restore cases.
 *
 * vscode-free: outcomes are returned as data (with pre-sanitized detail
 * strings) so callers own the toasts and the module stays unit-testable.
 */

import { GitCli, buildGitArgs } from '../gitCli';
import { FULL_SHA_RE } from '../gitDirMarkers';
import { parseStatus, isConflictedStatus } from '../gitParser';
import { sanitizeGitError } from '../gitError';
import { restorePathsToHead } from '../worktree/restoreToHead';
import { getLogger } from '../../utils/logger';

/** Outcome of {@link saveLocalChanges}. */
export type SaveLocalChangesResult =
  /** Working tree was already clean — nothing saved, nothing to restore. */
  | { status: 'clean' }
  /** Unmerged files present — the operation must be refused, not stashed over. */
  | { status: 'blocked-unmerged' }
  /**
   * Dirty tree stashed (incl. untracked); caller owes a restore. `stashSha`
   * pins the CREATED entry so the restore pops exactly it — `stash@{0}` is
   * not stable when a concurrent bracket or the user pushes another stash
   * mid-operation (git4idea's GitStashChangesSaver records the same pin).
   */
  | { status: 'saved'; stashSha: string };

/**
 * Read-only working-tree probe shared by the save bracket and flows that
 * delegate the actual save elsewhere (e.g. a rebase run with `--autostash`,
 * where git owns the stash but unmerged files must still refuse up front).
 * Conflict detection uses the canonical porcelain parse (`-z` +
 * {@link isConflictedStatus}) so AA/DD conflicts are caught alongside
 * U-marked ones.
 */
export async function detectLocalChanges(
  gitCli: GitCli,
  cwd: string
): Promise<'clean' | 'dirty' | 'blocked-unmerged'> {
  const status = await gitCli.exec(['status', '--porcelain', '-z'], { cwd, throwOnError: true });
  const entries = parseStatus(status.stdout);
  if (entries.length === 0) {
    return 'clean';
  }
  if (entries.some(isConflictedStatus)) {
    return 'blocked-unmerged';
  }
  return 'dirty';
}

/**
 * Stash the working tree (including untracked files) when dirty, refusing
 * when unmerged files are present ({@link detectLocalChanges} is the probe).
 *
 * @param label - Stash message, e.g. `Auto-stash before drop commit`.
 */
export async function saveLocalChanges(
  gitCli: GitCli,
  cwd: string,
  label: string
): Promise<SaveLocalChangesResult> {
  const detected = await detectLocalChanges(gitCli, cwd);
  if (detected === 'clean') {
    return { status: 'clean' };
  }
  if (detected === 'blocked-unmerged') {
    return { status: 'blocked-unmerged' };
  }
  await gitCli.exec(['stash', 'push', '--include-untracked', '-m', label], {
    cwd,
    throwOnError: true,
  });
  const sha = await gitCli.exec(['rev-parse', 'refs/stash'], { cwd, throwOnError: true });
  return { status: 'saved', stashSha: sha.stdout.trim() };
}

/** Outcome of {@link restoreLocalChanges}. */
export type RestoreLocalChangesResult =
  | { status: 'restored' }
  /**
   * The pop failed — typically a conflict with the operation's result. The
   * changes stay parked in the stash; `detail` is pre-sanitized for display.
   */
  | { status: 'failed'; detail: string };

/**
 * Pop the PINNED stash entry back onto the working tree. The entry is looked
 * up by its commit sha at pop time — its `stash@{N}` position may have moved
 * since the save (a concurrent bracket, a user stash, an autostash all
 * renumber the stack), and popping the head blindly would apply the WRONG
 * stash while stranding the saved changes. Never throws: a failed pop
 * (conflict, spawn fault, vanished entry) leaves the changes safely in the
 * stash and reports the sanitized reason for the caller to surface.
 */
export async function restoreLocalChanges(
  gitCli: GitCli,
  cwd: string,
  stashSha: string
): Promise<RestoreLocalChangesResult> {
  try {
    const list = await gitCli.exec(['stash', 'list', '--format=%gd\x1f%H'], { cwd });
    if (list.exitCode !== 0) {
      return {
        status: 'failed',
        detail: sanitizeGitError((list.stderr || list.stdout).trim() || 'stash list failed'),
      };
    }
    const row = list.stdout
      .split('\n')
      .map((line) => line.split('\x1f'))
      .find(([, sha]) => sha === stashSha);
    if (!row) {
      return {
        status: 'failed',
        detail: 'the saved stash entry is no longer in the stash list',
      };
    }
    // The ref comes from git's own `%gd` output (`stash@{N}`), not user input.
    const res = await gitCli.exec(['stash', 'pop', row[0]], { cwd });
    if (res.exitCode === 0) {
      return { status: 'restored' };
    }
    return {
      status: 'failed',
      detail: sanitizeGitError((res.stderr || res.stdout).trim() || 'stash pop failed'),
    };
  } catch (error) {
    return {
      status: 'failed',
      detail: sanitizeGitError(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Pre-apply restore token for a partially-applied patch: the working-state
 * snapshot pinned by SHA (absent when the tree was clean — pre-apply state is
 * then HEAD) plus the on-disk paths the patch touched. Produced by
 * PatchService before a plain 3-way apply; consumed by the Resolve Conflicts
 * dialog's Abort for `operation: 'applyPatch'`.
 */
export interface IPreApplyState {
  /** `git stash create` snapshot of the pre-apply working state, when dirty. */
  stashSha?: string;
  /** Repo-relative paths the patch touched (cleanly-applied siblings included). */
  patchPaths: string[];
}

/**
 * Snapshot the current working state WITHOUT disturbing the tree or the stash
 * stack: `git stash create` writes the stash-shaped commit and returns its
 * SHA, but stores no ref — so a bracket that is never restored leaves nothing
 * behind (git4idea's rollback label analog; a `stash push` here would change
 * what the operation applies onto). Returns undefined when the tree is clean
 * or the snapshot fails (callers degrade to HEAD as the restore source).
 */
export async function createWorkingStateSnapshot(
  gitCli: GitCli,
  cwd: string,
  label: string
): Promise<string | undefined> {
  try {
    const res = await gitCli.exec(['stash', 'create', label], { cwd, throwOnError: false });
    if (res.exitCode !== 0) {
      return undefined;
    }
    const sha = res.stdout.trim();
    return FULL_SHA_RE.test(sha) ? sha : undefined;
  } catch (error) {
    getLogger().debug('createWorkingStateSnapshot failed (degrading to HEAD source)', {
      cwd,
      err: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Restore the patch-touched paths to their pre-apply state:
 *  - paths present in the snapshot (or HEAD when the tree was clean) are
 *    checked out from that tree — content AND index entry, which also
 *    resolves any unmerged stages the 3-way apply left behind;
 *  - paths absent from it were CREATED by the patch (a pre-apply untracked
 *    file would have made `git apply` refuse outright) — they are unindexed
 *    and removed through the sanctioned restore-to-HEAD writer.
 * Untouched paths (local changes outside the patch) are never visited.
 *
 * Index-fidelity note: a restored path's index entry gets the snapshot's
 * WORKTREE content (`git stash create`'s primary tree), so a pre-apply
 * unstaged modification comes back staged. Worktree bytes are exact — the
 * same contract as the reference's local-history rollback, which restores
 * file content only (PatchApplier.java:287-310).
 *
 * Never throws: a failed restore reports the sanitized reason for the caller
 * to surface, leaving whatever state git got to (no destructive retry).
 */
export async function restorePreApplyState(
  gitCli: GitCli,
  cwd: string,
  state: IPreApplyState
): Promise<RestoreLocalChangesResult> {
  if (state.patchPaths.length === 0) {
    return {
      status: 'failed',
      detail: 'the patch reported no touched files, so there is nothing to restore safely',
    };
  }
  try {
    const source = state.stashSha ?? 'HEAD';
    const lsRes = await gitCli.exec(
      buildGitArgs('ls-tree', ['-r', '-z', '--name-only'], [source], state.patchPaths),
      { cwd, throwOnError: true }
    );
    const present = new Set(lsRes.stdout.split('\0').filter((p) => p.length > 0));
    const restorePaths = state.patchPaths.filter((p) => present.has(p));
    const createdPaths = state.patchPaths.filter((p) => !present.has(p));

    if (restorePaths.length > 0) {
      await gitCli.exec(buildGitArgs('checkout', [], [source], restorePaths), {
        cwd,
        throwOnError: true,
      });
    }
    if (createdPaths.length > 0) {
      await restorePathsToHead(
        gitCli,
        cwd,
        createdPaths.map((path) => ({ path, removeFromDiskIfAbsentFromHead: true }))
      );
    }
    return { status: 'restored' };
  } catch (error) {
    return {
      status: 'failed',
      detail: sanitizeGitError(error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Outcome of {@link withSavedChanges}. */
export type WithSavedChangesOutcome<T> =
  /** Unmerged files — `op` never ran. */
  | { status: 'blocked-unmerged' }
  /**
   * `op` ran. `restore` is `'not-needed'` when the tree was clean, else the
   * restore outcome (a `'failed'` restore means the changes are parked in
   * the stash — surface it).
   */
  | {
      status: 'done';
      result: T;
      restore: RestoreLocalChangesResult | { status: 'not-needed' };
    };

/**
 * Simple always-restore bracket: save → `op` → restore. The restore runs
 * whether `op` resolves or throws (a thrown error is re-thrown AFTER the
 * restore attempt; its restore outcome is logged since it cannot be
 * returned). Use the split save/restore functions directly when the flow
 * has branch-dependent restore points (e.g. a pausable rebase).
 */
export async function withSavedChanges<T>(
  gitCli: GitCli,
  cwd: string,
  label: string,
  op: () => Promise<T>
): Promise<WithSavedChangesOutcome<T>> {
  const saved = await saveLocalChanges(gitCli, cwd, label);
  if (saved.status === 'blocked-unmerged') {
    return { status: 'blocked-unmerged' };
  }

  let result: T;
  try {
    result = await op();
  } catch (error) {
    if (saved.status === 'saved') {
      const restore = await restoreLocalChanges(gitCli, cwd, saved.stashSha);
      if (restore.status === 'failed') {
        getLogger().warn('withSavedChanges: restore after failed op did not apply cleanly', {
          cwd,
          detail: restore.detail,
        });
      }
    }
    throw error;
  }

  if (saved.status === 'clean') {
    return { status: 'done', result, restore: { status: 'not-needed' } };
  }
  return {
    status: 'done',
    result,
    restore: await restoreLocalChanges(gitCli, cwd, saved.stashSha),
  };
}
