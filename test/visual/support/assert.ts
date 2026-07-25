/**
 * Computed-style assertions for the visual lane.
 *
 * Each helper targets a defect class the string-matching CSS tests cannot see.
 * A test asserting `css.includes('var(--vscode-dropdown-background)')` stays
 * green when the rule is present but never matches the element, loses on
 * specificity, or is overpainted by a later rule. These read the resolved value
 * out of a real cascade instead.
 */

import * as assert from 'assert';
import type { Page } from 'playwright-core';
import { themeToken, type ThemeName } from './theme';

interface IRgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Accepts the `rgb()`/`rgba()` a browser returns and the hex a token holds. */
function parseColor(value: string): IRgb {
  const text = value.trim();
  const fn = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter((p) => p.length > 0);
    return {
      r: Number(parts[0]),
      g: Number(parts[1]),
      b: Number(parts[2]),
      a: parts.length > 3 ? Number(parts[3]) : 1,
    };
  }
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = digits
        .split('')
        .map((d) => d + d)
        .join('');
    }
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
    };
  }
  if (text === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  throw new Error(`Cannot parse colour '${value}'`);
}

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(color: IRgb): number {
  return (
    0.2126 * channelLuminance(color.r) +
    0.7152 * channelLuminance(color.g) +
    0.0722 * channelLuminance(color.b)
  );
}

/** WCAG 2.1 contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(parseColor(foreground));
  const b = relativeLuminance(parseColor(background));
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

export async function computed(page: Page, selector: string, property: string): Promise<string> {
  const found = await page.$(selector);
  assert.ok(found, `expected an element matching '${selector}' in the rendered document`);
  return page.evaluate(
    ([sel, prop]) => {
      const el = document.querySelector(sel);
      return el ? window.getComputedStyle(el).getPropertyValue(prop) : '';
    },
    [selector, property] as const
  );
}

/**
 * The rule matched, won the cascade, and resolved to the theme's value.
 *
 * This is the assertion that catches an unthemed control: a missing or
 * non-matching rule leaves the browser's default, which is never a token value.
 */
export async function assertResolvesToToken(
  page: Page,
  selector: string,
  property: string,
  theme: ThemeName,
  token: string
): Promise<void> {
  const actual = await computed(page, selector, property);
  const expected = themeToken(theme, token);
  const actualRgb = parseColor(actual);
  const expectedRgb = parseColor(expected);
  assert.deepStrictEqual(
    { r: actualRgb.r, g: actualRgb.g, b: actualRgb.b },
    { r: expectedRgb.r, g: expectedRgb.g, b: expectedRgb.b },
    `${selector} { ${property} } resolved to '${actual}', expected var(--${token.replace(/^--/, '')}) = '${expected}'. ` +
      `A browser default here means the rule is missing or its selector does not match; ` +
      `another colour means a later rule overrode it.`
  );
}

/** `source` composited over `backdrop`, both already parsed. */
function over(source: IRgb, backdrop: IRgb): IRgb {
  const a = source.a + backdrop.a * (1 - source.a);
  if (a === 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const blend = (s: number, b: number): number =>
    Math.round((s * source.a + b * backdrop.a * (1 - source.a)) / a);
  return {
    r: blend(source.r, backdrop.r),
    g: blend(source.g, backdrop.g),
    b: blend(source.b, backdrop.b),
    a,
  };
}

/**
 * What the user actually sees behind `selector`'s text.
 *
 * Most themed elements set no background of their own and show their
 * container's. Comparing text against the element's own `background-color`
 * would read `rgba(0, 0, 0, 0)` and score every light-theme label as
 * unreadable, so walk ancestors to the first opaque layer and composite back
 * down.
 */
export async function effectiveBackground(page: Page, selector: string): Promise<string> {
  const layers = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) {
      return [];
    }
    const stack: string[] = [];
    let node: Element | null = el;
    while (node) {
      stack.push(window.getComputedStyle(node).backgroundColor);
      node = node.parentElement;
    }
    stack.push('rgb(255, 255, 255)');
    return stack;
  }, selector);
  assert.ok(
    layers.length > 0,
    `expected an element matching '${selector}' in the rendered document`
  );

  let backdrop: IRgb = { r: 255, g: 255, b: 255, a: 1 };
  for (let i = layers.length - 1; i >= 0; i--) {
    backdrop = over(parseColor(layers[i]), backdrop);
  }
  return `rgb(${backdrop.r}, ${backdrop.g}, ${backdrop.b})`;
}

/** Text clears a WCAG threshold against what is really behind it (AA body = 4.5). */
export async function assertReadable(
  page: Page,
  selector: string,
  minimumRatio = 4.5
): Promise<void> {
  const color = await computed(page, selector, 'color');
  const background = await effectiveBackground(page, selector);
  const ratio = contrastRatio(color, background);
  assert.ok(
    ratio >= minimumRatio,
    `${selector} has contrast ${ratio.toFixed(2)}:1 (${color} on ${background}), below the ${minimumRatio}:1 minimum`
  );
}

/**
 * The topmost painted element at the centre of `selector` is that element (or
 * a descendant), i.e. nothing is covering it.
 *
 * This is the stacking-context assertion: a filter bar pushed behind a tab
 * strip, or a selection fill painted over glyphs, both present here as some
 * other element answering `elementFromPoint`.
 */
export async function assertNotCovered(page: Page, selector: string): Promise<void> {
  const result = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) {
      return { ok: false, reason: 'not found' };
    }
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) {
      return { ok: false, reason: 'element has zero area' };
    }
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (top === null) {
      return { ok: false, reason: 'nothing painted at its centre' };
    }
    if (el === top || el.contains(top)) {
      return { ok: true, reason: '' };
    }
    return {
      ok: false,
      reason: `covered by <${top.tagName.toLowerCase()} class="${top.getAttribute('class') ?? ''}">`,
    };
  }, selector);
  assert.ok(result.ok, `${selector} is not the topmost element at its centre: ${result.reason}`);
}

/** Two elements do not intersect, for text-overlapping-text defects. */
export async function assertNotOverlapping(
  page: Page,
  firstSelector: string,
  secondSelector: string
): Promise<void> {
  const result = await page.evaluate(
    ([a, b]) => {
      const first = document.querySelector(a);
      const second = document.querySelector(b);
      if (!first || !second) {
        return { overlap: false, missing: !first ? a : b };
      }
      const x = first.getBoundingClientRect();
      const y = second.getBoundingClientRect();
      const overlap = !(
        x.right <= y.left ||
        y.right <= x.left ||
        x.bottom <= y.top ||
        y.bottom <= x.top
      );
      return { overlap, missing: '' };
    },
    [firstSelector, secondSelector] as const
  );
  assert.ok(!result.missing, `expected both '${firstSelector}' and '${secondSelector}' to render`);
  assert.ok(!result.overlap, `'${firstSelector}' overlaps '${secondSelector}'`);
}

/** The document does not scroll sideways, for surfaces that must fit narrow panels. */
export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const result = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert.ok(
    result.scrollWidth <= result.clientWidth,
    `document overflows horizontally: scrollWidth ${result.scrollWidth} > clientWidth ${result.clientWidth}`
  );
}
