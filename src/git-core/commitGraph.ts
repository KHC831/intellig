/**
 * Commit graph generation utilities.
 *
 * This module provides functionality to generate visual graph data from commit history,
 * showing branch and merge relationships. Each commit is assigned a column position
 * (lane) and lines connecting to parent commits.
 */

import { ICommit } from './interfaces/IGitService';

/**
 * Visual style of a graph line. Used by the renderer to differentiate
 * "real" edges (the parent commit is in the loaded window) from
 * off-window stubs (the parent fell off our `--max-count` slice).
 *
 * - `'solid'`: the default — a full edge to a parent that's rendered.
 * - `'dashed'`: a phantom stub — "history continues below the loaded
 *   window". IntelliJ uses a similar dashed-line affordance for refs
 *   whose target isn't visible, so the user can tell at a glance
 *   that the edge isn't going to a row they can scroll to.
 *
 * @invariant L9 — off-window parent edges MUST carry `style: 'dashed'`
 * and travel in the same lane as the source (`fromColumn === toColumn`).
 * See `docs/design/git-tool-window-spec.md` §8.L9.
 */
export type GraphLineStyle = 'solid' | 'dashed';

/**
 * Represents a line in the commit graph connecting commits.
 *
 * @invariant L4 — when `fromColumn === toColumn` (a same-lane edge), the
 * renderer MUST stroke the segment using `getColumnColor(fromColumn)` —
 * i.e. the *source* commit's lane color, never a destination color.
 * See `docs/design/git-tool-window-spec.md` §8.L4.
 *
 * @invariant L9 — when the parent commit is off-window, this line is
 * emitted with `fromColumn === toColumn` and `style: 'dashed'`; the
 * algorithm MUST NOT call `allocateLane()` for an off-window parent.
 * See `docs/design/git-tool-window-spec.md` §8.L9.
 */
export interface IGraphLine {
  /** Starting column (lane) of the line */
  fromColumn: number;
  /** Ending column (lane) of the line */
  toColumn: number;
  /** Color identifier for the line (used for visual distinction) */
  color: string;
  /** Type of line: commit (normal), merge (from merge commit), or branch (new branch) */
  type: 'commit' | 'merge' | 'branch';
  /**
   * Visual style. Optional for backwards-compat with consumers that
   * predate the field; when undefined, the renderer treats it as
   * `'solid'`. Set to `'dashed'` for off-window-parent stubs so the
   * "history continues below" affordance is visible.
   *
   * @invariant L9 — see interface-level note. `style: 'dashed'` is the
   * sole signal the renderer uses to draw a stub stroke; dropping it on
   * an off-window edge silently regresses to a phantom bezier.
   */
  style?: GraphLineStyle;
}

/**
 * A branch reference pointing at a commit, carrying the branch's name AND
 * its type. The `type` is sourced from `IBranch.type` (which `parseBranches`
 * derives from the `refs/heads/` vs `refs/remotes/` prefix), NOT guessed from
 * the name. This is the fix for Bug E: local branches with a `/` in their
 * name (`feature/foo`, `fix/bar`) must not be misclassified as remote.
 *
 * Only `'local'` and `'remote'` are carried here — tags travel through the
 * separate `tagMap` and never enter the branch map.
 */
export interface IBranchRef {
  /** The branch name (e.g. `feature/foo`, `origin/main`). */
  name: string;
  /** Whether this is a local (`refs/heads`) or remote (`refs/remotes`) branch. */
  type: 'local' | 'remote';
}

/**
 * Represents a commit with its graph visualization data.
 */
export interface ICommitNode {
  /** The underlying commit data */
  commit: ICommit;
  /** Column position (lane) where this commit is displayed */
  graphColumn: number;
  /** Lines connecting this commit to its parents */
  graphLines: IGraphLine[];
  /** Branch refs (name + type) pointing to this commit */
  branches: IBranchRef[];
  /** Tag names pointing to this commit */
  tags: string[];
  /**
   * True when this commit lies on the BFS path from the
   * currently-focused branch tip back to its merge-base with HEAD. The
   * renderer brightens on-path lines / commit circles and dims off-path
   * ones (full IntelliJ parity). When no branch is focused, every node has
   * `onFocusedBranchPath: false` and the renderer treats it as a no-op.
   */
  onFocusedBranchPath?: boolean;
}

