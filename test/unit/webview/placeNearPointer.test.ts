/**
 * The one pointer-placement rule every webview popup uses.
 *
 * Four popups grew their own copy of this arithmetic (the Commit window's
 * context menu, the Git tool window's three menus, its ref popup and its
 * parent-navigation popup), with different constants and three different
 * answers at a window edge. These pin the single rule they now share.
 */

import '../../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import {
  EDGE_GAP,
  MIN_MAX_HEIGHT,
  placeNearPointer,
} from '../../../src/webview-common/placeNearPointer';

/** A popup of `height` px in a `w` x `h` viewport, placed at (x, y). */
function place(
  viewport: { w: number; h: number },
  at: { x: number; y: number },
  height: number
): { left: number; top: number; maxHeight: number } {
  const dom = new JSDOM('<!doctype html><body></body>');
  Object.defineProperty(dom.window, 'innerWidth', { value: viewport.w, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: viewport.h, configurable: true });
  const node = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(node);

  placeNearPointer(node, at.x, at.y, height);

  const px = (v: string): number => parseInt(v, 10);
  const result = {
    left: px(node.style.left),
    top: px(node.style.top),
    maxHeight: px(node.style.maxHeight),
  };
  dom.window.close();
  return result;
}

const ROOM = { w: 1600, h: 1200 };

describe('placeNearPointer', () => {
  it('pins the popup to the pointer when the window has room for it', () => {
    const { left, top } = place(ROOM, { x: 400, y: 300 }, 320);
    assert.strictEqual(left, 400);
    assert.strictEqual(top, 300);
  });

  it('pulls the popup back inside the right edge, keeping the gap', () => {
    const { left } = place({ w: 500, h: 1200 }, { x: 480, y: 100 }, 320);
    assert.ok(
      left + 220 <= 500 - EDGE_GAP,
      `a popup at left=${left} runs past the right edge of a 500px window`
    );
  });

  it('pulls the popup back inside the bottom edge, keeping the gap', () => {
    const { top } = place({ w: 1600, h: 400 }, { x: 100, y: 380 }, 320);
    assert.ok(
      top + 320 <= 400 - EDGE_GAP,
      `a popup at top=${top} runs past the bottom of a 400px window`
    );
  });

  it('parks the popup at the gap when the window is too small to hold it', () => {
    // The pull-back arithmetic goes negative here (120 - 220 - 8), and a
    // negative left would hide the labels off the left edge entirely.
    const { left, top } = place({ w: 120, h: 100 }, { x: 10, y: 10 }, 320);
    assert.strictEqual(left, EDGE_GAP);
    assert.strictEqual(top, EDGE_GAP);
  });

  it('budgets the height from the CLAMPED top, not the raw pointer', () => {
    // Click low in a short panel: the popup is pulled up to y=72, so it has the
    // room from THERE down. Measuring from the pointer (y=380) would leave it a
    // scrolling sliver of the space it actually occupies.
    const { top, maxHeight } = place({ w: 1600, h: 400 }, { x: 100, y: 380 }, 320);
    assert.strictEqual(maxHeight, 400 - top - EDGE_GAP);
    assert.ok(maxHeight >= 320, `a 320px popup was squashed to ${maxHeight}px with room to spare`);
  });

  it('keeps a readable height floor when the window is shorter than the popup', () => {
    const { maxHeight } = place({ w: 1600, h: 60 }, { x: 10, y: 40 }, 320);
    assert.strictEqual(maxHeight, MIN_MAX_HEIGHT);
  });

  it('lets a popup taller than its budget scroll rather than overflow', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const node = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(node);
    placeNearPointer(node, 10, 10, 320);
    assert.strictEqual(node.style.overflowY, 'auto');
    dom.window.close();
  });
});
