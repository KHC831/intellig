/**
 * Computed-style assertions for the visual lane.
 *
 * Each helper targets a defect class the string-matching CSS tests cannot see.
 * A test asserting `css.includes('var(--vscode-dropdown-background)')` stays
 * green when the rule is present but never matches the element, loses on
 * specificity, or is overpainted by a later rule. These read the resolved value
 * out of a real cascade instead.
 *
 * Every helper begins with the same visibility precondition. Without it the
 * assertions are trivially satisfiable: `getComputedStyle` still reports colours
 * for a `display: none` subtree, and an `opacity: 0` element still answers
 * `elementFromPoint`, so a menu that renders nowhere at all passes a colour
 * check, a contrast check and an overlap check simultaneously. An assertion
 * that cannot distinguish "correct" from "absent" is worse than no assertion,
 * because it reports green.
 */

import * as assert from 'assert';
import type { Page } from 'playwright-core';
import { themeToken, type ThemeName, type IThemeOptions } from './theme';

interface IRgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Accepts what a browser returns and the hex a token holds. */
function parseColor(value: string): IRgb {
  const text = value.trim();

  const fn = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter((p) => p.length > 0);
    const channel = (raw: string): number =>
      raw.endsWith('%') ? Math.round((Number(raw.slice(0, -1)) / 100) * 255) : Number(raw);
    const alpha = (raw: string): number =>
      raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
    return {
      r: channel(parts[0]),
      g: channel(parts[1]),
      b: channel(parts[2]),
      a: parts.length > 3 ? alpha(parts[3]) : 1,
    };
  }

  // Chrome serializes color-mix() and wide-gamut authored colours this way.
  const srgb = /^color\(\s*srgb\s+([^)]+)\)$/i.exec(text);
  if (srgb) {
    const parts = srgb[1].split(/[\s/]+/).filter((p) => p.length > 0);
    const ratio = (raw: string): number =>
      raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
    return {
      r: Math.round(ratio(parts[0]) * 255),
      g: Math.round(ratio(parts[1]) * 255),
      b: Math.round(ratio(parts[2]) * 255),
      a: parts.length > 3 ? ratio(parts[3]) : 1,
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

  throw new Error(
    `Cannot parse colour '${value}'. Extend parseColor in test/visual/support/assert.ts ` +
      `rather than letting the lane guess.`
  );
}

/**
 * Guards the arithmetic against a silently-unparsed channel. `deepStrictEqual`
 * treats NaN as equal to NaN, so without this an unparsed colour would make
 * `assertResolvesToToken` pass rather than fail.
 */
function assertFiniteColor(color: IRgb, source: string, raw: string): void {
  const finite =
    Number.isFinite(color.r) &&
    Number.isFinite(color.g) &&
    Number.isFinite(color.b) &&
    Number.isFinite(color.a);
  assert.ok(finite, `${source} parsed to a non-finite colour from '${raw}'`);
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

/** `source` composited over `backdrop`. */
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

function toCss(color: IRgb): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

/**
 * WCAG 2.1 contrast ratio, 1 (identical) to 21 (black on white).
 *
 * A translucent foreground is composited over the background first: text at
 * `rgba(204, 204, 204, 0.06)` is invisible, and scoring it as though it were
 * fully opaque reports a passing 10:1.
 */
export function contrastRatio(foreground: string, background: string): number {
  const bg = parseColor(background);
  assertFiniteColor(bg, 'background', background);
  const fgRaw = parseColor(foreground);
  assertFiniteColor(fgRaw, 'foreground', foreground);
  const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw;
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

interface IVisibility {
  found: boolean;
  width: number;
  height: number;
  display: string;
  visibility: string;
  effectiveOpacity: number;
}

async function visibilityOf(page: Page, selector: string): Promise<IVisibility> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) {
      return {
        found: false,
        width: 0,
        height: 0,
        display: '',
        visibility: '',
        effectiveOpacity: 0,
      };
    }
    const style = window.getComputedStyle(el);
    const box = el.getBoundingClientRect();
    let opacity = 1;
    let node: Element | null = el;
    while (node) {
      opacity *= Number(window.getComputedStyle(node).opacity);
      node = node.parentElement;
    }
    return {
      found: true,
      width: box.width,
      height: box.height,
      display: style.display,
      visibility: style.visibility,
      effectiveOpacity: opacity,
    };
  }, selector);
}

