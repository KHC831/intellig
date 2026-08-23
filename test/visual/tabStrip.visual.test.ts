/**
 * Computed-style specs for the git tool window's tab strip (tabStripStyles).
 *
 * Two shipped defects live in this stylesheet's history. The strip scrolled
 * out of view with tall non-Log tab content: as plain flow siblings the panels
 * grew the page and the body scroll carried the strip away, until the bounded
 * flex column pinned it. And revealing a commit dragged the log filter bar up
 * behind the strip: a scrollIntoView walked every scrollable ancestor, which
 * only stays harmless while the bounded column keeps the document itself
 * unscrollable so an ancestor scroll can land nowhere but a panel's own
 * scroller. The pinned-strip spec here reproduces that exact gesture.
 */

import '../setup';
import * as assert from 'assert';
import { withRenderedPage } from './support/browser';
import {
  assertNoHorizontalOverflow,
  assertNotCovered,
  assertNotOverlapping,
  assertReadable,
  assertResolvesToToken,
} from './support/assert';
import { consoleEntries, gitToolWindowCss, tabbedBody } from './support/gitToolWindowFixture';
import type { ThemeName } from './support/theme';

const THEMES: readonly ThemeName[] = ['dark', 'light'];

/** Console active with enough entries that its log is taller than a viewport. */
const tallConsoleBody = (): string =>
  tabbedBody({ activeTab: 'console', console: consoleEntries(60) });

describe('git tool window tab strip (computed style)', () => {
  for (const theme of THEMES) {
    describe(`${theme} theme`, () => {
      it('keeps the strip in view when tab content is scrolled into view (pinned strip)', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: tallConsoleBody(), theme },
          async (page) => {
            // The fixture must force the choice: with content shorter than the
            // viewport, broken and correct layouts are indistinguishable.
            const tallEnough = await page.evaluate(() => {
              const log = document.querySelector('.console-log');
              return log !== null && log.scrollHeight > window.innerHeight;
            });
            assert.ok(
              tallEnough,
              'fixture too short: the console log must outgrow the viewport for this spec to decide anything'
            );

            // The shipped gesture: scrollIntoView walks every scrollable
            // ancestor. A direct page scroll is attempted too.
            const after = await page.evaluate(() => {
              document.querySelector('.console-entry:last-child')?.scrollIntoView();
              window.scrollTo(0, document.documentElement.scrollHeight);
              const strip = document.querySelector('.intellig-tab-strip');
              const log = document.querySelector('.console-log');
              const box = strip?.getBoundingClientRect();
              return {
                pageScrollY: window.scrollY,
                logScrollTop: log ? log.scrollTop : -1,
                stripTop: box ? box.top : NaN,
                stripBottom: box ? box.bottom : NaN,
                viewHeight: window.innerHeight,
              };
            });
            assert.strictEqual(
              after.pageScrollY,
              0,
              `the document scrolled ${after.pageScrollY}px: tall tab content grew the page ` +
                `instead of scrolling inside its panel, which is what carried the strip out of view`
            );
            assert.ok(
              after.logScrollTop > 0,
              `the scroll landed nowhere: .console-log has scrollTop ${after.logScrollTop}, ` +
                `so the panel is not the scroll container the bounded column makes it`
            );
            assert.ok(
              after.stripTop >= 0 && after.stripBottom <= after.viewHeight,
              `the strip sits at ${Math.round(after.stripTop)}..${Math.round(after.stripBottom)}px, ` +
                `outside the ${after.viewHeight}px viewport`
            );
            await assertNotCovered(page, '.intellig-tab-active');
          }
        );
      });

      // The strip's border is themed; its SURFACE is deliberately not, so it
      // tracks whichever container hosts the view rather than pinning one
      // theme's editor colour across the top of the panel. The absence itself
      // is asserted (with a positive control) in panelSurface.visual.test.ts.
      it('themes the strip border rather than painting a browser default', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: tallConsoleBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.intellig-tab-strip',
              'border-bottom-color',
              theme,
              'vscode-panel-border'
            );
          }
        );
      });

      it('underlines the active tab with the focus token and no other tab', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: tallConsoleBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.intellig-tab-active',
              'border-bottom-color',
              theme,
              'vscode-focusBorder'
            );
            const inactiveUnderline = await page.evaluate(() => {
              const tab = document.querySelector('#intellig-tab-history');
              return tab ? window.getComputedStyle(tab).borderBottomColor : 'missing';
            });
            assert.strictEqual(
              inactiveUnderline,
              'rgba(0, 0, 0, 0)',
              `an inactive tab draws a ${inactiveUnderline} underline; only the active tab may carry one, ` +
                `or the strip stops telling the user where they are`
            );
          }
        );
      });

      it('renders active and inactive tab labels readably', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: tallConsoleBody(), theme, realistic: true },
          async (page) => {
            await assertReadable(page, '.intellig-tab-active');
            await assertReadable(page, '#intellig-tab-history');
          }
        );
      });

      it('lays the tabs out side by side, above the panel, without overlap', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: tallConsoleBody(), theme, realistic: true },
          async (page) => {
            await assertNotOverlapping(page, '#intellig-tab-log', '#intellig-tab-console');
            await assertNotOverlapping(
              page,
              '.intellig-tab-strip',
              '.intellig-tab-panel[data-tab-panel="console"]'
            );
          }
        );
      });

      it('fits a 640px panel without forcing a sideways scroll', async () => {
        await withRenderedPage(
          {
            css: gitToolWindowCss(),
            body: tallConsoleBody(),
            theme,
            realistic: true,
            viewport: { width: 640, height: 600 },
          },
          async (page) => {
            await assertNoHorizontalOverflow(page);
          }
        );
      });
    });
  }
});
