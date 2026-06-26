/**
 * Per-branch graph coloring — "color follows the branch, not the lane".
 *
 * IntelliJ `GraphColorManagerImpl` / `GraphColorGetterByHead`: a commit's color
 * comes from the branch it belongs to (the head its first-parent chain leads up
 * to), not from its lane/column index. This module is the pure core:
 *
 *   - {@link GRAPH_BRANCH_COLORS} — a bright, VS-Code-toned fixed hex palette (hex
 *     so it works directly in SVG `stroke=`/`fill=` presentation attributes).
 *   - {@link computeBranchColors} — assigns each branch a palette color by
 *     display order (cycling, so adjacent branches differ), then owns each commit
 *     via a first-writer-wins walk down first parents, processing tips in
 *     priority order:
 *       • By IntelliJ layout TIER ({@link layoutPriority}, a port of
 *         `GitBranchLayoutComparator`): remote trunk → remote branch → local
 *         trunk → local branch. The more important branch is processed first, so
 *         it claims the shared subgraph below a divergence and the mainline stays
 *         a SINGLE color — a feature merged into main never recolors the trunk
 *         below its fork, and a published (remote) branch owns a shared line over
 *         a local one.
 *       • Within a tier, the NEWEST/topmost tip first (smallest row): the topmost
 *         tip walks its entire first-parent chain and claims every commit down to
 *         the first one a higher-priority branch already owns. A Y fork's arms
 *         each keep their own color over the shared base; a fully OVERLAPPING line
 *         (several same-tier tips stacked on one chain, no divergence) collapses
 *         to ONE color — the topmost tip owns the whole line, exactly as
 *         IntelliJ's `getOneOfHeadNodeIndex` collapses a linear graph to a single
 *         head when the topmost tip is processed first
 *         (`GraphLayoutBuilderHeadOrderTest.linearGraph`: order(0,2) → all head 0).
 *
 * Pure (no DOM, no I/O, deterministic) so it is directly unit/property-testable.
 * The rendering integration (threading the color through the print model + the
 * SVG painter, and the chips) lives elsewhere.
 */

import { buildGraphLayout, linearGraphFromDownAdjacency } from './graphLayout';

/**
 * Bright, vivid branch palette (fixed hex — usable directly in SVG
 * `stroke=`/`fill=` presentation attributes, where `var()` does not resolve).
 * 8 saturated hues tuned to match the vibrancy of VS Code's default theme
 * (the earlier earthy/natural set read as dull against it). Ordered so adjacent
 * palette indices stay distinguishable; branches reuse colors past that. Each
 * hue is a mid-tone — light enough to pop on the dark default theme, dark
 * enough to keep contrast on a light theme.
 */
