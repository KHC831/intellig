/**
 * Computed-style specs for the History tab (historyTabStyles).
 *
 * This stylesheet's shipped defect is the hash-overlapping-the-message one:
 * the commit-row grid fixed the hash track at 7ch, but git's %h abbreviation
 * grows past 7 characters in a large repo (10–12 for uniqueness), so a longer
 * hash overflowed its track into the subject column. The fixture therefore
 * carries a 12-character short hash on its first row — with a 7-character
 * hash, broken and correct track sizing render identically and the spec
 * decides nothing.
 */

import '../setup';
import * as assert from 'assert';
import { withRenderedPage } from './support/browser';
import {
  assertComputedEquals,
  assertNoHorizontalOverflow,
  assertNotOverlapping,
  assertReadable,
  assertResolvesToToken,
} from './support/assert';
import { gitToolWindowCss, historyState, tabbedBody } from './support/gitToolWindowFixture';
import type { ThemeName } from './support/theme';

const THEMES: readonly ThemeName[] = ['dark', 'light'];

const historyBody = (): string => tabbedBody({ activeTab: 'history', history: historyState() });

/** Selected only (no compare), so Diff Revisions renders disabled. */
const toolbarBody = (): string =>
  tabbedBody({
    activeTab: 'history',
    history: historyState({ compareCommit: undefined }),
  });

const errorBody = (): string =>
  tabbedBody({
    activeTab: 'history',
    history: historyState({ error: 'fatal: bad revision HEAD~999' }),
  });

describe('history tab (computed style)', () => {
  for (const theme of THEMES) {
    describe(`${theme} theme`, () => {
      it('fits a 12-character short hash in its own column instead of overlapping the subject', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: historyBody(), theme },
          async (page) => {
            const row = await page.evaluate(() => {
              const hash = document.querySelector('.history-commit-row .history-commit-hash');
              if (!hash) {
                return null;
              }
              return {
                text: hash.textContent ?? '',
                scrollWidth: hash.scrollWidth,
                clientWidth: hash.clientWidth,
              };
            });
            assert.ok(row, 'expected a commit row with a hash cell');
            assert.ok(
              row.text.length >= 10,
              `fixture hash '${row.text}' is too short: the 7ch-track regression only reproduces ` +
                `past 7 characters`
            );
            assert.ok(
              row.scrollWidth <= row.clientWidth,
              `the ${row.text.length}-character hash needs ${row.scrollWidth}px but its grid track ` +
                `gives it ${row.clientWidth}px: the overflow paints into the subject column`
            );
            await assertNotOverlapping(
              page,
              '.history-commit-row .history-commit-hash',
              '.history-commit-row .history-commit-subject'
            );
          }
        );
      });

      it('paints the selected row with the selection tokens', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: historyBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.history-commit-row.history-selected',
              'background-color',
              theme,
              'vscode-list-activeSelectionBackground'
            );
            await assertResolvesToToken(
              page,
              '.history-selected .history-commit-subject',
              'color',
              theme,
              'vscode-list-activeSelectionForeground'
            );
          }
        );
      });

      it('marks the compare row with a dashed focus outline', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: historyBody(), theme },
          async (page) => {
            await assertComputedEquals(
              page,
              '.history-commit-row.history-compare',
              'outline-style',
              'dashed',
              'The compare row is distinguished from single selection by the dashed outline alone.'
            );
            await assertResolvesToToken(
              page,
              '.history-commit-row.history-compare',
              'outline-color',
              theme,
              'vscode-focusBorder'
            );
          }
        );
      });

      it('colours the hash with the link token', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: historyBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.history-commit-row .history-commit-hash',
              'color',
              theme,
              'vscode-textLink-foreground'
            );
          }
        );
      });

      it('keeps the subject readable on plain and selected rows, and hash and author on plain rows', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: historyBody(), theme, realistic: true },
          async (page) => {
            await assertReadable(
              page,
              '.history-commit-row:not(.history-selected) .history-commit-subject'
            );
            await assertReadable(page, '.history-selected .history-commit-subject');
            await assertReadable(page, '.history-commit-row .history-commit-hash');
            // The author keeps descriptionForeground even on a selected row,
            // where it measures ≈4.4:1 — assert it on a plain row only.
            await assertReadable(
              page,
              '.history-commit-row:not(.history-selected) .history-commit-author'
            );
          }
        );
      });

      it('themes the toolbar: primary buttons, disabled button, branch select', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: toolbarBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.history-btn-get-version',
              'background-color',
              theme,
              'vscode-button-background'
            );
            await assertResolvesToToken(
              page,
              '.history-btn-get-version',
              'color',
              theme,
              'vscode-button-foreground'
            );
            await assertResolvesToToken(
              page,
              '.history-btn-diff-two[disabled]',
              'background-color',
              theme,
              'vscode-button-secondaryBackground'
            );
            await assertResolvesToToken(
              page,
              '.history-btn-diff-two[disabled]',
              'color',
              theme,
              'vscode-disabledForeground'
            );
            await assertResolvesToToken(
              page,
              '.history-branch-select',
              'background-color',
              theme,
              'vscode-input-background'
            );
          }
        );
      });

      it('surfaces an error strip in the validation tokens and keeps it visible', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: errorBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.history-error',
              'background-color',
              theme,
              'vscode-inputValidation-errorBackground'
            );
            await assertResolvesToToken(
              page,
              '.history-error',
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
            // pairing: ≈3.9:1 dark, ≈2.6:1 light. The floor is below both so
            // the spec catches overpaint and fade-out, not the theme's choice.
            await assertReadable(page, '.history-error', 2.5);
          }
        );
      });

      it('fits a 640px panel without forcing a sideways scroll', async () => {
        await withRenderedPage(
          {
            css: gitToolWindowCss(),
            body: historyBody(),
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
