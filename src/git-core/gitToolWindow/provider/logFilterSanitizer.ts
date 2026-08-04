/**
 * Log-filter boundary sanitization for the Git tool window: the pure
 * conversion from the untrusted webview filter payload to the host's
 * ILogFilter, plus the empty-filter collapse rule it shares with the branch
 * selector. Extracted verbatim from the provider.
 */

import type { ILogFilter } from '../../../services/interfaces';
import type { IWebviewLogFilter } from '../gitToolWindow.wireTypes';

/**
 * Whether every criterion of a log filter is unset — i.e. it would scope the
 * log to nothing more than the default view, so it should collapse to
 * `undefined`. Shared by the filter-bar apply path and the branch selector.
 */
function isLogFilterEmpty(filter: ILogFilter): boolean {
  return (
    !filter.branch &&
    !(filter.branches && filter.branches.length > 0) &&
    !filter.branchesNone &&
    !filter.logRange &&
    !filter.searchText &&
    !filter.author &&
    !(filter.authors && filter.authors.length > 0) &&
    !filter.path &&
    !(filter.paths && filter.paths.length > 0) &&
    !filter.since &&
    !filter.until &&
    !filter.noMerges &&
    !filter.firstParent &&
    !filter.simplifyMerges &&
    !filter.minParents &&
    !filter.maxParents
  );
}

/**
 * Handle applying log filter from webview
 */
/**
 * Reject a ref that would be unsafe to thread into `git log <ref>`: a leading
 * `-` (parsed as a CLI flag) or `.` (invalid per git-check-ref-format), on
 * the whole ref or any `/`-segment — the SAME shape the ops-layer getLog
 * guard throws on, so a bad ref becomes a clean filter no-op here instead of
 * a logged InvalidArgumentError there. Defense-in-depth; the ops guard stays.
 */
export function isUnsafeRef(ref: string): boolean {
  return (
    ref.startsWith('-') || ref.startsWith('.') || ref.split('/').some((seg) => seg.startsWith('-'))
  );
}

/**
 * Parse a webview-supplied filter date, returning `undefined` for an empty
 * value or one that yields an Invalid Date. An Invalid Date is truthy, so
 * without this it survives {@link _isLogFilterEmpty} and throws in
 * `toISOString()` in the ops layer.
 */
function parseFilterDate(value: string | null | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Convert the untrusted webview filter payload into the host's ILogFilter:
 * unsafe refs (CLI-flag / dot-leading) are dropped, invalid dates are
 * dropped, mode flags only join alongside search text, and a filter with no
 * surviving criterion collapses to `undefined`.
 */
export function sanitizeWebviewLogFilter(webviewFilter: IWebviewLogFilter): ILogFilter | undefined {
  let filter: ILogFilter | undefined;
  {
    {
      filter = {};

      // The branch/range crosses the untrusted webview boundary before reaching
      // `git log <ref>`; reject a leading `-` (CLI-flag injection) or `.`
      // (invalid per git-check-ref-format) defensively, mirroring the
      // GitService.getLog ref guard. A dropped ref simply leaves the branch
      // scope unset rather than applying a hostile value.
      if (webviewFilter.branch && !isUnsafeRef(webviewFilter.branch)) {
        // IntelliJ BranchFilterModel: a value containing `..`/`...` is a range
        // (VcsLogRangeFilter), not a single branch ref — route it accordingly.
        if (webviewFilter.branch.includes('..')) {
          filter.logRange = webviewFilter.branch;
        } else {
          filter.branch = webviewFilter.branch;
        }
      }
      // `searchText` / `author` / `path` do NOT get the branch's leading-`-`/`.`
      // guard, and that asymmetry is intentional: `branch` is threaded as a
      // POSITIONAL `git log <ref>` (so a leading `-` would be a flag), whereas
      // these three reach git ONLY in injection-safe positions downstream —
      // `--author=<v>` / `--grep=<v>` (`=`-bound, value can't split into its own
      // argv token) and `path` after the `--` pathspec separator. Applying the
      // ref guard here would also wrongly reject legitimate values: a `.`-leading
      // dotfile path (`.github/…`) and a search term that starts with `-`. The
      // safe-position contract is pinned by the getLog argv tests
      // (getLogPathFilter / getLogMatchMode).
      if (webviewFilter.searchText) {
        filter.searchText = webviewFilter.searchText;
        // Mode flags only matter alongside search text; a toggle with no text
        // is not a filter criterion, so it must not keep the filter "active".
        if (webviewFilter.searchRegex) {
          filter.searchRegex = true;
        }
        if (webviewFilter.searchCaseSensitive) {
          filter.searchCaseSensitive = true;
        }
      }
      if (webviewFilter.author) {
        filter.author = webviewFilter.author;
      }
      // Multi-select authors (User popup checkboxes) — safe downstream: each
      // value reaches git `=`-bound as its own `--author=<v>`.
      if (Array.isArray(webviewFilter.authors)) {
        const authors = webviewFilter.authors.filter((a) => typeof a === 'string' && a.length > 0);
        if (authors.length > 0) {
          filter.authors = authors;
        }
      }
      // Multi-select branches (nested checkbox tree): each is a positional
      // `git log <ref>`, so apply the same leading-`-`/`.` guard as the single
      // branch; drop unsafe entries.
      if (Array.isArray(webviewFilter.branches)) {
        const safe = webviewFilter.branches.filter(
          (b) => typeof b === 'string' && b.length > 0 && !isUnsafeRef(b)
        );
        if (safe.length > 0) {
          filter.branches = safe;
        }
      }
      // Explicit "no branches selected" — show no commits. Only honored when no
      // concrete branch subset is present (a subset already scopes the log).
      if (webviewFilter.branchesNone && !(filter.branches && filter.branches.length > 0)) {
        filter.branchesNone = true;
      }
      if (webviewFilter.path) {
        filter.path = webviewFilter.path;
      }
      // Multi-select paths reach git after the `--` pathspec separator, so (like
      // the single path) they need no leading-`-`/`.` guard.
      if (Array.isArray(webviewFilter.paths)) {
        const paths = webviewFilter.paths.filter((p) => typeof p === 'string' && p.length > 0);
        if (paths.length > 0) {
          filter.paths = paths;
        }
      }
      // Drop a value that parses to an Invalid Date: a garbage string from a
      // desynced/compromised webview is truthy, so it would survive
      // `_isLogFilterEmpty` and later throw in `since.toISOString()` downstream
      // (surfacing as a silently empty graph). Same drop-silently convention as
      // the unsafe-ref guard above.
      const since = parseFilterDate(webviewFilter.since);
      if (since) {
        filter.since = since;
      }
      const until = parseFilterDate(webviewFilter.until);
      if (until) {
        filter.until = until;
      }
      // Only meaningful alongside the instant it produced, so an unknown value
      // (or one with no `since`) is simply dropped and the range reads custom.
      if (since && (webviewFilter.datePreset === '24h' || webviewFilter.datePreset === '7d')) {
        filter.datePreset = webviewFilter.datePreset;
      }

      // Check if filter is empty
      if (isLogFilterEmpty(filter)) {
        filter = undefined;
      }
    }
  }
  return filter;
}

export { isLogFilterEmpty };
