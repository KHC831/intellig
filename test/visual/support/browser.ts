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
 * asserts computed values. It is deliberately not a pixel differ: see
 * ADR-010's rejection of visual snapshots. There is no rasterizer, no golden
 * image, and a failure names the property that changed.
 *
 * Uses the system Chrome via playwright-core's `chrome` channel so no browser
 * binary is vendored. If Chrome is absent, `npx playwright install chromium`
 * and set INTELLIG_VISUAL_CHANNEL=chromium.
 */

import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { themeRootCss, type ThemeName } from './theme';

/** Fixed so layout assertions never depend on the runner's window size. */
const VIEWPORT = { width: 1280, height: 800 };

let shared: Browser | undefined;

async function getBrowser(): Promise<Browser> {
  if (shared) {
    return shared;
  }
  const channel = process.env.INTELLIG_VISUAL_CHANNEL ?? 'chrome';
  try {
    shared = await chromium.launch(
      channel === 'chromium' ? { headless: true } : { headless: true, channel }
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not launch a browser for the visual lane (channel '${channel}'). ` +
        `Install Google Chrome, or run 'npx playwright install chromium' and set ` +
        `INTELLIG_VISUAL_CHANNEL=chromium.\nUnderlying error: ${detail}`
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
   * Applied to <body> so a surface can be measured inside its real container
   * background rather than the browser's default white.
   */
  bodyStyle?: string;
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
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await page.setContent(buildDocument(options), { waitUntil: 'load' });
    return await fn(page);
  } finally {
    await context.close();
  }
}

function buildDocument(options: IRenderOptions): string {
  const bodyStyle = options.bodyStyle ?? 'background: var(--vscode-editor-background);';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
${themeRootCss(options.theme)}
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; ${bodyStyle} }
</style>
<style>
${options.css}
</style>
</head>
<body>
${options.body}
</body>
</html>`;
}