/**
 * Color palette for graph lines.
 * Colors are assigned to lanes to visually distinguish different branches.
 */
const GRAPH_COLORS = [
  '#4CAF50', // Green
  '#2196F3', // Blue
  '#FF9800', // Orange
  '#9C27B0', // Purple
  '#F44336', // Red
  '#00BCD4', // Cyan
  '#FFEB3B', // Yellow
  '#E91E63', // Pink
  '#795548', // Brown
  '#607D8B', // Blue Grey
];

/**
 * Get a color for a given column index.
 *
 * @invariant L4 — load-bearing: any same-lane vertical stroke in the
 * SVG renderer MUST resolve its `stroke=` via this function, keyed by
 * the *source* commit's `graphColumn` — never by a destination lane,
 * even when a graph line bends. See
 * `docs/design/git-tool-window-spec.md` §8.L4.
 *
 * @param column - The column index
 * @returns A color string from the palette
 */
export function getColumnColor(column: number): string {
  return GRAPH_COLORS[column % GRAPH_COLORS.length];
}

/**
 * Internal state for tracking active lanes during graph generation.
 */
interface ILaneState {
  /** Map of commit hash to lane (column) index */
  commitToLane: Map<string, number>;
  /** Set of currently active lane indices */
  activeLanes: Set<number>;
  /** Next available lane index */
  nextLane: number;
  /**
   * Reverse index: lane → set of hashes currently CLAIMED on that lane and
   * not yet released. A lane is "alive" (off-limits to a new branch) while
   * its set is non-empty. A lane is RELEASED — returned to
   * `findNextAvailableLane`'s gap pool — the moment its set empties.
   *
   * The lifetime of a claim is "this commit's row UNTIL the row of the
   * parent its line lands on". Concretely: when commit X (row i) is emitted,
   * its first-parent line either
   *   (a) continues straight down X's lane (parent inherits the lane) — the
   *       lane stays alive via the parent's own claim, OR
   *   (b) BENDS to a parent already on another lane (a fork rejoining, or a
   *       branch tip whose parent lives elsewhere) — X's lane must stay
   *       RESERVED until that parent's row, because the bezier is in transit
   *       through every row in between and another commit's node must not
   *       land on the same column mid-transit.
   * Case (b) is why a naive "release as soon as the commit is emitted" is
   * wrong: it let two sibling tips diving to a shared base collide on one
   * lane. We instead release X's lane only when we REACH the parent row that
   * X's line targeted (tracked in `pendingReleaseAtRow`).
   *
   * Without lane release at all, `activeLanes` only grew: every ended branch
   * left a permanently-reserved lane, so each new fork took an ever-higher
   * lane index (lane 10+ in real repos) though only ~2 lanes were ever live
   * at once — a needlessly wide graph column that pushed branches off-screen.
   * IntelliJ reuses lanes; this is how.
   */
  laneClaimants: Map<number, Set<string>>;
}

/**
 * Claim `hash` onto `lane`. Idempotent per hash (a merge's later child can
 * reference an already-claimed parent without double-counting).
 */
function claimLane(state: ILaneState, hash: string, lane: number): void {
  if (state.commitToLane.has(hash)) {
    return;
  }
  state.commitToLane.set(hash, lane);
  state.activeLanes.add(lane);
  let set = state.laneClaimants.get(lane);
  if (!set) {
    set = new Set();
    state.laneClaimants.set(lane, set);
  }
  set.add(hash);
}

/**
 * Release `hash` from `lane` (it's emitted and its line has landed). When the
 * lane has no remaining claimants it is freed for reuse by a later branch.
 */
function releaseClaim(state: ILaneState, hash: string, lane: number): void {
  const set = state.laneClaimants.get(lane);
  if (!set) {
    return;
  }
  set.delete(hash);
  if (set.size === 0) {
    state.laneClaimants.delete(lane);
    state.activeLanes.delete(lane);
  }
}

/**
 * Find the next available lane (column) for a new branch.
 *
 * @param state - Current lane state
 * @returns The next available lane index
 */
function findNextAvailableLane(state: ILaneState): number {
  // Try to find a gap in active lanes first
  for (let i = 0; i < state.nextLane; i++) {
    if (!state.activeLanes.has(i)) {
      return i;
    }
  }
  // No gap found, use the next lane
  return state.nextLane;
}

