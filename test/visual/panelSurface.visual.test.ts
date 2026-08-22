/**
 * Computed-style specs for the surface colour of the panel-hosted views.
 *
 * The Git and Commit tool windows are contributed to a `panel` viewsContainer
 * (package.json `contributes.viewsContainers.panel`), so their background must
 * be `panel.background` — the colour VS Code paints the container and the
 * neighbouring native Branches tree with. Painting `sideBar.background` instead
 * renders them a different shade from everything around them, which reads as
 * the view stopping partway down the panel.
 *
 * The sentinel palette is the point here: in Dark/Light Modern
 * `panel.background` and `sideBar.background` are the SAME colour, so a
 * realistic palette cannot tell a correct rule from one naming the wrong token.
 */

import '../setup';
import { buildInlineStyles } from '../../src/git-core/gitToolWindow/provider/stylesBuilder';
import { toolWindowTabStyles } from '../../src/git-core/gitToolWindow/provider/documentShell';
import { commitToolWindowStyles } from '../../src/commits/commitToolWindowStyles';

/** The Git tool window ships both sheets; render the same concat it does. */
const gitToolWindowStyles = (): string => `${buildInlineStyles()}\n${toolWindowTabStyles()}`;
import { withRenderedPage } from './support/browser';
import { assertResolvesToToken } from './support/assert';
import type { ThemeName } from './support/theme';

const THEMES: readonly ThemeName[] = ['dark', 'light'];

// Each view supplies the shell that gives its body a real box — `body` with no
// content is 1280x0 and the computed-style read would be meaningless.
const PANEL_VIEWS: ReadonlyArray<{ name: string; css: () => string; body: string }> = [
  {
    name: 'Git tool window',
    css: () => gitToolWindowStyles(),
    body: '<div class="intellig-tabbed"><div class="intellig-tab-strip"></div></div>',
  },
  {
    name: 'Commit tool window',
    css: () => commitToolWindowStyles(),
    body: '<div class="ctw-body"></div>',
  },
];

describe('panel-hosted view surfaces (computed style)', () => {
  for (const view of PANEL_VIEWS) {
    describe(view.name, () => {
      for (const theme of THEMES) {
        it(`paints its body with the panel background token in the ${theme} theme`, async () => {
          await withRenderedPage({ css: view.css(), body: view.body, theme }, async (page) => {
            await assertResolvesToToken(
              page,
              'body',
              'background-color',
              theme,
              'vscode-panel-background'
            );
          });
        });
      }
    });
  }

  // The Log tab's column header is sticky and sits directly on the body, so a
  // body that moved to the panel token while the header kept the sidebar one
  // would put a visible band across the top of the list.
  for (const theme of THEMES) {
    it(`keeps the Log column header on the same surface token in the ${theme} theme`, async () => {
      await withRenderedPage(
        { css: gitToolWindowStyles(), body: '<div class="log-column-header"></div>', theme },
        async (page) => {
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
