/// <reference lib="dom" />
/**
 * The one rule for putting a popup under the pointer, shared by every webview.
 *
 * Pin the popup where the click landed, pulled back inside the window when the
 * click lands near an edge — otherwise a right-click low or far right opens a
 * menu that runs off-screen and cannot be read.
 *
 * DOM only, so both webview bundles can import it.
 */

/**
 * The width the right-edge clamp assumes a popup has. The stylesheet sets a
 * min-width and lets a long label run wider, so this is the planning width,
 * not an enforced maximum: a menu wider than this sits that much closer to
 * the edge than the clamp intends.
 */
export const MENU_WIDTH = 220;
/** Gap kept between the popup and the window edge. */
export const EDGE_GAP = 8;
/** Height a popup keeps even in a window too short to hold it. */
export const MIN_MAX_HEIGHT = 80;

/**
 * @param expectedHeight what the popup is expected to measure once laid out.
 * It cannot be read off the element — the popup is still hidden when it is
 * placed, so it has no layout box. Underestimating is safe: the height budget
 * below turns the overflow into a scroll rather than a clipped menu.
 */
export function placeNearPointer(
  node: HTMLElement,
  x: number,
  y: number,
  expectedHeight: number
): void {
  const view = node.ownerDocument?.defaultView ?? window;
  const maxLeft = Math.max(EDGE_GAP, view.innerWidth - MENU_WIDTH - EDGE_GAP);
  const maxTop = Math.max(EDGE_GAP, view.innerHeight - expectedHeight - EDGE_GAP);
  // maxLeft/maxTop are floored at EDGE_GAP, so a window too small to hold the
  // popup parks it at the gap rather than off-screen.
  const left = Math.min(x, maxLeft);
  const top = Math.min(y, maxTop);

  node.style.left = left + 'px';
  node.style.top = top + 'px';
  // Budget from the CLAMPED top, not the raw pointer: a click low in a short
  // panel is pulled upward, and measuring from where the pointer was would then
  // squash the popup into a scrolling sliver of the room it has.
  node.style.maxHeight = Math.max(MIN_MAX_HEIGHT, view.innerHeight - top - EDGE_GAP) + 'px';
  node.style.overflowY = 'auto';
}