/**
 * Children pre-pass.
 *
 * Build a map of `parentHash → array of child hashes in display order` so
 * the main pass can ask "is THIS commit the first-seen child of `parent`?"
 * Without this pre-pass the single-pass algorithm collapses divergent
 * branches that share an unseen parent: the SECOND child of a parent gets
 * its parent's lane unconditionally, which puts it on top of the first
 * child's lane.
 *
 * Display order matters — we record children in the same newest-first
 * order the main pass consumes commits, so `firstChild = arr[0]` gives the
 * topologically-newest child of each parent.
 *
 * @param commits - Array of commits in topological order (newest first)
 * @returns Map of parent hash → array of child hashes (newest-first)
 */
export function buildChildrenMap(commits: ICommit[]): Map<string, string[]> {
  const childrenMap = new Map<string, string[]>();
  for (const commit of commits) {
    for (const parent of commit.parents) {
      const arr = childrenMap.get(parent);
      if (arr) {
        // Defensive dedupe. A corrupt object
        // store can produce a commit listing the same parent twice; if
        // we let it slip through, the same child appears twice in the
        // children list and the first-seen check is a no-op for the
        // duplicated parent slot. Cheap O(arr.length) per push; arr is
        // tiny in any non-pathological repo.
        if (arr.includes(commit.hash)) {
          continue;
        }
        arr.push(commit.hash);
      } else {
        childrenMap.set(parent, [commit.hash]);
      }
    }
  }
  return childrenMap;
}

/**
 * Generate commit graph data from a list of commits.
 *
 * This function is the **algorithm boundary** for the lane / line
 * model defined in spec §1.1 (`docs/design/git-tool-window-spec.md`).
 * It processes commits in topological order (newest first), assigns
 * each commit to a lane (column), and emits the graph lines connecting
 * each commit to its parents.
 *
 * children-map two-pass algorithm. The pre-pass records each
 * parent's children in display order; the main pass uses that to decide
 * whether the current commit's parent inherits the current lane (only when
 * THIS commit is the parent's first-seen child AND it is the parent's
 * first parent slot, i.e. straight-down inheritance) or claims a brand
 * new lane (any other case — divergent fork).
 *
 * `focusedPathHashes` is the optional set of commit hashes
 * on the BFS path from the focused branch tip to its merge-base with
 * HEAD. Each `ICommitNode` is annotated with `onFocusedBranchPath` (true
 * when its hash is in the set, false otherwise — including when the set
 * is undefined or empty). The renderer reads this flag and the
 * `hasFocusedBranch` global to brighten on-path / dim off-path lines.
 *
 * The algorithm:
 * 1. Pre-pass: build childrenMap (parent hash → array of child hashes in display order).
 * 2. Main pass: for each commit, claim a lane (inherit if pre-claimed by an earlier
 *    child, else allocate next available); for each parent, decide whether to inherit
 *    this commit's lane (first-child + first-parent) or claim a new lane (divergence).
 * 3. Tag every node with `onFocusedBranchPath` for the renderer.
 *
 * @invariant L1 — Lane assignment is byte-identical across no-op
 * reloads and reflects HEAD ancestry: HEAD's branch tip pre-seeds
 * lane 0 (and ONLY HEAD's tip; non-HEAD branch tips go through the
 * main pass). See `docs/design/git-tool-window-spec.md` §8.L1.
 *
 * @invariant L9 — A parent that is NOT in the loaded window emits a
 * single same-lane `{fromColumn === toColumn, style: 'dashed'}` line
 * and MUST NOT call `allocateLane()` for that parent. See
 * `docs/design/git-tool-window-spec.md` §8.L9.
 *
 * @invariant L10 — Branch type (`'local'` vs `'remote'`) flows through
 * `IBranchRef.type` from `parseBranches`. The graph algorithm and
 * renderer MUST NOT infer type from the branch name shape (e.g. a
 * presence of `/`). See `docs/design/git-tool-window-spec.md` §8.L10.
 *
 * @param commits - Array of commits in topological order (newest first)
 * @param branchMap - Optional map of commit hash to branch refs (name + type)
 * @param tagMap - Optional map of commit hash to tag names
 * @param focusedPathHashes - Optional set of commit hashes on the focused
 * branch's path-to-merge-base. When `undefined` or empty,
 *   every node's `onFocusedBranchPath` is `false`.
 * @param headBranchName - Optional name of HEAD's branch (no
 *   `refs/heads/` prefix). When provided AND that branch's tip is in
 *   the loaded window, the tip is pre-claimed onto lane 0 so HEAD's
 *   branch always lands in the leftmost column — IntelliJ parity, and
 *   the load-bearing piece of cross-render lane stability (a refresh
 *   that doesn't touch the branch keeps it on the same lane).
 * @returns Array of commit nodes with graph visualization data
 */
