/**
 * The Git tool window's log-state store: the extended log state (graph nodes,
 * ref maps, selection, filter, focus name), the change-detection fingerprint,
 * the loaded-total, the one-shot scroll flags, and the merged-view HEAD set.
 * A passive store — it fires no events and posts nothing; the provider's
 * `updateLogState` sequencer and its setter orchestrators mutate it and own
 * every effect. Owned by GitToolWindowProvider as `provider.log`.
 *
 * The `state` getter hands out the LIVE object: the controller-context
 * contract (IGtwControllerContext) lets handlers read and mutate its fields
 * in place, so this store cannot seal it. The bounded exception is the object
 * IDENTITY: only {@link replaceState} / {@link applySnapshot} may swap the
 * state object, so a captured reference goes stale in exactly one place.
 */

import type { ICommit } from '../../interfaces/IGitService';
import { generateCommitGraph, type IBranchRef } from '../../commitGraph';
import type { IExtendedLogState } from '../GitToolWindowProvider';

export class LogStateModel {
  private _state: IExtendedLogState = {
    selectedCommits: new Set<string>(),
    expandedCommit: undefined,
    filter: undefined,
    commitNodes: [],
    branchMap: new Map<string, IBranchRef[]>(),
    tagMap: new Map<string, string[]>(),
    anchorHash: null,
    // No branch focused at start.
    focusedBranchName: null,
  };
  /**
   * Fingerprint of the last {@link applySnapshot} inputs (commit hashes,
   * branch/tag maps, head anchor, total). A repeated update with the same
   * fingerprint is an in-place background refresh that changed nothing — the
   * sequencer skips the full re-render (and the post sequence) so
   * watcher-driven reload churn can't rebuild the DOM and throw away the
   * user's scroll. Cleared whenever repository availability transitions (the
   * no-repo screen must never swallow a later identical update).
   */
  private _lastLogFingerprint: string | undefined;
  /**
   * Total commits available for the current repo/filter (from
   * `getLogCount` → `git rev-list --count`). Drives the graph's honest
   * "X of Y" loaded indicator and the `data-total-available` attribute the
   * webview reads to decide whether scroll-to-bottom should load more.
   * `undefined` falls back to "all loaded" (no more) so a missing count can
   * never spin the indicator forever.
   */
  private _logTotalAvailable: number | undefined;
  /**
   * One-shot flag: the NEXT graph render is a navigational one (repo switch,
   * filter/branch/range change, initial load) and should reset the webview to
   * the top instead of restoring the saved scroll position. Scroll is
   * preserved by DEFAULT — every in-place re-render keeps the user where they
   * are — so only intentional navigation sets this. Consumed by the render.
   */
  private _resetScrollOnNextRender: boolean = false;
  /** One-shot scroll-to-commit target, consumed by the next full render. */
  private _scrollToCommitHash: string | undefined;
  /**
   * HEAD commit hashes of every root in the merged "all roots" log. In merged
   * scope the single-repo HEAD spine / highlight is suppressed (no single
   * `headHash`), so this set keeps `undoCommit` enabled for the clicked
   * commit's own-repo HEAD. Empty in single-repo / specific scope, where the
   * single `state.headHash` drives the rule.
   */
  private _mergedHeadCommitHashes: ReadonlySet<string> = new Set();

  /** The LIVE state object (see the header for the mutability contract). */
  public get state(): IExtendedLogState {
    return this._state;
  }

  /** The single identity-replacement seam for the state object. */
  public replaceState(next: IExtendedLogState): void {
    this._state = next;
  }

  /** Whether `fingerprint` matches the last committed snapshot's. */
  public fingerprintMatches(fingerprint: string): boolean {
    return fingerprint === this._lastLogFingerprint;
  }

  /** Record `fingerprint` as the committed snapshot identity. */
  public commitFingerprint(fingerprint: string): void {
    this._lastLogFingerprint = fingerprint;
  }

  /**
   * Forget the committed fingerprint — repository availability transitioned,
   * so the next snapshot must paint even when its data is unchanged.
   */
  public invalidateFingerprint(): void {
    this._lastLogFingerprint = undefined;
  }

