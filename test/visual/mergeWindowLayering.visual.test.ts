/**
 * Computed-style specs for the merge window's fill and selection layering.
 *
 * This is the surface that shipped broken five times running. Each round moved
 * one layer and broke another: the selection was lifted over the fills and rose
 * over the text glyphs; isolating the overlay layer did not bring it back down;
 * dropping the lift for translucent fills left the selection colour muddied
 * when read through a fill; sinking the fills below the selection needed the
 * isolation back to stop them vanishing behind the editor background. Every
 * round was found by a human looking at the screen.
 *
 * The existing unit specs pin what the stylesheet SAYS — that a z-index is
 * -1, that an isolation is declared. They cannot say which layer actually won,
 * because jsdom has no stacking resolution and `elementFromPoint` does not
 * exist there. These specs ask the only question that matters: at the pixel
 * where the text is, what is on top.
 *
 * They render against a hand-built skeleton of Monaco's layer structure, not
 * Monaco itself (see support/mergeWindowFixture.ts). Two limitations follow,
 * both proven by mutation rather than assumed:
 *
 * 1. If Monaco changes its DOM shape these keep passing against a shape that no
 *    longer ships.
 * 2. The skeleton reproduces the selection-over-glyphs defect when the overlay
 *    layer carries no isolation, but NOT when it does: against this structure a
 *    lift inside an isolated layer stays confined, so the glyphs still win.
 *    The commit that dropped the lift reported the opposite against real
 *    Monaco. Either its DOM nests the selection outside the isolated overlay,
 *    or that diagnosis was imprecise. Until that is settled, treat these as
 *    guarding the arrangement that ships, not as a proof that any lift is safe.
 */

import '../setup';
import { mergeWindowStyles } from '../../src/conflicts/merge-window/mergeWindowHtml';
import { withRenderedPage } from './support/browser';
import {
  assertComputedEquals,
  assertNotCovered,
  assertPaintsAbove,
  assertReadable,
  assertResolvesToToken,
} from './support/assert';
import { editorSkeleton, type MergeFillKind } from './support/mergeWindowFixture';
import type { ThemeName } from './support/theme';

const THEMES: readonly ThemeName[] = ['dark', 'light'];
const KINDS: readonly MergeFillKind[] = ['conflict', 'modified', 'inserted', 'deleted'];

describe('merge window layering (computed style)', () => {
  for (const theme of THEMES) {
    describe(`${theme} theme`, () => {
      for (const kind of KINDS) {
        it(`keeps the text readable above a ${kind} fill with a selection over it`, async () => {
          const body = editorSkeleton('probe', { fill: kind, selected: true, focused: true });
          await withRenderedPage(
            { css: mergeWindowStyles(), body, theme, realistic: true },
            async (page) => {
              // The glyphs must win over both overlay layers. Lifting the
              // selection above the text is the defect that shipped twice.
              await assertNotCovered(page, '#probe .view-line');
              // Winning the stacking order is not the same as being legible.
              // The backdrop here is the selection composited over the fill,
              // which is what the reader actually sees and what a retargeted
              // selection or fill token would change.
              await assertReadable(page, '#probe .view-line');
            }
          );
        });

        it(`keeps the text readable over a bare ${kind} fill`, async () => {
          // Without a selection the fill IS the backdrop the glyphs sit on.
          // The selected variant cannot cover this: an opaque selection band
          // between fill and glyphs hides the fill from the measurement
          // entirely, so a fill retargeted at an unreadable colour shows up
          // only here.
          const body = editorSkeleton('probe', { fill: kind, focused: true });
          await withRenderedPage(
            { css: mergeWindowStyles(), body, theme, realistic: true },
            async (page) => {
              await assertReadable(page, '#probe .view-line');
            }
          );
        });

        it(`sinks a ${kind} fill below the selection so the selection keeps its own colour`, async () => {
          const body = editorSkeleton('probe', { fill: kind, selected: true, focused: true });
          await withRenderedPage(
            { css: mergeWindowStyles(), body, theme, realistic: true },
            async (page) => {
              // The fixture emits the fill last on purpose, so only `z-index:
              // -1` can keep it underneath. The glyph layer is legitimately
              // above both, so compare these two layers rather than asking
              // which is topmost overall.
              await assertPaintsAbove(page, '#probe .selected-text', '#probe .cdr');
            }
          );
        });
      }

      it('isolates the overlay layer so sunk fills do not vanish behind the editor', async () => {
        const body = editorSkeleton('probe', { fill: 'conflict', selected: true });
        await withRenderedPage(
          { css: mergeWindowStyles(), body, theme, realistic: true },
          async (page) => {
            await assertComputedEquals(
              page,
              '#probe .view-overlays',
              'isolation',
              'isolate',
              'Without a stacking context here the fills’ negative z-index escapes the overlay layer and they paint behind the editor background instead of under the selection.'
            );
          }
        );
      });

      it('uses the active selection colour in a focused pane', async () => {
        const body = editorSkeleton('probe', { selected: true, focused: true });
        await withRenderedPage({ css: mergeWindowStyles(), body, theme }, async (page) => {
          await assertResolvesToToken(
            page,
            '#probe .selected-text',
            'background-color',
            theme,
            'vscode-editor-selectionBackground'
          );
        });
      });

      it('uses the inactive selection colour in an unfocused pane', async () => {
        const body = editorSkeleton('probe', { selected: true, focused: false });
        await withRenderedPage({ css: mergeWindowStyles(), body, theme }, async (page) => {
          await assertResolvesToToken(
            page,
            '#probe .selected-text',
            'background-color',
            theme,
            'vscode-editor-inactiveSelectionBackground'
          );
        });
      });
    });
  }
});