export function generateCommitGraph(
  commits: ICommit[],
  branchMap?: Map<string, IBranchRef[]>,
  tagMap?: Map<string, string[]>,
  focusedPathHashes?: Set<string>,
  headBranchName?: string,
  headHash?: string
): ICommitNode[] {
  if (commits.length === 0) {
    return [];
  }

  // PRE-PASS — children-map: parent hash → array of child hashes in
  // display order. A parent's "first-seen" child is `childrenMap[parent][0]`.
  const childrenMap = buildChildrenMap(commits);

  // PRE-PASS — set of commit hashes in the rendered window. A commit's
  // parent that ISN'T in this set is older than the loaded log window
  // (we paginate via `--max-count`). When we encounter such a parent
  // we draw the lane straight down ("history continues below") rather
  // than allocating a fresh lateral lane that hooks into nowhere.
  // Without this, every commit whose parent fell off the load window
  // emitted a stray bezier into a phantom lane, which is the visual
  // "disconnected line" bug users reported.
  const commitsInWindow = new Set<string>();
  for (const c of commits) {
    commitsInWindow.add(c.hash);
  }

  const result: ICommitNode[] = [];
  const state: ILaneState = {
    commitToLane: new Map(),
    activeLanes: new Set(),
    nextLane: 0,
    laneClaimants: new Map(),
  };

  // Row index of every in-window commit, so we can defer a lane release to
  // the row of the parent a bending line lands on.
  const rowOfHash = new Map<string, number>();
  commits.forEach((c, i) => rowOfHash.set(c.hash, i));

  // Deferred lane releases keyed by the ROW at which they fire. When we
  // reach row R we free every (lane, hash) scheduled there — that's the row
  // where an in-transit line finally lands on its parent, after which the
  // source lane is genuinely free for reuse.
  const releaseAtRow = new Map<number, Array<{ lane: number; hash: string }>>();
  const scheduleRelease = (row: number, lane: number, hash: string): void => {
    let arr = releaseAtRow.get(row);
    if (!arr) {
      arr = [];
      releaseAtRow.set(row, arr);
    }
    arr.push({ lane, hash });
  };

  // Helper that allocates a brand-new lane and bumps `nextLane` so the
  // next allocation never collides with the one we just handed out.
  const allocateLane = (): number => {
    const lane = findNextAvailableLane(state);
    if (lane >= state.nextLane) {
      state.nextLane = lane + 1;
    }
    return lane;
  };

  // PRE-PASS — locate HEAD's branch tip (if any) so subsequent
  // pre-passes can privilege the HEAD-ancestry. `undefined` only when HEAD
  // genuinely can't be anchored in the loaded window.
  //
  // PREFER the explicit HEAD commit SHA (`headHash`, from `git rev-parse
  // HEAD`) over name-matching against the branchMap. The SHA is defined in
  // strictly more cases than the name and avoids three silent failure modes
  // that previously disabled the entire HEAD-spine pre-claim (and let a
  // divergent branch seize lane 0, splitting the mainline across colours):
  //   1. Detached HEAD — `headBranchName` is undefined, but `headHash` is
  //      still the rev-parse SHA.
  //   2. `getBranches` failed upstream — branchMap is empty, so name-match
  //      finds nothing, but `headHash` is independent of branchMap.
  //   3. symbolic-ref vs getBranches race — the symbolic HEAD name and the
  //      branchMap (built from a separate `git branch` call) can disagree
  //      mid-checkout / after a rename; matching on the SHA sidesteps it.
  // The name-match is kept as a fallback for callers that pass only the
  // name. Either way the tip must be in the loaded window to anchor.
  let headTipHash: string | undefined;
  if (headHash && commitsInWindow.has(headHash)) {
    headTipHash = headHash;
  } else if (headBranchName && branchMap && branchMap.size > 0) {
    for (const [commitHash, refs] of branchMap.entries()) {
      if (!commitsInWindow.has(commitHash)) {
        continue;
      }
      if (refs.some((r) => r.name === headBranchName)) {
        headTipHash = commitHash;
        break;
      }
    }
  }

  // PRE-PASS — compute the set of commit hashes in HEAD's ancestry,
  // so the children-map's "first child" tie-break can prefer a
  // HEAD-ancestry child over a divergent sibling.
  //
  // Why this matters (regression discovered post-PR #9): when
  // `git log --topo-order --all` interleaves a divergent branch's
  // commits BEFORE mainline rows in the loaded window, the
  // children-map's natural "first push wins" ordering picks the
  // DIVERGENT child as `firstChildOfParent` of the merge-base
  // commit. The divergent child then claims the merge-base on its
  // OWN (non-zero) lane via straight-down inheritance, and when the
  // mainline child reaches that same parent later, the parent is
  // already on the divergent lane. The mainline line bends
  // sideways into a different lane — visually a green-node-on-
  // blue-line mismatch on the mainline rows.
  //
  // Fix: BFS from HEAD's tip backwards through `parents`, stopping
  // at `commitsInWindow` boundary. Then in the children-map,
  // promote a HEAD-ancestry child to position 0 of every parent's
  // children array. The mainline always wins inheritance.
  const commitByHash = new Map<string, ICommit>();
  for (const c of commits) {
    commitByHash.set(c.hash, c);
  }

  const headAncestry = new Set<string>();
  if (headTipHash !== undefined) {
    const queue: string[] = [headTipHash];
    while (queue.length > 0) {
      const h = queue.shift()!;
      if (headAncestry.has(h)) {
        continue;
      }
      headAncestry.add(h);
      const c = commitByHash.get(h);
      if (c) {
        for (const p of c.parents) {
          if (commitsInWindow.has(p) && !headAncestry.has(p)) {
            queue.push(p);
          }
        }
      }
    }
  }

  // Promote HEAD-ancestry children to position 0 in the children-
  // map. Iteration is per-parent: for each parent, if its children
  // list contains a HEAD-ancestor, move that child to index 0.
  // Stable for the rest of the list (we only move the first match).
  if (headAncestry.size > 0) {
    for (const children of childrenMap.values()) {
      if (children.length < 2) {
        continue;
      }
      const idx = children.findIndex((c) => headAncestry.has(c));
      if (idx > 0) {
        const [headChild] = children.splice(idx, 1);
        children.unshift(headChild);
      }
    }
  }

  // PRE-PASS — seed lane 0 for HEAD's branch tip.
  //
  // Goal: pin HEAD's branch to the leftmost column for cross-render
  // stability — IntelliJ parity. The user's "current branch" sits on
  // lane 0 regardless of where it appears in the input ordering.
  //
  // We deliberately do NOT pre-seed every branch tip. An earlier
  // version did, walking refs in priority order and assigning each
  // tip its own lane; that broke the common case where a local
  // branch and its remote-tracking counterpart sit on the SAME
  // physical chain (e.g. local `main` and `origin/main` after a
  // fetch with no divergence). The pre-seeding split them onto
  // separate lanes, so the row's node rendered in lane-0 green
  // while the line flowing to its parent (now on lane 1) rendered
  // blue — visually wrong, no real divergence in the underlying
  // history.
  //
  // The natural first-seen-child algorithm in the main loop already
  // keeps non-divergent refs on the same lane. We let it do its
  // job for everything except HEAD, which gets the only privileged
  // pre-seed.
  //
  // We pre-claim lane 0 for HEAD's entire FIRST-PARENT SPINE, not just
  // the tip. The spine is HEAD-tip → its 1st parent → that commit's 1st
  // parent → … walked through `commitsInWindow`. Every commit on it gets
  // lane 0 up front.
  //
  // Why the whole spine, not just the tip: when a divergent branch
  // (`test_squash`, `mainline-clone`) shares an ancestor with mainline
  // and is listed BEFORE the mainline child in the `--all` topo slice,
  // the divergent branch reaches the shared ancestor FIRST and the main
  // pass allocates that ancestor a fresh side lane. The mainline child
  // then bends sideways to reach its own parent — a mainline commit
  // rendered on lane 2 (orange) with the green/blue mainline line hooking
  // into it. (Reported: "squash test" blue node + orange line; a green
  // node with a blue+orange line on one commit.) Pre-claiming the spine
  // pins every mainline commit to lane 0, so the divergent branches are
  // the ones that bend INTO lane 0 — correct IntelliJ behavior — and the
  // mainline stays a straight lane-0 column.
  //
  // HEAD-behind-newer is handled by extending the spine UPWARD too: when
  // HEAD's tip has a newer in-window descendant that reaches the tip via
  // its FIRST parent (an un-pulled upstream commit, or a branch built
  // straight on top of HEAD), that descendant is part of the same visual
  // mainline column. We walk up the first-parent-child links from HEAD's
  // tip to the topmost such descendant, start the spine there, then walk
  // the whole first-parent chain down. Without this the descendant would
  // collide with the pre-claimed HEAD tip and get bumped to lane 1 with a
  // `1->0` bend (the earlier blue-dot-on-lane-1 report).
  //
  // We deliberately pre-claim ONLY the first-parent spine — merge second
  // parents and divergent tips still go through the natural main pass, so
  // a local branch and its remote-tracking counterpart on the same chain
  // are NOT split onto separate lanes (the earlier all-tips regression).
  if (headTipHash !== undefined) {
    // Walk UP via first-parent-children to find the spine head: the
    // topmost commit that reaches HEAD's tip through an unbroken chain of
    // "first parent" links. A child counts only if THIS spine commit is
    // its `parents[0]` (a first-parent descendant), so divergent merges
    // that list HEAD's branch as a 2nd parent don't capture the spine.
    let spineHead = headTipHash;
    const upGuard = new Set<string>();
    for (;;) {
      if (upGuard.has(spineHead)) {
        break;
      }
      upGuard.add(spineHead);
      const children = childrenMap.get(spineHead) ?? [];
      const firstParentChild = children.find(
        (childHash) => commitByHash.get(childHash)?.parents[0] === spineHead
      );
      if (firstParentChild === undefined || !commitsInWindow.has(firstParentChild)) {
        break;
      }
      spineHead = firstParentChild;
    }

    // Walk the first-parent chain DOWN from the spine head, pinning every
    // commit to lane 0. Each spine commit is a distinct claim so the
    // occupancy counter knows lane 0 stays alive across the whole mainline.
    const lane = allocateLane();
    let spineHash: string | undefined = spineHead;
    const guard = new Set<string>();
    while (spineHash !== undefined && commitsInWindow.has(spineHash) && !guard.has(spineHash)) {
      guard.add(spineHash);
      claimLane(state, spineHash, lane);
      const c: ICommit | undefined = commitByHash.get(spineHash);
      spineHash = c?.parents[0];
    }
  }

  // MAIN PASS — claim lanes + emit graph lines.
  for (let rowIndex = 0; rowIndex < commits.length; rowIndex++) {
    const commit = commits[rowIndex];
    const commitHash = commit.hash;
    const graphLines: IGraphLine[] = [];

    // Fire any lane releases scheduled to land at THIS row: an in-transit
    // bending line reaches its parent here, so its source lane is now free
    // for reuse by branches that start at or after this row.
    const due = releaseAtRow.get(rowIndex);
    if (due) {
      for (const { lane, hash } of due) {
        releaseClaim(state, hash, lane);
      }
      releaseAtRow.delete(rowIndex);
    }

    // --- Step A: claim a lane for THIS commit ---
    // If a prior child already pre-claimed our lane (because we were
    // their first-seen-child target), inherit it; otherwise allocate.
    let column: number;
    if (state.commitToLane.has(commitHash)) {
      column = state.commitToLane.get(commitHash)!;
    } else {
      column = allocateLane();
      claimLane(state, commitHash, column);
    }
    state.activeLanes.add(column);

    // --- Step B: decide each parent's lane and emit a graph line ---
    // Track how THIS commit's lane (`column`) should be released after the
    // row is emitted (see the block after the loop):
    //   - 'inherited' : the first parent took `column` straight down — the
    //     parent's own claim keeps the lane alive, release X now.
    //   - 'bendToRow' : the first-parent line bends to a parent on another
    //     lane at row R — keep `column` reserved (X stays its claimant)
    //     until R, then free it.
    //   - 'end'       : no in-window first parent (root / off-window) —
    //     release `column` now.
    let firstParentDisposition: 'inherited' | 'end' = 'end';
    let bendReleaseRow = -1;
    const parents = commit.parents;
    for (let i = 0; i < parents.length; i++) {
      const parentHash = parents[i];
      let parentLane: number;

      // OFF-WINDOW PARENT: the parent commit fell off the loaded log
      // window (older than our `--max-count` slice). We can't allocate
      // a lane that points at it because it has no row to land on, and
      // we can't inherit our lane and walk down the column because the
      // next row will be a different commit. Emit a same-lane "history
      // continues below" line and skip allocating a phantom lateral
      // lane. The renderer draws this as a vertical stub from the
      // commit's centerY to the row's bottomY — visually correct
      // ("history continues") and identical to a same-lane parent that
      // simply isn't in the rendered window.
      //
      // Without this guard the algorithm took the `else` branch, called
      // allocateLane(), and emitted a bezier from `column` to a fresh
      // lane that has no node anywhere — producing the stray lateral
      // hook visible at the bottom of the row in user reports.
      if (!commitsInWindow.has(parentHash)) {
        graphLines.push({
          fromColumn: column,
          toColumn: column,
          color: getColumnColor(column),
          type: i === 0 ? 'commit' : 'merge',
          // Dashed: the line is a stub for history that continues
          // below the loaded window. IntelliJ-parity affordance —
          // makes it visually obvious the edge isn't pointing at a
          // row the user can scroll to.
          style: 'dashed',
        });
        continue;
      }

      if (state.commitToLane.has(parentHash)) {
        // Already claimed — either by an earlier sibling (the common
        // ancestor in a fork-then-merge) or by an even earlier prior
        // commit. Use the existing lane.
        parentLane = state.commitToLane.get(parentHash)!;
      } else {
        // KEY CHANGE — only inherit our lane if WE are the parent's
        // first-seen child in display order AND we're the parent's first
        // parent slot. Anything else is a divergent fork that needs a
        // brand-new lane.
        const firstChildOfParent = childrenMap.get(parentHash)?.[0];
        if (firstChildOfParent === commitHash && i === 0) {
          parentLane = column; // straight-down inheritance
        } else {
          parentLane = allocateLane();
        }
        claimLane(state, parentHash, parentLane);
      }

      // Record how the FIRST-parent line disposes of THIS commit's lane.
      if (i === 0) {
        if (parentLane === column) {
          firstParentDisposition = 'inherited';
        } else {
          // The line bends from `column` to `parentLane`. Keep `column`
          // reserved until the parent's row so no other commit's node lands
          // on it while this bezier is in transit.
          firstParentDisposition = 'end';
          bendReleaseRow = rowOfHash.get(parentHash) ?? -1;
        }
      }

      graphLines.push({
        fromColumn: column,
        toColumn: parentLane,
        // Merge / branch lines (i > 0) take the destination lane's color
        // so they read as "joining the merged branch's color"; the main
        // line uses the current commit's lane color.
        color: getColumnColor(i === 0 ? column : parentLane),
        type: i === 0 ? 'commit' : 'merge',
      });
    }

    const branches = branchMap?.get(commitHash) || [];
    const tags = tagMap?.get(commitHash) || [];
    const onFocusedBranchPath = focusedPathHashes?.has(commitHash) ?? false;

    result.push({
      commit,
      graphColumn: column,
      graphLines,
      branches,
      tags,
      onFocusedBranchPath,
    });

    // LANE RELEASE — dispose of THIS commit's claim on its lane now that the
    // row is emitted. Three cases (see firstParentDisposition above):
    if (firstParentDisposition === 'inherited') {
      // The first parent took `column` straight down and holds its own claim
      // on it. Drop X's claim; the lane stays alive via the parent. Net: the
      // lane is continuously occupied down the mainline / branch spine.
      releaseClaim(state, commitHash, column);
    } else if (bendReleaseRow > rowIndex) {
      // The first-parent line bends away to a parent at `bendReleaseRow`.
      // Keep X as a claimant of `column` (reserving it) until that row, so a
      // later branch can't grab the column while the bezier is mid-transit.
      scheduleRelease(bendReleaseRow, column, commitHash);
    } else {
      // Branch tip / root / off-window first parent — nothing continues the
      // lane below this row. Free it immediately for reuse.
      releaseClaim(state, commitHash, column);
    }
  }

  return result;
}

