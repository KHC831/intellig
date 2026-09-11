/**
 * Graph-panel + log-filter-row HTML builders for the Git tool window
 * document: the commit-row panel (print model, branch colors, column
 * header), the empty-state body, the branch/tag chip labels, and the
 * IntelliJ-style filter row with its popup bodies and button labels.
 * Extracted verbatim from the provider; every input arrives through
 * {@link ILogPanelProps}, assembled per render by the provider's thin
 * delegates.
 */

import type { DatePreset, ILogFilter } from '../../../services/interfaces';
import type { IRepository } from '../../interfaces/IGitService';
import type { ICommitNode, IBranchRef } from '../../commitGraph';
import type { IExtendedLogState } from '../GitToolWindowProvider';
import { DEFAULT_GRAPH_CONFIG } from '../../../utils/graphRenderer';
import {
  buildGraphPrintModel,
  computeGraphWidthFromModels,
  colorNodesFrom,
} from '../../graph/printModel';
import { compactPrintModelLanes } from '../../graph/laneCompaction';
import { computeBranchColors } from '../../graph/branchColors';
import { buildCommitRows } from './graphClusterBuilder';
import { escapeHtml } from './htmlBuilders';
import { normalizeRepoPath, normalizeRepoPathString } from '../../../utils/normalizeRepoPath';

/** Button text for each relative date preset (also the filter-row value). */
const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  '24h': 'Last 24 Hours',
  '7d': 'Last 7 Days',
};

/**
 * Per-render view of the provider state the panel builders read. Assembled by
 * the provider for each render call; the `state` member is the LIVE extended
 * log state object (not a copy), matching what the in-class code read.
 */
export interface ILogPanelProps {
  state: IExtendedLogState;
  searchDraft: string | undefined;
  searchModeUi: { regex: boolean; caseSensitive: boolean } | undefined;
  availableRepositories: readonly IRepository[];
  visibleRepoRoots: readonly string[] | null;
  repositoryScope: 'all' | number;
  selectedRepositoryIndex: number;
  columnWidths: readonly [number, number];
  trunkBranchNames: string[];
  showLongEdges: boolean;
  showGpgColumn: boolean;
  showRootColumn: boolean;
  showRootNames: boolean;
  /**
   * Whether this render keeps the webview's saved scroll position
   * (`data-preserve-scroll`). The provider consumes its one-shot
   * reset-on-next-render flag when assembling the props, so the flag's
   * write stays with its owner.
   */
  preserveScroll: boolean;
}

/**
 * Generate the Graph Panel HTML for the 2-panel layout.
 *
 * Renders commit rows in reverse chronological order (as provided by the
 * commitNodes array). Each row contains:
 * - SVG graph visualization (via buildGraphPrintModel + paintRow)
 * - Commit short hash
 * - Commit message summary (first line, truncated to ~60 chars)
 * - Author name
 * - Relative date
 *
 * The method uses the existing graphRenderer utilities to produce color-coded
 * lane SVGs and the commitGraph utilities for lane computation.
 *
 * @param commitNodes - Array of ICommitNode in reverse chronological order
 * @param selectedCommits - Set of currently selected commit hashes (optional)
 * @param loadedCount - Number of commits currently loaded (optional, for incremental loading)
 * @param totalAvailable - Total number of commits available in the repository (optional)
 * @param scrollToCommitHash - Optional commit hash to auto-scroll to on page load
 * @returns HTML string for the graph panel content
 */
