/**
 * Blame AUTHOR color-mode helper.
 *
 * IntelliJ's annotation gutter offers two background color modes (see
 * `com.intellij.openapi.vcs.actions.ColorMode`): ORDER (commit-age heat, in
 * `heatColor.ts`) and AUTHOR. In AUTHOR mode every blame line is tinted by a
 * stable per-author color so you can see at a glance which lines belong to the
 * same person, independent of commit age.
 *
 * This module mirrors IntelliJ's AUTHOR assignment exactly:
 *   - A fixed background palette is built from the default annotation anchor
 *     colors and the same linear-interpolation + shuffle that IntelliJ uses
 *     (AnnotationsSettings.getOrderedColors → getAuthorsColors).
 *   - The distinct authors of the file are sorted, and the author at sorted
 *     index `i` is assigned `palette[i % palette.length]`
 *     (AnnotateToggleAction.computeBgColors, AUTHOR branch).
 *
 * The mapping is therefore deterministic and file-scoped: the same set of
 * authors always yields the same author→color assignment, with no per-session
 * randomness. Like `heatColor.ts`, this is a pure-function boundary (no VS Code
 * APIs, no side effects) so it can be unit-tested without the extension host.
 *
 * IntelliJ reference:
 *   platform/vcs-impl AnnotateToggleAction.computeBgColors (AUTHOR branch:
 *     sorted distinct authors → palette[index % size])
 *   platform/vcs-impl AnnotationsSettings.getAuthorsColors / getOrderedColors
 *     (anchor palette + linear interpolation + SHUFFLE_STEP reordering)
 *   platform/analysis-impl ColorGenerator.generateLinearColorSequence (RGB lerp)
 *   platform/vcs-impl/.../ColorMode.java (AUTHOR / ORDER / NONE enum)
 */

/**
 * Default annotation anchor colors (IntelliJ's light scheme
 * `VCS_ANNOTATIONS_COLOR_1..5` from DefaultColorSchemesManager.xml). The
 * AUTHOR palette is generated from these the same way IntelliJ does.
 */
const ANCHOR_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [0xea, 0xff, 0xe2],
  [0xd1, 0xd1, 0xd1],
  [0xd9, 0xe4, 0xf9],
  [0xff, 0xfb, 0xcf],
  [0xff, 0xbf, 0xc3],
];

/** Colors interpolated between each adjacent anchor pair (IntelliJ constant). */
const COLORS_BETWEEN_ANCHORS = 4;

/** Stride IntelliJ uses to spread visually-similar palette entries apart. */
const SHUFFLE_STEP = 4;

/**
 * Background alpha for AUTHOR tints. Matches the gutter's hot-end alpha
 * ({@link import('./heatColor').ALPHA_HOT}) so AUTHOR and ORDER backgrounds
 * carry comparable visual weight.
 */
export const AUTHOR_BG_ALPHA = 0.85;

type Rgb = readonly [number, number, number];

/** Java `(int)(v1 + (v2 - v1) * ratio)` clamped to a byte — truncates toward zero. */
function lerpChannel(a: number, b: number, ratio: number): number {
  const value = Math.trunc(a + (b - a) * ratio);
  return Math.min(255, Math.max(0, value));
}

/**
 * Linear color sequence between anchors, mirroring
 * `ColorGenerator.generateLinearColorSequence`: the first anchor, then
 * `COLORS_BETWEEN_ANCHORS` interpolated colors per segment, then each
 * subsequent anchor (first element of every segment dropped to avoid dupes).
 */
function generateLinearColorSequence(anchors: ReadonlyArray<Rgb>): Rgb[] {
  if (anchors.length === 1) {
    return [anchors[0]];
  }
  const result: Rgb[] = [anchors[0]];
  for (let i = 0; i < anchors.length - 1; i++) {
    const c1 = anchors[i];
    const c2 = anchors[i + 1];
    for (let k = 1; k <= COLORS_BETWEEN_ANCHORS; k++) {
      const ratio = k / (COLORS_BETWEEN_ANCHORS + 1);
      result.push([
        lerpChannel(c1[0], c2[0], ratio),
        lerpChannel(c1[1], c2[1], ratio),
        lerpChannel(c1[2], c2[2], ratio),
      ]);
    }
    result.push(c2);
  }
  return result;
}

/**
 * Reorder the ordered palette by {@link SHUFFLE_STEP}, mirroring
 * `AnnotationsSettings.getAuthorsColors`, so adjacent authors get
 * visually-distinct colors instead of neighboring interpolation steps.
 */
function shuffleForAuthors(colors: ReadonlyArray<Rgb>): Rgb[] {
  const result: Rgb[] = [];
  for (let i = 0; i < SHUFFLE_STEP; i++) {
    for (let k = 0; k <= Math.floor(colors.length / SHUFFLE_STEP); k++) {
      const index = k * SHUFFLE_STEP + i;
      if (index < colors.length) {
        result.push(colors[index]);
      }
    }
  }
  return result;
}

// Built once at module load — the palette is a pure function of the constants.
const AUTHOR_PALETTE_RGB: ReadonlyArray<Rgb> = shuffleForAuthors(
  generateLinearColorSequence(ANCHOR_COLORS)
);

const AUTHOR_PALETTE_RGBA: ReadonlyArray<string> = AUTHOR_PALETTE_RGB.map(
  ([r, g, b]) => `rgba(${r}, ${g}, ${b}, ${AUTHOR_BG_ALPHA})`
);

/**
 * The AUTHOR background palette as CSS `rgba()` strings, in assignment order.
 * Deterministic across calls. Exposed for unit testing and introspection.
 */
export function authorColorPalette(): ReadonlyArray<string> {
  return AUTHOR_PALETTE_RGBA;
}

/** Distinct, alphabetically-sorted authors — the sort IntelliJ applies. */
function sortedDistinct(authors: Iterable<string>): string[] {
  // Author names, not refs; code-unit order matches IntelliJ's own
  // String.compareTo sort, which decides the deterministic color-assignment
  // index — a locale-aware sort would reorder the palette.
  // ref-sort-exempt: see above
  return Array.from(new Set(authors)).sort();
}

/**
 * Build the author→color map for a file, mirroring IntelliJ's AUTHOR branch:
 * the distinct authors are sorted and the author at sorted index `i` is
 * assigned `palette[i % palette.length]`.
 *
 * @param authors - All author identities appearing in the file (duplicates ok).
 * @returns A map from author identity to its CSS `rgba()` background color.
 */
export function buildAuthorColorMap(authors: Iterable<string>): Map<string, string> {
  const map = new Map<string, string>();
  const distinct = sortedDistinct(authors);
  for (let i = 0; i < distinct.length; i++) {
    map.set(distinct[i], AUTHOR_PALETTE_RGBA[i % AUTHOR_PALETTE_RGBA.length]);
  }
  return map;
}

/**
 * Resolve a single author's AUTHOR-mode color within the file's author set.
 *
 * The author is folded into the set if not already present, so the result is
 * deterministic even when callers pass an inconsistent set.
 *
 * @param author - The author identity to color.
 * @param authors - All author identities appearing in the file.
 * @returns The CSS `rgba()` background color for `author`.
 */
export function computeAuthorColor(author: string, authors: Iterable<string>): string {
  const distinct = sortedDistinct([...authors, author]);
  const index = distinct.indexOf(author);
  return AUTHOR_PALETTE_RGBA[index % AUTHOR_PALETTE_RGBA.length];
}
