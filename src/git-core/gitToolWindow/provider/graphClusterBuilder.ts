import * as path from 'path';
import { ICommitNode } from '../../commitGraph';
import { GRAPH_BRANCH_COLORS } from '../../graph/branchColors';
import { DEFAULT_GRAPH_CONFIG } from '../../../utils/graphRenderer';
import { IRowPrintModel } from '../../graph/printModel';
import { paintRow } from '../../graph/graphPainter';
import { formatCommitDate } from '../../../utils/dateFormat';
import { escapeHtml } from './htmlBuilders';
import { parseFixupSquashSubject } from './fixupSquashSubject';

/**
 * Per-render inputs for {@link buildCommitRows}. The graph SVG for every row is
 * pre-built once by `_getGraphPanelHtml` into {@link printModels} (Layer 3); the
 * row builder just paints each model (Layer 4) and assembles the surrounding
 * commit-info markup, staying a pure function with no provider/controller ref.
 */
export interface ICommitRowData {
  /** Hashes of the currently selected commits. */
  selected: Set<string>;
  /** Hashes already cherry-picked onto {@link cherryPickBaseRef}, if known. */
  cherryPickedHashes?: Set<string>;
  /** The base ref used when computing {@link cherryPickedHashes}. */
  cherryPickBaseRef?: string;
  /** Per-row graph print model (one per commit, same order as `commitNodes`). */
  printModels: IRowPrintModel[];
  /** Renders the branch-labels HTML for a node (provider-bound callback). */
  branchLabelsFor: (node: ICommitNode) => string;
  /**
   * When true, render the GPG/SSH signature status column (G5 parity).
   * Driven by the `intellig.log.showGpgColumn` setting (default false).
   */
  showGpgColumn?: boolean;
  /**
   * When true, render the repository "Root" column: a narrow stripe in a
   * stable per-root color (IntelliJ vcs-log parity), the basename in the
   * tooltip. Driven by `intellig.log.showAllRoots`; the provider only sets it
   * for multi-repository workspaces.
   */
  showRootColumn?: boolean;
  /**
   * When true (and {@link showRootColumn} is on), the root column widens and
   * paints the repo basename on the root color — IntelliJ's "Show Root
   * Names". Driven by `intellig.log.showRootNames` (default false).
   */
  showRootNames?: boolean;
}

/** Stable per-root stripe color: a name-stable hash over the shared graph
 * palette, so a repo keeps its color across sessions, filters, and reloads. */
function rootColor(rootPath: string): string {
  let h = 0;
  for (let i = 0; i < rootPath.length; i++) {
    h = (Math.imul(31, h) + rootPath.charCodeAt(i)) | 0;
  }
  return GRAPH_BRANCH_COLORS[Math.abs(h) % GRAPH_BRANCH_COLORS.length];
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
    printModels,
    branchLabelsFor,
    showGpgColumn,
    showRootColumn,
    showRootNames,
  } = rowData;

  return commitNodes
    .map((node, index) => {
      const commit = node.commit;
      const isSelected = selected.has(commit.hash);
      const isCherryPicked = cherryPickedHashes?.has(commit.hash) ?? false;

      // Paint this row's pre-built print model (Layer 4). All graph topology
      // decisions live in the model (Layer 3); the painter is dumb.
      const graphSvg = paintRow(printModels[index], DEFAULT_GRAPH_CONFIG);

      // Format fields.
      //
      // Emit the FULL first line and let CSS `.commit-title { overflow:
      // hidden; text-overflow: ellipsis; white-space: nowrap }` truncate it
      // against the panel's actual flex-allocated width — a character cap
      // here would ellipsize a 70-char subject on a 1200px-wide panel. The
      // tooltip (`title=` below) carries the full multi-line message.
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

      // Root column cell (G8, merged multi-root log) — IntelliJ-style
      // (vcs-log RootCellRenderer): a narrow stripe in a stable per-root
      // color, fused across consecutive same-root rows; the repo name lives
      // in the tooltip. `showRootNames` widens the cell and paints the
      // basename on the color instead. The provider enables the column only
      // when the workspace has more than one repository.
      let rootCellHtml = '';
      if (showRootColumn) {
        const rootOf = (i: number): string | undefined =>
          (commitNodes[i]?.commit as { repoRoot?: string } | undefined)?.repoRoot;
        const repoRootPath = rootOf(index);
        if (repoRootPath) {
          const samePrev = rootOf(index - 1) === repoRootPath;
          const sameNext = rootOf(index + 1) === repoRootPath;
          const run =
            samePrev && sameNext
              ? ''
              : samePrev
                ? ' run-end'
                : sameNext
                  ? ' run-start'
                  : ' run-single';
          const color = rootColor(repoRootPath);
          const basename = escapeHtml(path.basename(repoRootPath));
          const fullPath = escapeHtml(repoRootPath);
          rootCellHtml = showRootNames
            ? `<span class="log-root-name log-root-cell${run}" style="background-color: ${color}" title="${fullPath}">${basename}</span>`
            : `<span class="log-root-cell"><span class="log-root-stripe${run}" style="background-color: ${color}" title="${basename} — ${fullPath}"></span></span>`;
        } else {
          // Keep the cell so rows stay aligned when a commit carries no root.
          rootCellHtml = `<span class="log-root-cell"></span>`;
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
          ${rootCellHtml}
          <div class="commit-graph">
            ${graphSvg}${cherryBadgeHtml}
          </div>
          <div class="commit-info">
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
