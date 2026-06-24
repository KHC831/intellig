/**
 * Theme-token tests for the log filter popup buttons (Branch / User / Date /
 * Path) that replaced the native `<select>` dropdowns. The whole reason these
 * are custom buttons + panels is that Chromium renders a native `<select>` popup
 * in an unstyleable UA layer (wrong font/background). These specs pin that the
 * popup button + panel are themed through the VS Code `--vscode-dropdown-*`
 * tokens so a future edit cannot silently fall back to a native control.
 */

import '../../setup';
import * as assert from 'assert';
import { buildInlineStyles } from '../../../src/git-core/gitToolWindow/provider/stylesBuilder';

describe('log filter popup theming', () => {
  it('emits a .log-filter-pop-btn rule (the styled dropdown trigger)', () => {
    const css = buildInlineStyles();
    assert.ok(
      /\.log-filter-pop-btn\s*\{/.test(css),
      'buildInlineStyles() must emit a `.log-filter-pop-btn` rule so the filter dropdowns are themed, not native-white'
    );
  });

  it('themes the popup button background/foreground/border via dropdown tokens', () => {
    const css = buildInlineStyles();
    const rule = extractRule(css, '.log-filter-pop-btn');
    assert.ok(rule, 'expected a `.log-filter-pop-btn` rule block');
    assert.ok(
      rule.includes('var(--vscode-dropdown-background)'),
      'button background must use var(--vscode-dropdown-background)'
    );
    assert.ok(
      rule.includes('var(--vscode-dropdown-foreground)'),
      'button foreground must use var(--vscode-dropdown-foreground)'
    );
    assert.ok(
      rule.includes('var(--vscode-dropdown-border)'),
      'button border must use var(--vscode-dropdown-border)'
    );
  });

  it('themes the popup panel via dropdown tokens', () => {
    const css = buildInlineStyles();
    const rule = extractRule(css, '.log-filter-popup');
    assert.ok(rule, 'expected a `.log-filter-popup` rule block');
    assert.ok(
      rule.includes('var(--vscode-dropdown-background)'),
      'popup panel background must use var(--vscode-dropdown-background)'
    );
  });

  it('shows a theme-aware focus ring via the focusBorder token', () => {
    const css = buildInlineStyles();
    assert.ok(
      /\.log-filter-pop-btn:focus\s*\{[^}]*var\(--vscode-focusBorder\)/.test(css),
      'the `.log-filter-pop-btn:focus` rule must use var(--vscode-focusBorder)'
    );
  });
});

/** Return the declaration body of the first `selector { ... }` block, or undefined. */
function extractRule(css: string, selector: string): string | undefined {
  const start = css.indexOf(selector + ' {');
  if (start === -1) {
    return undefined;
  }
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  if (open === -1 || close === -1) {
    return undefined;
  }
  return css.slice(open + 1, close);
}