  public getTotal(): number | undefined {
    return this._logTotalAvailable;
  }

  public setTotal(total: number | undefined): void {
    this._logTotalAvailable = total;
  }

  /** Arm the one-shot navigational scroll reset (see the field doc). */
  public markResetScroll(): void {
    this._resetScrollOnNextRender = true;
  }

  /** Whether a navigational scroll reset is pending (peek — does not clear). */
  public hasPendingScrollReset(): boolean {
    return this._resetScrollOnNextRender;
  }

  /** Take the one-shot scroll reset: returns the flag and clears it. */
  public consumeResetScroll(): boolean {
    const pending = this._resetScrollOnNextRender;
    this._resetScrollOnNextRender = false;
    return pending;
  }

  /** Arm the one-shot scroll-to-commit target for the next full render. */
  public setScrollTarget(hash: string): void {
    this._scrollToCommitHash = hash;
  }

  /** Take the one-shot scroll target: returns it and clears it. */
  public consumeScrollTarget(): string | undefined {
    const target = this._scrollToCommitHash;
    this._scrollToCommitHash = undefined;
    return target;
  }

  public getMergedHeads(): ReadonlySet<string> {
    return this._mergedHeadCommitHashes;
  }

  public setMergedHeads(hashes: Iterable<string>): void {
    this._mergedHeadCommitHashes = new Set(hashes);
  }

  /**
   * Reset the per-root HEAD set at the top of a snapshot; the merged loader
   * repopulates it via {@link setMergedHeads} right after `updateLogState`.
   * Single-repo / specific loads leave it empty.
   */
  public clearMergedHeads(): void {
    this._mergedHeadCommitHashes = new Set();
  }

  /**
   * Commit a new log snapshot: generate the graph, prune the selection and
   * anchor to the surviving hashes, and replace the state object.
   *
   * `focusName` / `focusedPathHashes` arrive from the sequencer's focus
   * revalidation, which must run BEFORE this call — the path set feeds the
   * per-node `onFocusedBranchPath` tagging.
   *
   * Anchor lifecycle:
   *   - `selectedCommits` is pruned to the intersection with the new commit
   *     hashes so a force-push / log-filter that drops commits doesn't leave
   *     dangling selection state pointing at hashes that aren't rendered.
   *   - `anchorHash` resets to `null` when the anchor is no longer present.
   *     The webview-side mirror is reset by the `syncSelection` message the
   *     sequencer posts after this, plus the `data-anchor-hash` attribute on
   *     the next render.
   */
  public applySnapshot(
    commits: ICommit[],
    branchMap: Map<string, IBranchRef[]> | undefined,
    tagMap: Map<string, string[]> | undefined,
    headHash: string | undefined,
    headBranchName: string | undefined,
    focusName: string | null,
    focusedPathHashes: Set<string> | undefined
  ): void {
    const commitNodes = generateCommitGraph(
      commits,
      branchMap,
      tagMap,
      focusedPathHashes,
      headBranchName,
      // Pass the explicit HEAD commit SHA so the lane algorithm can anchor
      // HEAD's mainline spine to lane 0 even when the branch NAME can't be
      // resolved (detached HEAD, getBranches failure, symbolic-ref race).
      // Omitting it disables the spine anchor and lets a divergent
      // branch seize lane 0, splitting the mainline.
      headHash
    );

    const emptyBranchMap: Map<string, IBranchRef[]> = new Map();
    const emptyTagMap: Map<string, string[]> = new Map();

    const newHashes = new Set(commitNodes.map((n) => n.commit.hash));
    const prunedSelection = new Set<string>();
    for (const h of this._state.selectedCommits) {
      if (newHashes.has(h)) {
        prunedSelection.add(h);
      }
    }
    const currentAnchor = this._state.anchorHash;
    const newAnchor = currentAnchor && newHashes.has(currentAnchor) ? currentAnchor : null;

    this._state = {
      ...this._state,
      commitNodes,
      branchMap: branchMap || emptyBranchMap,
      tagMap: tagMap || emptyTagMap,
      selectedCommits: prunedSelection,
      anchorHash: newAnchor,
      focusedBranchName: focusName,
      headHash,
      headBranchName,
    };
  }
}
