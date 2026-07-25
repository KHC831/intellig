/**
 * Computed-style specs for the changed-file context menu.
 *
 * The unit lane already asserts that `buildInlineStyles()` CONTAINS the menu
 * tokens. That cannot fail when the rule is present but never matches, loses on
 * specificity, or is overpainted — which is how the multi-repo `<select>`
 * shipped unthemed and how a merge-window fill shipped over its own glyphs.
 * These specs render the production css against the production markup and read
 * the resolved values back out of a real cascade.
 *
 * Both themes run: a token that resolves acceptably in dark can still fail in
 * light, and the host picks the theme, not us.
 */

import '../setup';
import { buildFileContextMenuHtml } from '../../src/git-core/gitToolWindow/provider/htmlBuilders';
import { buildInlineStyles } from '../../src/git-core/gitToolWindow/provider/stylesBuilder';
import { withRenderedPage } from './support/browser';
import {
  assertNotCovered,
  assertNotOverlapping,
  assertReadable,
  assertResolvesToToken,
} from './support/assert';
import type { ThemeName } from './support/theme';

/**
 * The production markup ships `hidden`; the webview clears it on show. Measure
 * the shown state, which is the only state a user sees, and anchor it in the
 * viewport since `.context-menu` is `position: fixed`.
 */
const SHOWN_MENU = buildFileContextMenuHtml()
  .replace(' hidden ', ' ')
  .replace(
    'class="commit-context-menu context-menu"',
    'class="commit-context-menu context-menu" style="top:40px;left:40px;"'
  );

const THEMES: readonly ThemeName[] = ['dark', 'light'];

describe('changed-file context menu (computed style)', () => {
  for (const theme of THEMES) {
    describe(`${theme} theme`, () => {
      it('paints its surface with the menu background token, not a browser default', async () => {
        await withRenderedPage(
          { css: buildInlineStyles(), body: SHOWN_MENU, theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '#file-context-menu',
              'background-color',
              theme,
              'vscode-menu-background'
            );
          }
        );
      });

      it('renders item labels readably against that surface', async () => {
        await withRenderedPage(
          { css: buildInlineStyles(), body: SHOWN_MENU, theme },
          async (page) => {
            await assertReadable(page, '#file-context-menu .context-menu-item');
          }
        );
      });

      it('keeps the menu on top of the page content it opens over', async () => {
        const body = `<div style="position:fixed;inset:0;background:var(--vscode-editor-background);"></div>${SHOWN_MENU}`;
        await withRenderedPage({ css: buildInlineStyles(), body, theme }, async (page) => {
          await assertNotCovered(page, '#file-context-menu .context-menu-item');
        });
      });

      it('stacks its items without overlapping them', async () => {
        await withRenderedPage(
          { css: buildInlineStyles(), body: SHOWN_MENU, theme },
          async (page) => {
            await assertNotOverlapping(
              page,
              '[data-file-action="showDiff"]',
              '[data-file-action="openRepositoryVersion"]'
            );
          }
        );
      });
    });
  }
});
