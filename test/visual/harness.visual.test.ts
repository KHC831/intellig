/**
 * The lane's assertions pointed at itself.
 *
 * Every other spec here asks whether the product's CSS is right. These ask
 * whether the question can be answered at all, by rendering a defect on purpose
 * and requiring the assertion to report it. An assertion that cannot tell
 * "correct" from "absent" reports green forever, which is the one failure mode
 * a test lane cannot detect from the inside.
 *
 * The `pointer-events` cases exist because the hit test the stacking and
 * readability helpers depend on answers a question the lane is not asking.
 * `elementFromPoint` reports what would receive a CLICK, and it skips any layer
 * declared `pointer-events: none` — while that layer still paints. Overlays are
 * routinely declared that way (this repo's own `.action-band` is), so before
 * the harness neutralised the property, an opaque overlay painted over text was
 * invisible to `assertNotCovered` and absent from `assertReadable`'s backdrop.
 * Both reported green on a surface no one could read.
 *
 * Neutralising the property has a cost the lane must state: no spec can assert
 * hover or click behaviour that DEPENDS on a production `pointer-events` value,
 * because the harness has overwritten it on every element (ResetDialog's
 * disabled-radio rule — events fall through so the protected-branch tooltip
 * surfaces on the row — is the live case). Assert the precondition instead:
 * the computed rule on the element the behaviour needs, which is why
 * `computed()` refuses to report `pointer-events` itself and fails loudly
 * rather than measuring the harness's value. The trade is deliberate — without
 * the forcing, every stacking and readability probe silently skipped
 * `pointer-events: none` layers that still paint.
 */

import '../setup';
import type { Page } from 'playwright-core';
import { withRenderedPage } from './support/browser';
import { assertNotCovered, assertReadable, assertResolvesToTintOfToken } from './support/assert';

const CSS = `
#probe { position: relative; width: 300px; height: 60px; background-color: #101010; }
.layer { position: absolute; top: 0; left: 0; width: 100%; height: 20px; }
.glyphs { color: #ffffff; }
.cover { background-color: #ffffff; }
`;

/** Glyphs with an opaque layer painted OVER them. */
const covered = (coverStyle: string): string => `
<div id="probe">
  <div class="layer glyphs">merged text</div>
  <div class="layer cover" style="${coverStyle}"></div>
</div>`;

/** Glyphs with an opaque layer painted UNDER them, in their own colour. */
const backed = (fillStyle: string): string => `
<div id="probe">
  <div class="layer cover" style="${fillStyle}"></div>
  <div class="layer glyphs">merged text</div>
</div>`;

/** The assertion must reject, and its message must name what went wrong. */
async function mustReport(run: () => Promise<void>, expected: RegExp): Promise<void> {
  let message: string | undefined;
  try {
    await run();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (message === undefined) {
    throw new Error(
      `the assertion passed against a deliberately broken surface; it cannot ` +
        `distinguish a correct render from a broken one`
    );
  }
  if (!expected.test(message)) {
    throw new Error(`assertion failed for the wrong reason: ${message}`);
  }
}

describe('visual harness self-check', () => {
  const render = (body: string, fn: (page: Page) => Promise<void>): Promise<void> =>
    withRenderedPage({ css: CSS, body, theme: 'dark', realistic: true }, fn);

  it('passes clean markup, so the cases below are not vacuous', async () => {
    await render(covered('display: none;'), async (page) => {
      await assertNotCovered(page, '#probe .glyphs');
      await assertReadable(page, '#probe .glyphs');
    });
  });

  it('reports an opaque layer painted over the text', async () => {
    await render(covered(''), async (page) => {
      await mustReport(() => assertNotCovered(page, '#probe .glyphs'), /covered by/);
    });
  });

  it('reports that layer when it is pointer-events: none', async () => {
    await render(covered('pointer-events: none;'), async (page) => {
      await mustReport(() => assertNotCovered(page, '#probe .glyphs'), /covered by/);
    });
  });

  it('reports text on a same-coloured backdrop', async () => {
    await render(backed(''), async (page) => {
      await mustReport(() => assertReadable(page, '#probe .glyphs'), /contrast 1\.00:1/);
    });
  });

  it('reports that backdrop when it is pointer-events: none', async () => {
    await render(backed('pointer-events: none;'), async (page) => {
      await mustReport(() => assertReadable(page, '#probe .glyphs'), /contrast 1\.00:1/);
    });
  });

  // The tint assertion's own teeth: it must accept the production shape
  // (`color-mix` of the token over transparent), reject the right hue at the
  // wrong opacity, and reject the wrong token at the right opacity. Rendered
  // under the sentinel palette, where hue identity is decidable.
  describe('assertResolvesToTintOfToken', () => {
    const TINT_CSS = `
#tint-ok { width: 40px; height: 20px; background-color: color-mix(in srgb, var(--vscode-focusBorder) 60%, transparent); }
#tint-opaque { width: 40px; height: 20px; background-color: var(--vscode-focusBorder); }
#tint-wrong { width: 40px; height: 20px; background-color: color-mix(in srgb, var(--vscode-menu-background) 60%, transparent); }
`;
    const TINT_BODY =
      '<div id="tint-ok"></div><div id="tint-opaque"></div><div id="tint-wrong"></div>';

    it('passes a correct tint, so the cases below are not vacuous', async () => {
      await withRenderedPage({ css: TINT_CSS, body: TINT_BODY, theme: 'dark' }, async (page) => {
        await assertResolvesToTintOfToken(
          page,
          '#tint-ok',
          'background-color',
          'dark',
          'vscode-focusBorder',
          0.6
        );
      });
    });

    it('reports an opaque fill where a translucent tint is required', async () => {
      await withRenderedPage({ css: TINT_CSS, body: TINT_BODY, theme: 'dark' }, async (page) => {
        await mustReport(
          () =>
            assertResolvesToTintOfToken(
              page,
              '#tint-opaque',
              'background-color',
              'dark',
              'vscode-focusBorder',
              0.6
            ),
          /alpha does not/
        );
      });
    });

    it('reports a tint of the wrong token', async () => {
      await withRenderedPage({ css: TINT_CSS, body: TINT_BODY, theme: 'dark' }, async (page) => {
        await mustReport(
          () =>
            assertResolvesToTintOfToken(
              page,
              '#tint-wrong',
              'background-color',
              'dark',
              'vscode-focusBorder',
              0.6
            ),
          /wrong token/
        );
      });
    });
  });
});
