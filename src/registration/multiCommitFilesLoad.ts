/**
 * Loads the changed files behind a multi-commit log selection.
 *
 * A selection of N commits costs N `git diff` calls, and the gesture that
 * produces it (shift+arrow held down) changes the selection on every row. The
 * loader therefore owns two bounds: at most
 * {@link MULTI_DETAILS_COMMIT_CAP} commits per selection, and at most
 * {@link MULTI_DETAILS_LOAD_CONCURRENCY} git processes in flight.
 */

import type { IRepository } from '../services';
import type { IChangedFile } from '../git-core/interfaces/IGitToolWindowProvider';
import { MULTI_DETAILS_COMMIT_CAP } from '../git-core/gitToolWindow/provider/detailsPanelModel';
import { createStalenessGuard } from './stalenessGuard';
import { mapWithLimit } from '../utils/mapWithLimit';

/** Git processes in flight for one selection's changed-files load. */
export const MULTI_DETAILS_LOAD_CONCURRENCY = 4;

export interface IMultiCommitFilesLoadDeps {
  /** Repository that contains `hash`, or undefined when none does. */
  resolveRepo(hash: string): Promise<IRepository | undefined>;
  loadChangedFiles(repo: IRepository, hash: string): Promise<IChangedFile[]>;
  /**
   * Hand the finished load to the panel. `loadedHashes` is the subset the cap
   * allowed, so the panel can describe what it is showing against what it was
   * asked for; `errorsByHash` carries the reason each failed commit
   * contributed nothing, so an unreadable diff is not painted as "no changes".
   */
  publish(
    hashes: readonly string[],
    filesByHash: ReadonlyMap<string, IChangedFile[]>,
    loadedHashes: readonly string[],
    errorsByHash: ReadonlyMap<string, string>
  ): void;
}

export interface IMultiCommitFilesLoader {
  load(hashes: readonly string[]): Promise<void>;
  /**
   * Abandon whatever is in flight. A selection that shrinks below two commits
   * fires no new load, so without this the queued diffs for the selection the
   * user just left run to completion.
   */
  invalidate(): void;
}

/**
 * Build the `onDidSelectCommits` handler.
 *
 * The returned handler is single-flight by generation, not by promise: a newer
 * selection makes every older invocation stop before its next git call and
 * never publish. Superseded work is abandoned where it costs — before the
 * spawn — rather than run to completion and discarded at the paint seam.
 */
export function createMultiCommitFilesLoader(
  deps: IMultiCommitFilesLoadDeps
): IMultiCommitFilesLoader {
  const guard = createStalenessGuard();

  return {
    invalidate: (): void => {
      guard.bump();
    },

    load: async (hashes: readonly string[]): Promise<void> => {
      const generation = guard.bump();
      const loadedHashes = hashes.slice(0, MULTI_DETAILS_COMMIT_CAP);
      const filesByHash = new Map<string, IChangedFile[]>();
      const errorsByHash = new Map<string, string>();

      await mapWithLimit(loadedHashes, MULTI_DETAILS_LOAD_CONCURRENCY, async (hash) => {
        if (!guard.isCurrent(generation)) {
          return;
        }
        // Everything per-commit is contained: one commit that cannot be
        // resolved or read contributes no files and its own reason, rather
        // than rejecting the fan-out and leaving the selection unpainted.
        try {
          const repo = await deps.resolveRepo(hash);
          if (!repo || !guard.isCurrent(generation)) {
            return;
          }
          filesByHash.set(hash, await deps.loadChangedFiles(repo, hash));
        } catch (err) {
          filesByHash.set(hash, []);
          errorsByHash.set(hash, err instanceof Error ? err.message : String(err));
        }
      });

      if (!guard.isCurrent(generation)) {
        return;
      }
      deps.publish(hashes, filesByHash, loadedHashes, errorsByHash);
    },
  };
}
