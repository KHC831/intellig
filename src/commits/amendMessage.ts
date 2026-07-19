/**
 * Amend-mode commit-message bookkeeping shared by {@link CommitDialog} and
 * {@link CommitToolWindow} (reference AmendCommitHandlerImpl): entering amend
 * swaps HEAD's message into the composer while saving the current draft;
 * leaving amend restores the draft only when the user hasn't edited the
 * amend message.
 */

import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { getLogger } from '../utils/logger';

/**
 * HEAD's full commit message (subject, blank line, body), or undefined when
 * the log is empty or unreadable (empty repo / genuine fault — log+degrade,
 * the caller simply gets no prefill).
 */
export async function loadHeadCommitMessage(
  gitService: IGitService,
  repo: IRepository | undefined
): Promise<string | undefined> {
  if (!repo) {
    return undefined;
  }
  try {
    const commits = await gitService.getLog(repo, { maxCount: 1 });
    if (commits.length === 0) {
      return undefined;
    }
    const head = commits[0];
    return head.body ? `${head.message}\n\n${head.body}` : head.message;
  } catch (error) {
    getLogger()
      .child({ component: 'amendMessage' })
      .debug('loadHeadCommitMessage failed', {
        err: error instanceof Error ? error.message : String(error),
      });
    return undefined;
  }
}

/** See module doc. One instance per commit surface. */
export class AmendMessageTracker {
  private _amendData?: { beforeAmendMessage: string; amendMessage: string };

  /**
   * Entering amend: returns the text the composer should show (HEAD's
   * message), or undefined to leave the composer untouched (no HEAD message,
   * or the draft already equals it). Saves the draft for {@link exitAmend}.
   */
  async enterAmend(
    currentMessage: string,
    loadHead: () => Promise<string | undefined>
  ): Promise<string | undefined> {
    const amendMessage = await loadHead();
    if (amendMessage === undefined || amendMessage === currentMessage) {
      return undefined;
    }
    this._amendData = { beforeAmendMessage: currentMessage, amendMessage };
    return amendMessage;
  }

  /**
   * Leaving amend: returns the saved pre-amend draft when the composer still
   * shows the unedited amend message, else undefined (user edits win).
   */
  exitAmend(currentMessage: string): string | undefined {
    const data = this._amendData;
    this._amendData = undefined;
    if (!data || data.amendMessage !== currentMessage) {
      return undefined;
    }
    return data.beforeAmendMessage;
  }
}