export function buildGraphPanelHtml(
  commitNodes: ICommitNode[],
  selectedCommits: Set<string> | undefined,
  loadedCount: number | undefined,
  totalAvailable: number | undefined,
  scrollToCommitHash: string | undefined,
  props: ILogPanelProps
): string {
  const selected = selectedCommits || new Set<string>();

  if (commitNodes.length === 0) {
    return buildEmptyGraphPanelHtml(props);
  }

  // Build the per-row graph print model once for the whole window (Layer 3).
  // This single pure projection replaces the former cluster of per-row lane
  // maps (active / continues-above / continues-below / terminal / child-count
  // / child-lanes / incoming-bends / focus); the painter (Layer 4) consumes it.
  // Resolve owning-branch colors once and share them with BOTH the painter
  // (via the print model) and the branch chips, so a branch's line and its
  // chip render the same color.
  const branchColors = computeBranchColors(colorNodesFrom(commitNodes), {
    headBranchName: props.state.headBranchName,
    trunkBranchNames: props.trunkBranchNames,
  });
  const printModels = buildGraphPrintModel(commitNodes, {
    branchColors,
    headHash: props.state.headHash,
    // IntelliJ default: hide the middle of long edges unless the user opts
    // into full-length edges via `intellig.log.showLongEdges`.
    hideLongEdges: !props.showLongEdges,
  });

  // Compact the lanes: with the long edges' middles hidden, their reserved
  // columns are free to reuse, so relabel columns down to the ~handful of
  // lanes actually drawn per row (IntelliJ visible-graph parity). Without this
  // the column is sized to the highest raw lane index (~46 on a deep bitcoin
  // window) though only ~10 lanes ever show at once, leaving a wide empty gap
  // before the message text. Full-edge mode deliberately keeps raw lane
  // indices instead — see ADR-016, known divergences.
  if (!props.showLongEdges) {
    compactPrintModelLanes(printModels);
  }

  // Pre-resolve the cherry-picked set once per render to keep the
  // per-row check O(1).
  const cherryPickedHashes = props.state.cherryPickedHashes;
  const cherryPickBaseRef = props.state.cherryPickBaseRef;

  // Size the graph column to the widest row across the (compacted) window so
  // every drawn lane shows and the message column stays LEFT-ALIGNED (one
  // width for all rows). Compaction keeps this small and roughly constant even
  // on a deep merge history. Derived from the print model's per-row inked lanes.
  const graphColumnWidthPx = Math.max(
    80,
    computeGraphWidthFromModels(
      printModels,
      DEFAULT_GRAPH_CONFIG.columnWidth,
      DEFAULT_GRAPH_CONFIG.padding
    )
  );

  // Build commit rows
  const rowsHtml = buildCommitRows(commitNodes, {
    selected,
    cherryPickedHashes,
    cherryPickBaseRef,
    printModels,
    branchLabelsFor: (node) => buildBranchLabelsHtml(node, branchColors, props.state),
    showGpgColumn: props.showGpgColumn,
    // The root column needs the merged scope AND an actually-multi-repo
    // workspace — a single-repo user never sees it (IntelliJ:
    // VcsLogColorManager.hasMultiplePaths).
    showRootColumn: props.showRootColumn,
    showRootNames: props.showRootNames,
  });

  // Determine if more commits are available for incremental loading
  const loaded = loadedCount ?? commitNodes.length;
  const total = totalAvailable ?? commitNodes.length;
  const hasMore = loaded < total;

  const loadingIndicatorHtml = hasMore
    ? `<div class="graph-loading-indicator" data-loaded="${loaded}" data-total="${total}">
          <span class="loading-spinner">⟳</span>
          <span class="loading-text">Loading more commits... (${loaded} of ${total})</span>
        </div>`
    : '';

  const scrollAttr = scrollToCommitHash ? ` data-scroll-to-commit="${scrollToCommitHash}"` : '';

  // Preserve-by-default: every render stamps data-preserve-scroll so the
  // inline script restores the saved scroll position, keeping the user where
  // they are across in-place re-renders (load-more, cherry-mark arrival,
  // selection/focus change). A navigational render (repo switch, filter/branch/
  // range change, initial load) sets the one-shot reset flag instead, omitting
  // the attribute so the webview starts at the top. Consumed here.
  const preserveScrollAttr = props.preserveScroll ? ' data-preserve-scroll="true"' : '';

  // Embed the anchor hash so a full
  // re-render rehydrates the JS `let anchorHash` mirror correctly.
  // The webview JS reads this attribute on script-execution and
  // again whenever the host posts a `syncSelection` message.
  const anchorAttr = props.state.anchorHash ?? '';

  // visually-hidden help span referenced by
  // `aria-describedby="focused-branch-help"` on every focused branch
  // chip. Rendered ONCE per panel so all focused chips (only one is
  // ever focused at a time today; loop-safe nonetheless) share the
  // same description without duplicating it in the DOM. The
  // `.visually-hidden` utility keeps the text in the AT layer (read
  // by screen readers, find-in-page, accessibility-tree inspectors)
  // while removing it from sighted layout.
  const focusedBranchHelpHtml = `<span id="focused-branch-help" class="visually-hidden">Currently focused branch — graph is filtered to this branch's history</span>`;

  // Publish the resizable fixed-column widths as CSS custom properties on
  // the panel so the header and every row read the same value — a single
  // source of truth keeps them aligned, and embedding the current widths in
  // the markup means a full re-render rehydrates a user's dragged widths.
  const [authorWidthPx, dateWidthPx] = props.columnWidths;
  const columnHeaderHtml = getLogColumnHeaderHtml(props);
  const logFilterRowHtml = buildLogFilterRowHtml(props);

  return `
      <div class="graph-panel" role="listbox" aria-label="Commit Graph" aria-multiselectable="true" style="--graph-width: ${graphColumnWidthPx}px; --col-author-width: ${authorWidthPx}px; --col-date-width: ${dateWidthPx}px;" data-selected-count="${selected.size}" data-anchor-hash="${escapeHtml(anchorAttr)}" data-loaded-count="${loaded}" data-total-available="${total}"${scrollAttr}${preserveScrollAttr}>
        ${focusedBranchHelpHtml}
        ${logFilterRowHtml}
        ${columnHeaderHtml}
        ${rowsHtml}
        ${loadingIndicatorHtml}
      </div>`;
}

