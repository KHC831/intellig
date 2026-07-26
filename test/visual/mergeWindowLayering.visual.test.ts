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
import * as assert from 'assert';
import {
  mergeWindowStyles,
  MERGE_FILL_ALPHA,
  MERGE_WORD_ALPHA,
} from '../../src/conflicts/merge-window/mergeWindowHtml';
import { withRenderedPage } from './support/browser';
import {
  assertComputedEquals,
  assertNotCovered,
  assertPaintsAbove,
  assertReadable,
  assertResolvesToTintOfToken,
  assertResolvesToToken,
} from './support/assert';
import {
  editorSkeleton,
  MERGE_FILL_KINDS,
  MERGE_BG_TOKEN,
  MERGE_STRONG_TOKEN,
} from './support/mergeWindowFixture';
import type { ThemeName } from './support/theme';

const THEMES: readonly ThemeName[] = ['dark', 'light'];
const KINDS = MERGE_FILL_KINDS;

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

        it(`colours a ${kind} chunk fill as a translucent tint of its content token`, async () => {
          // The class is runtime-composed (`merge-${kind}`), so each kind gets
          // its own identity assertion: a rule pointing at the wrong token, or
          // shipped opaque, is invisible to the readability and stacking specs
          // while the hue happens to work.
          const body = editorSkeleton('probe', { fill: kind, focused: true });
          await withRenderedPage({ css: mergeWindowStyles(), body, theme }, async (page) => {
            await assertResolvesToTintOfToken(
              page,
              `#probe .cdr.merge-${kind}`,
              'background-color',
              theme,
              MERGE_BG_TOKEN[kind],
              MERGE_FILL_ALPHA
            );
          });
        });

        it(`sinks a ${kind} word highlight below the selection`, async () => {
          // Same defect class as the chunk fills, one level down: the word
          // layer shares the `z-index: -1` declaration, the fixture emits it
          // after the selection, and only that rule keeps a selection swept
          // across a word highlight in its own colour.
          const body = editorSkeleton('probe', { word: kind, selected: true, focused: true });
          await withRenderedPage(
            { css: mergeWindowStyles(), body, theme, realistic: true },
            async (page) => {
              await assertPaintsAbove(page, '#probe .selected-text', '#probe .merge-word');
            }
          );
        });

        it(`keeps the text legible over a ${kind} word highlight on its chunk fill`, async () => {
          // Word emphasis composes ON TOP of the chunk band in production, so
          // the measured backdrop is word-over-fill-over-editor — the densest
          // stack a glyph ever sits on, held to the same AA floor as
          // everything else: the word alpha is chosen so the strong tone
          // reads as emphasis while editor text stays readable through it.
          const body = editorSkeleton('probe', { fill: kind, word: kind, focused: true });
          await withRenderedPage(
            { css: mergeWindowStyles(), body, theme, realistic: true },
            async (page) => {
              await assertNotCovered(page, '#probe .view-line');
              await assertReadable(page, '#probe .view-line');
            }
          );
        });

        it(`colours a ${kind} word highlight as a translucent tint of its strong token`, async () => {
          const body = editorSkeleton('probe', { word: kind, focused: true });
          await withRenderedPage({ css: mergeWindowStyles(), body, theme }, async (page) => {
            await assertResolvesToTintOfToken(
              page,
              '#probe .merge-word',
              'background-color',
              theme,
              MERGE_STRONG_TOKEN[kind],
              MERGE_WORD_ALPHA
            );
          });
        });

        it(`marks a ${kind} deleted-elsewhere line with a 2px border in its strong token`, async () => {
          // `.merge-empty` is a border marker, not a fill: deleted takes the
          // base rule's colour, the other kinds override it, and the box stays
          // transparent so the line beneath shows through.
          const body = editorSkeleton('probe', { empty: kind });
          await withRenderedPage({ css: mergeWindowStyles(), body, theme }, async (page) => {
            await assertComputedEquals(
              page,
              '#probe .merge-empty',
              'border-top-width',
              '2px',
              'The marker IS the border; without its width the deleted-elsewhere line is invisible.'
            );
            await assertResolvesToToken(
              page,
              '#probe .merge-empty',
              'border-top-color',
              theme,
              MERGE_STRONG_TOKEN[kind]
            );
          });
        });

        it(`outlines a resolved ${kind} chunk with dotted borders in its strong token`, async () => {
          const body = editorSkeleton('probe', { resolved: kind });
          await withRenderedPage({ css: mergeWindowStyles(), body, theme }, async (page) => {
            await assertComputedEquals(
              page,
              '#probe .merge-resolved-top',
              'border-top-style',
              'dotted',
              'A resolved chunk keeps a dotted outline instead of its fill; solid or none stops reading as resolved.'
            );
            await assertComputedEquals(
              page,
              '#probe .merge-resolved-bottom',
              'border-bottom-style',
              'dotted',
              'The bottom edge carries the matching dotted rule.'
            );
            await assertResolvesToToken(
              page,
              '#probe .merge-resolved-top',
              'border-top-color',
              theme,
              MERGE_STRONG_TOKEN[kind]
            );
            await assertResolvesToToken(
              page,
              '#probe .merge-resolved-bottom',
              'border-bottom-color',
              theme,
              MERGE_STRONG_TOKEN[kind]
            );
          });
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

  it('pins the fixture kinds set-equal to the k- families the stylesheet ships', () => {
    // MERGE_FILL_KINDS drives every per-kind loop above, so a fifth family
    // added in production would silently miss all of them unless this pin
    // forces the fixture to grow with the stylesheet.
    const families = new Set([...mergeWindowStyles().matchAll(/\bk-([a-z]+)\b/g)].map((m) => m[1]));
    assert.deepStrictEqual(
      [...families].sort(),
      [...MERGE_FILL_KINDS].sort(),
      'the k- families in mergeWindowStyles() and the fixture kind list must be the same set; ' +
        'a family present in only one of them is untested by every per-kind spec'
    );
  });
});
