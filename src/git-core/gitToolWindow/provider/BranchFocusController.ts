/**
 * The Git tool window's branch-focus state machine: the focused-path hash set,
 * the post-await staleness generation, branch-tip resolution, the BFS path to
 * the merge base, and the branch-click navigation. Owned by
 * GitToolWindowProvider as `provider.focus`; state lives here and in the log
 * store (the focus NAME sits inside the extended log state), effects go
 * through {@link IFocusHost}.
 */

import type { ICommitNode } from '../../commitGraph';
import { graphRowKeyParts } from '../../graphRowKey';
import type { IGitService, IRepository } from '../../interfaces/IGitService';
import type { GitToolWindowOutbound } from '../gitToolWindow.protocol';
import { bfsPathToMergeBase } from './loadedGraphQueries';
import type { LogStateModel } from './LogStateModel';

/**
 * The provider-side effects and capabilities this controller reaches.
 * Function-typed call-time lambdas (live reads), built once in the provider
 * constructor; the render/fire lambdas route through the provider INSTANCE so
 * the ordering tests that patch `_render` / `_onDidChangeState.fire` on it
 * observe the real call order.
 */
export interface IFocusHost {
  render: () => void;
  fireStateChange: () => void;
  hasView: () => boolean;
  post: (msg: GitToolWindowOutbound) => void;
  getGitService: () => IGitService | undefined;
  getSelectedRepository: () => IRepository | undefined;
  /** Single-select the given commit (selectGraphRow + details posts). */
  selectCommit: (hash: string) => void;
  /** Non-selecting scroll — preserves selection / anchor / expandedCommit. */
  scrollWebviewToCommit: (hash: string) => void;
}

export class BranchFocusController {
  /**
   * Hashes on the focused branch's path to the merge base. Read by the graph
   * snapshot (per-node `onFocusedBranchPath` tagging); populated while
   * {@link setFocusedBranch} runs; cleared when focus drops or the focused
   * branch disappears from a refresh.
   */
  private _focusedPathHashes: Set<string> = new Set();
  /**
   * Staleness counter. {@link setFocusedBranch} bumps this on entry and
   * captures it; after its `await getMergeBase` it bails when a later focus
   * call (or a snapshot that cleared focus) has bumped past it, so rapid
   * focus switches don't land state in the wrong order.
   */
  private _focusGeneration = 0;

  constructor(
    private readonly _host: IFocusHost,
    private readonly _log: LogStateModel
  ) {}

  /** The current focused-path set, or undefined when empty (no-focus baseline). */
  public pathHashesOrUndefined(): Set<string> | undefined {
    return this._focusedPathHashes.size > 0 ? this._focusedPathHashes : undefined;
  }

  /**
   * Re-validate the focus name against a new snapshot's branch set, BEFORE
   * the graph is generated (the path set feeds node tagging). If the focus
   * target disappeared (force-push, branch rename, repo switch), the name
   * nulls out and the cached path clears — every node then gets
   * `onFocusedBranchPath: false`, the no-focus baseline. The generation bumps
   * only on the cleared-focus path: a refresh that KEEPS the focus name
   * doesn't invalidate an in-flight continuation (whichever computed
   * merge-base wins is still semantically correct — the branch is still
   * here).
   *
   * @returns the focus name the snapshot should commit
   */
  public revalidateOnSnapshot(branchNamesPresent: ReadonlySet<string>): string | null {
    const currentFocusName = this._log.state.focusedBranchName;
    const newFocusName =
      currentFocusName && branchNamesPresent.has(currentFocusName) ? currentFocusName : null;
    if (newFocusName === null) {
      if (currentFocusName !== null) {
        this._focusGeneration += 1;
      }
      this._focusedPathHashes = new Set();
    }
    return newFocusName;
  }