/**
 * Build the empty-state body for the graph panel.
 *
 * The graph panel reaches this branch whenever `commitNodes` is empty
 * AND the host has already cleared the loading state and confirmed a
 * repository (the loading / no-repository cases are handled upstream
 * in `_getHtmlContent` by `_getLoadingHtml` / `_getNoRepositoryHtml`,
 * so they never reach here). That leaves exactly two reasons the row
 * list can be empty:
 *
 *   - `filteredEmpty` — a log filter is active and matched zero
 *     commits. We surface a "Clear filter" affordance so the user can
 *     recover in one click.
 *   - `noCommits` — a real repository with no commits in the loaded
 *     window (a freshly-initialised repo before the first commit).
 *
 * Distinguishing the two avoids the old "No commits found" message,
 * which read as "your filter is broken" to users staring at a fresh
 * repo and "your repo is empty" to users who'd just typed a filter
 * that matched nothing.
 *
 * The repository selector is preserved at the top so a multi-repo
 * user can switch repos without the dropdown vanishing on an empty
 * result.
 */
export function buildEmptyGraphPanelHtml(props: ILogPanelProps): string {
  // An explicit "no repositories checked" scope is a filter outcome too:
  // without it the empty list reads as "No commits yet" with no way back.
  const scopeShowsNone = props.visibleRepoRoots !== null && props.visibleRepoRoots.length === 0;
  const hasActiveFilter = props.state.filter !== undefined || scopeShowsNone;

  const body = hasActiveFilter
    ? `<div class="graph-empty-state">
           <p class="empty-message">No commits match the current filter</p>
           <button type="button" class="graph-empty-action" data-action="clearLogFilter">Clear filter</button>
         </div>`
    : `<div class="graph-empty-state">
           <p class="empty-message">No commits yet — make your first commit</p>
         </div>`;

  return `
      <div class="graph-panel" role="listbox" aria-label="Commit Graph" aria-multiselectable="true" data-selected-count="0" data-anchor-hash="">
        ${buildLogFilterRowHtml(props)}
        ${body}
      </div>`;
}

/**
 * Build the log column-header row.
 *
 * The header sits above the commit rows and labels the three columns —
 * the flexible Title column plus the two fixed-width Author and Date
 * columns. Between the columns sit drag handles (`data-column-resize`):
 * dragging the Title↕Author handle resizes the Author column, and the
 * Author↕Date handle resizes the Date column. The fixed columns size
 * themselves from the `--col-author-width` / `--col-date-width` custom
 * properties published on the panel, so the header and every row stay
 * pixel-aligned. The graph cell's left spacer matches `--graph-width` so
 * the Title label lines up with the commit messages below it.
 *
 * @returns HTML string for the column-header row.
 */
function getLogColumnHeaderHtml(props: ILogPanelProps): string {
  const gpgHeaderCell = props.showGpgColumn
    ? `<div class="log-gpg-status" aria-label="GPG signature status" title="GPG/SSH signature status">GPG</div>`
    : '';
  return `
        <div class="log-column-header" role="row" aria-hidden="true">
          <div class="log-column-header-graph"></div>
          <div class="log-column-header-info">
            <div class="log-column-header-title">Title</div>
            <div class="log-column-resize-handle" data-column-resize="author" role="separator" aria-label="Resize author column" tabindex="0"></div>
            <div class="log-column-header-author">Author</div>
            <div class="log-column-resize-handle" data-column-resize="date" role="separator" aria-label="Resize date column" tabindex="0"></div>
            <div class="log-column-header-date">Date</div>
            ${gpgHeaderCell}
          </div>
        </div>`;
}

/**
 * Build the always-visible log filter row — IntelliJ `VcsLogClassicFilterUi`
 * parity: a text-search field followed by Branch / User / Date / Path popup
 * buttons (each filter is a styled popup, not a native `<select>`/`<datalist>`
 * whose popup Chromium renders in an unstyleable UA layer).
 *
 * The webview CSP is `script-src 'nonce-<nonce>'` with no `unsafe-inline`, so
 * every control uses `data-action` attributes (routed by the delegated
 * click/keydown listeners in the inline script), never inline handlers.
 *
 * The current filter is mirrored into `data-f-*` attributes on the row so the
 * inline script can rehydrate its `filterState` after a full re-render (which
 * the host does on every refresh). All values are HTML-escaped — they land in
 * attribute positions and are user-controlled.
 *
 * @returns HTML string for the filter row.
 * @internal Public for direct snapshot/DOM tests; the `_` prefix flags
 *   "not for production callers outside this class", matching the
 *   existing `_get*Html` testability pattern.
 */