/**
 * The element is actually on screen. Every other helper calls this first, so no
 * assertion in the lane can be satisfied by an element that renders nowhere.
 *
 * Opacity is accumulated across ancestors: `opacity` on a parent hides a child
 * without changing any computed value the child reports.
 */
async function assertVisible(page: Page, selector: string): Promise<void> {
  const v = await visibilityOf(page, selector);
  assert.ok(v.found, `expected an element matching '${selector}' in the rendered document`);
  assert.notStrictEqual(v.display, 'none', `'${selector}' is display:none`);
  assert.notStrictEqual(v.visibility, 'hidden', `'${selector}' is visibility:hidden`);
  assert.ok(
    v.width > 0 && v.height > 0,
    `'${selector}' has a zero-area box (${v.width}x${v.height})`
  );
  assert.ok(
    v.effectiveOpacity > 0.05,
    `'${selector}' has effective opacity ${v.effectiveOpacity.toFixed(3)} (including ancestors), so it is invisible`
  );
}

/**
 * The centre of `selector`'s box, asserted to lie inside the viewport.
 *
 * Every hit-test below probes that point, and `elementFromPoint` answers null
 * for a point outside the viewport. Without this precondition an off-screen
 * element reports "nothing painted at its centre" or "the two layers do not
 * overlap", sending the reader after a stacking bug that does not exist when
 * the real cause is a fixture taller than the window.
 */
async function probePoint(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) {
      return null;
    }
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      viewWidth: window.innerWidth,
      viewHeight: window.innerHeight,
    };
  }, selector);
  assert.ok(box, `expected an element matching '${selector}' in the rendered document`);
  assert.ok(
    // Exclusive at the far edge: a point at exactly the viewport width or
    // height lies outside it, and the hit test answers null there.
    box.x >= 0 && box.y >= 0 && box.x < box.viewWidth && box.y < box.viewHeight,
    `'${selector}' centres at (${Math.round(box.x)}, ${Math.round(box.y)}), outside the ` +
      `${box.viewWidth}x${box.viewHeight} viewport, so no hit-test can reach it. ` +
      `Give the spec a viewport that fits the surface rather than reading this as a stacking failure.`
  );
  return { x: box.x, y: box.y };
}

