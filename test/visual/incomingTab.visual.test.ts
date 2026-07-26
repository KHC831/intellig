/**
 * Computed-style specs for the Incoming tab (incomingTabStyles).
 *
 * No shipped defect lives here; the row grid mirrors the History tab's, so
 * these specs pin the same contract the sibling tab already broke once: rows
 * on the selection tokens, the hash inside its own column (the renderer
 * always slices to 7 characters, which is what makes the 7ch track safe —
 * the fit spec pins that pairing), and the status states readable.
 */

import '../setup';
import * as assert from 'assert';
import { withRenderedPage } from './support/browser';
import {
  assertNoHorizontalOverflow,
  assertReadable,
  assertResolvesToToken,
} from './support/assert';
import { gitToolWindowCss, incomingState, tabbedBody } from './support/gitToolWindowFixture';
import type { ThemeName } from './support/theme';

const THEMES: readonly ThemeName[] = ['dark', 'light'];

const incomingBody = (): string => tabbedBody({ activeTab: 'incoming', incoming: incomingState() });

const upToDateBody = (): string =>
  tabbedBody({
    activeTab: 'incoming',
    incoming: incomingState({ commits: [], incomingCount: 0, selectedCommit: undefined }),
  });

const errorBody = (): string =>
  tabbedBody({
    activeTab: 'incoming',
    incoming: incomingState({ error: 'fetch failed: could not resolve host github.com' }),
  });

describe('incoming tab (computed style)', () => {
  for (const theme of THEMES) {
    describe(`${theme} theme`, () => {
      it('paints the selected row with the selection tokens and the hash with the link token', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: incomingBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.incoming-commit-row.incoming-selected',
              'background-color',
              theme,
              'vscode-list-activeSelectionBackground'
            );
            await assertResolvesToToken(
              page,
              '.incoming-selected .incoming-commit-subject',
              'color',
              theme,
              'vscode-list-activeSelectionForeground'
            );
            await assertResolvesToToken(
              page,
              '.incoming-commit-row:not(.incoming-selected) .incoming-commit-hash',
              'color',
              theme,
              'vscode-textLink-foreground'
            );
          }
        );
      });

      it('keeps the sliced 7-character hash inside its 7ch column', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: incomingBody(), theme },
          async (page) => {
            const cell = await page.evaluate(() => {
              const hash = document.querySelector('.incoming-commit-row .incoming-commit-hash');
              if (!hash) {
                return null;
              }
              return {
                text: hash.textContent?.trim() ?? '',
                scrollWidth: hash.scrollWidth,
                clientWidth: hash.clientWidth,
              };
            });
            assert.ok(cell, 'expected an incoming commit row with a hash cell');
            assert.strictEqual(
              cell.text.length,
              7,
              `the renderer slices hashes to 7 characters; '${cell.text}' breaks the pairing ` +
                `that makes the fixed 7ch track safe`
            );
            assert.ok(
              cell.scrollWidth <= cell.clientWidth,
              `the hash needs ${cell.scrollWidth}px but its track gives it ${cell.clientWidth}px: ` +
                `the overflow paints into the subject column`
            );
          }
        );
      });

      it('keeps subject, hash and header count readable, on plain and selected rows', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: incomingBody(), theme, realistic: true },
          async (page) => {
            await assertReadable(
              page,
              '.incoming-commit-row:not(.incoming-selected) .incoming-commit-subject'
            );
            await assertReadable(page, '.incoming-selected .incoming-commit-subject');
            await assertReadable(
              page,
              '.incoming-commit-row:not(.incoming-selected) .incoming-commit-hash'
            );
            await assertReadable(page, '.incoming-count');
          }
        );
      });

      it('renders the up-to-date state readably', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: upToDateBody(), theme, realistic: true },
          async (page) => {
            await assertReadable(page, '.incoming-up-to-date-message');
          }
        );
      });

      it('surfaces an error banner in the validation tokens and keeps it visible', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: errorBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.incoming-error',
              'background-color',
              theme,
              'vscode-inputValidation-errorBackground'
            );
            await assertResolvesToToken(
              page,
              '.incoming-error',
              'color',
              theme,
              'vscode-errorForeground'
            );
          }
        );
        await withRenderedPage(
          { css: gitToolWindowCss(), body: errorBody(), theme, realistic: true },
          async (page) => {
            // errorForeground on the error background is the palette's own
            // pairing (≈3.9:1 dark, ≈2.6:1 light); the floor catches overpaint
            // and fade-out, not the theme's choice.
            await assertReadable(page, '.incoming-error-message', 2.5);
          }
        );
      });

      it('fits a 640px panel without forcing a sideways scroll', async () => {
        await withRenderedPage(
          {
            css: gitToolWindowCss(),
            body: incomingBody(),
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
