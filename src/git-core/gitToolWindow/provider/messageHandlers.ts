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