async function computed(page: Page, selector: string, property: string): Promise<string> {
  assert.notStrictEqual(
    property,
    'pointer-events',
    `pointer-events is forced by the harness so that every painted layer answers the hit ` +
      `test (see makeEveryLayerHitTestable), so its computed value here is the harness's, ` +
      `not the stylesheet's. Assert the behaviour the rule controls instead.`
  );
  await assertVisible(page, selector);
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
 * Meaningful only against the sentinel palette, where every token has a unique
 * value. Under the realistic palette a wrong-but-adjacent token resolves to an
 * identical RGB and this passes; see test/visual/support/theme.ts.
 */
export async function assertResolvesToToken(
  page: Page,
  selector: string,
  property: string,
  theme: ThemeName,
  token: string,
  options: IThemeOptions = {}
): Promise<void> {
  const actual = await computed(page, selector, property);
  const expected = themeToken(theme, token, options);
  const actualRgb = parseColor(actual);
  const expectedRgb = parseColor(expected);
  assertFiniteColor(actualRgb, `${selector} { ${property} }`, actual);
  assertFiniteColor(expectedRgb, `token --${token.replace(/^--/, '')}`, expected);
  const why =
    `${selector} { ${property} } resolved to '${actual}', expected var(--${token.replace(/^--/, '')}) = '${expected}'. ` +
    `A browser default here means the rule is missing or its selector does not match; ` +
    `another colour means a later rule overrode it.`;
  assert.deepStrictEqual(
    { r: actualRgb.r, g: actualRgb.g, b: actualRgb.b },
    { r: expectedRgb.r, g: expectedRgb.g, b: expectedRgb.b },
    why
  );
  // Alpha is compared too, and separately: a rule can carry the token's hue at
  // the wrong opacity and be invisible on screen while its RGB matches exactly.
  // Tokens carry alpha of their own (`--vscode-toolbar-hoverBackground` is
  // `#b8b8b850` in light), and the merge window's fills blend toward
  // transparent, so opacity is part of what a rule has to get right. Chrome
  // serializes alpha to three decimals, so an exact compare would reject a
  // correct `#rrggbbaa` token.
  assert.ok(
    Math.abs(actualRgb.a - expectedRgb.a) <= 0.005,
    `${why} The colour matches but the alpha does not: got ${actualRgb.a}, expected ${expectedRgb.a}.`
  );
}

/**
 * A non-colour property resolved to an expected value.
 *
 * For rules whose whole job is structural rather than chromatic — an
 * `isolation` that traps a stacking context, a border that marks a column
 * boundary. `why` is appended to the failure so the message explains what
 * breaks, not just which string differed.
 */
export async function assertComputedEquals(
  page: Page,
  selector: string,
  property: string,
  expected: string,
  why: string
): Promise<void> {
  const actual = await computed(page, selector, property);
  assert.strictEqual(
    actual.trim(),
    expected,
    `${selector} { ${property} } resolved to '${actual.trim()}', expected '${expected}'. ${why}`
  );
}

/**
 * What the user actually sees behind `selector`'s text.
 *
 * Most themed elements set no background of their own and show whatever is
 * behind them. Comparing text against the element's own `background-color`
 * would read `rgba(0, 0, 0, 0)` and score every light-theme label as
 * unreadable, so this composites the whole stack behind the measured point.
 *
 * The stack comes from a hit test, not an ancestor walk. An ancestor walk sees
 * only containers, and the layer that makes text unreadable is very often not
 * one: the merge window's chunk fills sit under the glyphs with `z-index: -1`
 * as a SIBLING of the glyph layer, so an ancestor walk scores white text over
 * an opaque white fill as white-on-editor-background and passes it.
 */
async function effectiveBackground(page: Page, selector: string): Promise<string> {
  await assertVisible(page, selector);
  const point = await probePoint(page, selector);
  const layers = await page.evaluate(
    ([sel, x, y]) => {
      const el = document.querySelector(sel);
      if (!el) {
        return [];
      }
      const hit = document.elementsFromPoint(x, y);
      const index = hit.indexOf(el);
      // Front to back from the element down. Falls back to the ancestor chain
      // when the element is not in the stack at all (clipped out of the hit
      // test), which measures less but never measures nothing.
      const behind: Element[] = [];
      if (index === -1) {
        let node: Element | null = el;
        while (node) {
          behind.push(node);
          node = node.parentElement;
        }
      } else {
        behind.push(...hit.slice(index));
      }
      const stack = behind.map((node) => window.getComputedStyle(node).backgroundColor);
      stack.push('rgb(255, 255, 255)');
      return stack;
    },
    [selector, point.x, point.y] as const
  );

  let backdrop: IRgb = { r: 255, g: 255, b: 255, a: 1 };
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = parseColor(layers[i]);
    assertFiniteColor(layer, `background layer of '${selector}'`, layers[i]);
    backdrop = over(layer, backdrop);
  }
  return toCss(backdrop);
}

/**
 * Text clears a WCAG threshold against what is really behind it (AA body = 4.5).
 *
 * Covers the three ways text goes unreadable without any colour looking wrong
 * in isolation: a foreground that is nearly transparent, an ancestor `opacity`
 * fading the whole subtree, and something painted over the top. The last is the
 * merge-window "fill over its own glyphs" defect, which a pure colour
 * comparison structurally cannot see.
 */