/**
 * Compute the set of commit hashes that are terminal nodes (branch tips).
 * A terminal node is a commit that is NOT a parent of any other commit in the graph.
 *
 * @param nodes - Array of commit nodes
 * @returns Set of commit hashes that have no children in the graph
 */
export function computeTerminalNodes(nodes: ICommitNode[]): Set<string> {
  // Build a set of all hashes that appear as parents of other commits
  const parentHashes = new Set<string>();
  for (const node of nodes) {
    for (const parentHash of node.commit.parents) {
      parentHashes.add(parentHash);
    }
  }

  // Terminal nodes are commits whose hash does NOT appear as a parent
  const terminalNodes = new Set<string>();
  for (const node of nodes) {
    if (!parentHashes.has(node.commit.hash)) {
      terminalNodes.add(node.commit.hash);
    }
  }

  return terminalNodes;
}

/**
 * Build a map of commit hash -> number of child commits in the graph.
 * For each commit, counts how many other commits in the graph list it as a parent.
 *
 * @param nodes - Array of commit nodes
 * @returns Map of commit hash to child count
 */
export function computeChildCountMap(nodes: ICommitNode[]): Map<string, number> {
  const childCountMap = new Map<string, number>();

  for (const node of nodes) {
    for (const parentHash of node.commit.parents) {
      const currentCount = childCountMap.get(parentHash) || 0;
      childCountMap.set(parentHash, currentCount + 1);
    }
  }

  return childCountMap;
}

