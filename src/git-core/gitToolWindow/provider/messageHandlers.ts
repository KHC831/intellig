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
