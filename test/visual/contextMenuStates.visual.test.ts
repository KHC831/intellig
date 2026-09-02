/**
 * Computed-style specs for context-menu INTERACTION states.
 *
 * The default-state specs live in `contextMenuTheming.visual.test.ts`. States
 * reached only by interaction are their own escape route: a `:hover` rule that
 * overrides a background without also overriding the foreground it inherits
 * renders readable in one theme and invisible in the other, and no test that
 * only ever measures the resting state can see it.
 */

import '../setup';
import * as assert from 'assert';
import { renderMenuMarkup } from '../helpers/renderMenuMarkup';
import {
  COMMIT_MENU,
  COMMIT_MENU_ITEMS,
} from '../../src/git-core/gitToolWindow/webview/menuDefinitions';
import { buildInlineStyles } from '../../src/git-core/gitToolWindow/provider/stylesBuilder';
import { withRenderedPage } from './support/browser';
import { assertComputedEquals, assertReadable, assertResolvesToToken } from './support/assert';
import { shownMenuMarkup, withMenuItemClass } from './support/markup';
import type { ThemeName } from './support/theme';

// Built per spec, not at module scope: see contextMenuTheming.visual.test.ts.
const menu = (): string =>
  shownMenuMarkup(renderMenuMarkup(COMMIT_MENU_ITEMS, COMMIT_MENU), 'commit-context-menu');

const THEMES: readonly ThemeName[] = ['dark', 'light'];

/**
 * The destructive arms. `.context-menu-danger:hover` swaps the background to
 * the error token but inherits `.context-menu-item:hover`'s selection
 * foreground, so both halves have to be checked together.
 */
const DANGER_ACTIONS = ['resetToHere', 'dropCommit'] as const;

describe('commit context menu interaction states (computed style)', () => {
  for (const theme of THEMES) {
    describe(`${theme} theme`, () => {
      it('keeps an ordinary item readable while hovered', async () => {
        await withRenderedPage(
          { css: buildInlineStyles(), body: menu(), theme, realistic: true },
          async (page) => {
            const selector = '[data-action="cherryPick"]';
            await page.hover(selector);
            await assertReadable(page, selector);
          }
        );
      });

      // showAt() focuses the first row on open and handleKey() moves focus
      // with Arrow/Home/End — a row's markup carries tabindex="0" only when
      // enabled (ContextMenu._buildItem), so a real DOM focus() here exercises
      // the same :focus state the widget puts a row into.
      it('outlines a focused item with the focus token', async () => {
        await withRenderedPage({ css: buildInlineStyles(), body: menu(), theme }, async (page) => {
          const selector = '[data-action="cherryPick"]';
          await page.focus(selector);
          await assertResolvesToToken(page, selector, 'outline-color', theme, 'vscode-focusBorder');
          // outline-color alone passes a zero-width or "none" outline, which
          // paints nothing — the exact defect this pin exists to catch.
          await assertComputedEquals(
            page,
            selector,
            'outline-style',
            'solid',
            'a non-solid outline-style can paint nothing at all even with the right colour'
          );
          await assertComputedEquals(
            page,
            selector,
            'outline-width',
            '1px',
            'a zero-width outline paints nothing, so the focus ring would be invisible even with the right colour'
          );
        });
      });

      for (const action of DANGER_ACTIONS) {
        it(`keeps the destructive "${action}" item readable while hovered`, async () => {
          await withRenderedPage(
            { css: buildInlineStyles(), body: menu(), theme, realistic: true },
            async (page) => {
              const selector = `[data-action="${action}"]`;
              await page.hover(selector);
              await assertReadable(page, selector);
            }
          );
        });
      }
    });
  }

  // Nothing below resolves a theme token, so one theme suffices; the rules
  // under test are structural (an opacity, a display) and identical in both.
  describe('state flags (single theme)', () => {
    it('pins DANGER_ACTIONS set-equal to the danger items the menu ships', () => {
      // The hover loop above iterates DANGER_ACTIONS, so a third destructive
      // item added in production would silently skip it without this pin.
      const shipped = [
        ...renderMenuMarkup(COMMIT_MENU_ITEMS, COMMIT_MENU).matchAll(
          /class="[^"]*context-menu-danger[^"]*"[^>]*data-action="([^"]+)"/g
        ),
      ].map((m) => m[1]);
      assert.deepStrictEqual(
        [...shipped].sort(),
        [...DANGER_ACTIONS].sort(),
        'the danger items in the production menu and DANGER_ACTIONS must be the same set; ' +
          'an item in only one of them misses the destructive-hover specs'
      );
    });

    it('fades a disabled item and drops its pointer cursor', async () => {
      // `disabled` is toggled at runtime, so the fixture adds it the way the
      // webview script does. pointer-events cannot be asserted here — the
      // harness forces it on every element (see harness.visual.test.ts).
      const body = withMenuItemClass(menu(), 'cherryPick', 'disabled');
      await withRenderedPage({ css: buildInlineStyles(), body, theme: 'dark' }, async (page) => {
        await assertComputedEquals(
          page,
          '[data-action="cherryPick"]',
          'opacity',
          '0.4',
          'The fade is what tells the user the item cannot be invoked.'
        );
        await assertComputedEquals(
          page,
          '[data-action="cherryPick"]',
          'cursor',
          'default',
          'A pointer cursor on a dead item promises a click that does nothing.'
        );
      });
    });

    it('hides multi-only items in a single-selection menu', async () => {
      // The production markup ships `menu-multi-hidden` on the multi-only
      // rows; if its display rule lost its selector, single-mode menus would
      // show them and every other spec here would stay green.
      await withRenderedPage(
        { css: buildInlineStyles(), body: menu(), theme: 'dark' },
        async (page) => {
          const state = await page.evaluate(() => {
            const el = document.querySelector('[data-action="compareVersions"]');
            if (!el) {
              return null;
            }
            const box = el.getBoundingClientRect();
            return {
              display: window.getComputedStyle(el).display,
              area: box.width * box.height,
            };
          });
          assert.ok(
            state,
            'expected the multi-only compareVersions item in the production menu markup'
          );
          assert.strictEqual(
            state.display,
            'none',
            'a multi-only item must not render in a single-selection menu'
          );
          assert.strictEqual(state.area, 0, 'a hidden item must not occupy menu space');
        }
      );
    });
  });
});
