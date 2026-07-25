/**
 * Merge window: selected text must stay readable, and the selection highlight
 * must stay visible over merge chunk backgrounds.
 *
 * Monaco renders the selection (SelectionsOverlay) BEFORE line decorations
 * (DecorationsOverlay) inside the same per-line overlay container, so an OPAQUE
 * `.merge-*` chunk decoration paints on top of the selection and hides it.
 *
 * The stylesheet solves that with translucency, not with stacking order: the
 * chunk fills let the selection beneath them show through. Lifting the
 * selection with a z-index instead is what this file exists to prevent — Monaco's
 * `.view-overlays` is `position: absolute; z-index: auto`, so it is not a
 * stacking context, and a lifted `.selected-text` escapes it and paints over
 * the sibling `.view-lines` glyphs, making selected text unreadable. Both
 * symptoms were user-reported in turn, from the two halves of that same trade.
 *
 * The invariants below are the contract: nothing in Monaco's layers gets
 * lifted, and every chunk fill stays see-through.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import {
  MERGE_FILL_ALPHA,
  mergeWindowStyles,
} from '../../../src/conflicts/merge-window/mergeWindowHtml';

/** Mount the generated stylesheet in jsdom and return its parsed rules. */
function parseRules(): CSSStyleRule[] {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head><style>${mergeWindowStyles()}</style></head><body></body></html>`
  );
  const sheet = dom.window.document.styleSheets[0];
  const rules: CSSStyleRule[] = [];
  for (const rule of Array.from(sheet.cssRules)) {
    if (rule.constructor.name === 'CSSStyleRule') {
      rules.push(rule as CSSStyleRule);
    }
  }
  return rules;
}

/**
 * Raw declaration block for `selector`, read from the stylesheet source rather
 * than jsdom — jsdom's CSS parser drops declarations whose values it cannot
 * model (`color-mix(...)` among them), so a parsed lookup would silently see
 * the opaque fallback and pass while the real fill is translucent.
 */
function rawBlock(selector: string): string {
  const css = mergeWindowStyles();
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `stylesheet must carry a "${selector}" rule`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/** The chunk fills that sit over the selection, and their word-level emphasis. */
const FILL_SELECTORS = [
  '.merge-conflict',
  '.merge-modified',
  '.merge-inserted',
  '.merge-deleted',
  '.merge-word.k-conflict',
  '.merge-word.k-modified',
  '.merge-word.k-inserted',
  '.merge-word.k-deleted',
];

describe('merge window: selection visibility over chunk decorations', () => {
  it('never lifts a Monaco layer above the text glyphs', () => {
    // A positive z-index anywhere in Monaco's own layers is the regression:
    // .view-overlays is not a stacking context, so the lift escapes and the
    // selection paints over .view-lines. Selected text then reads as blank.
    for (const rule of parseRules()) {
      if (!rule.selectorText.includes('.monaco-editor')) {
        continue;
      }
      const zRaw = rule.style.getPropertyValue('z-index');
      if (zRaw === '') {
        continue;
      }
      const z = parseInt(zRaw, 10);
      assert.ok(
        !Number.isFinite(z) || z <= 0,
        `"${rule.selectorText}" lifts a Monaco layer (z-index ${zRaw}). ` +
          'Monaco .view-overlays is position:absolute with z-index:auto, so it is NOT a ' +
          'stacking context and the lift escapes it, painting over the .view-lines glyphs. ' +
          'Keep the selection visible with a translucent chunk fill instead.'
      );
    }
  });

  it('does not depend on isolating .view-overlays to contain a lift', () => {
    // isolation:isolate was the patch for the escaping z-index above. With no
    // lift to contain, requiring it would be cargo cult; its presence means the
    // z-index approach crept back in.
    for (const rule of parseRules()) {
      if (!rule.selectorText.includes('.monaco-editor')) {
        continue;
      }
      assert.notStrictEqual(
        rule.style.getPropertyValue('isolation'),
        'isolate',
        `"${rule.selectorText}" isolates a Monaco layer, which is only needed to trap a ` +
          'lifted selection z-index. The fill is translucent now; nothing should be lifted.'
      );
    }
  });

  it('keeps every chunk fill translucent so the selection shows through it', () => {
    for (const selector of FILL_SELECTORS) {
      const block = rawBlock(selector);
      assert.ok(
        /color-mix\(.*\btransparent\s*\)/.test(block),
        `"${selector}" must blend toward transparent so Monaco's selection — painted ` +
          `BENEATH the decoration layer — remains visible through it. Got: ${block.trim()}`
      );
    }
  });

  it('paints the pane band, strip band and connector at ONE shared alpha', () => {
    // The three are meant to read as a single continuous channel across the
    // window (see MERGE_KIND_CONNECTOR_COLORS' contract). Giving the in-editor
    // band an alpha while the strip band and canvas connector stayed opaque
    // made the channel look broken at every pane boundary (user-reported).
    const pct = `${Math.round(MERGE_FILL_ALPHA * 100)}%`;
    for (const kind of ['conflict', 'modified', 'inserted', 'deleted']) {
      for (const selector of [`.merge-${kind}`, `.action-band.k-${kind}`]) {
        assert.ok(
          rawBlock(selector).includes(pct),
          `"${selector}" must blend at the shared MERGE_FILL_ALPHA (${pct}) so the pane band, ` +
            `strip band and connector match. Got: ${rawBlock(selector).trim()}`
        );
      }
    }

    // The canvas cannot parse color-mix(), so it applies the same constant as
    // globalAlpha. Assert it reads the CONSTANT rather than a copied literal —
    // a duplicated number is exactly how these drifted apart.
    const webviewSource = fs.readFileSync(
      path.join(process.cwd(), 'src/conflicts/merge-window/webview/main.ts'),
      'utf8'
    );
    assert.ok(
      /globalAlpha\s*=[^;]*MERGE_FILL_ALPHA/.test(webviewSource),
      'the connector fill must set globalAlpha from MERGE_FILL_ALPHA, not a hard-coded copy'
    );
  });

  it('still declares an opaque fallback first for engines without color-mix', () => {
    for (const selector of FILL_SELECTORS) {
      const block = rawBlock(selector);
      const decls = block
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d.startsWith('background'));
      assert.ok(
        decls.length >= 2 && !decls[0].includes('color-mix'),
        `"${selector}" must declare the plain background before the color-mix one so an ` +
          `engine that cannot parse color-mix keeps a visible fill. Got: ${block.trim()}`
      );
    }
  });
});
