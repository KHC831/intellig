/**
 * Rollback / Revert Local Changes — pure argument-narrowing and confirm-text
 * helpers for `intellig.rollbackChanges`: narrow the arg, re-derive it
 * against fresh porcelain, build the confirm text.
 */

import { statusCodeToFileStatus } from '../../git-core/gitParser';
import { getLogger } from '../../utils/logger';
import type {
  IRollbackChange,
  IFileStatus,
  FileStatus,
} from '../../git-core/interfaces/IGitService';

/**
 * Build the modal confirmation text for the Rollback / Revert Local Changes
 * action — IntelliJ's RollbackChangesDialog lists every affected file before
 * the (irreversible) revert. Returns the headline + a `detail` block that
 * enumerates the files and, when untracked files are in the set, spells out
 * that those will be deleted from disk (no recovery).
 *
 * Pure so the file-listing + data-loss wording can be unit-tested without the
 * VS Code modal.
 */
export function buildRollbackConfirmMessage(changes: readonly IRollbackChange[]): {
  message: string;
  detail: string;
} {
  const count = changes.length;
  const noun = count === 1 ? 'file' : 'files';
  const untracked = changes.filter((c) => c.status === 'untracked');

  const lines = changes.map((c) => `• ${c.path} (${c.status})`);
  let detail = `The following ${count} ${noun} will be reverted to their last committed state:\n${lines.join('\n')}`;
  if (untracked.length > 0) {
    const un = untracked.length === 1 ? 'file is' : 'files are';
    detail += `\n\n${untracked.length} of these ${un} untracked and will be DELETED from disk — this cannot be undone.`;
  }

  return {
    message: `Roll back local changes to ${count} ${noun}? This reverts your changes and cannot be undone.`,
    detail,
  };
}

const ROLLBACK_STATUSES = new Set<FileStatus>([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'untracked',
]);

/**
 * Narrow the untyped command argument into a list of {@link IRollbackChange}.
 * Callers (webview / context menu) pass `{ path, status }[]`; anything that
 * doesn't match — including the palette's no-arg invocation — yields
 * `undefined`, signalling the command to gather + prompt for the file set.
 *
 * A malformed entry (bad path, empty path, non-rollback-able status) is
 * dropped rather than failing the whole array — the surviving entries are
 * still all genuine selections, so the rollback proceeds on the filtered set
 * rather than falling back to a repo-wide gather+prompt. The drop is logged,
 * since silently rolling back fewer files than the confirm modal's own count
 * implies would otherwise go unnoticed.
 */
export function extractRollbackChanges(arg: unknown): IRollbackChange[] | undefined {
  if (!Array.isArray(arg)) {
    return undefined;
  }
  const out: IRollbackChange[] = [];
  for (const item of arg) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { path?: unknown }).path === 'string' &&
      (item as { path: string }).path.length > 0 &&
      ROLLBACK_STATUSES.has((item as { status?: FileStatus }).status as FileStatus)
    ) {
      // `oldPath` (a rename/copy's HEAD path) must survive the narrowing —
      // dropping it makes the rollback delete the renamed file without
      // restoring the original.
      const oldPath = (item as { oldPath?: unknown }).oldPath;
      out.push({
        path: (item as { path: string }).path,
        status: (item as { status: FileStatus }).status,
        ...(typeof oldPath === 'string' && oldPath.length > 0 ? { oldPath } : {}),
      });
    }
  }
  const droppedCount = arg.length - out.length;
  if (droppedCount > 0) {
    getLogger()
      .child({ component: 'commitRollbackChanges' })
      .warn('Dropped malformed rollback change entries', { droppedCount, kept: out.length });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Re-derive each arg-supplied change's status and rename source from a fresh
 * `git status` read. Arg callers (webview rows, context menus) often carry a
 * bare `{path, status}` — and a stale or oldPath-less 'renamed' entry makes
 * the rollback delete the renamed file WITHOUT restoring the original. The
 * porcelain read is authoritative, so it wins whenever the path appears in
 * it; a path absent from status keeps the caller's claim (the git op then
 * fails informatively rather than us guessing).
 */
export function enrichRollbackChanges(
  changes: readonly IRollbackChange[],
  statuses: readonly IFileStatus[]
): IRollbackChange[] {
  const byPath = new Map(statuses.map((s) => [s.path, s]));
  return changes.map((c) => {
    const s = byPath.get(c.path);
    if (!s) {
      return c;
    }
    return {
      path: c.path,
      status: statusCodeToFileStatus(s.indexStatus, s.workTreeStatus),
      ...(s.renamed ? { oldPath: s.renamed } : {}),
    };
  });
}
