import * as path from 'path';
import { ICommitNode } from '../../commitGraph';
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
    printModels,
    branchLabelsFor,
    showGpgColumn,
    showRootColumn,
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