export function buildLogFilterRowHtml(props: ILogPanelProps): string {
  const filter = props.state.filter;
  // Committed (applied) text rides `data-f-search`; the input VALUE shows
  // the live draft when one is in flight so a re-render can't wipe it.
  const search = escapeHtml(filter?.searchText ?? '');
  const searchInputValue = escapeHtml(props.searchDraft ?? filter?.searchText ?? '');
  // UI slot first (covers toggle-with-empty-text); the applied filter is
  // the fallback for hydration before any applyLogFilter message arrived.
  const searchRegex = props.searchModeUi?.regex ?? filter?.searchRegex ?? false;
  const searchCaseSensitive =
    props.searchModeUi?.caseSensitive ?? filter?.searchCaseSensitive ?? false;
  // A range filter ("A..B") lives in logRange; show it in the Branch button
  // value, falling back to the single-branch scope. `data-f-branch` keeps that
  // single/range value for back-compat; the multi-select tree round-trips
  // through `data-f-branches` below.
  const branch = filter?.logRange ?? filter?.branch ?? '';
  const branches = filter?.branches ?? [];
  const branchesNone = filter?.branchesNone ?? false;
  const paths = filter?.paths ?? [];
  const author = filter?.author ?? '';
  const authors = filter?.authors ?? [];
  const path = filter?.path ?? '';
  // Row attrs round-trip the applied bounds losslessly (a preset carries an
  // exact timestamp); the custom-range date INPUTS still use day values.
  const sinceAttr = filter?.since ? filter.since.toISOString() : '';
  const untilAttr = filter?.until ? filter.until.toISOString() : '';

  const branchLabel = escapeHtml(branchFilterLabel(filter));
  const authorLabel =
    authors.length > 1 ? `${authors.length} users` : escapeHtml(authors[0] ?? author) || 'All';
  const dateLabel = escapeHtml(dateFilterLabel(filter?.since, filter?.until, filter?.datePreset));
  const repoLabel = escapeHtml(repoScopeLabel(props));

  // The Repository filter scopes the log to a subset of a multi-root
  // workspace. It is meaningless with a single repo, so it is omitted then.
  const repoPopup =
    props.availableRepositories.length > 1
      ? getFilterPopupHtml('repo', 'Repository', repoLabel, getRepositoryPopupBodyHtml(props))
      : '';

  return `
        <div class="log-filter-row" role="group" aria-label="Log filters" data-f-search="${search}" data-f-branch="${escapeHtml(branch)}" data-f-branches="${escapeHtml(JSON.stringify(branches))}" data-f-branches-none="${branchesNone}" data-f-author="${escapeHtml(author)}" data-f-authors="${escapeHtml(JSON.stringify(authors))}" data-f-path="${escapeHtml(path)}" data-f-paths="${escapeHtml(JSON.stringify(paths))}" data-f-since="${sinceAttr}" data-f-until="${untilAttr}" data-f-date-preset="${escapeHtml(filter?.datePreset ?? '')}">
          <div class="log-filter-search">
            <input type="text" id="filter-search" class="log-filter-search-input" data-action="filterSearchKeydown" placeholder="Message or hash" value="${searchInputValue}" aria-label="Search by message or hash" autocomplete="off" />
            <button type="button" id="filter-search-regex" class="log-filter-toggle-btn${searchRegex ? ' active' : ''}" data-action="toggleSearchRegex" title="Match by regular expression" aria-label="Match by regular expression" aria-pressed="${searchRegex}">.*</button>
            <button type="button" id="filter-search-case" class="log-filter-toggle-btn${searchCaseSensitive ? ' active' : ''}" data-action="toggleSearchCase" title="Match case (case-sensitive)" aria-label="Match case (case-sensitive)" aria-pressed="${searchCaseSensitive}">Aa</button>
            <button type="button" id="filter-jump" class="log-filter-toggle-btn" data-action="jumpToCommit" title="Jump to Commit (SHA, branch, or tag)" aria-label="Jump to Commit">⌖</button>
          </div>
          ${getFilterPopupHtml('branch', 'Branch', branchLabel, getBranchPopupBodyHtml())}
          ${getFilterPopupHtml('user', 'User', authorLabel, getUserPopupBodyHtml(author))}
          ${getFilterPopupHtml('date', 'Date', dateLabel, getDatePopupBodyHtml(filter?.since, filter?.until, filter?.datePreset))}
          ${repoPopup}
        </div>`;
}

/**
 * Wrap one filter as a label-button + anchored popup panel — the webview
 * analogue of IntelliJ's `FilterPopupComponent` (a button showing the active
 * value that opens a popup of choices). The popup starts `hidden`; the
 * delegated `toggleFilterPopup` click handler flips it. `bodyHtml` is the
 * popup contents (already escaped by its builder).
 */
function getFilterPopupHtml(
  key: string,
  label: string,
  valueLabel: string,
  bodyHtml: string
): string {
  return `
          <div class="log-filter-pop" data-popup-wrap="${key}">
            <button type="button" class="log-filter-pop-btn" data-action="toggleFilterPopup" data-popup="${key}" aria-haspopup="true" aria-expanded="false">
              <span class="log-filter-pop-label">${label}:</span>
              <span class="log-filter-pop-value" id="filter-${key}-value">${valueLabel}</span>
              <span class="log-filter-pop-caret" aria-hidden="true">▾</span>
            </button>
            <div class="log-filter-popup" id="filter-popup-${key}" role="group" aria-label="${label} filter" hidden>${bodyHtml}</div>
          </div>`;
}

