import type { ICommit, IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { isHexObjectId } from '../git-core/gitDirMarkers';
import { isLogFilterEmpty } from '../git-core/gitToolWindow/provider/logFilterSanitizer';

/**
 * The Git tool window's log-filter shape (a subset of the UI filter bar). Kept
 * here so the scope builder and its callers share one definition.
 */
export interface ILogScopeFilter {
  branch?: string;
  /** Multi-select branches — union (show commits from ANY). Folded in with {@link branch}. */
  branches?: string[];
  /**
   * Explicit "no branches selected" state — show NO commits (the user unchecked
   * every branch). Distinct from the absent/empty branch filter, which means
   * "all branches" (`--all`). Maps to {@link ILogScope.matchNothing}.
   */
  branchesNone?: boolean;
  author?: string;
  /** Multi-select authors — union (repeated --author patterns). */
  authors?: string[];
  since?: Date;
  until?: Date;
  path?: string;
  /** Multi-select paths — union (commits touching ANY). Folded in with {@link path}. */
  paths?: string[];
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
  /**
   * Short-circuit to an EMPTY result without walking git — the "no branches
   * selected" state. `getLog`/`getLogCount` honor it; mutually exclusive with
   * {@link all} and {@link refs}.
   */
  matchNothing?: boolean;
  refs?: string[];
  logRange?: string;
  hashes?: string[];
  author?: string;
  authors?: string[];
  since?: Date;
  until?: Date;
  paths?: string[];
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
/**
 * A single hash word: 7 hex chars up to a full object id. Mirrors IntelliJ's
 * `VcsLogUtil.HASH_REGEX` 7-char floor and every-word-must-match semantics, but
 * the upper bound is widened from IntelliJ's 40 to a full SHA-256 object id (64
 * hex) — the repo's SHA-256 readiness supersedes that parity detail. The
 * definition of "hex object id" is delegated to {@link isHexObjectId} so it
 * stays SHA-256-ready in one place.
 */
const HASH_WORD_MIN_LEN = 7;

/**
 * Decide whether a search query is a HASH filter rather than a message search.
 * Returns the list of hash words when EVERY whitespace-separated word is a hex
 * object id of at least 7 chars (IntelliJ TextFilterModel: a text whose words
 * are all hashes becomes a HASH_FILTER), otherwise `undefined` (treat as a
 * `--grep` message search). A 6-char or shorter token, anything with a non-hex
 * char, or a mix of a hash and a word all fall through to message search —
 * matching IntelliJ.
 */
export function parseHashQuery(text: string | undefined): string[] | undefined {
  if (!text) {
    return undefined;
  }
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return undefined;
  }
  for (const w of words) {
    if (w.length < HASH_WORD_MIN_LEN || !isHexObjectId(w, { allowPrefix: true })) {
      return undefined;
    }
  }
  return words;
}

export function buildLogScope(filter?: ILogScopeFilter): ILogScope {
  // Multi-select branches/paths fold in the single-value legacy fields. Multiple
  // branches union (any), multiple paths union (any). A branch scope suppresses
  // `--all`.
  const refs = [...(filter?.branches ?? []), ...(filter?.branch ? [filter.branch] : [])];
  const paths = [...(filter?.paths ?? []), ...(filter?.path ? [filter.path] : [])];
  const logRange = filter?.logRange;
  // The "Message or hash" box: a query that is entirely hash words filters by
  // hash (`--no-walk <hash…>`), which scopes to exactly those commits — so it
  // suppresses `--all`/grep. Otherwise the query is a message `--grep`.
  const hashes = parseHashQuery(filter?.searchText);
  // An explicit "none" branch state shows no commits at all — short-circuit
  // BEFORE the --all/refs decision so it can't be read as "walk everything".
  if (filter?.branchesNone) {
    return {
      all: false,
      matchNothing: true,
      logRange,
      hashes,
      author: filter?.author,
      authors: filter?.authors,
      since: filter?.since,
      until: filter?.until,
      paths: paths.length > 0 ? paths : undefined,
      grep: hashes ? undefined : filter?.searchText,
      noMerges: filter?.noMerges,
      firstParent: filter?.firstParent,
      simplifyMerges: filter?.simplifyMerges,
      minParents: filter?.minParents,
      maxParents: filter?.maxParents,
      regex: filter?.searchRegex,
      caseSensitive: filter?.searchCaseSensitive,
    };
  }
  return {
    all: refs.length === 0 && !logRange && !hashes,
    refs: refs.length > 0 ? refs : undefined,
    logRange,
    hashes,
    author: filter?.author,
    authors: filter?.authors,
    since: filter?.since,
    until: filter?.until,
    paths: paths.length > 0 ? paths : undefined,
    grep: hashes ? undefined : filter?.searchText,
    noMerges: filter?.noMerges,
    firstParent: filter?.firstParent,
    simplifyMerges: filter?.simplifyMerges,
    minParents: filter?.minParents,
    maxParents: filter?.maxParents,
    regex: filter?.searchRegex,
    caseSensitive: filter?.searchCaseSensitive,
  };
}

/**
 * Narrow a branch-SUBSET scope to the refs a SINGLE repo actually has, for the
 * merged multi-root log. A multi-ref `git log <a> <b>` fails ENTIRELY ("fatal:
 * unknown revision") when one ref is unknown in that repo, which would silently
 * drop that repo's whole history. So each repo's log must pass only the selected
 * refs it has; a repo with none of them contributes nothing.
 *
 * @returns
 *   - `{ skip: true }`  — the repo has NONE of the selected refs → contribute no
 *     commits (don't run a poisoned multi-ref command).
 *   - `{ skip: false, refs }` — the subset narrowed to this repo's refs (order
 *     preserved from the selection).
 *   - `{ skip: false }` (no `refs`) — no branch subset is active (`scopeRefs`
 *     empty/undefined): the caller's scope is unchanged (`--all` or otherwise).
 */
export function narrowRefsForRepo(
  scopeRefs: readonly string[] | undefined,
  repoBranchNames: Iterable<string>
): { skip: boolean; refs?: string[] } {
  if (!scopeRefs || scopeRefs.length === 0) {
    return { skip: false };
  }
  const names = new Set(repoBranchNames);
  const refs = scopeRefs.filter((r) => names.has(r));
  if (refs.length === 0) {
    return { skip: true };
  }
  return { skip: false, refs };
}

/**
 * `filter` with its selected branches narrowed to the ones in `existing`, the
 * way the Branch popup shows them after a selected branch is deleted or
 * renamed: the survivors stay selected, and with none left the branch
 * criterion goes (all branches). `undefined` when nothing else is left of the
 * filter; the same object when nothing was dropped.
 */
export function pruneMissingBranches<F extends ILogScopeFilter>(
  filter: F | undefined,
  existing: ReadonlySet<string>
): F | undefined {
  if (!filter || (!filter.branch && !(filter.branches && filter.branches.length > 0))) {
    return filter;
  }
  const branches = (filter.branches ?? []).filter((b) => existing.has(b));
  const branch = filter.branch && existing.has(filter.branch) ? filter.branch : undefined;
  if (branches.length === (filter.branches ?? []).length && branch === filter.branch) {
    return filter;
  }
  const pruned: F = {
    ...filter,
    branches: branches.length > 0 ? branches : undefined,
    branch,
  };
  if (pruned.branches === undefined) {
    delete pruned.branches;
  }
  if (pruned.branch === undefined) {
    delete pruned.branch;
  }
  return isLogFilterEmpty(pruned) ? undefined : pruned;
}

/**
 * {@link pruneMissingBranches} against the branches `repos` have now, handing
 * a changed filter to `store` so the filter row and the saved filter agree
 * with what loads. A repository that lists none (git returns an empty list
 * when the read fails) leaves the filter untouched: a passing failure must
 * not clear the selection. No branch is read when the filter selects none.
 */
export async function reconcileFilterBranches<F extends ILogScopeFilter>(
  gitService: Pick<IGitService, 'getBranches'>,
  repos: readonly IRepository[],
  filter: F | undefined,
  store: (filter: F | undefined) => void = (): void => {}
): Promise<F | undefined> {
  if (!filter || (!filter.branch && !(filter.branches && filter.branches.length > 0))) {
    return filter;
  }
  const perRepo = await Promise.all(
    repos.map((repo) => gitService.getBranches(repo).catch(() => []))
  );
  if (perRepo.length === 0 || perRepo.some((branches) => branches.length === 0)) {
    return filter;
  }
  const pruned = pruneMissingBranches(filter, new Set(perRepo.flat().map((b) => b.name)));
  if (pruned !== filter) {
    store(pruned);
  }
  return pruned;
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