export const GRAPH_BRANCH_COLORS: readonly string[] = [
  '#3fb950', // green
  '#4c9df5', // blue
  '#e8843a', // orange
  '#b771e0', // purple
  '#c79324', // amber
  '#1fa8a3', // teal
  '#6e7681', // slate
  '#ec5f78', // pink
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
 * Layout priority of a branch ref — a faithful port of IntelliJ
 * `GitRefManager.GitBranchLayoutComparator`, which orders heads by "importance"
 * so the more important branch is laid out further left AND its color is reused
 * by the shared subgraph below a divergence. IntelliJ's tier order is:
 *
 *   ORIGIN_MASTER → REMOTE_BRANCH → MASTER → LOCAL_BRANCH → TAG → CURRENT → …
 *
 * i.e. published history (remotes) outranks local, and `origin/master|main`
 * outranks every other remote. We mirror the branch tiers that apply to the
 * refs we color (local/remote branches):
 *
 *   0  remote trunk   — `origin/master`, `origin/main` (any remote prefix)
 *   1  remote branch  — every other `<remote>/<name>`
 *   2  local trunk    — local `master` / `main`
 *   3  local branch   — every other local branch
 *
 * Lower number = higher priority = processed first in the ownership walk.
 *
 * Deliberate deviation from IntelliJ: we do NOT demote the checked-out branch
 * to the low CURRENT_BRANCH tier. IntelliJ relies on `origin/master` to anchor
 * the mainline when you are on `master`; a local-only repo has no such anchor,
 * and demoting `master` there would let a sibling local branch steal the
 * trunk's color (regressing the "trunk owns its whole spine" invariant). Keeping
 * trunk strong regardless of checkout matches the existing locked behavior.
 */
function layoutPriority(ref: IColorRef): number {
  if (ref.type === 'remote') {
    return isTrunkName(remoteTail(ref.name)) ? 0 : 1;
  }
  return isTrunkName(ref.name) ? 2 : 3;
}

/** `master`/`main` (the trunk branch names IntelliJ special-cases). */
function isTrunkName(name: string): boolean {
  return name === 'master' || name === 'main';
}

/** Strip a single remote prefix: `origin/main` → `main`, `upstream/x` → `x`. */
function remoteTail(name: string): string {
  const slash = name.indexOf('/');
  return slash >= 0 ? name.slice(slash + 1) : name;
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
 * Ownership is delegated to the ported IntelliJ engine ({@link buildGraphLayout},
 * `GraphLayout.getOneOfHeadNodeIndex`) so "which head owns this commit" is
 * answered by the SAME code IntelliJ's own layout tests exercise, rather than a
 * separately-maintained walk. We feed it a FIRST-PARENT-ONLY graph (each node's
 * single down-edge is its `parents[0]`) so ownership follows the mainline spine —
 * a merged side branch never recolors the trunk below its fork. The heads are
 * the ref-bearing tips, ordered by the same `(layout tier, row, name)` priority
 * the coloring has always used:
 *
 *   1. IntelliJ layout TIER ({@link layoutPriority}): remote trunk → remote
 *      branch → local trunk → local branch. The more important branch is
 *      processed first and owns the shared subgraph below a divergence, so the
 *      mainline stays ONE color and a published branch outranks a local one.
 *   2. Within a tier, the NEWEST/topmost tip first (smallest row): the topmost
 *      tip owns its whole first-parent chain down to the first commit a
 *      higher-priority branch already claimed. A Y fork's newer arm keeps its own
 *      color over the shared base; a fully OVERLAPPING line collapses to ONE
 *      color (the engine gives a linear graph a single head when the topmost tip
 *      sorts first — `GraphLayoutBuilderHeadOrderTest.linearGraph`).
 *   3. Name, as a final stable tiebreak.
 *
 * @param nodes display-ordered commit nodes (newest first; index = row).
 */
export function computeBranchColors(
  nodes: readonly IColorNode[],
  options: IBranchColorOptions = {}
): Map<string, string> {
  const { headBranchName } = options;
  const indexOf = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    indexOf.set(nodes[i].hash, i);
  }

  // Branch tips (ref-bearing commits) and their representative ref. The tip's
  // node index seeds a layout head; `priority`/`refName` order those heads.
  interface ITip {
    index: number;
    refName: string;
    priority: number;
  }
  const tips: ITip[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const ref = pickRef(nodes[i].refs, headBranchName);
    if (!ref) {
      continue;
    }
    tips.push({ index: i, refName: ref.name, priority: layoutPriority(ref) });
  }

  // Assign each tip a palette color by DISPLAY order (newest tip first = smallest
  // index), cycling the palette so consecutive branches down the view get
  // distinct, rotating colors — never `color1 → color2 → color1` for three
  // adjacent branches (which reads as if the 1st and 3rd are related).
  const tipColor = new Map<number, string>();
  [...tips]
    .sort((a, b) => a.index - b.index)
    .forEach((tip, n) => {
      tipColor.set(tip.index, GRAPH_BRANCH_COLORS[n % GRAPH_BRANCH_COLORS.length]);
    });

  // Build the FIRST-PARENT-ONLY linear graph: each node's lone down-edge is its
  // first parent, if in-window. Full-DAG edges would let a merged side branch
  // change the trunk's ownership; first-parent-only keeps it on the spine.
  const downAdjacency: number[][] = nodes.map((node) => {
    const firstParent = node.parents.length > 0 ? indexOf.get(node.parents[0]) : undefined;
    return firstParent === undefined ? [] : [firstParent];
  });
  const graph = linearGraphFromDownAdjacency(downAdjacency);

  // Order heads by the coloring priority above. `buildGraphLayout` processes
  // heads in this comparator order, so the more important / topmost tip claims a
  // shared chain first — exactly the old first-writer-wins walk.
  const priorityOf = new Map<number, ITip>();
  for (const tip of tips) {
    priorityOf.set(tip.index, tip);
  }
  const comparator = (a: number, b: number): number => {
    const ta = priorityOf.get(a);
    const tb = priorityOf.get(b);
    // Ref-less graph heads (no tip) sort after every ref tip and amongst
    // themselves by index, a stable order; they own only commits no branch
    // reaches, which stay uncolored.
    if (!ta || !tb) {
      if (ta) {
        return -1;
      }
      if (tb) {
        return 1;
      }
      return a - b;
    }
    if (ta.priority !== tb.priority) {
      return ta.priority - tb.priority;
    }
    if (a !== b) {
      return a - b;
    }
    return ta.refName.localeCompare(tb.refName);
  };

  const layout = buildGraphLayout(
    graph,
    tips.map((t) => t.index),
    comparator
  );

  // A commit's owner is the head its layout fragment belongs to; color it by
  // that head's palette color. An owner with no ref (a ref-less graph head)
  // means no branch reaches the commit — leave it uncolored (lane fallback).
  const colorByHash = new Map<string, string>();
  for (let i = 0; i < nodes.length; i++) {
    const owner = layout.getOneOfHeadNodeIndex(i);
    const color = tipColor.get(owner);
    if (color !== undefined) {
      colorByHash.set(nodes[i].hash, color);
    }
  }

  return colorByHash;
}
