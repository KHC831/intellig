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
   * asked for.
   */
  publish(
    hashes: readonly string[],
    filesByHash: ReadonlyMap<string, IChangedFile[]>,
    loadedHashes: readonly string[]
  ): void;
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
): (hashes: readonly string[]) => Promise<void> {
  const guard = createStalenessGuard();

  return async (hashes: readonly string[]): Promise<void> => {
    const generation = guard.bump();
    const loadedHashes = hashes.slice(0, MULTI_DETAILS_COMMIT_CAP);
    const filesByHash = new Map<string, IChangedFile[]>();

    await mapWithLimit(loadedHashes, MULTI_DETAILS_LOAD_CONCURRENCY, async (hash) => {
      if (!guard.isCurrent(generation)) {
        return;
      }
      const repo = await deps.resolveRepo(hash);
      if (!repo || !guard.isCurrent(generation)) {
        return;
      }
      try {
        filesByHash.set(hash, await deps.loadChangedFiles(repo, hash));
      } catch {
        // One unreadable commit must not blank the whole combined tree;
        // it simply contributes no files.
        filesByHash.set(hash, []);
      }
    });

    if (!guard.isCurrent(generation)) {
      return;
    }
    deps.publish(hashes, filesByHash, loadedHashes);
  };
}
