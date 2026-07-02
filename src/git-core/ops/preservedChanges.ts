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

import { GitCli } from '../gitCli';
import { parseStatus, isConflictedStatus } from '../gitParser';
import { sanitizeGitError } from '../gitError';
import { getLogger } from '../../utils/logger';

/** Outcome of {@link saveLocalChanges}. */
export type SaveLocalChangesResult =
  /** Working tree was already clean — nothing saved, nothing to restore. */
  | { status: 'clean' }
  /** Unmerged files present — the operation must be refused, not stashed over. */
  | { status: 'blocked-unmerged' }
  /** Dirty tree stashed (incl. untracked); caller owes a restore. */
  | { status: 'saved' };

/**
 * Stash the working tree (including untracked files) when dirty, refusing
 * when unmerged files are present. Conflict detection uses the canonical
 * porcelain parse (`-z` + {@link isConflictedStatus}) so AA/DD conflicts are
 * caught alongside U-marked ones.
 *
 * @param label - Stash message, e.g. `Auto-stash before drop commit`.
 */
export async function saveLocalChanges(
  gitCli: GitCli,
  cwd: string,
  label: string
): Promise<SaveLocalChangesResult> {
  const status = await gitCli.exec(['status', '--porcelain', '-z'], { cwd, throwOnError: true });
  const entries = parseStatus(status.stdout);
  if (entries.length === 0) {
    return { status: 'clean' };
  }
  if (entries.some(isConflictedStatus)) {
    return { status: 'blocked-unmerged' };
  }
  await gitCli.exec(['stash', 'push', '--include-untracked', '-m', label], {
    cwd,
    throwOnError: true,
  });
  return { status: 'saved' };
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
 * Pop the most recent stash entry back onto the working tree. Never throws:
 * a failed pop (conflict, spawn fault) leaves the changes safely in the
 * stash and reports the sanitized reason for the caller to surface.
 */
export async function restoreLocalChanges(
  gitCli: GitCli,
  cwd: string
): Promise<RestoreLocalChangesResult> {
  try {
    const res = await gitCli.exec(['stash', 'pop'], { cwd });
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
      const restore = await restoreLocalChanges(gitCli, cwd);
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
  return { status: 'done', result, restore: await restoreLocalChanges(gitCli, cwd) };
}
