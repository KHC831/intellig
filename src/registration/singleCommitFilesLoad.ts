/**
 * Loads the changed files behind a single-commit log selection.
 *
 * The sibling of {@link createMultiCommitFilesLoader}, and deliberately the same
 * shape: every way the load can fail — no repository contains the commit, or
 * the diff itself throws — publishes a payload carrying the reason. A silent
 * bail paints the commit as "changed nothing", and the panel only re-asks for a
 * commit whose payload is missing, so a bail also leaves the selection unable to
 * recover without the user selecting away and back.
 */

import type { IRepository } from '../services';
import type { IChangedFile } from '../git-core/interfaces/IGitToolWindowProvider';

export interface ISingleCommitFilesLoadDeps {
  /** Repository that contains `hash`, or undefined when none does. */
  resolveRepo(hash: string): Promise<IRepository | undefined>;
  loadChangedFiles(repo: IRepository, hash: string): Promise<IChangedFile[]>;
  /**
   * Hand the finished load to the panel. `error` carries the reason the commit
   * contributed no files, so an unreadable or unresolvable commit is not
   * painted as an empty changeset.
   */
  publish(hash: string, files: IChangedFile[], error?: unknown): void;
  /** Side work to kick off once the repository is known (containing branches). */
  onRepoResolved?(repo: IRepository, hash: string): void;
}

/** Build the `onDidSelectCommit` handler. */
export function createSingleCommitFilesLoader(
  deps: ISingleCommitFilesLoadDeps
): (hash: string) => Promise<void> {
  return async (hash: string): Promise<void> => {
    let repo: IRepository | undefined;
    try {
      repo = await deps.resolveRepo(hash);
    } catch (err) {
      deps.publish(hash, [], err);
      return;
    }
    if (!repo) {
      deps.publish(hash, [], new Error('No repository found for this commit'));
      return;
    }
    deps.onRepoResolved?.(repo, hash);
    try {
      deps.publish(hash, await deps.loadChangedFiles(repo, hash));
    } catch (err) {
      deps.publish(hash, [], err);
    }
  };
}
