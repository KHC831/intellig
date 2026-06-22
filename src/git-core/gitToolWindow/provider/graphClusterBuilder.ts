import * as path from 'path';
import { ICommitNode, isBranchSplit } from '../../commitGraph';
import { ActiveLaneMap, DEFAULT_GRAPH_CONFIG, renderGraphSvg } from '../../../utils/graphRenderer';
import { formatCommitDate } from '../../../utils/dateFormat';
import { escapeHtml } from './htmlBuilders';
import { parseFixupSquashSubject } from './fixupSquashSubject';

/**
 * Per-render lane/graph inputs for {@link buildCommitRows}, pre-computed once
 * over the whole `commitNodes` window by `_getGraphPanelHtml` (Zone A) and
 * threaded into the row builder so it stays a pure function with no provider
 * or controller-context reference.
 */
export interface ICommitRowData {
  /** Hashes of the currently selected commits. */
  selected: Set<string>;
  /** Hashes already cherry-picked onto {@link cherryPickBaseRef}, if known. */
  cherryPickedHashes?: Set<string>;
  /** The base ref used when computing {@link cherryPickedHashes}. */
  cherryPickBaseRef?: string;
  /** Active lanes per row index. */
  activeLaneMap: ActiveLaneMap;
  /**
   * Per row, lanes that continue from the row above as the same line. Optional
   * for back-compat with callers/tests that predate the through-line fix; when
   * omitted, a branch-split row falls back to the prior suppression behaviour.
   */
  continuesFromAboveMap?: ActiveLaneMap;
  /**
   * Per row, lanes that continue into the row below as the same line. Paired
   * with {@link continuesFromAboveMap}; together they let the renderer draw
   * straight strokes from the precise interval model (reuse vs. through-line).
   * Optional for back-compat with callers/tests that predate the fix.
   */
  continuesBelowMap?: ActiveLaneMap;
  /** Hashes that are terminal (branch-tip) nodes. */
  terminalNodes: Set<string>;
  /** Child count per commit hash, for split-point detection. */
  childCountMap: Map<string, number>;
  /** Child lanes per commit hash. */
  childLanesMap: Map<string, Set<number>>;
  /** Source lanes whose far-parent line lands at each parent hash. */
  incomingBendsMap: Map<string, Set<number>>;
  /** True when any commit in the rendered set is on the focused-branch path. */
  hasFocusedBranch: boolean;
  /** Renders the branch-labels HTML for a node (provider-bound callback). */
  branchLabelsFor: (node: ICommitNode) => string;
  /**
   * When true, render the GPG/SSH signature status column (G5 parity).
   * Driven by the `intellig.log.showGpgColumn` setting (default false).
   */
  showGpgColumn?: boolean;
  /**
   * When true, render the repository "Root" column showing the basename of
   * each commit's repo root directory (G8 multi-root log parity).
   * Driven by the `intellig.log.showAllRoots` setting (default false).
   */
  showRootColumn?: boolean;
}

/**
 * Build the joined HTML for every commit row in the graph panel.
 *
 * This is the per-row graph-cluster assembly extracted verbatim from
 * `GitToolWindowProvider._getGraphPanelHtml`: for each `(node, index)` it
 * derives the row's lane inputs from the pre-computed maps, renders the graph
 * SVG, formats the message/author/date fields, builds the cherry-picked
 * badge, and assembles the `.commit-row` markup. The rendered output is
 * byte-identical to the inline implementation it replaced.
 */
/**
 * Map a `%G?` character to the visual glyph, CSS modifier class, and tooltip
 * shown in the GPG signature column.
 *
 * Returns `undefined` for 'N' (no signature) and for absent/unknown values so
 * the cell is left empty for unsigned commits — matching IntelliJ's GPG column
 * behaviour (no badge for unsigned commits).
 */