/**
 * Determine if a commit is a branch split point.
 * A branch split occurs when a commit's hash appears as a parent
 * of more than one other commit in the loaded graph.
 *
 * @param commitHash - The hash of the commit to check
 * @param childCountMap - Map of commit hash to child count (from computeChildCountMap)
 * @returns True if the commit has more than one child in the graph
 */
export function isBranchSplit(commitHash: string, childCountMap: Map<string, number>): boolean {
  const count = childCountMap.get(commitHash) || 0;
  return count > 1;
}

/**
 * Calculate the maximum column (lane) used in the graph.
 * Useful for determining the width needed to render the graph.
 *
 * @param nodes - Array of commit nodes
 * @returns The maximum column index used, or -1 if empty
 */
export function getMaxGraphColumn(nodes: ICommitNode[]): number {
  if (nodes.length === 0) {
    return -1;
  }

  let maxColumn = 0;
  for (const node of nodes) {
    maxColumn = Math.max(maxColumn, node.graphColumn);
    for (const line of node.graphLines) {
      maxColumn = Math.max(maxColumn, line.fromColumn, line.toColumn);
    }
  }

  return maxColumn;
}

/**
 * Check if a commit is a merge commit (has multiple parents).
 *
 * @param commit - The commit to check
 * @returns True if the commit has more than one parent
 */
