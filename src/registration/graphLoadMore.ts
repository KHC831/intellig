import * as vscode from 'vscode';
import type { IRepository } from '../git-core/interfaces/IGitService';

/**
 * Scroll-to-bottom "load more" for the Git tool window commit graph.
 *
 * The webview posts `loadMoreCommits` when the user scrolls near the bottom
 * (scriptBuilder); the provider re-fires it as `onDidRequestLoadMoreCommits`.
 * Nothing used to subscribe, so the graph was hard-capped at the first page.
 * This module supplies the missing subscriber: a small state machine that
 * tracks the active repo/filter + current display limit and grows the limit by
 * one page on each load-more, re-running the same scoped load. Scroll is kept by
 * default — every in-place re-render preserves the user's position; only a fresh
 * navigational load resets to the top (see GitToolWindowProvider).
 *
 * The controller is generic over the registerViews-local log-filter shape so
 * it carries the EXACT filter through to the grown fetch (and the rev-list
 * count) without depending on registerViews internals.
 */

/** Re-run the scoped graph load at a grown limit. */
export type GraphLoadMoreReloader<F> = (
  repo: IRepository,
  filter: F | undefined,
  opts: { limit: number }
) => void;

export interface IGraphLoadMoreController<F> {
  /**
   * Record a FRESH (non-load-more) load — a repo switch, filter change, or
   * refresh. Resets the display limit back to one page so a previously-grown
   * repo never carries its limit into a different repo/filter.
   */
  noteFreshLoad(repo: IRepository, filter: F | undefined): void;
  /**
   * Called when entering the merged "All repositories" view. Clears the
   * active single-repo state so `handleLoadMore` is a no-op until the next
   * single-repo fresh load — prevents a scroll-to-bottom from re-running a
   * stale single-repo load over the merged graph.
   */
  noteMergedLoad(): void;
  /** The limit the current load should request (base page, or grown). */
  currentLimit(): number;
  /**
   * Handle a scroll-to-bottom request: grow the limit by one page and re-run
   * the active scoped load. No-op until a fresh load has established which
   * repo/filter is active.
   */
  handleLoadMore(): void;
}

/**
 * Create the load-more state machine. `basePage` is the INITIAL window (the
 * small first-paint chunk — kept small for a fast startup, IntelliJ shows a
 * 100-commit "small data pack" first). `incrementPage` (default `basePage`) is
 * the per-load-more growth; a larger increment keeps scrolling smooth without
 * paying for it up front. `reload` re-runs the scoped load — in production this
 * is `loadLogCommitsForRepo` with an explicit grown limit.
 */
export function createGraphLoadMoreController<F>(
  basePage: number,
  reload: GraphLoadMoreReloader<F>,
  incrementPage: number = basePage
): IGraphLoadMoreController<F> {
  let limit = basePage;
  let repo: IRepository | undefined;
  let filter: F | undefined;

  return {
    noteFreshLoad(r: IRepository, f: F | undefined): void {
      repo = r;
      filter = f;
      limit = basePage;
    },
    noteMergedLoad(): void {
      // Clear the active single-repo state. handleLoadMore guards on `repo`
      // being defined, so this makes load-more a no-op until the next
      // single-repo noteFreshLoad re-establishes the active repo.
      repo = undefined;
      filter = undefined;
      limit = basePage;
    },
    currentLimit(): number {
      return limit;
    },
    handleLoadMore(): void {
      if (!repo) {
        return;
      }
      limit += incrementPage;
      reload(repo, filter, { limit });
    },
  };
}

/**
 * Subscribe `onLoadMore` to the provider's `onDidRequestLoadMoreCommits`
 * event. Extracted so the wiring (the previously-dead emitter now HAS a
 * subscriber) is unit-testable in isolation from the registerViews closure.
 */
export function wireGraphLoadMore(
  provider: { onDidRequestLoadMoreCommits: vscode.Event<void> },
  onLoadMore: () => void
): vscode.Disposable {
  return provider.onDidRequestLoadMoreCommits(() => onLoadMore());
}
