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
