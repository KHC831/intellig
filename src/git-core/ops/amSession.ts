/**
 * `git am` session recovery ops (`--continue` / `--skip` / `--abort`) — the
 * single implementation shared by PatchService (Apply Patch flows) and
 * ConflictResolutionService (the Resolve Conflicts dialog's Continue during a
 * live am session), so the two surfaces cannot drift on outcome
 * classification.
 *
 * vscode-free: outcomes are returned as data with pre-sanitized failure text;
 * callers own the toasts.
 */

import { GitCli } from '../gitCli';
import { NON_INTERACTIVE_GIT_ENV } from '../gitEnv';
import { parseStatus, isConflictedStatus } from '../gitParser';
import { sanitizeGitError } from '../gitError';

/** Outcome of one {@link runAmSessionOp} invocation. */
export interface IAmSessionOpOutcome {
  /** `true` when git finished the operation cleanly. */
  success: boolean;
  /**
   * Unmerged paths present after a failed continue/skip (the next mailbox
   * patch collided). Callers route these to the Resolve Conflicts dialog.
   */
  conflictPaths?: string[];
  /** Sanitized git error for non-conflict failures. */
  failureReason?: string;
}

/**
 * Run one `git am` session op. Non-zero exit with unmerged files present
 * reports them as `conflictPaths`; any other failure surfaces a sanitized
 * `failureReason`. The editor is pinned to a no-op: `am --continue` commits
 * the patch with its stored message and must not try to open an editor under
 * the non-TTY spawn.
 */
export async function runAmSessionOp(
  gitCli: GitCli,
  cwd: string,
  flag: '--continue' | '--skip' | '--abort'
): Promise<IAmSessionOpOutcome> {
  const result = await gitCli.exec(['am', flag], {
    cwd,
    throwOnError: false,
    env: { ...process.env, ...NON_INTERACTIVE_GIT_ENV },
  });
  if (result.exitCode === 0) {
    return { success: true };
  }
  const statusResult = await gitCli.exec(['status', '--porcelain', '-z'], { cwd });
  const conflictPaths = parseStatus(statusResult.stdout)
    .filter(isConflictedStatus)
    .map((f) => f.path);
  if (conflictPaths.length > 0) {
    return { success: false, conflictPaths };
  }
  return {
    success: false,
    failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
  };
}
