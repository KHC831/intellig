/**
 * Computed-style specs for the changed-file context menu's resting state.
 *
 * The unit lane already asserts that `buildInlineStyles()` CONTAINS the menu
 * tokens. That cannot fail when the rule is present but never matches, loses on
 * specificity, or is overpainted — which is how the multi-repo `<select>`
 * shipped unthemed and how a merge-window fill shipped over its own glyphs.
 * These specs render the production css against the production markup and read
 * the resolved values back out of a real cascade.
 *
 * Both themes run: a token that resolves acceptably in dark can still fail in
 * light, and the host picks the theme, not us. Interaction states live in
 * `contextMenuStates.visual.test.ts`.
 */

import '../setup';
import { buildFileContextMenuHtml } from '../../src/git-core/gitToolWindow/provider/htmlBuilders';
import { buildInlineStyles } from '../../src/git-core/gitToolWindow/provider/stylesBuilder';
import { withRenderedPage } from './support/browser';
import {
  assertNoHorizontalOverflow,
  assertNotCovered,
  assertNotOverlapping,
  assertReadable,
  assertResolvesToToken,
} from './support/assert';
import { shownMenuMarkup } from './support/markup';
import type { ThemeName } from './support/theme';

// Built per spec, not at module scope: shownMenuMarkup throws when its edit
// stops matching, and a module-scope throw surfaces as ts-node's opaque
// "Cannot find module test/setup" instead of the guard's own message.
const menu = (): string => shownMenuMarkup(buildFileContextMenuHtml(), 'file-context-menu');

const THEMES: readonly ThemeName[] = ['dark', 'light'];

describe('changed-file context menu (computed style)', () => {
  for (const theme of THEMES) {
    describe(`${theme} theme`, () => {
      it('paints its surface with the menu background token, not a browser default', async () => {
        // Sentinel palette (the default): under the real palette this token and
        // editor-background are the same colour, so the assertion could not
        // tell a correct rule from one pointing at the wrong token.
        await withRenderedPage({ css: buildInlineStyles(), body: menu(), theme }, async (page) => {
          await assertResolvesToToken(
            page,
            '#file-context-menu',
            'background-color',
            theme,
            'vscode-menu-background'
          );
        });
      });

      it('renders item labels readably against that surface', async () => {
        await withRenderedPage(
          { css: buildInlineStyles(), body: menu(), theme, realistic: true },
          async (page) => {
            await assertReadable(page, '#file-context-menu .context-menu-item');
          }
        );
      });

      it('keeps the menu on top of page content that claims a stacking order', async () => {
        // The backdrop follows the menu in DOM order AND claims a z-index, so
        // the production `z-index` is what decides the outcome. With the
        // backdrop first, paint order alone would keep the menu on top and the
        // spec would pass no matter what the stylesheet said.
        const body = `${menu()}<div style="position:fixed;inset:0;z-index:5;background:var(--vscode-editor-background);"></div>`;
        await withRenderedPage(
          { css: buildInlineStyles(), body, theme, realistic: true },
          async (page) => {
            await assertNotCovered(page, '#file-context-menu .context-menu-item');
          }
        );
      });

      it('stacks its items without overlapping them', async () => {
        await withRenderedPage({ css: buildInlineStyles(), body: menu(), theme }, async (page) => {
          await assertNotOverlapping(
            page,
            '[data-file-action="showDiff"]',
            '[data-file-action="openRepositoryVersion"]'
          );
        });
      });

      it('fits a narrow panel without forcing a sideways scroll', async () => {
        await withRenderedPage(
          {
            css: buildInlineStyles(),
            body: menu(),
            theme,
            realistic: true,
            viewport: { width: 320, height: 600 },
          },
          async (page) => {
            await assertNoHorizontalOverflow(page);
          }
        );
      });
    });
  }
});
