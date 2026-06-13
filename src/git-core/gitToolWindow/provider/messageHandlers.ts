import { computeRangeSelection } from '../multiSelect';
import type { ICommitDetails } from '../../../services/interfaces';
import type { IGtwControllerContext } from './IGtwControllerContext';

/**
 * Webview message handlers extracted from the Git tool window provider's
 * dispatch switch. Each takes the controller context and performs the work
 * for one inbound webview message, reaching provider state, emitters, and
 * behavior through the narrowed context rather than the concrete class.
 */

/**
 * Handle the loadMoreCommits message from the webview.
 * Fires the onDidRequestLoadMoreCommits event so that the extension host
 * can fetch the next batch of commits and append them.
 */
export function handleLoadMoreCommits(ctx: IGtwControllerContext): void {
  ctx.fireLoadMoreCommits();
}

/**
 * Handle the panelResize message from the webview.
 * Receives the new graph/details width percentages from the draggable
 * dividers and applies them. The write + persistence are coupled inside
 * `setPanelWidths`, so the handler just hands the new widths to the context.
 *
 * @param widths - The new panel width percentages [graph, details]
 */
export function handlePanelResize(ctx: IGtwControllerContext, widths: [number, number]): void {
  ctx.setPanelWidths(widths);
}

/**
 * Select the given commit only if it is not already part of the current
 * selection — "right-clicking an unselected commit moves selection to that
 * commit". No-op when the hash is already selected, so the multi-select stays
 * intact and the action targets all selected commits. Reads the live
 * selection set off the context and delegates the actual mutation to
 * selectCommit.
 */
export function selectIfNotSelected(ctx: IGtwControllerContext, hash: string): void {
  if (ctx.extendedLogState.selectedCommits.has(hash)) {
    return;
  }
  ctx.selectCommit(hash);
}

/**
 * Programmatic selection setter. Replaces the current selection with
 * `hashes` (dropping any not in the rendered commit nodes), sets the anchor
 * per the `anchor` argument, focuses the details pane on the first surviving
 * hash, then renders + fires + posts in the standard order.
 */
export function selectCommits(
  ctx: IGtwControllerContext,
  hashes: readonly string[],
  anchor?: string | null
): void {
  // Mirror selectCommit's pending-state cleanup so
  // a programmatic selection doesn't leak a half-loaded changed-files
  // payload into the next details-panel render.
  ctx.clearPendingChangedFiles();

  const known = new Set(ctx.extendedLogState.commitNodes.map((n) => n.commit.hash));
  const filtered = hashes.filter((h) => known.has(h));
  ctx.extendedLogState.selectedCommits = new Set(filtered);

  if (anchor === undefined) {
    // No explicit anchor: pick the first surviving hash, or null if empty.
    ctx.extendedLogState.anchorHash = filtered.length > 0 ? filtered[0] : null;
  } else if (anchor === null) {
    ctx.extendedLogState.anchorHash = null;
  } else {
    ctx.extendedLogState.anchorHash = known.has(anchor) ? anchor : null;
  }
  // For N>=2, focus the details pane on the FIRST
  // surviving hash so the panel can't show a stale commit that's no
  // longer in the selection. For N=1, use that single hash. For N=0,
  // leave whatever was there (the pane will switch to the placeholder
  // on the next render).
  if (filtered.length >= 1) {
    ctx.extendedLogState.expandedCommit = filtered[0];
  }

  // (HIGH) — render BEFORE posting so the precomputed enable map
  // anchor sync land on the live document, not the pre-reload one.
  ctx.updateWebview();
  // Fire BEFORE the post sequence (matches
  // selectCommit's ordering).
  ctx.fireDidChangeState();
  // belt-and-suspenders — the rendered HTML already
  // carries data-anchor-hash; syncSelection guards against
  // interpolation bugs and partial-update extension cases.
  ctx.postSyncSelection();
  ctx.postMenuStateUpdate();
}

/**
 * Shift+click range-select. Replaces the selection with the inclusive range
 * from the current anchor to `hash` (display order). When the anchor is null
 * or has scrolled out of the rendered list, falls back to selectCommit + the
 * anchor is left to that path. Anchor is intentionally NOT moved — IntelliJ
 * semantics so the user can keep extending the range from the same anchor.
 */
export function rangeSelectCommit(ctx: IGtwControllerContext, hash: string): void {
  const allHashes = ctx.extendedLogState.commitNodes.map((n) => n.commit.hash);
  const range = computeRangeSelection(ctx.extendedLogState.anchorHash, hash, allHashes);

  if (range.length === 0) {
    // Click target not in the rendered list; nothing to do.
    return;
  }

  const anchorIsValid =
    ctx.extendedLogState.anchorHash !== null &&
    allHashes.indexOf(ctx.extendedLogState.anchorHash) !== -1;

  if (!anchorIsValid) {
    // Anchor-null OR stale anchor (TL-C-1): behave like a plain-click —
    // set anchor + selection to the clicked hash. Mirrors the
    // applyRangeSelectionDom JS behavior so the host doesn't drift.
    ctx.selectCommit(hash);
    return;
  }

  ctx.clearPendingChangedFiles();

  ctx.extendedLogState.selectedCommits = new Set(range);
  ctx.extendedLogState.expandedCommit = hash;
  // Anchor unchanged — shift-click does not move the anchor.

  // Fire BEFORE the post sequence.
  ctx.fireDidChangeState();
  // Partial-update path — sync selection + details panel without
  // a full HTML re-render. Bug fix: the previous `_updateWebview()`
  // call rebuilt the entire panel HTML, which destroyed the
  // currently-focused commit-row DOM element. The webview JS keys
  // its keyboard handler off `e.target.closest('.commit-row')`, so
  // after a re-render no row is focused and the next Shift+Arrow
  // press finds no target — the user-visible "Shift+Arrow stops
  // responding after 1-2 commits" symptom.
  ctx.postSyncSelection();
  ctx.postDetailsForExpandedCommit();
  ctx.postMenuStateUpdate();
}

