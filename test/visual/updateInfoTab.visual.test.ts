/**
 * Computed-style specs for the Update Info tab (updateInfoTabStyles).
 *
 * No shipped defect lives here. The tab's whole job is telling five outcomes
 * apart by colour — updated, up-to-date, conflict, error, skipped — so the
 * token-identity specs pin each status class to its git-decoration token
 * under the sentinel palette, where a wrong-but-adjacent token cannot hide
 * behind a colliding real value.
 */

import '../setup';
import { withRenderedPage } from './support/browser';
import {
  assertNoHorizontalOverflow,
  assertNotOverlapping,
  assertReadable,
  assertResolvesToToken,
} from './support/assert';
import { gitToolWindowCss, tabbedBody, updateInfoState } from './support/gitToolWindowFixture';
import type { ThemeName } from './support/theme';

const THEMES: readonly ThemeName[] = ['dark', 'light'];

const updateInfoBody = (): string =>
  tabbedBody({ activeTab: 'updateInfo', updateInfo: updateInfoState() });

describe('update info tab (computed style)', () => {
  for (const theme of THEMES) {
    describe(`${theme} theme`, () => {
      it('colours each outcome with its own status token', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: updateInfoBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.update-info-status-updated',
              'color',
              theme,
              'vscode-gitDecoration-addedResourceForeground'
            );
            await assertResolvesToToken(
              page,
              '.update-info-status-conflict',
              'color',
              theme,
              'vscode-gitDecoration-conflictingResourceForeground'
            );
            await assertResolvesToToken(
              page,
              '.update-info-status-error',
              'color',
              theme,
              'vscode-errorForeground'
            );
            await assertResolvesToToken(
              page,
              '.update-info-status-up-to-date',
              'color',
              theme,
              'vscode-descriptionForeground'
            );
            // Same token as up-to-date, asserted anyway: the failure this
            // catches is the skipped rule losing its selector, not the two
            // outcomes diverging.
            await assertResolvesToToken(
              page,
              '.update-info-status-skipped',
              'color',
              theme,
              'vscode-descriptionForeground'
            );
          }
        );
      });

      it('renders the branch in the preformat token and the detail in the error token', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: updateInfoBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.update-info-branch code',
              'color',
              theme,
              'vscode-textPreformat-foreground'
            );
            await assertResolvesToToken(
              page,
              '.update-info-detail',
              'color',
              theme,
              'vscode-errorForeground'
            );
          }
        );
      });

      it('keeps the headline, repo names and branch readable', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: updateInfoBody(), theme, realistic: true },
          async (page) => {
            await assertReadable(page, '.update-info-headline');
            await assertReadable(page, '.update-info-repo');
            await assertReadable(page, '.update-info-branch code');
          }
        );
      });

      it('keeps the outcome labels legible in the palette’s own colours', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: updateInfoBody(), theme, realistic: true },
          async (page) => {
            await assertReadable(page, '.update-info-status-updated');
            await assertReadable(page, '.update-info-status-conflict');
            await assertReadable(page, '.update-info-status-skipped');
            await assertReadable(page, '.update-info-status-up-to-date');
            // errorForeground on the panel background is the palette's own
            // pairing (≈5.3:1 dark, ≈3.2:1 light); the floor is below both so
            // the spec catches overpaint and fade-out, not the theme's choice.
            await assertReadable(page, '.update-info-status-error', 2.5);
            await assertReadable(page, '.update-info-detail', 2.5);
          }
        );
      });

      it('pushes the status chip to the row edge without overlapping the repo name', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: updateInfoBody(), theme, realistic: true },
          async (page) => {
            await assertNotOverlapping(
              page,
              '.update-info-row .update-info-repo',
              '.update-info-row .update-info-status'
            );
            await assertNotOverlapping(
              page,
              '.update-info-row .update-info-strategy',
              '.update-info-row .update-info-status'
            );
          }
        );
      });

      it('fits a 640px panel without forcing a sideways scroll', async () => {
        await withRenderedPage(
          {
            css: gitToolWindowCss(),
            body: updateInfoBody(),
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
