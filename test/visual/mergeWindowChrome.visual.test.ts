/**
 * Computed-style specs for the merge window's chrome.
 *
 * Everything here renders without Monaco: the toolbar, the seven columns, the
 * gutters and action strips, and the bottom bar. The unit lane checks that
 * `mergeWindowStyles()` CONTAINS these rules; only a real cascade can say the
 * rule reached the element it was written for.
 *
 * Two defects in this file's history are exactly that distinction. The column
 * boundaries were drawn on the gutter's title cell, so they spanned a 22px
 * header beside a 30px gutter while the buttons sat in the neighbouring 34px
 * strip: present in the stylesheet, wrong on screen. And the bottom-bar buttons
 * reference secondary-button tokens with no literal fallback, which is the same
 * shape as the selection bug that painted grey for two rounds — an unresolved
 * `var()` drops the whole declaration and the control falls back to browser
 * chrome.
 */

import '../setup';
import { mergeWindowStyles } from '../../src/conflicts/merge-window/mergeWindowHtml';
import { withRenderedPage } from './support/browser';
import {
  assertComputedEquals,
  assertNoHorizontalOverflow,
  assertNotOverlapping,
  assertReadable,
  assertResolvesToToken,
} from './support/assert';
import { mergeWindowChrome } from './support/mergeWindowFixture';
import type { ThemeName } from './support/theme';

const THEMES: readonly ThemeName[] = ['dark', 'light'];

/** The window fills its host tab; the default 16px page padding would not. */
const FULL_HEIGHT = 'height: 100vh; padding: 0;';

describe('merge window chrome (computed style)', () => {
  for (const theme of THEMES) {
    describe(`${theme} theme`, () => {
      it('draws one boundary on every column after the first', async () => {
        await withRenderedPage(
          { css: mergeWindowStyles(), body: mergeWindowChrome(), theme, bodyStyle: FULL_HEIGHT },
          async (page) => {
            const columns = await page.$$eval('#panes > *', (els) => els.length);
            // Seven columns: left pane, strip, gutter, result, gutter, strip,
            // right pane. Pinned because the boundary rule is `* + *`, so a
            // column added without a border would be invisible to a spot check.
            if (columns !== 7) {
              throw new Error(`expected 7 columns in #panes, found ${columns}`);
            }
            for (let nth = 2; nth <= columns; nth++) {
              const selector = `#panes > *:nth-child(${nth})`;
              await assertComputedEquals(
                page,
                selector,
                'border-left-style',
                'solid',
                'Column boundaries come from `#panes > * + *`; drawn on an inner title cell instead they span the header only.'
              );
              await assertResolvesToToken(
                page,
                selector,
                'border-left-color',
                theme,
                'vscode-panel-border'
              );
            }
            await assertComputedEquals(
              page,
              '#panes > *:nth-child(1)',
              'border-left-style',
              'none',
              'The first column has no neighbour to its left, so it must not carry a boundary.'
            );
          }
        );
      });

      it('themes the bottom-bar buttons instead of falling back to browser chrome', async () => {
        await withRenderedPage(
          { css: mergeWindowStyles(), body: mergeWindowChrome(), theme, bodyStyle: FULL_HEIGHT },
          async (page) => {
            await assertResolvesToToken(
              page,
              '#btn-abort',
              'background-color',
              theme,
              'vscode-button-secondaryBackground'
            );
            await assertResolvesToToken(
              page,
              '#btn-apply',
              'background-color',
              theme,
              'vscode-button-background'
            );
            await assertResolvesToToken(
              page,
              '#btn-apply',
              'color',
              theme,
              'vscode-button-foreground'
            );
          }
        );
      });

      it('keeps the primary action readable', async () => {
        await withRenderedPage(
          {
            css: mergeWindowStyles(),
            body: mergeWindowChrome(),
            theme,
            realistic: true,
            bodyStyle: FULL_HEIGHT,
          },
          async (page) => {
            await assertReadable(page, '#btn-apply');
            await assertReadable(page, '#btn-abort');
          }
        );
      });

      it('lays the three panes out side by side without overlapping', async () => {
        await withRenderedPage(
          {
            css: mergeWindowStyles(),
            body: mergeWindowChrome(),
            theme,
            realistic: true,
            bodyStyle: FULL_HEIGHT,
          },
          async (page) => {
            await assertNotOverlapping(page, '#left-editor', '#result-editor');
            await assertNotOverlapping(page, '#result-editor', '#right-editor');
            await assertNotOverlapping(page, '#toolbar', '#panes');
            await assertNotOverlapping(page, '#panes', '#bottombar');
          }
        );
      });

      it('fits a narrow window without forcing a sideways scroll', async () => {
        await withRenderedPage(
          {
            css: mergeWindowStyles(),
            body: mergeWindowChrome(),
            theme,
            realistic: true,
            bodyStyle: FULL_HEIGHT,
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
