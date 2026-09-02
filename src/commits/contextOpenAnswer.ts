/**
 * The Commit tool window's `contextOpen` ping: the webview right-clicks a
 * row and the host answers with `showRowContextMenu`. Every arm — file,
 * changelist, shelf, stash — repeats the same shape: resolve whatever the
 * ping is about, then either post the message back or send nothing. What
 * varies per arm (whether a missing row bails or falls back, what the
 * message's row-identifying fields are, whether a lookup can throw) stays
 * entirely inside the arm's own `lookup`; this carries only the two things
 * every one of them repeated.
 */

import type { CommitToolWindowOutbound } from './commitToolWindow.protocol';

/** `lookup` returns this to answer the ping with nothing. */
export const CONTEXT_OPEN_BAIL = Symbol('contextOpen.bail');

export async function answerContextOpen(
  showContextMenu: (message: CommitToolWindowOutbound) => Promise<void> | void,
  lookup: () =>
    | CommitToolWindowOutbound
    | typeof CONTEXT_OPEN_BAIL
    | Promise<CommitToolWindowOutbound | typeof CONTEXT_OPEN_BAIL>
): Promise<void> {
  const message = await lookup();
  if (message === CONTEXT_OPEN_BAIL) {
    return;
  }
  await showContextMenu(message);
}
