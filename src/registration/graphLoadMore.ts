import * as vscode from 'vscode';
import type { IRepository } from '../git-core/interfaces/IGitService';

/**
 * Scroll-to-bottom "load more" + navigation classification for the Git tool
 * window commit graph.
 *
 * The webview posts `loadMoreCommits` when the user scrolls near the bottom
 * (the gitToolWindow entry); the provider re-fires it as `onDidRequestLoadMoreCommits`.
 * This module supplies the subscriber: a small state machine that tracks the
 * active repo/filter + current display limit and grows the limit by one page
 * on each load-more, re-running the same scoped load.
 *
 * It also owns the NAVIGATIONAL verdict — whether a load targets a different
 * (repo, filter) than the previous one — because navigation and the load-more
 * window are the same state: a navigational load resets the limit to one page
 * and the webview scroll to the top, while an in-place refresh of the same
 * target (watcher tick, refresh button, post-action reload) keeps both. One
 * tracker, so the two can never disagree.
 *
 * Loads run in two phases: `beginLoad` stages the target and classifies it;
 * `commitLoad` promotes the staged target once its data has rendered. A load
 * that fails (or is superseded by the staleness guard) never commits, so the
 * retry classifies as navigational again, and every successful load — in-place
 * ones included — refreshes the captured repo snapshot that `handleLoadMore`
 * replays (repo objects are rebuilt on every reload; a pinned old snapshot
 * would replay a stale HEAD into the head-anchor resolution).
 *
 * The controller is generic over the registerViews-local log-filter shape so
 * it carries the EXACT filter through to the grown fetch (and the rev-list
 * count) without depending on registerViews internals.
 */

/** Value shapes a log filter may carry — kept flat so the stable key below is
 * total; a nested object field would stringify uselessly and must instead
 * extend this union (the constraint makes that a compile error). */
export type FlatFilterValue = string | number | boolean | Date | readonly string[] | undefined;

/** Stable, order-independent key for a log filter object. */
export function stableLogFilterKey(
  filter: Readonly<Record<string, FlatFilterValue>> | undefined
): string {
  if (filter === undefined || filter === null) {
    return '';
  }
  const keys = Object.keys(filter)
    .filter((k) => filter[k] !== undefined)
    .sort();
  if (keys.length === 0) {
    return '';
  }
  const parts = keys.map((k) => {
    const value = filter[k];
    const rendered =
      value instanceof Date
        ? value.toISOString()
        : Array.isArray(value)
          ? JSON.stringify(value)
          : String(value);
    return `${k}=${rendered}`;
  });
  return parts.join('\u0000');
}

/** Re-run the scoped graph load at a grown limit. A returned promise lets
 * {@link IGraphLoadMoreController.ensureWindowCovers} await the load. */
export type GraphLoadMoreReloader<F> = (
  repo: IRepository,
  filter: F | undefined,
  opts: { limit: number }
) => void | Promise<void>;

export interface IGraphLoadMoreController<F> {
  /**
   * Phase 1 of a non-load-more load: stage the target and classify it.
   * Returns true when the load is NAVIGATIONAL — a repo switch, a filter
   * change, or the first load — which is the caller's cue to reset the
   * webview scroll (and, via {@link currentLimit}, the one-page window).
   */
  beginLoad(repo: IRepository, filter: F | undefined): boolean;
  /**
   * Phase 2: commit the staged target after its data rendered. Establishes
   * the baseline for the next `beginLoad`, refreshes the repo snapshot that
   * `handleLoadMore` replays, and applies the navigational limit reset.
   * No-op when nothing is staged (load-more re-runs never stage).
   */
  commitLoad(): void;
  /**
   * Called when entering the merged "All repositories" view. Clears the
   * active single-repo state so `handleLoadMore` is a no-op until the next
   * single-repo load commits — prevents a scroll-to-bottom from re-running a
   * stale single-repo load over the merged graph — and makes that next
   * single-repo load navigational (it is a scope switch).
   */
  noteMergedLoad(): void;
  /** The limit the current load should request: one base page for a staged
   * navigational load, the grown window otherwise. */
  currentLimit(): number;
  /**
   * Handle a scroll-to-bottom request: grow the limit by one page and re-run
   * the active scoped load. No-op until a load has committed which
   * repo/filter is active.
   */
  handleLoadMore(): void;
  /**
   * The committed active (repo, filter) target, or `undefined` before the
   * first committed load / in the merged view. Lets callers run a
   * scope-identical query (e.g. a rev-list count) against exactly the load
   * this controller replays.
   */
  activeTarget(): { repo: IRepository; filter: F | undefined } | undefined;
  /**
   * Grow the window so it covers at least `minLimit` commits and re-run the
   * active scoped load, AWAITING it (jump-to-hash uses this to load the full
   * history before retrying a miss — the reference retries as packs load
   * until the pack is full). Never shrinks an already-larger window; the
   * grown limit becomes the baseline further load-mores increment from.
   * Returns false (no reload) when no target has committed.
   */
  ensureWindowCovers(minLimit: number): Promise<boolean>;
}

/**
 * Create the load-more state machine. `basePage` is the INITIAL window (the
 * small first-paint chunk — kept small for a fast startup, IntelliJ shows a
 * 100-commit "small data pack" first). `incrementPage` (default `basePage`) is
 * the per-load-more growth; a larger increment keeps scrolling smooth without
 * paying for it up front. `reload` re-runs the scoped load — in production this
 * is `loadLogCommitsForRepo` with an explicit grown limit.
 */
export function createGraphLoadMoreController<F extends Readonly<Record<string, FlatFilterValue>>>(
  basePage: number,
  reload: GraphLoadMoreReloader<F>,
  incrementPage: number = basePage
): IGraphLoadMoreController<F> {
  let limit = basePage;
  let repo: IRepository | undefined;
  let filter: F | undefined;
  /** Committed (rootPath, filterKey) baseline; undefined = next load is navigational. */
  let activeKey: string | undefined;
  let staged:
    | { repo: IRepository; filter: F | undefined; key: string; navigational: boolean }
    | undefined;

  const targetKey = (r: IRepository, f: F | undefined): string =>
    r.rootUri.fsPath + '\u0001' + stableLogFilterKey(f);

  return {
    beginLoad(r: IRepository, f: F | undefined): boolean {
      const key = targetKey(r, f);
      const navigational = key !== activeKey;
      staged = { repo: r, filter: f, key, navigational };
      return navigational;
    },
    commitLoad(): void {
      if (!staged) {
        return;
      }
      repo = staged.repo;
      filter = staged.filter;
      activeKey = staged.key;
      if (staged.navigational) {
        limit = basePage;
      }
      staged = undefined;
    },
    noteMergedLoad(): void {
      // Clear the active single-repo state. handleLoadMore guards on `repo`
      // being defined, so this makes load-more a no-op until the next
      // single-repo load commits and re-establishes the active repo.
      repo = undefined;
      filter = undefined;
      activeKey = undefined;
      staged = undefined;
      limit = basePage;
    },
    currentLimit(): number {
      return staged?.navigational ? basePage : limit;
    },
    handleLoadMore(): void {
      if (!repo) {
        return;
      }
      limit += incrementPage;
      void reload(repo, filter, { limit });
    },
    activeTarget(): { repo: IRepository; filter: F | undefined } | undefined {
      return repo ? { repo, filter } : undefined;
    },
    async ensureWindowCovers(minLimit: number): Promise<boolean> {
      if (!repo) {
        return false;
      }
      if (minLimit > limit) {
        limit = minLimit;
      }
      await reload(repo, filter, { limit });
      return true;
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
