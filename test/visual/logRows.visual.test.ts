/**
 * Computed-style specs for the main log's commit rows (commitRowStyles,
 * reached through buildInlineStyles).
 *
 * The contract under test is IntelliJ's: on a selected row EVERY cell takes
 * the selection foreground — the base style derives it from a renderer
 * configured with `selected`, and no column can opt out
 * (vcs-log GraphCommitCellRenderer.kt getSelectionForeground,
 * VcsLogGraphTable.java BaseStyleProvider.getBaseStyle). The shipped defect
 * class is the opt-out: secondary cells pinning descriptionForeground win
 * specificity over the row's selection foreground and render dim text on the
 * selection fill.
 *
 * Markup comes from the production `buildCommitRows` with the unit lane's
 * print-model kit driving the graph cell; the selection class comes from the
 * builder's own selection set.
 */

import '../setup';
import { withRenderedPage } from './support/browser';
import { assertReadable, assertResolvesToToken } from './support/assert';
import { gitToolWindowCss, logRowsBody } from './support/gitToolWindowFixture';
import type { ThemeName } from './support/theme';

const THEMES: readonly ThemeName[] = ['dark', 'light'];

describe('main log commit rows (computed style)', () => {
  for (const theme of THEMES) {
    describe(`${theme} theme`, () => {
      it('swaps the author and date to the selection foreground on a selected row', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: logRowsBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.commit-row.selected .commit-author',
              'color',
              theme,
              'vscode-list-activeSelectionForeground'
            );
            await assertResolvesToToken(
              page,
              '.commit-row.selected .commit-date',
              'color',
              theme,
              'vscode-list-activeSelectionForeground'
            );
          }
        );
      });

      it('keeps the description tone for author and date on an unselected row', async () => {
        // The negative half: the selection override must not leak into the
        // resting rows, where the dim secondary tone is the design.
        await withRenderedPage(
          { css: gitToolWindowCss(), body: logRowsBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.commit-row:not(.selected) .commit-author',
              'color',
              theme,
              'vscode-descriptionForeground'
            );
            await assertResolvesToToken(
              page,
              '.commit-row:not(.selected) .commit-date',
              'color',
              theme,
              'vscode-descriptionForeground'
            );
          }
        );
      });

      it('keeps every selected-row cell readable over the selection fill', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: logRowsBody(), theme, realistic: true },
          async (page) => {
            await assertReadable(page, '.commit-row.selected .commit-title');
            await assertReadable(page, '.commit-row.selected .commit-author');
            await assertReadable(page, '.commit-row.selected .commit-date');
          }
        );
      });
    });
  }
});