export async function assertReadable(
  page: Page,
  selector: string,
  minimumRatio = 4.5
): Promise<void> {
  await assertNotCovered(page, selector);
  const rawColor = await computed(page, selector, 'color');
  const background = await effectiveBackground(page, selector);

  const { effectiveOpacity } = await visibilityOf(page, selector);
  const fg = parseColor(rawColor);
  assertFiniteColor(fg, `${selector} { color }`, rawColor);
  const faded: IRgb = { ...fg, a: fg.a * effectiveOpacity };

  const ratio = contrastRatio(toCssWithAlpha(faded), background);
  assert.ok(
    ratio >= minimumRatio,
    `${selector} has contrast ${ratio.toFixed(2)}:1 (${rawColor}` +
      `${effectiveOpacity < 1 ? ` at effective opacity ${effectiveOpacity.toFixed(2)}` : ''}` +
      ` on ${background}), below the ${minimumRatio}:1 minimum`
  );
}

function toCssWithAlpha(color: IRgb): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
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
  await assertVisible(page, selector);
  const point = await probePoint(page, selector);
  const result = await page.evaluate(
    ([sel, x, y]) => {
      const el = document.querySelector(sel);
      if (!el) {
        return { ok: false, reason: 'not found' };
      }
      const top = document.elementFromPoint(x, y);
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
    },
    [selector, point.x, point.y] as const
  );
  assert.ok(result.ok, `${selector} is not the topmost element at its centre: ${result.reason}`);
}

/**
 * Of two overlapping layers, the first paints above the second.
 *
 * `assertNotCovered` asks whether an element is topmost overall, which is the
 * wrong question when a third layer is legitimately above both — the merge
 * window's text glyphs sit above both the selection and the fills, by design.
 * This compares just the two named layers, reading the real hit-test stack.
 */
export async function assertPaintsAbove(
  page: Page,
  aboveSelector: string,
  belowSelector: string
): Promise<void> {
  await assertVisible(page, aboveSelector);
  await assertVisible(page, belowSelector);
  const point = await probePoint(page, aboveSelector);
  const result = await page.evaluate(
    ([above, below, x, y]) => {
      const top = document.querySelector(above);
      const bottom = document.querySelector(below);
      if (!top || !bottom) {
        return { ok: false, detail: 'missing' };
      }
      const stack = document.elementsFromPoint(x, y);
      const topIndex = stack.indexOf(top);
      const bottomIndex = stack.indexOf(bottom);
      if (topIndex === -1 || bottomIndex === -1) {
        return { ok: false, detail: 'the two layers do not overlap at that point' };
      }
      // elementsFromPoint is ordered front to back.
      return {
        ok: topIndex < bottomIndex,
        detail: stack
          .slice(0, 6)
          .map((el) => `${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''}`)
          .join(' over '),
      };
    },
    [aboveSelector, belowSelector, point.x, point.y] as const
  );
  assert.ok(
    result.ok,
    `expected '${aboveSelector}' to paint above '${belowSelector}', but the stack front-to-back is: ${result.detail}`
  );
}

/** Two elements do not intersect, for text-overlapping-text defects. */
export async function assertNotOverlapping(
  page: Page,
  firstSelector: string,
  secondSelector: string
): Promise<void> {
  await assertVisible(page, firstSelector);
  await assertVisible(page, secondSelector);
  const overlap = await page.evaluate(
    ([a, b]) => {
      const first = document.querySelector(a);
      const second = document.querySelector(b);
      if (!first || !second) {
        return false;
      }
      const x = first.getBoundingClientRect();
      const y = second.getBoundingClientRect();
      return !(x.right <= y.left || y.right <= x.left || x.bottom <= y.top || y.bottom <= x.top);
    },
    [firstSelector, secondSelector] as const
  );
  assert.ok(!overlap, `'${firstSelector}' overlaps '${secondSelector}'`);
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