/**
 * Branch popup shell. The live-filter input is static; the master "All
 * branches" checkbox + the Local / per-remote checkbox tree are injected
 * client-side from the `logFilterOptionsReady` message (lazy, on first open —
 * no load-time git).
 */
function getBranchPopupBodyHtml(): string {
  return `
              <input type="text" class="log-filter-popup-search" data-action="filterPopupSearch" data-popup="branch" placeholder="Filter branches" aria-label="Filter branches" autocomplete="off" />
              <div class="log-filter-popup-list" id="filter-branch-list"></div>`;
}

/**
 * User (author) popup — a free-text author field plus a lazily-filled list of
 * known authors (requested on open, cached). Mirrors IntelliJ
 * `UserFilterPopupComponent`. Pressing Enter in the field applies it.
 */
function getUserPopupBodyHtml(author: string): string {
  const esc = escapeHtml(author);
  return `
              <input type="text" id="filter-author-input" class="log-filter-popup-search" data-action="filterAuthorKeydown" placeholder="Author name or email" value="${esc}" aria-label="Author name or email" autocomplete="off" />
              <div class="log-filter-popup-list" id="filter-author-list">
                <button type="button" class="log-filter-popup-item" data-action="pickAuthorFilter" data-author="__all__">All users</button>
              </div>`;
}

/**
 * Date popup — preset ranges (Last 24 Hours / Last 7 Days) plus "Select…",
 * which reveals an inline custom-range panel (IntelliJ `DateFilterComponent`):
 * After/Before checkboxes each gating a date input that is disabled until its
 * box is checked.
 */
function getDatePopupBodyHtml(
  since: Date | undefined,
  until: Date | undefined,
  datePreset?: DatePreset
): string {
  // A preset owns the whole date filter, so the custom bounds stay unchecked
  // and closed: pre-checking "After" with the preset's instant rounded to a
  // date input widened the range to that day's midnight on a bare Apply.
  const isPreset = datePreset !== undefined;
  const sinceVal = isPreset ? '' : toDateInputValue(since);
  const untilVal = isPreset ? '' : toDateInputValue(until);
  const hasSince = sinceVal !== '';
  const hasUntil = untilVal !== '';
  const customOpen = hasSince || hasUntil;
  const presetSelected = (preset: DatePreset): string =>
    datePreset === preset ? ' aria-checked="true" class="log-filter-popup-item selected"' : '';
  return `
              <button type="button" class="log-filter-popup-item" data-action="pickDateFilter" data-range="all">All</button>
              <button type="button"${presetSelected('24h') || ' class="log-filter-popup-item"'} data-action="pickDateFilter" data-range="24h">Last 24 Hours</button>
              <button type="button"${presetSelected('7d') || ' class="log-filter-popup-item"'} data-action="pickDateFilter" data-range="7d">Last 7 Days</button>
              <button type="button" class="log-filter-popup-item" data-action="dateSelectCustom">Select…</button>
              <div class="log-filter-date-custom" id="filter-date-custom"${customOpen ? '' : ' hidden'}>
                <label class="log-filter-date-bound">
                  <input type="checkbox" id="filter-after-enabled" data-action="toggleDateBound" data-bound="after"${hasSince ? ' checked' : ''} /> After
                  <input type="date" id="filter-after-date" class="log-filter-date-input" value="${sinceVal}"${hasSince ? '' : ' disabled'} />
                </label>
                <label class="log-filter-date-bound">
                  <input type="checkbox" id="filter-before-enabled" data-action="toggleDateBound" data-bound="before"${hasUntil ? ' checked' : ''} /> Before
                  <input type="date" id="filter-before-date" class="log-filter-date-input" value="${untilVal}"${hasUntil ? '' : ' disabled'} />
                </label>
                <button type="button" class="log-filter-popup-apply" data-action="applyDateCustom">Apply</button>
              </div>`;
}

/**
 * Repository popup — a checkbox per workspace repository (plus an "All
 * repositories" reset), letting the user scope the merged log + Branches view
 * to a SUBSET of a multi-root workspace (IntelliJ's root filter). Repos are
 * known server-side, so the checkboxes render directly (no lazy message). The
 * checked set drives {@link _handleVisibleRepositoriesSelection}: all/none →
 * "show all", exactly one → single-repo scope, 2..n-1 → a visible subset.
 * Only emitted when more than one repository is open (see callsite).
 */
