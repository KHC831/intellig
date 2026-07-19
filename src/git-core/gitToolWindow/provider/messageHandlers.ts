import { computeRangeSelection } from '../multiSelect';
import type { IGtwControllerContext } from './IGtwControllerContext';
import { buildDetailsPanelPlaceholderModel, commitNodeToBaseDetails } from './detailsPanelModel';
import type { DetailsPanelModel } from './detailsPanelModel';
import type { ICommitDetails } from '../../../services/interfaces';

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
  // Keep `expandedCommit` on the first surviving hash so single-commit
  // consumers (and the N=1 render) never point at a commit that left the
  // selection. At N=0 it is moot: the seam posts the placeholder.
  if (filtered.length >= 1) {
    ctx.extendedLogState.expandedCommit = filtered[0];
  }

  // Render BEFORE posting so the precomputed enable map
  // anchor sync land on the live document, not the pre-reload one.
  // focus-restore-exempt: a scripted selection answers no gesture, so there is
  // no focus to hand back and pulling it would yank the user out of whatever
  // they are actually using.
  ctx.updateWebview();
  // Fire BEFORE the post sequence (matches
  // selectCommit's ordering).
  ctx.fireDidChangeState();
  // belt-and-suspenders — the rendered HTML already
  // carries data-anchor-hash; syncSelection guards against
  // interpolation bugs and partial-update extension cases.
  ctx.postSyncSelection();
  ctx.postMenuStateUpdate();

  postDetailsForSelection(ctx);
}

/**
 * The current selection in GRAPH order.
 *
 * `selectedCommits` is a Set, so iterating it yields click order — which would
 * make both the rendered block order and which commits the load cap keeps
 * depend on the sequence the user happened to click. IntelliJ reads the
 * selection off the table (`VcsLogGraphTable.getSelection` →
 * `getSelectedRows()`), which is ascending row order however it was built.
 * Hashes no longer among the rendered nodes keep their relative order at the
 * end; they contribute no block, but the loader still hears about them.
 */
function selectionInGraphOrder(ctx: IGtwControllerContext): string[] {
  const rows = ctx.extendedLogState.commitNodes.map((n) => n.commit.hash);
  return Array.from(ctx.extendedLogState.selectedCommits)
    .map((hash, insertion) => ({ hash, insertion, row: rows.indexOf(hash) }))
    .sort((a, b) => {
      if (a.row === b.row) {
        return a.insertion - b.insertion;
      }
      return (a.row === -1 ? Infinity : a.row) - (b.row === -1 ? Infinity : b.row);
    })
    .map((entry) => entry.hash);
}

/**
 * Post the details payload the CURRENT selection calls for: the placeholder
 * at none, the multi-commit model at two or more, the single-commit model
 * otherwise.
 *
 * Every path that changes the selection posts through here. A selection of
 * two or more commits is its own presentation — a count, the per-commit
 * summaries and the combined file tree — and rendering the range tip's
 * details instead misreports an N-commit selection as one commit (reference:
 * CommitDetailsListPanel renders a block per commit). An empty selection is
 * likewise its own presentation: the graph shows nothing selected, so the
 * panel must not keep describing whichever commit was expanded last.
 */
export function postDetailsForSelection(ctx: IGtwControllerContext): void {
  if (!ctx.hasView()) {
    return;
  }
  const selected = selectionInGraphOrder(ctx);
  // Ask the host to load the files for this selection. Warm cache → paint
  // them now; cold → paint the summaries immediately and repaint when the
  // load lands, the same two-phase shape the single-commit panel uses.
  // Called for EVERY selection, including ones too small to need a load, so
  // a load still running for a selection the user left lands as stale
  // instead of painting over the new one.
  ctx.requestMultiCommitFiles(selected);

  if (selected.length === 0) {
    // The last selected commit's half-loaded payload belongs to no current
    // selection; dropping it here keeps every empty-selection entry point
    // from having to remember to.
    ctx.clearPendingChangedFiles();
  } else if (selected.length === 1) {
    // One commit selected — however the user got here. A selection that
    // SHRANK to one (ctrl-click deselect, a range collapsing onto its anchor)
    // never went through the plain-click path, so asking here is what keeps
    // the survivor from painting an empty file list forever. The request is
    // idempotent per commit, so a repaint costs nothing.
    ctx.requestSingleCommitFiles(selected[0]);
  }

  ctx.postToWebview({ type: 'updateDetailsPanel', model: buildSelectionDetailsModel(ctx) });
}

/**
 * The details-panel model for the CURRENT selection — the single source both
 * the message path and the full HTML render read.
 *
 * Selection size, not the expanded commit, decides the presentation: zero
 * selected is the placeholder, two or more is the multi-commit model, one is
 * that commit's details. A render path that only knew about the expanded
 * commit repainted an N-commit selection as a single commit, and undid the
 * empty-selection placeholder, on every full re-render (a `.git` watcher tick,
 * load-more, repo switch, undock).
 *
 * `expandedOverride` lets the render path pass details it already has in hand
 * for the single-commit case; it never overrides the empty or multi shapes.
 */
