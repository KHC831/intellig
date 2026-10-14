// layoutPriority is ported from intellij-community plugins/git4idea/backend/src/log/GitRefManager.kt
// (GitBranchLayoutComparator). Copyright 2000-2023 JetBrains s.r.o. and contributors. Apache 2.0 license.

/**
 * Per-branch graph coloring — "color follows the branch, not the lane".
 *
 * IntelliJ `GraphColorManagerImpl` / `GraphColorGetterByHead`: a commit's color
 * comes from the branch it belongs to (the head its first-parent chain leads up
 * to), not from its lane/column index. This module is the pure core:
 *
 *   - {@link GRAPH_BRANCH_COLORS} — a 6-hue colorblind-safe fixed hex palette
 *     (hex so it works directly in SVG `stroke=`/`fill=` presentation attributes).
 *   - {@link computeBranchColors} — assigns each branch a palette color from a
 *     STABLE hash of its name ({@link branchColorFor}), so a branch keeps its
 *     colour regardless of its position in the graph (editing a branch/commit
 *     can't recolor the others). It then owns each commit via a first-writer-wins
 *     walk down first parents, processing tips in priority order:
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
 * Branch palette (fixed hex — usable directly in SVG `stroke=`/`fill=`
 * presentation attributes, where `var()` does not resolve). A 10-hue set rooted
 * in Paul Tol's "bright"/"muted" qualitative schemes, minus pure red (the main
 * red-green confusion hue) and grey. The hues are spread around the wheel and
 * mid-toned so each is distinguishable from the others — including under
 * deuteranopia / protanopia / tritanopia — and reads on both the dark and light
 * default themes. Blue leads because the trunk is pinned to slot 0 (see
 * {@link branchColorFor}); every other branch's slot is a stable hash of its
 * name, so colours are consistent across edits. With 10 slots two branches
 * collide far less often, but it's still possible — add more here.
 */
export const GRAPH_BRANCH_COLORS: readonly string[] = [
  '#3c6699', // blue (darkened from Tol's #4477aa for contrast against the cyan)
  '#ee7733', // orange
  '#66ccee', // cyan
  '#ccbb44', // yellow
  '#aa3377', // purple
  '#228833', // green
  '#44aa99', // teal
  '#6a5acd', // slate violet (indigo)
  '#dd77bb', // pink
  '#882255', // wine
];

/**
 * Stable palette index for a branch name: `java.lang.String.hashCode()` reduced
 * to the palette size (sign-corrected for JS's signed `%`). The same name always
 * maps to the same index, so a branch keeps its color regardless of where it
 * sits in the graph. Mirrors IntelliJ's color-by-ref-name-hash.
 */
function stableColorIndex(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  }
  const n = GRAPH_BRANCH_COLORS.length;
  return ((h % n) + n) % n;
}

/**
 * The fixed palette color a branch name maps to — name-stable and
 * position-independent (see {@link stableColorIndex}). Exposed so callers and
 * tests can resolve a branch's colour without re-deriving the hash.
 *
 * The trunk is PINNED to the blue slot rather than hashed: the mainline is the
 * spine users read the graph against, and blue is the conventional calm mainline
 * hue (IntelliJ, GitKraken, Fork all lead with blue/purple there — a hashed
 * `main` landed on orange). Pinning keeps the local trunk and its `<remote>/`
 * form the same color. Blue is not reserved: a non-trunk branch can still hash
 * to it, the same accepted collision class as any two branches sharing a slot.
 *
 * `trunkBranchNames` is the repo's actual default branch(es) — e.g. the
 * `origin/HEAD` target — as SHORT names; when supplied it defines the trunk, so
 * a repo that follows `develop` (or any non-standard default) colors that branch
 * (and `origin/develop`) as the mainline. When omitted or empty, the trunk falls
 * back to the conventional `main`/`master`/`mainline`.
 */