  /**
   * Focus the graph on a branch.
   *
   * Resolves the branch's tip commit, computes the BFS path back to the
   * merge-base with HEAD, updates the log state, and lands the effects in
   * ADR-009 section 3 order — render, fire, then post — so the post lands on
   * the new document, not the doomed pre-render one. A trailing non-selecting
   * scroll brings the tip into view without clearing a user's mid-shift-click
   * range.
   *
   * @param branchName - The branch to focus. When `null`, clears focus.
   */
  public async setFocusedBranch(branchName: string | null): Promise<void> {
    // render-unconditional: all three paths repaint with no change detection,
    // so focusing the branch already focused repaints. Guarding it is a real
    // fix and not one this fence's slice made; note that the method is async,
    // so any count has to await it or it reads before the work.
    //
    // Bump generation counter. Capture for post-await
    // staleness check.
    this._focusGeneration += 1;
    const myGen = this._focusGeneration;

    if (branchName === null) {
      // Clear focus — chip class drops, path empties, graph re-renders
      // baseline. Cheap because every branch goes through here on the way
      // out (e.g. user re-clicks the icon to toggle off).
      this._log.state.focusedBranchName = null;
      this._focusedPathHashes = new Set();
      this._regenerateCommitNodesForFocus();
      // ADR-009 section 3 — render FIRST, fire, then post.
      // Posting before render means the post lands on the doomed
      // pre-reload document.
      this._host.render();
      this._host.fireStateChange();
      this._postBranchFocusUpdate(null, null);
      return;
    }

    // Resolve the branch's tip commit hash (the same resolver
    // `handleBranchClick` navigates with).
    const targetHash = this._resolveBranchTipHash(branchName);
    if (!targetHash) {
      // Branch isn't in the loaded log. We still set the focus name so a
      // subsequent updateLogState that DOES contain it lights up the
      // chip — this matches IntelliJ's "focus persists until cleared"
      // behavior. The path remains empty.
      this._log.state.focusedBranchName = branchName;
      this._focusedPathHashes = new Set();
      this._regenerateCommitNodesForFocus();
      this._host.render();
      this._host.fireStateChange();
      this._postBranchFocusUpdate(branchName, null);
      return;
    }

    // Compute the path from `targetHash` back through
    // `commitNodes` to the merge-base of `HEAD` and the branch.
    let pathHashes = new Set<string>();
    const repo = this._host.getSelectedRepository();
    const gitService = this._host.getGitService();
    if (repo && gitService?.getMergeBase) {
      // T-8: getMergeBase may return undefined (no common ancestor / git
      // error). In that case `mergeBaseHash` is undefined and the BFS
      // walks until it exhausts loaded nodes — the "all walked commits
      // are on path" trap-handler in {@link bfsPathToMergeBase}.
      let mergeBaseHash: string | undefined;
      try {
        mergeBaseHash = await gitService.getMergeBase(repo, 'HEAD', branchName);
      } catch {
        // Defensive — same as undefined.
        mergeBaseHash = undefined;
      }

      // Staleness check after `await`. If a later
      // setFocusedBranch / updateLogState bumped the counter, OR if
      // the focused branch is no longer in the current branchMap
      // (refresh dropped it), bail: the live state already reflects
      // the newer intent and overwriting it would regress.
      if (myGen !== this._focusGeneration) {
        return;
      }
      const known = this.collectKnownBranchNames();
      if (!known.has(branchName)) {
        return;
      }

      pathHashes = bfsPathToMergeBase(this._log.state.commitNodes, targetHash, mergeBaseHash);
    }

    this._focusedPathHashes = pathHashes;
    this._log.state.focusedBranchName = branchName;

    // Re-tag commit nodes with onFocusedBranchPath now that the path set
    // is populated. The snapshot path would also do this, but
    // setFocusedBranch fires WITHOUT a commit-list refresh, so we walk
    // the existing nodes and patch the flag in place.
    this._regenerateCommitNodesForFocus();

    // ADR-009 section 3 — render-then-fire-then-post.
    this._host.render();
    this._host.fireStateChange();
    this._postBranchFocusUpdate(branchName, targetHash);

    // non-selecting scroll: bring the tip into view
    // WITHOUT clearing the user's selection / anchor / expandedCommit.
    this._host.scrollWebviewToCommit(targetHash);
  }

  /**
   * Collect every branch name visible to the host (i.e. listed in
   * `branchMap.values()` or any `commitNodes[].branches`). The
   * webview-message handler validates against this set before propagating to
   * {@link setFocusedBranch}, defending against a malicious / desynced
   * webview that posts arbitrary strings.
   */
  public collectKnownBranchNames(): Set<string> {
    const names = new Set<string>();
    for (const list of this._log.state.branchMap.values()) {
      for (const ref of list) {
        names.add(ref.name);
      }
    }
    for (const node of this._log.state.commitNodes) {
      if (node.branches) {
        for (const ref of node.branches) {
          names.add(ref.name);
        }
      }
    }
    return names;
  }