export function buildSelectionDetailsModel(
  ctx: IGtwControllerContext,
  expandedOverride?: ICommitDetails
): DetailsPanelModel {
  const selected = selectionInGraphOrder(ctx);

  if (selected.length === 0) {
    return buildDetailsPanelPlaceholderModel();
  }

  if (selected.length >= 2) {
    const detailsList = selected
      .map((hash) => ctx.extendedLogState.commitNodes.find((n) => n.commit.hash === hash))
      .filter((node): node is NonNullable<typeof node> => node !== undefined)
      .map((node) => ({
        ...commitNodeToBaseDetails(node),
        changedFiles: ctx.getMultiChangedFiles(node.commit.hash) ?? [],
        changedFilesError: ctx.getMultiChangedFilesError(node.commit.hash),
      }));
    return ctx.getMultiCommitDetailsPanelModel(detailsList);
  }

  const details = expandedOverride ?? ctx.getExpandedCommitDetails();
  return details ? ctx.getDetailsPanelModel(details) : buildDetailsPanelPlaceholderModel();
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
  // a full HTML re-render. A full `_render()` rebuilds the entire
  // panel HTML, which would destroy the
  // currently-focused commit-row DOM element. The webview JS keys
  // its keyboard handler off `e.target.closest('.commit-row')`, so
  // after a re-render no row is focused and the next Shift+Arrow
  // press finds no target — the user-visible "Shift+Arrow stops
  // responding after 1-2 commits" symptom.
  ctx.postSyncSelection();
  postDetailsForSelection(ctx);
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

  // The range tip becomes the expanded commit, so the payload loaded for the
  // previous one no longer describes it (rangeSelectCommit clears for the
  // same reason).
  ctx.clearPendingChangedFiles();

  for (const h of range) {
    ctx.extendedLogState.selectedCommits.add(h);
  }
  ctx.extendedLogState.expandedCommit = hash;

  // Fire BEFORE the post sequence.
  ctx.fireDidChangeState();
  // Partial-update path — see the matching comment block in
  // `rangeSelectCommit` for the rationale: a full `_render()`
  // re-render destroys commit-row focus and breaks the keyboard
  // Shift+Arrow loop.
  ctx.postSyncSelection();
  postDetailsForSelection(ctx);
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
  ctx.requestSingleCommitFiles(hash);
  ctx.fireDidChangeState();
  ctx.postMenuStateUpdate();

  // Send a partial update to the details panel via postMessage
  // instead of a full _render() to preserve graph scroll position.
  // Also update the graph row selection highlighting and scroll to the commit.
  if (ctx.hasView()) {
    // Update graph row selection
    ctx.postToWebview({
      type: 'selectGraphRow',
      commitHash: hash,
    });
    postDetailsForSelection(ctx);
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
  // The details pane follows the commit the user just acted on, and its
  // loaded payload belongs to whichever commit was expanded before.
  const stillSelected = ctx.extendedLogState.selectedCommits.has(hash);
  if (stillSelected) {
    ctx.clearPendingChangedFiles();
    ctx.extendedLogState.expandedCommit = hash;
  } else if (ctx.extendedLogState.expandedCommit === hash) {
    // Deselected the expanded commit: fall back to another survivor so the
    // pane never describes a commit that left the selection. With no survivor
    // there is nothing to fall back to and the seam posts the placeholder.
    const survivor = ctx.extendedLogState.selectedCommits.values().next();
    if (!survivor.done) {
      ctx.clearPendingChangedFiles();
      ctx.extendedLogState.expandedCommit = survivor.value;
    }
  }

  // Order: render FIRST so the new document exists,
  // THEN post so postMessage lands on the live page rather than the
  // pre-reload one (ADR-009 section 3 sub-rule). _postSyncSelection mirrors
  // the host's anchor + selection onto the JS-side mirror so the
  // freshly-rendered document agrees with state on first paint.
  // The re-render below destroys the focused `.commit-row`, and the delegated
  // keyboard handler has nothing to act on without one — Ctrl+Space then
  // Shift+Down would do nothing. The range-select handlers dodge this by
  // skipping the render entirely; this path needs it, so it hands focus back.
  ctx.updateWebview(true);
  // Fire onDidChangeState BEFORE the wire posts
  // so subscribers see "selection changed" on the same event-loop
  // tick the host knows it. Aligns with selectCommit's ordering.
  ctx.fireDidChangeState();
  // belt-and-suspenders — the rendered HTML already
  // carries data-anchor-hash; syncSelection guards against
  // interpolation bugs and partial-update extension cases.
  ctx.postSyncSelection();
  ctx.postMenuStateUpdate();
  postDetailsForSelection(ctx);
}
