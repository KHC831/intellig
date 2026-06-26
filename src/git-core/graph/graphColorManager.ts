/**
 * TEST-ONLY characterization fixture — NOT the production color source.
 *
 * Production graph colors come from the fixed palette in `branchColors.ts`
 * (`GRAPH_BRANCH_COLORS` + `computeBranchColors`), which assigns palette hexes by
 * branch display order. This module instead reproduces IntelliJ's INTERNAL
 * color-by-head MATH (`GraphColorManagerImpl.getColor` +
 * `GraphColorGetterByHead.getNodeColor`, platform/vcs-log) — a `java.lang.String`
 * hashCode of the ref name. We port it solely so `graphColorManager.test.ts` can
 * pin the layout engine's head-ownership against IntelliJ's exact integer values;
 * it has no production importer and MUST NOT be wired into one (doing so would
 * paint commits with raw Java hashCodes instead of the tuned palette).
 *
 * The color of a node is the color of the HEAD that owns its layout fragment:
 *   - on the head's own (main) fragment — `headFragmentIndex == fragmentIndex`
 *     — the color is derived from the head's first ref name
 *     (`firstRef.name.hashCode()`);
 *   - on any other fragment, the color IS the fragment (layout) index.
 *
 * `javaStringHashCode` reproduces `java.lang.String.hashCode()` so the
 * ref-name → color mapping matches byte-for-byte.
 */

import type { GraphLayout } from './graphLayout';

/** IntelliJ `GraphColorManagerImpl.DEFAULT_COLOR`. */
export const DEFAULT_COLOR = 0;

/**
 * `java.lang.String.hashCode()`: s[0]*31^(n-1) + s[1]*31^(n-2) + … + s[n-1],
 * computed with 32-bit integer overflow (Java `int` semantics).
 */
export function javaStringHashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Port of `GraphColorManagerImpl.getColor(headCommit, headFragmentIndex,
 * fragmentIndex)`.
 *
 * @param headRefName the first ref name of the head commit, or `undefined` when
 *                    the head carries no ref (→ {@link DEFAULT_COLOR}).
 */
export function getColor(
  headRefName: string | undefined,
  headFragmentIndex: number,
  fragmentIndex: number
): number {
  if (headFragmentIndex === fragmentIndex) {
    if (headRefName === undefined) {
      return DEFAULT_COLOR;
    }
    return javaStringHashCode(headRefName);
  }
  return fragmentIndex;
}

/**
 * Port of `GraphColorGetterByHead.getNodeColor(nodeId, layoutIndex)`.
 *
 * @param refNameForHead maps a head node index to its first ref name (drives the
 *                       branch color); returns `undefined` for a ref-less head.
 */
export function getNodeColor(
  layout: GraphLayout,
  refNameForHead: (headNodeIndex: number) => string | undefined,
  nodeId: number,
  layoutIndex: number
): number {
  const headNodeId = nodeId < 0 ? 0 : layout.getOneOfHeadNodeIndex(nodeId);
  const headLayoutIndex = layout.getLayoutIndex(headNodeId);
  return getColor(refNameForHead(headNodeId), headLayoutIndex, layoutIndex);
}
