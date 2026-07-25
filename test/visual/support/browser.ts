/**
 * Headless-Chromium page factory for the computed-style lane.
 *
 * The unit lane runs webview code under jsdom, which has no layout or cascade
 * engine: `getComputedStyle` there cannot tell you whether a rule matched, lost
 * on specificity, or resolved to a readable colour. Every CSS defect the
 * project has shipped (an unthemed control, a selection fill painting over
 * glyphs, a filter bar landing behind the tab strip) is invisible to it.
 *
 * This lane renders the SAME css and markup the host emits in a real engine and
 * asserts computed values. It is deliberately not a pixel differ: see ADR-010's
 * rejection of visual snapshots. There is no rasterizer, no golden image, and a
 * failure names the property that changed.
 *
 * Uses the system Chrome via playwright-core's `chrome` channel so no browser
 * binary is vendored. If Chrome is absent, `npx playwright-core install chromium`
 * and set INTELLIG_VISUAL_CHANNEL=chromium.
 */

import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { themeRootCss, type ThemeName } from './theme';
import { headedEnabled, saveShot, shotsEnabled, slowMoMs } from './capture';

/** Fixed so layout assertions never depend on the runner's window size. */
const VIEWPORT = { width: 1280, height: 800 };

/**
 * Below this the lane's own primitives are not dependable: `elementFromPoint`
 * behaviour around stacking contexts and `getComputedStyle` serialization of
 * modern colour spaces both moved in this range. A too-old browser should fail
 * loudly rather than produce quietly wrong verdicts.
 */
const MINIMUM_CHROMIUM_MAJOR = 110;

let shared: Browser | undefined;

async function getBrowser(): Promise<Browser> {
  if (shared) {
    return shared;
  }
  const channel = process.env.INTELLIG_VISUAL_CHANNEL ?? 'chrome';
  const launch = { headless: !headedEnabled(), slowMo: slowMoMs() };
  try {
    shared = await chromium.launch(channel === 'chromium' ? launch : { ...launch, channel });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not launch a browser for the visual lane (channel '${channel}'). ` +
        `Install Google Chrome, or run 'npx playwright-core install chromium' and set ` +
        `INTELLIG_VISUAL_CHANNEL=chromium.\nUnderlying error: ${detail}`
    );
  }
  // `version()` is a bare '146.0.7680.80' for the chrome channel but can carry
  // a 'HeadlessChrome/146...' prefix for bundled builds; accept both.
  const major = Number(/(?:^|\/)(\d+)\./.exec(shared.version())?.[1] ?? '0');
  if (major < MINIMUM_CHROMIUM_MAJOR) {
    const version = shared.version();
    await shared.close();
    shared = undefined;
    throw new Error(
      `The visual lane needs Chromium ${MINIMUM_CHROMIUM_MAJOR}+ but launched '${version}'. ` +
        `Update Chrome, or set INTELLIG_VISUAL_CHANNEL=chromium after 'npx playwright-core install chromium'.`
    );
  }
  return shared;
}

/** Root-hook teardown; the lane leaks a browser process without it. */
export async function closeSharedBrowser(): Promise<void> {
  if (shared) {
    await shared.close();
    shared = undefined;
  }
}

export interface IRenderOptions {
  /** Emitted verbatim into a <style> block, as the host emits it. */
  css: string;
  /** Emitted verbatim into <body>, as the host emits it. */
  body: string;
  theme: ThemeName;
  /**
   * Use the real VS Code palette instead of unique sentinel values. Required
   * for contrast specs, where the relationship between two tokens is the point.
   * See test/visual/support/theme.ts.
   */
  realistic?: boolean;
  /**
   * Extra `body` declarations, emitted AFTER the production css so they win.
   * Only needed when a surface must be measured against a container the
   * production stylesheet does not itself provide.
   */
  bodyStyle?: string;
  /** Narrower than the default when a spec is about fitting a cramped panel. */
  viewport?: { width: number; height: number };
}

/**
 * Renders one surface and hands the page to `fn`, closing it afterwards.
 *
 * `css` and `body` must come from the production builders (for example
 * `buildInlineStyles()`), never be retyped in the test: a hand-copied rule
 * would pin the test's own opinion instead of what ships.
 */
export async function withRenderedPage<T>(
  options: IRenderOptions,
  fn: (page: Page) => Promise<T>
): Promise<T> {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: options.viewport ?? VIEWPORT });
  const page = await context.newPage();
  try {
    await page.setContent(buildDocument(options), { waitUntil: 'load' });
    await makeEveryLayerHitTestable(page);
    const result = await fn(page);
    if (shotsEnabled()) {
      await saveShot(page);
    }
    return result;
  } catch (error) {
    // Always capture a failure, shots flag or not: a contrast number in the
    // assertion message is hard to picture, and the image is what makes it
    // obvious. saveShot never throws, so it cannot mask this error.
    await saveShot(page, '--FAILED');
    throw error;
  } finally {
    await context.close();
  }
}

/**
 * Makes every painted element answer the hit test.
 *
 * The stacking and readability assertions ask what PAINTS at a point, and the
 * only browser API that answers is `elementFromPoint`, which reports what would
 * receive a CLICK. The two diverge on `pointer-events: none`: such a layer
 * paints normally but is skipped by the hit test. An opaque overlay declared
 * that way therefore reads as "nothing is covering the text" and drops out of
 * the measured backdrop — both assertions report green on a surface no one can
 * read. Overlays are routinely declared that way; the merge window's own
 * `.action-band` is one.
 *
 * Applied inline and `!important` because production rules select by class and
 * some of Monaco's carry `!important` themselves. Nothing in this lane clicks
 * and paint is unaffected, so no assertion changes subject. It does make the
 * property itself the harness's value rather than the stylesheet's, which is
 * why `computed()` refuses to report it.
 */
async function makeEveryLayerHitTestable(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const styled = el as Partial<HTMLElement>;
      styled.style?.setProperty('pointer-events', 'auto', 'important');
    }
  });
}

function buildDocument(options: IRenderOptions): string {
  const realistic = options.realistic === true;
  // The production stylesheet sits between the reset and the override block so
  // it wins over the reset (as it does in the host) but still loses to an
  // explicit per-spec bodyStyle.
  const override =
    options.bodyStyle === undefined ? '' : `<style>\n    body { ${options.bodyStyle} }\n</style>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
${themeRootCss(options.theme, { realistic })}
    * { box-sizing: border-box; }
    /* VS Code injects a default foreground/background into every webview
       before the extension's own stylesheet. Without it a surface that sets no
       background of its own renders on white even in a dark theme, and any
       contrast reading taken against the page is measured against the wrong
       backdrop. Declared in the reset block so production css still wins. */
    body {
      margin: 0;
      padding: 16px;
      background-color: var(--vscode-editor-background);
      color: var(--vscode-foreground);
    }
</style>
<style>
${options.css}
</style>
${override}
</head>
<body>
${options.body}
</body>
</html>`;
}
