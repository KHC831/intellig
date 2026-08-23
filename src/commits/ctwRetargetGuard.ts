/**
 * Whether a Commit-window message still refers to the repository it was
 * rendered against.
 *
 * The repository selector switches this view's target synchronously and reloads
 * asynchronously, so for the length of a `git status` (plus the model push's
 * 300ms coalescer) the rows on screen belong to the previous repo while actions
 * resolve against the new one. Every outbound message carries the root its rows
 * came from; anything acting on repo CONTENT is dropped when that stamp is
 * stale — including the commit and stash paths, which mutate the index.
 *
 * Pure policy, no vscode: the view asks, this decides.
 */

/**
 * Messages that change how the view RENDERS rather than what it acts on.
 * Switching repo and immediately clicking the Shelf tab is legitimate, so these
 * are exempt. Everything else is guarded, which means a message type added
 * later is guarded by default rather than silently opting out.
 */
const VIEW_PREFERENCE_MESSAGES: ReadonlySet<string> = new Set([
  'tabChange',
  'changesGroupingChange',
  'shelfTabFilterChange',
  'gearAction',
]);

/**
 * True when `message` acts on repo content and its stamp is no longer the
 * sticky target. An unstamped message (an older webview) is never stale, so a
 * version skew degrades to the previous behaviour rather than going silent.
 */
export function isStaleForTarget(
  message: { type: string; repoRoot?: string },
  isCurrentRoot: (root: string) => boolean
): boolean {
  if (VIEW_PREFERENCE_MESSAGES.has(message.type) || message.repoRoot === undefined) {
    return false;
  }
  return !isCurrentRoot(message.repoRoot);
}
