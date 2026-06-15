/**
 * Blame gutter background heat-color helper.
 *
 * Matches IntelliJ's annotation background gradient semantics:
 *   - The background color is interpolated linearly across the range of commit
 *     ages visible in the file (oldest ↔ newest).
 *   - Newer commits receive a warmer / more opaque background.
 *   - Older commits receive a cooler / more transparent background.
 *
 * This module is a pure-function boundary — no VS Code APIs, no side effects —
 * so it can be unit-tested deterministically without the extension host.
 *
 * IntelliJ reference: platform/vcs-impl
 *   AnnotationsSettings.getOrderedColors (anchor-palette + linear interpolation)
 *   AnnotateToggleAction.computeBgColors (maps revision order index → palette)
 *   ColorGenerator.generateLinearColorSequence (RGB lerp between anchors)
 *   AnnotationFieldGutter.getBgColor (ORDER mode picks from the computed map)
 *
 * We use an RGB base color (a warm amber) interpolated toward a cool gray for
 * the cold end, modulated by alpha (opacity). The alpha approach ensures the
 * gradient works on any editor background theme without requiring anchor
 * colors from the VS Code token scheme.
 */

/** Warm end base color components (amber — matches IntelliJ's "recent" warm tone). */
const HOT_R = 210;
const HOT_G = 170;
const HOT_B = 100;

/** Cold end base color components (neutral blue-gray — IntelliJ's "ancient" cold tone). */
const COLD_R = 120;
const COLD_G = 140;
const COLD_B = 180;

/** Alpha at the hot (newest) end. IntelliJ renders recent commits with a visible bg. */
export const ALPHA_HOT = 0.85;

/** Alpha at the cold (oldest) end. IntelliJ renders very old commits with a faint bg. */
export const ALPHA_COLD = 0.15;

/**
 * Compute the background heat color for a blamed line.
 *
 * Interpolates linearly between the cold-end color (oldest commit in the file)
 * and the hot-end color (newest commit in the file) based on the commit's
 * relative position in that range.
 *
 * @param commitMs - The blamed commit's timestamp in milliseconds.
 * @param oldestMs - The oldest commit timestamp in the file (milliseconds).
 * @param newestMs - The newest commit timestamp in the file (milliseconds).
 * @returns A CSS `rgba(r, g, b, a)` string.
 */
export function computeHeatColor(commitMs: number, oldestMs: number, newestMs: number): string {
  // When all commits share the same timestamp (single-commit file or
  // collapsed range), map to the hot end so new-looking files render warm.
  const span = newestMs - oldestMs;
  const ratio = span > 0 ? (commitMs - oldestMs) / span : 1.0;

  // Clamp ratio to [0, 1] — guards against clock skew or data anomalies.
  const t = Math.min(1, Math.max(0, ratio));

  // Linear interpolation from COLD to HOT
  const r = Math.round(COLD_R + (HOT_R - COLD_R) * t);
  const g = Math.round(COLD_G + (HOT_G - COLD_G) * t);
  const b = Math.round(COLD_B + (HOT_B - COLD_B) * t);
  const a = heatAlphaForAge(t);

  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Map a normalized recency ratio (0 = oldest, 1 = newest) to an opacity
 * value. Exposed for unit testing.
 *
 * The alpha is linearly interpolated between {@link ALPHA_COLD} and
 * {@link ALPHA_HOT} so that tests can pin the monotonic gradient contract.
 *
 * @param ratio - A value in [0, 1] where 1 means newest.
 * @returns Alpha opacity in [ALPHA_COLD, ALPHA_HOT].
 */
export function heatAlphaForAge(ratio: number): number {
  const t = Math.min(1, Math.max(0, ratio));
  // Round to 2 decimal places to keep the rgba() string compact.
  return Math.round((ALPHA_COLD + (ALPHA_HOT - ALPHA_COLD) * t) * 100) / 100;
}

/**
 * Parse a `rgba(r, g, b, a)` string produced by {@link computeHeatColor}.
 * Used exclusively in unit tests to inspect individual channels.
 *
 * @param rgba - A CSS `rgba()` string.
 * @returns Parsed `{r, g, b, a}` components.
 * @throws If the string does not match the expected format.
 */
export function parseHeatRgba(rgba: string): { r: number; g: number; b: number; a: number } {
  const m = rgba.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  if (!m) {
    throw new Error(`parseHeatRgba: unexpected format: ${rgba}`);
  }
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number(m[4]) };
}
