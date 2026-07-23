/**
 * Merge window: the text-selection highlight must stay visible over merge
 * chunk backgrounds.
 *
 * Monaco renders the selection (SelectionsOverlay) BEFORE line decorations
 * (DecorationsOverlay) inside the same per-line overlay container, so the
 * whole-line `.merge-*` chunk decorations — opaque in both the real merge
 * theme tokens and our fallbacks — paint on top of the selection and hide it
 * (user-reported: dragging over conflict text showed no highlight). The
 * stylesheet must lift Monaco's `.selected-text` overlay above the sibling
 * decoration divs, and no merge decoration rule may stack above it.
 */

import '../../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { mergeWindowStyles } from '../../../src/conflicts/merge-window/mergeWindowHtml';

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

describe('merge window: selection visibility over chunk decorations', () => {
  it('lifts Monaco selection overlays above the merge decoration layer', () => {
    const rules = parseRules();
    const selectionRule = rules.find(
      (r) => r.selectorText.includes('.monaco-editor') && r.selectorText.includes('.selected-text')
    );
    assert.ok(
      selectionRule,
      'stylesheet must carry a .monaco-editor … .selected-text rule lifting the selection overlay'
    );
    const z = parseInt(selectionRule.style.getPropertyValue('z-index'), 10);
    assert.ok(
      Number.isFinite(z) && z >= 1,
      `selection overlay must have z-index >= 1 so it stacks above sibling decoration divs; got "${selectionRule.style.getPropertyValue('z-index')}"`
    );
  });

  it('isolates .view-overlays so the lifted selection z-index cannot escape over the text glyphs', () => {
    // Regression: the `.selected-text { z-index: 1 }` lift was added to clear
    // the chunk decorations, but .view-overlays was not a stacking context, so
    // the z-index escaped to the shared context and lifted the selection above
    // its SIBLING .view-lines (the glyphs) too — the selection then painted
    // over the text and selected text was unreadable (user-reported). Isolating
    // .view-overlays traps the lift below the text layer.
    const rules = parseRules();
    const overlaysRule = rules.find(
      (r) =>
        r.selectorText.includes('.monaco-editor') &&
        r.selectorText.includes('.view-overlays') &&
        !r.selectorText.includes('.selected-text')
    );
    assert.ok(
      overlaysRule,
      'stylesheet must carry a .monaco-editor .view-overlays rule to contain the lifted selection z-index'
    );
    assert.strictEqual(
      overlaysRule.style.getPropertyValue('isolation'),
      'isolate',
      'without isolation:isolate the .selected-text z-index escapes the overlays layer and paints the selection OVER the glyphs (.view-lines), making selected text unreadable'
    );
  });

  it('no merge decoration rule stacks itself above the selection overlay', () => {
    const rules = parseRules();
    const selectionRule = rules.find(
      (r) => r.selectorText.includes('.monaco-editor') && r.selectorText.includes('.selected-text')
    );
    const selectionZ = selectionRule
      ? parseInt(selectionRule.style.getPropertyValue('z-index'), 10)
      : 0;
    for (const rule of rules) {
      if (
        !/\.merge-(conflict|modified|inserted|deleted|word|empty|resolved)/.test(rule.selectorText)
      ) {
        continue;
      }
      const zRaw = rule.style.getPropertyValue('z-index');
      if (zRaw === '') {
        continue;
      }
      assert.ok(
        parseInt(zRaw, 10) < selectionZ,
        `merge decoration rule "${rule.selectorText}" must not stack at/above the selection overlay (z-index ${zRaw} vs selection ${selectionZ})`
      );
    }
  });
});