function getRepositoryPopupBodyHtml(props: ILogPanelProps): string {
  const subset = props.visibleRepoRoots
    ? new Set(props.visibleRepoRoots.map((p) => normalizeRepoPathString(p)))
    : null;
  const scopeAll = props.repositoryScope === 'all';
  const isChecked = (repo: IRepository, index: number): boolean => {
    if (subset) {
      return subset.has(normalizeRepoPath(repo.rootUri));
    }
    // No subset: every repo is checked in merged scope; only the scoped repo
    // is checked in a single-repo scope.
    return scopeAll || index === props.selectedRepositoryIndex;
  };
  const allChecked = scopeAll && !subset;

  const rows = props.availableRepositories
    .map((repo, index) => {
      const fsPath = repo.rootUri.fsPath;
      const folderName = escapeHtml(fsPath.split('/').pop() || fsPath);
      const checked = isChecked(repo, index) ? ' checked' : '';
      return `<label class="log-filter-tree-row" title="${escapeHtml(fsPath)}"><input type="checkbox" class="log-filter-tree-check" data-action="toggleRepoCheckbox" data-repo-root="${escapeHtml(fsPath)}"${checked} />${folderName}</label>`;
    })
    .join('');

  return `
              <div class="log-filter-popup-list" id="filter-repo-list">
                <label class="log-filter-tree-row"><input type="checkbox" class="log-filter-tree-check" data-action="toggleAllRepos"${allChecked ? ' checked' : ''} />All repositories</label>
                ${rows}
              </div>`;
}

/**
 * Human-readable Date-button value. `since`+`until` → "after – before";
 * one bound → "Since X" / "Until X"; neither → "All".
 */
function dateFilterLabel(
  since: Date | undefined,
  until: Date | undefined,
  datePreset?: DatePreset
): string {
  // A preset keeps its own name: rendering "Since <date>" both loses which
  // preset is active and reads as a midnight-bound custom range.
  if (datePreset !== undefined) {
    return DATE_PRESET_LABELS[datePreset];
  }
  const s = toDateInputValue(since);
  const u = toDateInputValue(until);
  if (s && u) {
    return `${s} – ${u}`;
  }
  if (s) {
    return `Since ${s}`;
  }
  if (u) {
    return `Until ${u}`;
  }
  return 'All';
}

/**
 * Branch-button value: a range ("A..B") as-is, the leaf name for a single
 * selected branch, "N branches" for a multi-select, the legacy single-branch
 * value if present, else "All". Mirrors the webview's `branchSummary` so the
 * label stays correct across a full re-render.
 */
function branchFilterLabel(filter: ILogFilter | undefined): string {
  if (filter?.logRange) {
    return filter.logRange;
  }
  if (filter?.branchesNone) {
    return 'None';
  }
  const branches = filter?.branches ?? [];
  if (branches.length === 1) {
    return branches[0].split('/').filter(Boolean).pop() || branches[0];
  }
  if (branches.length > 1) {
    return `${branches.length} branches`;
  }
  return filter?.branch || 'All';
}

/**
 * Repository-button value: "All" when every root is shown, the scoped repo's
 * folder name in a single-repo scope, or "N repositories" for a visible
 * subset.
 */
function repoScopeLabel(props: ILogPanelProps): string {
  if (props.visibleRepoRoots) {
    return props.visibleRepoRoots.length === 0
      ? 'None'
      : `${props.visibleRepoRoots.length} repositories`;
  }
  if (props.repositoryScope !== 'all') {
    const repo = props.availableRepositories[props.selectedRepositoryIndex];
    if (repo) {
      const fs = repo.rootUri.fsPath;
      return fs.split('/').pop() || fs;
    }
  }
  return 'All';
}

/**
 * Format a filter date for an `<input type="date">` value (YYYY-MM-DD).
 * Uses UTC parts so the rendered day matches the stored instant rather
 * than shifting under the host's local timezone. Returns '' for an
 * absent or invalid date.
 */
function toDateInputValue(date: Date | undefined): string {
  if (!date || Number.isNaN(date.getTime())) {
    return '';
  }
  const yyyy = date.getUTCFullYear().toString().padStart(4, '0');
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = date.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Get the branch labels HTML for a commit node.
 * Renders `<span>` elements for each branch name on the commit node.
 * Applies `branch-label-local` or `branch-label-remote` CSS class based on
 * the branch ref's `type` (sourced from `IBranch.type`, NOT guessed from
 * the name — see Bug E).
 * Branch names are escaped for HTML safety.
 *
 * @param node - The commit node to render branch labels for
 * @returns HTML string with branch label spans, or empty string if no branches
 *
 * @internal Public for direct snapshot tests (snap-7a..7e in
 *   `commitGraphSnapshots.test.ts`). The `_` prefix flags "do not
 *   call from production code outside this class"; the `public`
 *   visibility is intentional contract for white-box testability,
 *   matching the existing pattern (`_getGraphPanelHtml`,
 *   `_getMultiCommitDetailsPanelModel`, etc.).
 */