export function branchColorFor(
  name: string,
  type?: 'local' | 'remote',
  trunkBranchNames?: readonly string[]
): string {
  const trunk = resolveTrunkNames(trunkBranchNames);
  // The remote-tail strip applies only to remote refs: a LOCAL branch whose
  // last segment happens to be a trunk name (`dev/main`) is just a branch.
  // An unknown type keeps the tail heuristic (name-only callers/tests).
  if (isTrunkName(name, trunk) || (type !== 'local' && isTrunkName(remoteTail(name), trunk))) {
    return GRAPH_BRANCH_COLORS[0];
  }
  return GRAPH_BRANCH_COLORS[stableColorIndex(name)];
}

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
  /**
   * The repo's default branch(es) as SHORT names (e.g. the `origin/HEAD`
   * target). Defines the trunk — the branch pinned to blue and given the
   * mainline-owning layout tier. Empty/omitted falls back to `main`/`master`.
   * In a merged multi-root view this is the union of the in-scope repos'
   * defaults.
   */
  trunkBranchNames?: readonly string[];
}

/**
 * The conventional trunk names used when a repo default isn't supplied. Covers
 * `master`/`main` plus `mainline`, so a repo that names its trunk `mainline`
 * gets the consistent blue trunk color for BOTH `mainline` and its remote form
 * (`<remote>/mainline`) without relying on `origin/HEAD` being set.
 */
const DEFAULT_TRUNK_NAMES: readonly string[] = ['master', 'main', 'mainline'];

/**
 * The effective trunk name set: the supplied repo default(s) when non-empty,
 * otherwise the conventional `master`/`main`/`mainline` fallback.
 */
function resolveTrunkNames(trunkBranchNames?: readonly string[]): ReadonlySet<string> {
  return new Set(
    trunkBranchNames && trunkBranchNames.length > 0 ? trunkBranchNames : DEFAULT_TRUNK_NAMES
  );
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
function layoutPriority(ref: IColorRef, trunk: ReadonlySet<string>): number {
  if (ref.type === 'remote') {
    return isTrunkName(remoteTail(ref.name), trunk) ? 0 : 1;
  }
  return isTrunkName(ref.name, trunk) ? 2 : 3;
}

/** Whether `name` is one of the effective trunk branch names. */
function isTrunkName(name: string, trunk: ReadonlySet<string>): boolean {
  return trunk.has(name);
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
  const trunk = resolveTrunkNames(options.trunkBranchNames);
  const indexOf = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    indexOf.set(nodes[i].hash, i);
  }

  // Branch tips (ref-bearing commits) and their representative ref. The tip's
  // node index seeds a layout head; `priority`/`refName` order those heads.
  interface ITip {
    index: number;
    refName: string;
    refType: 'local' | 'remote';
    priority: number;
  }
  const tips: ITip[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const ref = pickRef(nodes[i].refs, headBranchName);
    if (!ref) {
      continue;
    }
    // Ownership priority is the BEST (most important) tier over ALL of the tip's
    // refs — a trunk carrying both `main` and `origin/main` ranks as remote trunk
    // (tier 0), so a sibling remote feature can't outrank it and steal the spine.
    // `pickRef` still chooses only the display name / palette representative.
    const priority = Math.min(...nodes[i].refs.map((r) => layoutPriority(r, trunk)));
    tips.push({ index: i, refName: ref.name, refType: ref.type, priority });
  }

  // Assign each tip a palette color from a STABLE hash of its branch name, so a
  // branch's color depends only on its name — never on its position in the graph.
  // Adding or removing a branch/commit (which shifts row positions) therefore
  // can't recolor an existing branch: the rendering stays stable across edits.
  // Mirrors IntelliJ GraphColorManagerImpl (color by ref-name hash). Trade-off vs
  // the old positional rotation: two branches can hash to the same palette slot,
  // so adjacent branches are no longer guaranteed to differ.
  const tipColor = new Map<number, string>();
  for (const tip of tips) {
    tipColor.set(tip.index, branchColorFor(tip.refName, tip.refType, options.trunkBranchNames));
  }

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
