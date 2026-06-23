import type { ICommit, IGitService, IRepository } from '../git-core/interfaces/IGitService';

/**
 * The Git tool window's log-filter shape (a subset of the UI filter bar). Kept
 * here so the scope builder and its callers share one definition.
 */
export interface ILogScopeFilter {
  branch?: string;
  author?: string;
  since?: Date;
  until?: Date;
  path?: string;
  searchText?: string;
  noMerges?: boolean;
  firstParent?: boolean;
  simplifyMerges?: boolean;
  minParents?: number;
  maxParents?: number;
  logRange?: string;
  searchRegex?: boolean;
  searchCaseSensitive?: boolean;
}

/**
 * The refs + filter SET selector shared by a graph page's `getLog` and its
 * `getLogCount`. Excludes the window (`maxCount`) and ordering (`topoOrder`),
 * which change neither the commit set nor its size.
 */
export interface ILogScope {
  all: boolean;
  ref?: string;
  logRange?: string;
  author?: string;
  since?: Date;
  until?: Date;
  path?: string;
  grep?: string;
  noMerges?: boolean;
  firstParent?: boolean;
  simplifyMerges?: boolean;
  minParents?: number;
  maxParents?: number;
  regex?: boolean;
  caseSensitive?: boolean;
}

/**
 * Build the single refs/filter scope a graph page is loaded under. This is the
 * ONE source of the scope object so the loaded list (`getLog`) and the total
 * (`getLogCount`) can never diverge — a divergence would make the "X of Y"
 * indicator lie and, worse, leave `hasMore` permanently true (a never-ending
 * load-more spinner).
 *
 * A branch or range filter scopes the log to that ref, so `--all` is
 * suppressed; without one we walk all refs for the full graph. The UI's
 * `searchText` maps to git `--grep`, `searchRegex` to `-E`, `searchCaseSensitive`
 * to dropping `--regexp-ignore-case` (see StashTagHistoryOps.getLog).
 */
export function buildLogScope(filter?: ILogScopeFilter): ILogScope {
  const branchRef = filter?.branch;
  const logRange = filter?.logRange;
  return {
    all: !branchRef && !logRange,
    ref: branchRef,
    logRange,
    author: filter?.author,
    since: filter?.since,
    until: filter?.until,
    path: filter?.path,
    grep: filter?.searchText,
    noMerges: filter?.noMerges,
    firstParent: filter?.firstParent,
    simplifyMerges: filter?.simplifyMerges,
    minParents: filter?.minParents,
    maxParents: filter?.maxParents,
    regex: filter?.searchRegex,
    caseSensitive: filter?.searchCaseSensitive,
  };
}

/** One graph page: the windowed commit list plus the honest total available. */
export interface IGraphPage {
  commits: ICommit[];
  /**
   * `git rev-list --count` over the SAME scope, resolving to the honest total
   * (or `undefined` if it failed). DELIBERATELY a Promise that is NOT awaited
   * before the commits return: on a large repo `rev-list --count --all` walks
   * the entire history (5–10s) and previously blocked the first paint behind the
   * "Loading git graph…" spinner. Callers render the `commits` immediately and
   * fold the resolved total into the "X of Y" indicator / load-more state in the
   * background.
   */
  totalAvailable: Promise<number | undefined>;
}

/**
 * Fetch one graph page: `getLog` windowed to `limit` (awaited — this is the
 * first paint) and `getLogCount` for the honest total (NOT awaited — returned as
 * a background promise), BOTH under the identical {@link buildLogScope} object so
 * the loaded list and the total can never diverge. Counting is best-effort: a
 * failure degrades to "all loaded" (no spinner). Topo order is requested on the
 * log only; it doesn't affect the count.
 */
export async function fetchGraphPage(
  gitService: Pick<IGitService, 'getLog' | 'getLogCount'>,
  repo: IRepository,
  filter: ILogScopeFilter | undefined,
  limit: number
): Promise<IGraphPage> {
  const scope = buildLogScope(filter);
  const commits = await gitService.getLog(repo, { maxCount: limit, topoOrder: true, ...scope });
  // Kick off the count concurrently but do NOT await it — it stays off the
  // first-paint critical path. `.catch` keeps a count failure from becoming an
  // unhandled rejection; it degrades to `undefined` ("all loaded").
  const totalAvailable = gitService.getLogCount(repo, scope).catch(() => undefined);
  return { commits, totalAvailable };
}
