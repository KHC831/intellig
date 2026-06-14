import { ICommitNode, isBranchSplit } from '../../commitGraph';
import { ActiveLaneMap, DEFAULT_GRAPH_CONFIG, renderGraphSvg } from '../../../utils/graphRenderer';
import { formatCommitDate } from '../../../utils/dateFormat';
import { escapeHtml } from './htmlBuilders';

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
export function buildCommitRows(commitNodes: ICommitNode[], rowData: ICommitRowData): string {
  const {
    selected,
    cherryPickedHashes,
    cherryPickBaseRef,
    activeLaneMap,
    terminalNodes,
    childCountMap,
    childLanesMap,
    incomingBendsMap,
    hasFocusedBranch,
    branchLabelsFor,
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
      // Source lanes whose far-parent first-parent
      // line lands at THIS row from above. The renderer draws a top-half
      // bend per lane.
      const incomingBendLanes = incomingBendsMap.get(commit.hash) || new Set<number>();
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
        incomingBendLanes
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
      // `_truncateMessage` is preserved at :3149 — still used by
      // `_getMultiCommitDetailsPanelHtml` at :3057 for the
      // details-panel preview, where a hard char cap IS desired
      // (no flex container, no responsive ellipsis behind it).
      const messageFirstLine = commit.message.split('\n')[0];
      const messageSummary = escapeHtml(messageFirstLine);
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
             role="option"
             tabindex="0"
             aria-selected="${isSelected}">
          <div class="commit-graph">
            ${graphSvg}${cherryBadgeHtml}
          </div>
          <div class="commit-info">
            <div class="commit-title" title="${fullMessage}">${messageSummary}</div>
            <div class="commit-branches">${branchLabelsHtml}</div>
            <span class="commit-author" title="${authorEmail}">${authorName}</span>
            <span class="commit-date" title="${fullDate}">${commitDate}</span>
          </div>
        </div>`;
    })
    .join('');
}
