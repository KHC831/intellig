/**
 * Theme-token tests for the multi-repo `.repository-selector` dropdown.
 *
 * The Git tool-window toolbar renders a `<select class="repository-selector">`
 * for switching between repositories in a multi-root workspace. Without a CSS
 * rule it falls back to the browser's native white control, clashing with the
 * VS Code theme. These specs pin that the selector is themed through the VS
 * Code `--vscode-dropdown-*` tokens (never a hardcoded color) so a future edit
 * cannot silently drop the theming or pin a non-overridable color.
 */

import '../../setup';
import * as assert from 'assert';
import { buildInlineStyles } from '../../../src/git-core/gitToolWindow/provider/stylesBuilder';

describe('repository-selector dropdown theming', () => {
  it('emits a .repository-selector rule (so the control is not native-default styled)', () => {
    const css = buildInlineStyles();
    assert.ok(
      /\.repository-selector\s*\{/.test(css),
      'buildInlineStyles() must emit a `.repository-selector` rule so the multi-repo dropdown is themed, not native-white'
    );
  });

  it('themes the selector background/foreground/border via VS Code dropdown tokens', () => {
    const css = buildInlineStyles();
    const rule = extractRule(css, '.repository-selector');
    assert.ok(rule, 'expected a `.repository-selector` rule block');
    assert.ok(
      rule.includes('var(--vscode-dropdown-background)'),
      'selector background must use var(--vscode-dropdown-background)'
    );
    assert.ok(
      rule.includes('var(--vscode-dropdown-foreground)'),
      'selector foreground must use var(--vscode-dropdown-foreground)'
    );
    assert.ok(
      rule.includes('var(--vscode-dropdown-border)'),
      'selector border must use var(--vscode-dropdown-border)'
    );
  });

  it('styles the option list with the dropdown list-background token', () => {
    const css = buildInlineStyles();
    assert.ok(
      /\.repository-selector\s+option\s*\{[^}]*var\(--vscode-dropdown-listBackground\)/.test(css),
      'the `.repository-selector option` rule must use var(--vscode-dropdown-listBackground)'
    );
  });

  it('shows a theme-aware focus ring via the focusBorder token', () => {
    const css = buildInlineStyles();
    assert.ok(
      /\.repository-selector:focus\s*\{[^}]*var\(--vscode-focusBorder\)/.test(css),
      'the `.repository-selector:focus` rule must use var(--vscode-focusBorder)'
    );
  });
});

/** Return the declaration body of the first `selector { ... }` block, or undefined. */
function extractRule(css: string, selector: string): string | undefined {
  const start = css.indexOf(selector);
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