/**
 * Shift+Ctrl+click additive range-select. Adds the inclusive range from the
 * anchor to `hash` to the existing selection. With a null/stale anchor, falls
 * back to a single toggle so the first click still has an effect. Anchor is
 * unchanged.
 */
export function addRangeSelectCommit(ctx: IGtwControllerContext, hash: string): void {
  const allHashes = ctx.extendedLogState.commitNodes.map((n) => n.commit.hash);
  const range = computeRangeSelection(ctx.extendedLogState.anchorHash, hash, allHashes);

  if (range.length === 0) {
    return;
  }

  const anchorIsValid =
    ctx.extendedLogState.anchorHash !== null &&
    allHashes.indexOf(ctx.extendedLogState.anchorHash) !== -1;

  if (!anchorIsValid) {
    // Mirror rangeSelectCommit: stale/null anchor → plain toggle.
    toggleCommitSelection(ctx, hash);
    return;
  }

  for (const h of range) {
    ctx.extendedLogState.selectedCommits.add(h);
  }
  ctx.extendedLogState.expandedCommit = hash;

  // Fire BEFORE the post sequence.
  ctx.fireDidChangeState();
  // Partial-update path — see the matching comment block in
  // `rangeSelectCommit` for the rationale: a full `_updateWebview()`
  // re-render destroys commit-row focus and breaks the keyboard
  // Shift+Arrow loop.
  ctx.postSyncSelection();
  ctx.postDetailsForExpandedCommit();
  ctx.postMenuStateUpdate();
}

/**
 * Single-select a commit in the log view. Clears any pending changed-files
 * payload, replaces the selection with `hash`, sets it as both the expanded
 * commit and the multi-select anchor (plain-click moves the anchor), fires the
 * select + state-change events, then posts a partial details-panel update so
 * the graph scroll position is preserved instead of a full re-render. The
 * graph-row highlight + details-panel posts run only when a view is attached,
 * with the details payload built from the matching commit node (or a
 * placeholder when the hash is not among the rendered nodes).
 */
export function selectCommit(ctx: IGtwControllerContext, hash: string): void {
  // Clear pending changed files when selecting a new commit
  ctx.clearPendingChangedFiles();

  ctx.extendedLogState.selectedCommits.clear();
  ctx.extendedLogState.selectedCommits.add(hash);
  ctx.extendedLogState.expandedCommit = hash;
  // plain-click sets the multi-select anchor.
  ctx.extendedLogState.anchorHash = hash;

  // Fire onDidChangeState BEFORE the post sequence
  // so subscribers see "selection changed" on the same event-loop
  // tick the host knows it.
  ctx.fireDidSelectCommit(hash);
  ctx.fireDidChangeState();
  ctx.postMenuStateUpdate();

  // Send a partial update to the details panel via postMessage
  // instead of a full _updateWebview() to preserve graph scroll position.
  // Also update the graph row selection highlighting and scroll to the commit.
  if (ctx.hasView()) {
    // Update graph row selection
    ctx.postToWebview({
      type: 'selectGraphRow',
      commitHash: hash,
    });

    const node = ctx.extendedLogState.commitNodes.find((n) => n.commit.hash === hash);
    if (node) {
      const commitDetails: ICommitDetails = {
        hash: node.commit.hash,
        message: node.commit.message,
        body: node.commit.body,
        author: { name: node.commit.author.name, email: node.commit.author.email },
        date: node.commit.authorDate,
        parents: node.commit.parents || [],
        branches: (node.branches || []).map((ref) => ref.name),
        tags: node.tags || [],
        changedFiles: [],
      };
      const detailsHtml = ctx.getDetailsPanelHtml(commitDetails);
      ctx.postToWebview({
        type: 'updateDetailsPanel',
        html: detailsHtml,
      });
    } else {
      // Commit not found — show placeholder
      const placeholderHtml = ctx.getDetailsPanelPlaceholderHtml();
      ctx.postToWebview({
        type: 'updateDetailsPanel',
        html: placeholderHtml,
      });
    }
  }
}

/**
 * Toggle commit selection (for multi-select)
 */
export function toggleCommitSelection(ctx: IGtwControllerContext, hash: string): void {
  if (ctx.extendedLogState.selectedCommits.has(hash)) {
    ctx.extendedLogState.selectedCommits.delete(hash);
  } else {
    ctx.extendedLogState.selectedCommits.add(hash);
  }
  // Ctrl/Cmd-click also moves the anchor to the clicked
  // commit, matching IntelliJ's selection model.
  ctx.extendedLogState.anchorHash = hash;

  // (HIGH) — order: render FIRST so the new document exists,
  // THEN post so postMessage lands on the live page rather than the
  // pre-reload one (ADR-009 §3 sub-rule). _postSyncSelection mirrors
  // the host's anchor + selection onto the JS-side mirror so the
  // freshly-rendered document agrees with state on first paint.
  ctx.updateWebview();
  // Fire onDidChangeState BEFORE the wire posts
  // so subscribers see "selection changed" on the same event-loop
  // tick the host knows it. Aligns with selectCommit's ordering.
  ctx.fireDidChangeState();
  // belt-and-suspenders — the rendered HTML already
  // carries data-anchor-hash; syncSelection guards against
  // interpolation bugs and partial-update extension cases.
  ctx.postSyncSelection();
  ctx.postMenuStateUpdate();
}