export function buildBranchLabelsHtml(
  node: ICommitNode,
  branchColors: ReadonlyMap<string, string> | undefined,
  state: IExtendedLogState
): string {
  const hasBranches = !!node.branches && node.branches.length > 0;
  // Tag chips render alongside the branch chip family. The
  // empty-string return contract (snap-7d) extends to the no-tag case
  // here so `.commit-branches:empty` still collapses.
  const hasTags = !!node.tags && node.tags.length > 0;

  if (!hasBranches && !hasTags) {
    // CSS `.commit-branches:empty { display: none }` depends
    // on this returning the LITERAL empty string (not whitespace, not
    // an HTML comment) so the empty wrapper collapses with no margin
    // / no flex basis. Pinned by snap-7d in commitGraphSnapshots.test.ts.
    //
    // Following IntelliJ, there is no separate "HEAD" badge: the
    // current branch is conveyed by colouring its own chip yellow (see
    // below). A detached HEAD with no branch tip therefore produces no
    // chip at all — matching IntelliJ, where a detached HEAD shows only
    // the bare commit row.
    return '';
  }

  const focusedBranchName = state.focusedBranchName;
  const headBranchName = state.headBranchName;
  const allBranches = node.branches || [];
  // Chip collapse rule (IntelliJ parity).
  //
  // Inline up to MAX_INLINE chips. Privileged refs — the current
  // (HEAD) branch and the focused branch — are pulled to the FRONT of
  // the inline set so they are never the ones hidden when a commit
  // carries more refs than fit. The remainder collapses into a single
  // clickable `+N` summary chip.
  //
  // This deliberately NEVER hides a lone branch behind a bare `+1`: a
  // single non-current tip always shows its name, because one chip is
  // always ≤ MAX_INLINE.
  const MAX_INLINE_BRANCH_CHIPS = 3;
  const isPrivileged = (name: string): boolean =>
    name === headBranchName || name === focusedBranchName;
  // Stable partition: privileged refs first (in their original
  // relative order), then the rest. A stable ordering keeps the
  // snapshot output deterministic.
  const orderedBranches = [
    ...allBranches.filter((b) => isPrivileged(b.name)),
    ...allBranches.filter((b) => !isPrivileged(b.name)),
  ];
  const inlineBranches: IBranchRef[] = orderedBranches.slice(0, MAX_INLINE_BRANCH_CHIPS);
  const collapsedBranches: IBranchRef[] = orderedBranches.slice(MAX_INLINE_BRANCH_CHIPS);

  // Option C (IntelliJ `LabelPainter`): the owning-branch color is the chip
  // ICON's color, NOT a chip fill. The chip stays a neutral badge with
  // foreground text (set in CSS), so the branch name is always readable
  // regardless of how light the branch color is — while the colored icon still
  // ties the chip to its graph line. The current-branch chip adds a ring +
  // bold (`.branch-label-head`).
  const chipColor = branchColors?.get(node.commit.hash);
  // Defense-in-depth: only inline a VALIDATED hex color into the `style`
  // attribute. `branchColors` is a controlled palette today, but a future
  // ref-derived value must never become CSS injection inside an inline style.
  const iconColorAttr =
    chipColor && /^#[0-9a-fA-F]{3,8}$/.test(chipColor) ? ` style="color:${chipColor}"` : '';

  const labels = inlineBranches.map((branchRef) => {
    const branchName = branchRef.name;
    // Classify directly from the branch ref's `type` (sourced from
    // IBranch.type / refs-prefix), NOT from a `name.includes('/')` heuristic.
    // A local branch named `feature/foo` is local, not remote.
    const isRemote = branchRef.type === 'remote';
    // The current branch (the one HEAD points at) gets the ring+bold
    // `.branch-label-head` treatment; its fill is the branch color like every
    // other chip.
    const isCurrent = !!headBranchName && branchName === headBranchName;
    const baseClass = isCurrent
      ? 'branch-label-head'
      : isRemote
        ? 'branch-label-remote'
        : 'branch-label-local';
    // `branch-label-focused` is render-time source of
    // truth for the focus outline; the partial-update message handler
    // is just the optimization for selection-changes-without-rerender.
    const isFocused = focusedBranchName === branchName;
    const cssClass = isFocused ? `${baseClass} branch-label-focused` : baseClass;
    const escapedName = escapeHtml(branchName);
    // role="img" + descriptive aria-label tells SRs
    // this is a branch chip, not just inline text. Per UX request,
    // both local and remote branches use the same codicon-git-branch
    // icon — the ref kind is still distinguishable via the chip's
    // CSS class (`branch-label-local` / `branch-label-remote`) and
    // the aria-label text ("Local branch:" / "Remote branch:"). The
    // icon's aria-hidden="true" lets the chip's own aria-label own
    // the AT narration. The aria-label string is run through
    // _escapeHtml since branch names are user-controlled.
    // aria-pressed is deferred to when chips become
    // keyboard-interactive — adding it now would lie about an
    // interaction that doesn't yet exist. Pinned by snap-12b..d, 12f.
    //
    // The current (HEAD) branch chip announces "Current branch: …".
    // With the standalone ✓HEAD badge removed, the yellow colour is the
    // visual current-branch cue; the aria-label is the non-colour
    // (WCAG 1.4.1) affordance that tells SR users which ref is HEAD.
    const iconClass = 'codicon-git-branch';
    const ariaLabelText = isCurrent
      ? `Current branch: ${branchName}`
      : isRemote
        ? `Remote branch: ${branchName}`
        : `Local branch: ${branchName}`;
    const ariaLabel = escapeHtml(ariaLabelText);
    // Focused chip carries `aria-describedby` to
    // a visually-hidden help span (rendered once at panel level)
    // explaining the focus state. Non-focused chips omit the
    // attribute so SRs don't announce the help text on every chip.
    const ariaDescribedByAttr = isFocused ? ' aria-describedby="focused-branch-help"' : '';
    // data-branch-name carries the unescaped name so the inline
    // script's partial-update handler can match by attribute. The
    // attribute value goes through the same _escapeHtml the chip text
    // uses so reflective injection is impossible. `iconColorAttr` tints the
    // chip ICON with the controlled palette hex so the chip ties to its
    // graph line; the chip itself is a neutral badge (CSS).
    return `<span class="${cssClass}" data-branch-name="${escapedName}" role="img" aria-label="${ariaLabel}"${ariaDescribedByAttr}><i class="codicon ${iconClass}"${iconColorAttr} aria-hidden="true"></i>${escapedName}</span>`;
  });

  // Tag chips render LAST (rightmost) so branch
  // chips remain in their existing order. Following IntelliJ's "Tag
  // Names off" default, a tag renders as the codicon-tag ICON at rest;
  // the NAME is revealed only on hover/focus (the .tag-label-name span,
  // collapsed by CSS until :hover/:focus). The name stays in the DOM
  // (find-in-page + textContent) and is always available to screen
  // readers via the chip's aria-label="Tag: …" (the discoverability
  // backstop), plus a native title= tooltip. The chip is keyboard-
  // focusable (tabindex="0") so focus reveals the name too — the
  // reveal is never mouse-only (WCAG). data-tag-name carries the
  // unescaped name for any future partial-update path. The tag name is
  // run through `_escapeHtml` for textContent, aria-label, and title.
  const tagLabels = (node.tags || []).map((tagName) => {
    const escapedName = escapeHtml(tagName);
    const ariaLabel = escapeHtml(`Tag: ${tagName}`);
    return `<span class="tag-label" data-tag-name="${escapedName}" role="img" aria-label="${ariaLabel}" title="${escapedName}" tabindex="0"><i class="codicon codicon-tag" aria-hidden="true"></i><span class="tag-label-name">${escapedName}</span></span>`;
  });

  // Collapse summary chip: `+N` shown after the inline branch chips
  // (and before the tag chips) when more branches exist than fit
  // inline. The chip is a BUTTON — clicking (or Enter/Space) opens a
  // popup listing every collapsed ref; each popup row navigates to that
  // branch. role="button" + tabindex="0" make it keyboard-activatable
  // with a visible focus ring (WCAG 1.4.1 — interaction is not
  // colour-only). aria-haspopup advertises the menu; aria-expanded
  // starts "false" and the popup handler toggles it as the menu
  // opens/closes (WCAG 4.1.2 state). The title= tooltip still lists the
  // names on hover, and data-collapsed-branches carries the names the
  // popup handler consumes.
  let collapsedSummaryHtml = '';
  if (collapsedBranches.length > 0) {
    const tooltipLines = collapsedBranches.map((b) => b.name).join('\n');
    const escapedTooltip = escapeHtml(tooltipLines);
    // data-collapsed-branches is a JSON array of the collapsed ref names,
    // consumed by the popup handler's `JSON.parse`. JSON lets a name
    // contain ANY character — including a literal '|' (git permits it) —
    // without the delimiter collision a pipe-join had. _escapeHtml then
    // makes the JSON safe inside the double-quoted attribute; the browser
    // decodes the entities back to valid JSON before the handler reads it.
    const dataAttr = escapeHtml(JSON.stringify(collapsedBranches.map((b) => b.name)));
    const ariaLabel = escapeHtml(
      `Show ${collapsedBranches.length} more branch${collapsedBranches.length === 1 ? '' : 'es'}: ${collapsedBranches.map((b) => b.name).join(', ')}`
    );
    collapsedSummaryHtml = `<span class="branch-label-collapsed" data-collapsed-branches="${dataAttr}" role="button" tabindex="0" aria-label="${ariaLabel}" aria-haspopup="true" aria-expanded="false" title="${escapedTooltip}">+${collapsedBranches.length}</span>`;
  }

  return labels.join('') + collapsedSummaryHtml + tagLabels.join('');
}