  /**
   * Resolve a branch name to its tip commit hash by inspecting the
   * branchMap and (as a fallback) the per-node branches array.
   * Returns undefined when the branch isn't in the loaded log.
   *
   * Branch-map keys are graph ROW keys — `hash\0root` in the merged
   * all-roots log — so every hit is decomposed back to the bare hash
   * ({@link graphRowKeyParts}); downstream consumers (selectCommit, the
   * webview scroll, the BFS) all identify commits by bare hash. When
   * `preferredRepoRoot` is given (the clicked tree row's repo), a tip from
   * that root outranks a same-named branch in another root.
   */
  private _resolveBranchTipHash(
    branchName: string,
    preferredRepoRoot?: string
  ): string | undefined {
    let firstMatch: string | undefined;
    for (const [rowKey, branches] of this._log.state.branchMap.entries()) {
      if (branches.some((ref) => ref.name === branchName)) {
        const { hash, repoRoot } = graphRowKeyParts(rowKey);
        if (preferredRepoRoot !== undefined && repoRoot === preferredRepoRoot) {
          return hash;
        }
        firstMatch ??= hash;
      }
    }
    if (firstMatch !== undefined) {
      return firstMatch;
    }
    for (const node of this._log.state.commitNodes) {
      if (node.branches && node.branches.some((ref) => ref.name === branchName)) {
        const nodeRoot = (node.commit as { repoRoot?: string }).repoRoot;
        if (preferredRepoRoot !== undefined && nodeRoot === preferredRepoRoot) {
          return node.commit.hash;
        }
        firstMatch ??= node.commit.hash;
      }
    }
    return firstMatch;
  }

  /**
   * re-tag every node's `onFocusedBranchPath` flag against
   * the current {@link _focusedPathHashes} set. Cheaper than re-running the
   * graph generation, and the lane assignments don't change with focus state.
   */
  private _regenerateCommitNodesForFocus(): void {
    const path = this._focusedPathHashes;
    const tagged: ICommitNode[] = this._log.state.commitNodes.map((node) => ({
      ...node,
      onFocusedBranchPath: path.has(node.commit.hash),
    }));
    this._log.replaceState({
      ...this._log.state,
      commitNodes: tagged,
    });
  }

  /**
   * Post a `branchFocusUpdate` message to the webview with the current focus
   * name and resolved tip hash. The webview's inline-script handler caches
   * this into a `branchFocus` local and toggles the `branch-label-focused`
   * class on `[data-branch-name]` chips so a partial state update (no full
   * re-render) keeps the chip in sync.
   */
  private _postBranchFocusUpdate(
    focusedBranchName: string | null,
    focusedHash: string | null
  ): void {
    if (!this._host.hasView()) {
      return;
    }
    this._host.post({
      type: 'updateBranchFocus',
      focusedBranchName,
      focusedHash,
    });
  }

  /**
   * Handle a branch click: scroll the graph to the branch's HEAD commit.
   * Finds the branch's tip via {@link _resolveBranchTipHash} (branch map
   * first, per-node branches as fallback; merged-mode row keys decompose to
   * bare hashes there), then selects that commit and asks the webview to
   * scroll to it. `preferredRepoRoot` — the clicked tree row's repo — breaks
   * ties when several roots carry a same-named branch.
   *
   * Uses the partial-update path (selectCommit + a non-selecting scroll post)
   * rather than a full re-render, so the graph panel's scroll position is
   * preserved and the visibility-aware inline scrollToCommit only scrolls
   * when the target row is not already fully visible.
   */
  public handleBranchClick(branchName: string, preferredRepoRoot?: string): void {
    const targetCommitHash = this._resolveBranchTipHash(branchName, preferredRepoRoot);

    if (targetCommitHash) {
      // Use the partial-update path (no full re-render) so the graph panel's
      // scroll position is preserved. selectCommit posts selectGraphRow +
      // updateDetailsPanel; the scroll post is gated by the now
      // visibility-aware inline scrollToCommit. Avoiding a full render means
      // scrollTop is never reset to the top, so the inline visibility check
      // runs against the user's real scroll position.
      this._host.selectCommit(targetCommitHash);
      this._host.scrollWebviewToCommit(targetCommitHash);
    }
  }
}
