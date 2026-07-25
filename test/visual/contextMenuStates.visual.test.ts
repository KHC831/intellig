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
import { buildCommitContextMenuHtml } from '../../src/git-core/gitToolWindow/provider/htmlBuilders';
import { buildInlineStyles } from '../../src/git-core/gitToolWindow/provider/stylesBuilder';
import type { IGtwControllerContext } from '../../src/git-core/gitToolWindow/provider/IGtwControllerContext';
import { withRenderedPage } from './support/browser';
import { assertReadable } from './support/assert';
import { shownMenuMarkup } from './support/markup';
import type { ThemeName } from './support/theme';

/** The builder reads only `extendedLogState.commitNodes` to stamp the head hash. */
const CTX = {
  extendedLogState: { commitNodes: [] },
} as unknown as IGtwControllerContext;

// Built per spec, not at module scope: see contextMenuTheming.visual.test.ts.
const menu = (): string => shownMenuMarkup(buildCommitContextMenuHtml(CTX), 'commit-context-menu');

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
});
