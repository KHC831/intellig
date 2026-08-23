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
import * as assert from 'assert';
import type { Page } from 'playwright-core';
import {
  mergeWindowStyles,
  MERGE_FILL_ALPHA,
} from '../../src/conflicts/merge-window/mergeWindowHtml';
import { withRenderedPage } from './support/browser';
import {
  assertComputedEquals,
  assertNoHorizontalOverflow,
  assertNotOverlapping,
  assertReadable,
  assertResolvesToTintOfToken,
  assertResolvesToToken,
} from './support/assert';
import {
  chromeWithActionBand,
  chromeWithActionButtons,
  mergeWindowChrome,
  MERGE_BG_TOKEN,
  MERGE_FILL_KINDS,
} from './support/mergeWindowFixture';
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

      it('keeps the apply and abort actions readable', async () => {
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

      for (const kind of MERGE_FILL_KINDS) {
        it(`tints the ${kind} action band with its content token`, async () => {
          // The band class is runtime-composed (`action-band k-${kind}`), so
          // each kind is asserted on its own instance: a band pointing at the
          // wrong token breaks the pane-strip-connector channel reading as one
          // colour, and nothing else in the lane renders these rules.
          await withRenderedPage(
            {
              css: mergeWindowStyles(),
              body: chromeWithActionBand(kind),
              theme,
              bodyStyle: FULL_HEIGHT,
            },
            async (page) => {
              await assertResolvesToTintOfToken(
                page,
                '.action-band',
                'background-color',
                theme,
                MERGE_BG_TOKEN[kind],
                MERGE_FILL_ALPHA
              );
            }
          );
        });
      }
    });
  }
});

/**
 * The x of the accept and reject buttons inside one action strip. Read from the
 * rendered boxes, so it reflects the cascade rather than the rule text.
 */
async function stripOrder(
  page: Page,
  stripBodyId: string
): Promise<{ apply: number; ignore: number }> {
  const boxes = await page.evaluate((id: string) => {
    const body = document.getElementById(id);
    const at = (sel: string): number | null => {
      const el = body ? body.querySelector(sel) : null;
      return el ? el.getBoundingClientRect().left : null;
    };
    return { apply: at('.action-btn.apply'), ignore: at('.action-btn.ignore') };
  }, stripBodyId);
  assert.ok(
    boxes.apply !== null && boxes.ignore !== null,
    `#${stripBodyId} must render both an accept and a reject button; got ${JSON.stringify(boxes)}`
  );
  return { apply: boxes.apply, ignore: boxes.ignore };
}

/**
 * Per-change accept/reject icon order in the two action strips.
 *
 * Each strip hugs the divider between its side editor and the result, but on
 * opposite edges: the left strip's result-facing edge is its RIGHT one, the
 * right strip's is its LEFT one. The accept arrow points at the result and must
 * sit on that facing edge, with the reject X on the outside — so the pair reads
 * reject-then-accept on the left and accept-then-reject on the right.
 *
 * Placing both buttons by the same absolute edges puts the left strip's accept
 * arrow on the far side, pointing at the result across the X it has to skip.
 * That is a cascade fact, not a stylesheet-contains fact: only rendering the
 * production chrome and reading the boxes back can tell the two apart.
 */
describe('merge window action strips (computed geometry)', () => {
  for (const theme of THEMES) {
    describe(`${theme} theme`, () => {
      it('orders the LEFT strip reject-then-accept, accept hugging the divider', async () => {
        await withRenderedPage(
          {
            css: mergeWindowStyles(),
            body: chromeWithActionButtons(),
            theme,
            bodyStyle: FULL_HEIGHT,
          },
          async (page) => {
            const order = await stripOrder(page, 'action-left');
            assert.ok(
              order.ignore < order.apply,
              `left strip must read reject then accept; got reject at x=${order.ignore}, ` +
                `accept at x=${order.apply}`
            );
          }
        );
      });

      it('orders the RIGHT strip accept-then-reject, accept hugging the divider', async () => {
        await withRenderedPage(
          {
            css: mergeWindowStyles(),
            body: chromeWithActionButtons(),
            theme,
            bodyStyle: FULL_HEIGHT,
          },
          async (page) => {
            const order = await stripOrder(page, 'action-right');
            assert.ok(
              order.apply < order.ignore,
              `right strip must read accept then reject; got accept at x=${order.apply}, ` +
                `reject at x=${order.ignore}`
            );
          }
        );
      });
    });
  }
});