function gpgStatusCell(
  status: string | undefined
): { glyph: string; cssClass: string; title: string } | undefined {
  switch (status) {
    case 'G':
      return { glyph: '✓', cssClass: 'log-gpg-valid', title: 'Valid signature' };
    case 'B':
      return { glyph: '✗', cssClass: 'log-gpg-bad', title: 'Bad signature' };
    case 'U':
      return { glyph: '?', cssClass: 'log-gpg-warn', title: 'Unknown validity' };
    case 'X':
      return { glyph: '⚠', cssClass: 'log-gpg-warn', title: 'Expired key' };
    case 'Y':
      return { glyph: '⚠', cssClass: 'log-gpg-warn', title: 'Expired key at signing time' };
    case 'R':
      return { glyph: '✗', cssClass: 'log-gpg-bad', title: 'Revoked key' };
    case 'E':
      return { glyph: '—', cssClass: 'log-gpg-muted', title: 'Cannot check (missing key)' };
    default:
      // 'N' (no signature) and undefined → empty cell
      return undefined;
  }
}

export function buildCommitRows(commitNodes: ICommitNode[], rowData: ICommitRowData): string {
  const {
    selected,
    cherryPickedHashes,
    cherryPickBaseRef,
    activeLaneMap,
    continuesFromAboveMap,
    continuesBelowMap,
    terminalNodes,
    childCountMap,
    childLanesMap,
    incomingBendsMap,
    hasFocusedBranch,
    branchLabelsFor,
    showGpgColumn,
    showRootColumn,
  } = rowData;

  return commitNodes
    .map((node, index) => {
      const commit = node.commit;
      const isSelected = selected.has(commit.hash);
      const isCherryPicked = cherryPickedHashes?.has(commit.hash) ?? false;

      // Generate SVG graph for this row
      const activeLanes = activeLaneMap.get(index) || new Set<number>();
      const isTerminal = terminalNodes.has(commit.hash);
      const isSplitPoint = isBranchSplit(commit.hash, childCountMap);
      const childLanes = childLanesMap.get(commit.hash) || new Set<number>();
      // Next row's active lanes, so the renderer can tell whether a
      // bezier-target lane also continues below (a through-lane) and must
      // be drawn full-height — preventing the gap under a merge commit.
      const nextActiveLanes = activeLaneMap.get(index + 1) || new Set<number>();
      // Previous row's active lanes, so the renderer can tell whether a lane
      // continues from ABOVE. A lane active here but not above is born at this
      // row (a merge's second-parent lane) and must not draw a top-half stub
      // floating above the merge diamond.
      const prevActiveLanes = activeLaneMap.get(index - 1) || new Set<number>();
      // Lanes transiting straight through THIS row from above (same line), so a
      // branch-split row keeps a genuine through-line's pass-through stroke.
      const continuesFromAbove = continuesFromAboveMap?.get(index) || new Set<number>();
      // Lanes that continue from THIS row into the row below as the same line.
      // Paired with `continuesFromAbove`, this is what switches the renderer to
      // the precise interval-model straight-stroke path (vs. legacy heuristics).
      const continuesBelow = continuesBelowMap?.get(index);
      // Source lanes whose far-parent first-parent
      // line lands at THIS row from above. The renderer draws a top-half
      // bend per lane.
      const incomingBendLanes = incomingBendsMap.get(commit.hash) || new Set<number>();
      // The last loaded row caps its off-window continuations with a "more
      // history below" chevron.
      const isLastRow = index === commitNodes.length - 1;
      const graphSvg = renderGraphSvg(
        node,
        index,
        activeLanes,
        DEFAULT_GRAPH_CONFIG,
        isTerminal,
        isSplitPoint,
        childLanes,
        hasFocusedBranch,
        nextActiveLanes,
        incomingBendLanes,
        prevActiveLanes,
        isLastRow,
        continuesFromAbove,
        continuesBelow
      );

      // Format fields.
      //
      // Emit the FULL first line of the commit message
      // and let CSS `.commit-title { overflow: hidden; text-overflow:
      // ellipsis; white-space: nowrap }` truncate responsively based on
      // the panel's actual flex-allocated width. The call to
      // `_truncateMessage(…, 60)` hard-capped the row text at 60 chars
      // regardless of available space, so a 1200px-wide panel still
      // showed `"…"` on a 70-char subject. The tooltip (`title=` below)
      // still carries the full multi-line message so hover still
      // reveals everything.
      //
      // The details-panel multi-commit preview uses a hard char cap
      // instead (buildMultiCommitDetailsPanelModel's truncateSummary),
      // where a fixed cap IS desired (no flex container, no responsive
      // ellipsis behind it).
      const messageFirstLine = commit.message.split('\n')[0];
      // G6 parity: fixup!/squash! subjects render a clickable link on the
      // target text so the user can jump to the target commit in the log.
      // IntelliJ reference: GitLinkToCommitResolver.kt (git4idea).
      const fixupParsed = parseFixupSquashSubject(messageFirstLine);
      const messageSummary = fixupParsed
        ? `${escapeHtml(fixupParsed.prefix)} <a class="log-fixup-link" data-action="jumpToFixupTarget" data-target="${escapeHtml(fixupParsed.target)}">${escapeHtml(fixupParsed.target)}</a>`
        : escapeHtml(messageFirstLine);
      const fullMessage = escapeHtml(commit.message);
      const authorName = escapeHtml(commit.author.name);
      const authorEmail = escapeHtml(commit.author.email);
      // IntelliJ-style absolute timestamp: the row shows a
      // locale-aware date + time (no seconds), matching IntelliJ's
      // log. The inline label never goes stale (no relative "2h"
      // distance baked into static HTML); the tooltip carries the
      // full timestamp with seconds. See `formatCommitDate`.
      const { display: dateDisplay, tooltip: dateTooltip } = formatCommitDate(commit.authorDate);
      const commitDate = escapeHtml(dateDisplay);
      const fullDate = escapeHtml(dateTooltip);

      // Generate branch labels HTML
      const branchLabelsHtml = branchLabelsFor(node);

      // `✓` badge + title tooltip for already-cherry-picked commits.
      const cherryBadgeHtml = isCherryPicked
        ? `<span class="commit-cherry-badge" title="${
            cherryPickBaseRef
              ? `Already cherry-picked to ${escapeHtml(cherryPickBaseRef)}`
              : 'Already cherry-picked'
          }" aria-label="already cherry-picked">✓</span>`
        : '';

      // GPG signature cell — only rendered when the column is enabled.
      let gpgCellHtml = '';
      if (showGpgColumn) {
        const cell = gpgStatusCell((commit as { gpgStatus?: string }).gpgStatus);
        gpgCellHtml = cell
          ? `<span class="log-gpg-status ${cell.cssClass}" title="${escapeHtml(cell.title)}" aria-label="${escapeHtml(cell.title)}">${cell.glyph}</span>`
          : `<span class="log-gpg-status"></span>`;
      }

      // Root column cell — shown when showAllRoots is enabled (G8).
      // Displays the basename of the repo root so users can identify
      // which repository each commit belongs to in the merged view.
      let rootCellHtml = '';
      if (showRootColumn) {
        const repoRootPath = (commit as { repoRoot?: string }).repoRoot;
        if (repoRootPath) {
          const basename = escapeHtml(path.basename(repoRootPath));
          const fullPath = escapeHtml(repoRootPath);
          rootCellHtml = `<span class="log-root-label" title="${fullPath}">${basename}</span>`;
        }
      }

      const rowClasses = [
        'commit-row',
        isSelected ? 'selected' : '',
        isCherryPicked ? 'commit-row-cherry-picked' : '',
      ]
        .filter(Boolean)
        .join(' ');

      return `
        <div class="${rowClasses}"
             data-hash="${escapeHtml(commit.hash)}"
             data-parents="${escapeHtml(commit.parents.join(','))}"
             role="option"
             tabindex="0"
             aria-selected="${isSelected}">
          <div class="commit-graph">
            ${graphSvg}${cherryBadgeHtml}
          </div>
          <div class="commit-info">
            ${rootCellHtml}
            <div class="commit-title" title="${fullMessage}">${messageSummary}</div>
            <div class="commit-branches">${branchLabelsHtml}</div>
            <span class="commit-author" title="${authorEmail}">${authorName}</span>
            <span class="commit-date" title="${fullDate}">${commitDate}</span>
            ${gpgCellHtml}
          </div>
        </div>`;
    })
    .join('');
}