export function isMergeCommit(commit: ICommit): boolean {
  return commit.parents.length > 1;
}

/**
 * Check if a commit is a root commit (has no parents).
 *
 * @param commit - The commit to check
 * @returns True if the commit has no parents
 */
export function isRootCommit(commit: ICommit): boolean {
  return commit.parents.length === 0;
}

/**
 * Get the number of active lanes at a given commit.
 * This represents how many parallel branches are visible at that point.
 *
 * @param nodes - Array of commit nodes up to and including the target
 * @param index - Index of the target commit in the nodes array
 * @returns Number of active lanes
 */
export function getActiveLaneCount(nodes: ICommitNode[], index: number): number {
  if (index < 0 || index >= nodes.length) {
    return 0;
  }

  const activeLanes = new Set<number>();

  // Collect all lanes used up to this point
  for (let i = 0; i <= index; i++) {
    const node = nodes[i];
    activeLanes.add(node.graphColumn);
    for (const line of node.graphLines) {
      activeLanes.add(line.toColumn);
    }
  }

  return activeLanes.size;
}

/**
 * Compute a map of parent commit hash → Set of child commit graph columns.
 * For each commit that appears as a parent of another commit, records which
 * columns (lanes) the child commits occupy.
 *
 * This is used to draw split curves on the parent's row showing lines
 * diverging from the parent node up to the child lanes.
 *
 * @param nodes - Array of commit nodes
 * @returns Map of parent hash to set of child column indices
 */
export function computeChildLanesMap(nodes: ICommitNode[]): Map<string, Set<number>> {
  const childLanesMap = new Map<string, Set<number>>();

  for (const node of nodes) {
    for (const parentHash of node.commit.parents) {
      if (!childLanesMap.has(parentHash)) {
        childLanesMap.set(parentHash, new Set());
      }
      childLanesMap.get(parentHash)!.add(node.graphColumn);
    }
  }

  return childLanesMap;
}
