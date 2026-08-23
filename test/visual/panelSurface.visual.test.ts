/**
 * Computed-style specs for the surface of the panel-hosted views.
 *
 * VS Code injects `<style id="_defaultStyles">` into every webview containing
 * `@layer vscode-default { body { background-color: transparent } }`
 * (Code.app/…/contrib/webview/browser/pre/index.html). A body with no author
 * background therefore composites over whatever container hosts the view, and
 * is correct in the panel, the sidebar and the secondary sidebar alike. An
 * unlayered author rule beats any layered one regardless of specificity, so
 * naming a surface token here silently hard-codes one container — which is how
 * these views came to paint the sidebar colour while docked in the panel.
 *
 * Harness note: this lane's reset paints the body `editor-background` as its
 * stand-in for the host container (production gets `transparent` plus a real
 * container behind it). So "the view adds no surface of its own" is measured
 * here as "the body still resolves to the RESET's token" — if the production
 * sheet declared one, the body would resolve to that token instead. That is
 * what these specs would have caught: before the fix the body resolved to
 * sideBar-background, then to panel-background.
 *
 * An absence is worthless to measure on its own: an element with no rule at
 * all computes to the same thing as one deliberately left alone (see the
 * sentinel note in support/theme.ts), so a sheet that failed to load would read
 * as a pass. Every case below pairs the absence with a positive control — a
 * different property of the SAME element from the SAME sheet, which must
 * resolve to its sentinel — so the measurement can tell "deliberately absent"
 * from "nothing applied".
 */

import '../setup';
import * as assert from 'assert';
import { buildThreePanelStyles } from '../../src/git-core/gitToolWindow/provider/stylesBuilder';
import { toolWindowTabStyles } from '../../src/git-core/gitToolWindow/provider/documentShell';
import { commitToolWindowStyles } from '../../src/commits/commitToolWindowStyles';
import { withRenderedPage } from './support/browser';
import { assertComputedEquals, assertResolvesToToken } from './support/assert';
import type { ThemeName } from './support/theme';

const THEMES: readonly ThemeName[] = ['dark', 'light'];

/**
 * The sheet the Git tool window actually ships: `buildThreePanelStyles()` (a
 * superset of `buildInlineStyles()`) plus the tab sheets, exactly as
 * documentShell assembles them. Rendering the inner sheet instead would make
 * the lane blind to an outer rule overpainting the body.
 */
const gitToolWindowStyles = (): string => `${buildThreePanelStyles()}\n${toolWindowTabStyles()}`;

/** The lane reset's body colour: what a container the view does not repaint looks like. */
const CONTAINER_TOKEN = 'vscode-editor-background';
const NO_AUTHOR_BACKGROUND = 'rgba(0, 0, 0, 0)';

/**
 * Each view: the sheet it ships, a body shell that gives it a real box, and a
 * positive control proving that sheet reached the page.
 */
const PANEL_VIEWS: ReadonlyArray<{
  name: string;
  css: () => string;
  body: string;
  control: { selector: string; property: string; token: string };
}> = [
  {
    name: 'Git tool window',
    css: () => gitToolWindowStyles(),
    body:
      '<div class="intellig-tabbed"><div class="intellig-tab-strip">' +
      '<button class="intellig-tab intellig-tab-active"></button></div></div>',
    control: {
      selector: '.intellig-tab-active',
      property: 'border-bottom-color',
      token: 'vscode-focusBorder',
    },
  },
  {
    name: 'Commit tool window',
    css: () => commitToolWindowStyles(),
    body: '<div class="ctw-body"><button class="ctw-tab ctw-tab-active"></button></div>',
    control: {
      selector: '.ctw-tab-active',
      property: 'border-bottom-color',
      token: 'vscode-focusBorder',
    },
  },
];

describe('panel-hosted view surfaces (computed style)', () => {
  for (const view of PANEL_VIEWS) {
    describe(view.name, () => {
      for (const theme of THEMES) {
        it(`leaves its body to the host container in the ${theme} theme`, async () => {
          await withRenderedPage({ css: view.css(), body: view.body, theme }, async (page) => {
            // Positive control FIRST: without it the transparency assertion
            // below passes on a page where the stylesheet never applied.
            await assertResolvesToToken(
              page,
              view.control.selector,
              view.control.property,
              theme,
              view.control.token
            );
            // Still the reset's colour => the view's sheet declared none, so
            // the injected vscode-default transparency lets the real body
            // track whichever container hosts it.
            await assertResolvesToToken(page, 'body', 'background-color', theme, CONTAINER_TOKEN);
          });
        });
      }
    });
  }

  // The tab strip is a plain flex child, not a sticky band, so it has nothing
  // to stay opaque over and follows the body. It painted editor.background,
  // which is a different shade from the panel in every stock dark theme.
  for (const theme of THEMES) {
    it(`leaves the Git tab strip to the host container in the ${theme} theme`, async () => {
      await withRenderedPage(
        {
          css: gitToolWindowStyles(),
          body: '<div class="intellig-tab-strip"><button class="intellig-tab"></button></div>',
          theme,
        },
        async (page) => {
          // Control: the strip's OWN rule applied (its border resolves), so the
          // missing background below is a deliberate absence, not a dead sheet.
          await assertResolvesToToken(
            page,
            '.intellig-tab-strip',
            'border-bottom-color',
            theme,
            'vscode-panel-border'
          );
          await assertComputedEquals(
            page,
            '.intellig-tab-strip',
            'background-color',
            NO_AUTHOR_BACKGROUND,
            'the strip must not paint its own surface colour.'
          );
        }
      );
    });
  }

  // The Log column header IS sticky: rows scroll under it, so it must stay
  // opaque and therefore does name a surface token. panel.background is the
  // right one for the container the view is contributed to.
  for (const theme of THEMES) {
    it(`keeps the sticky Log column header opaque in the ${theme} theme`, async () => {
      await withRenderedPage(
        { css: gitToolWindowStyles(), body: '<div class="log-column-header"></div>', theme },
        async (page) => {
          const sticky = await page.evaluate(() => {
            const el = document.querySelector('.log-column-header');
            return el ? getComputedStyle(el).position : null;
          });
          assert.strictEqual(sticky, 'sticky', 'the header is what makes an opaque fill necessary');
          await assertResolvesToToken(
            page,
            '.log-column-header',
            'background-color',
            theme,
            'vscode-panel-background'
          );
        }
      );
    });
  }
});
