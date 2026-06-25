/**
 * Per-branch graph coloring — "color follows the branch, not the lane".
 *
 * IntelliJ `GraphColorManagerImpl` / `GraphColorGetterByHead`: a commit's color
 * comes from the branch it belongs to (the head its first-parent chain leads up
 * to), not from its lane/column index. This module is the pure core:
 *
 *   - {@link GRAPH_BRANCH_COLORS} — a clean, earthy/natural fixed hex palette (hex
 *     so it works directly in SVG `stroke=`/`fill=` presentation attributes).
 *   - {@link computeBranchColors} — assigns each branch a palette color by
 *     display order (cycling, so adjacent branches differ), then owns each commit
 *     via a first-writer-wins walk down first parents, processing tips in
 *     priority order:
 *       • Trunk (`main`/`master`, incl. `origin/*`) FIRST — it claims its whole
 *         first-parent spine, so the shared mainline stays a SINGLE color and a
 *         feature merged into main never recolors a segment of the trunk below
 *         its fork. New colors appear only at each branch's divergence point.
 *       • Among non-trunk branches, the lowest/oldest tip first: a Y fork's
 *         arms each keep their own color over the shared base; on a full overlap
 *         the line splits at the shorter branch's tip.
 *
 * Pure (no DOM, no I/O, deterministic) so it is directly unit/property-testable.
 * The rendering integration (threading the color through the print model + the
 * SVG painter, and the chips) lives elsewhere.
 */

/**
 * Clean, earthy/natural branch palette (fixed hex — usable directly in SVG
 * `stroke=`/`fill=` presentation attributes, where `var()` does not resolve).
 * 8 nature-toned hues, ordered so adjacent palette indices stay distinguishable;
 * branches reuse colors past that.
 */
export const GRAPH_BRANCH_COLORS: readonly string[] = [
  '#2f8f4e', // forest
  '#2f7fb0', // ocean
  '#c0653f', // terracotta
  '#8a4f86', // plum
  '#7a8c3a', // moss
  '#7d7468', // stone
  '#4aa0c8', // sky
  '#9c4a5a', // wine
];

/** A branch ref tip (name + kind), as carried on a commit node. */
export interface IColorRef {
  name: string;
  type: 'local' | 'remote';
}

/** Minimal commit shape for color ownership — decoupled from ICommitNode. */
export interface IColorNode {
  /** Full commit hash. */
  hash: string;
  /** Parent hashes; `parents[0]` is the first parent (the mainline). */
  parents: readonly string[];
  /** Branch refs pointing AT this commit (i.e. this commit is their tip). */
  refs: readonly IColorRef[];
}

/** Options controlling ownership priority. */
export interface IBranchColorOptions {
  /** Name of the currently checked-out branch, if known (a same-row tiebreak). */
  headBranchName?: string;
}

/**
 * Trunk refs — `master`/`main` and their `origin/` (or any single remote
 * prefix) variants. IntelliJ `GitBranchLayoutComparator` ranks these highest
 * for graph layout, ABOVE the checked-out branch and regardless of tip age, so
 * the shared mainline is laid on one backbone. We mirror that for ownership:
 * the trunk claims its whole first-parent spine first, so the mainline stays a
 * single color and feature colors begin only at each divergence point.
 */
function isTrunkRef(refName: string): boolean {
  if (refName === 'main' || refName === 'master') {
    return true;
  }
  const slash = refName.indexOf('/');
  const tail = slash >= 0 ? refName.slice(slash + 1) : refName;
  return tail === 'main' || tail === 'master';
}

/** Pick the representative ref for a tip commit (drives that chain's color). */
function pickRef(refs: readonly IColorRef[], headBranchName?: string): IColorRef | undefined {
  if (refs.length === 0) {
    return undefined;
  }
  // Priority: current branch → local → remote → name (stable).
  return [...refs].sort((a, b) => {
    const aCur = a.name === headBranchName ? 0 : 1;
    const bCur = b.name === headBranchName ? 0 : 1;
    if (aCur !== bCur) {
      return aCur - bCur;
    }
    const aLocal = a.type === 'local' ? 0 : 1;
    const bLocal = b.type === 'local' ? 0 : 1;
    if (aLocal !== bLocal) {
      return aLocal - bLocal;
    }
    return a.name.localeCompare(b.name);
  })[0];
}

/**
 * Compute the owning-branch color for each commit.
 *
 * Returns a `hash → color` map for commits that a branch reaches via first
 * parent. Commits absent from the map have no owning branch (detached / not on
 * any branch's first-parent chain) — the caller falls back to a lane color.
 *
 * @param nodes display-ordered commit nodes (newest first; index = row).
 */
export function computeBranchColors(
  nodes: readonly IColorNode[],
  options: IBranchColorOptions = {}
): Map<string, string> {
  const { headBranchName } = options;
  const rowOf = new Map<string, number>();
  const nodeOf = new Map<string, IColorNode>();
  for (let i = 0; i < nodes.length; i++) {
    rowOf.set(nodes[i].hash, i);
    nodeOf.set(nodes[i].hash, nodes[i]);
  }

  // Collect branch tips (commits that have refs).
  interface ITip {
    hash: string;
    row: number;
    refName: string;
  }
  const tips: ITip[] = [];
  for (const node of nodes) {
    const ref = pickRef(node.refs, headBranchName);
    if (!ref) {
      continue;
    }
    tips.push({ hash: node.hash, row: rowOf.get(node.hash)!, refName: ref.name });
  }

  // Assign each tip a palette color by DISPLAY order (newest tip first), cycling
  // the palette so consecutive branches down the view get distinct, rotating
  // colors — never `color1 → color2 → color1` for three adjacent branches (which
  // reads as if the 1st and 3rd are related). Stable for a given window.
  const tipColor = new Map<string, string>();
  [...tips]
    .sort((a, b) => a.row - b.row)
    .forEach((tip, index) => {
      tipColor.set(tip.hash, GRAPH_BRANCH_COLORS[index % GRAPH_BRANCH_COLORS.length]);
    });

  // Ownership priority — first-writer-wins, processed in this order:
  //   1. Trunk (`main`/`master`) FIRST, so it claims its entire first-parent
  //      spine and the shared mainline stays ONE color — a feature merged into
  //      main no longer recolors a segment of the trunk below its fork. New
  //      colors appear only at each branch's divergence point. (IntelliJ
  //      GitBranchLayoutComparator ranks master/main above checkout and age.)
  //   2. Among non-trunk branches, the lowest/oldest tip first (largest row):
  //      a shorter branch claims the shared base before a longer branch overruns
  //      it (scenario 2); a Y fork's newer arm keeps its own color (scenario 1).
  tips.sort((a, b) => {
    const aTrunk = isTrunkRef(a.refName) ? 0 : 1;
    const bTrunk = isTrunkRef(b.refName) ? 0 : 1;
    if (aTrunk !== bTrunk) {
      return aTrunk - bTrunk;
    }
    if (a.row !== b.row) {
      return b.row - a.row;
    }
    return a.refName.localeCompare(b.refName);
  });

  const colorByHash = new Map<string, string>();
  for (const tip of tips) {
    const color = tipColor.get(tip.hash)!;
    // Walk down the first-parent chain, claiming until we hit a commit a
    // higher-priority (more-specific) branch already owns, or leave the window.
    let cursor: string | undefined = tip.hash;
    while (cursor !== undefined && !colorByHash.has(cursor)) {
      colorByHash.set(cursor, color);
      const node = nodeOf.get(cursor);
      cursor = node && node.parents.length > 0 ? node.parents[0] : undefined;
    }
  }

  return colorByHash;
}
