/**
 * Pure helpers for multi-commit selection in the Git Tool Window.
 *
 * Introduces IntelliJ-parity multi-select on the log/graph:
 *   - Plain click   → single-select + set anchor
 *   - Ctrl/Cmd      → toggle membership + move anchor
 *   - Shift         → replace selection with range from anchor to click
 *   - Shift+Ctrl    → add range from anchor to click to existing selection
 *
 * The helpers below are extracted as module-level functions so they can be
 * unit-tested without standing up a webview / DOM. They take ordered hash
 * lists rather than raw `ICommitNode[]` to keep the seam narrow — callers
 * project the `commitNodes` display order down to a `string[]` (or the
 * slim `IMenuStateNode` shape) before invoking these helpers.
 *
 * Architectural invariant (ADR-009): the **host** is the source of
 * truth for menu visibility/enable state. The webview JS does NOT mirror
 * the rules — instead the host calls {@link computeMenuState} and posts
 * the result via the `updateMenuEnableState` message; the JS just applies
 * the precomputed map by toggling CSS classes. This eliminates the
 * "two copies of the rules drift apart" failure mode that review
 * flagged.
 */

/**
 * All right-click menu actions that participate in multi-select gating.
 *
 * The 13 single-select originals plus the two new multi-select-only
 * actions introduced in: `squashCommits` (N≥2 contiguous) and
 * `compareVersions` (N=2).
 *
 * Relationship to {@link import('./GitToolWindowProvider').LogContextAction}
 * Every member of this union is also a member of
 * `LogContextAction` so the cast at `_handleCommitContextMenu` is safe.
 * `LogContextAction` may include legacy actions that pre-date multi-select
 * (none currently) — the structural test
 * "every data-action has a matching case in _handleAction" pins both ends.
 */
/**
 * Disabled-tooltip text for a history-rewriting action whose target isn't
 * contained in the current branch. Mirrors IntelliJ's
 * `rebase.log.commit.editing.action.commit.not.in.head.error.text`.
 */
const NOT_IN_CURRENT_BRANCH_REASON = 'Commit is not in the current branch.';

export type MultiSelectMenuAction =
  | 'copyHash'
  | 'createPatch'
  | 'cherryPick'
  | 'checkoutRevision'
  | 'showRepoAtRevision'
  | 'compareWithLocal'
  | 'resetToHere'
  | 'revert'
  | 'undoCommit'
  | 'dropCommit'
  | 'editCommitMessage'
  | 'interactiveRebase'
  | 'squashCommits'
  | 'compareVersions'
  // compareWithBranch opens a QuickPick listing local + remote branches + tags
  // and routes through BranchComparisonView.
  // IntelliJ Git.Fixup.To.Commit / Git.Squash.Into.Commit: single-only.
  // Commit the staged changes as a `fixup!`/`squash!` of the selected commit.
  | 'fixup'
  | 'squashInto'
  | 'compareWithBranch'
  // IntelliJ Git.PushUpToHere: single-only (push up to selected commit).
  | 'pushUpToCommit'
  // G9: go-to-parent/child navigation — single-only (disabled in multi-select).
  | 'goToParent'
  | 'goToChild';

/**
 * Inputs for {@link computeMenuEnableState}. Centralised here so the
 * structural-guard surface in tests stays small.
 */
export interface IMultiSelectMenuInputs {
  /** Total number of selected commits, ≥ 0. */
  selectedCount: number;
  /**
   * `true` when the selected commits' display indices are consecutive
   * (no gaps). Caller computes via {@link isSelectionContiguous} on the
   * rendered `commitNodes` order.
   */
  isContiguous: boolean;
  /** `true` when the selection is N=1 AND that commit is HEAD. */
  isHeadInSelection: boolean;
  /** `true` when at least one selected commit has ≥ 2 parents (a merge). */
  hasMergeCommitInSelection: boolean;
  /**
   * `true` when EVERY selected commit is contained in the current branch (each
   * an ancestor of HEAD, inclusive). Gates the history-rewriting actions —
   * Fixup / Squash Into / squashCommits / dropCommit / editCommitMessage /
   * interactiveRebase — because each rebases `oldest^..HEAD` and silently moves
   * the checked-out branch when the target lives elsewhere. Mirrors IntelliJ
   * `GitCommitEditingActionBase.checkCommitsCanBeEdited`, which greys commits
   * not in HEAD. Defaults `true` when HEAD can't be resolved (merged scope /
   * HEAD off the loaded window) so we never falsely grey an editable commit.
   */
  isSelectedInCurrentBranch: boolean;
  /**
   * `true` when the selected commits form a single first-parent chain (one
   * branch's spine, no cross-branch mixing). Gates `squashCommits` on top of
   * {@link isContiguous}: a shift-range can be contiguous in display order yet
   * span interleaved branches, which squash must reject. Optional, defaulting
   * `true`, so fixtures that only exercise the contiguity/merge rules still
   * type-check (the chain gate then stays permissive). See
   * {@link isContiguousFirstParentChain}.
   */
  isFirstParentChain?: boolean;
}

/**
 * Slim view of a commit node sufficient for menu-state computation.
 * Keeps the helper module independent of the heavyweight `ICommitNode`
 * shape so the wire payload stays narrow and test fixtures stay tiny.
 */
export interface IMenuStateNode {
  /** Full 40-char hash (display order is implicit in array order). */
  hash: string;
  /**
   * Number of parent commits — `>= 2` denotes a merge commit, which the
   * `squashCommits` rule rejects regardless of contiguity.
   */
  parentCount: number;
  /**
   * Parent commit hashes (display order is implicit in array order). Used to
   * walk HEAD's ancestor set for the "commit is in the current branch" gate on
   * Fixup / Squash Into. Optional so existing fixtures/payloads that only carry
   * `parentCount` still type-check (the gate then defaults to enabled).
   */
  parents?: string[];
  /**
   * Absolute repository root the rendered row belongs to, in the merged
   * "All Repositories" log. Carried per-row so a commit-targeted action
   * resolves the repo of the row the user actually clicked — unlike a
   * hash-keyed index, this stays correct when a hash is shared across roots
   * (the index can only hold one root per hash, last-writer-wins).
   * `undefined` in single-repo / specific-scope logs, where rows carry no
   * source root.
   */
  repoRoot?: string;
}

/**
 * Inputs for {@link computeMenuState}. Carries everything the host needs
 * to derive the entire wire payload in one call.
 */
export interface IMenuStateInputs {
  /** Set of selected commit hashes. Order doesn't matter. */
  selectedHashes: ReadonlySet<string>;
  /** Display-ordered commit nodes (newest-first). */
  commitNodes: readonly IMenuStateNode[];
  /**
   * Hash of the current HEAD commit, or empty string when no commits are
   * loaded. Drives the `undoCommit` enable rule in single-repo / specific
   * scope.
   */
  headHash: string;
  /**
   * HEAD commit hashes of every root in the merged "All Repositories" log.
   * In merged scope there is no single HEAD (and {@link headHash} is empty,
   * because the misleading single-repo HEAD spine / highlight is suppressed),
   * so `undoCommit` enables when the clicked commit is the HEAD of ITS OWN
   * repo — i.e. a member of this set. Empty / omitted in single-repo scope,
   * where {@link headHash} alone drives the rule.
   */
  headHashes?: ReadonlySet<string>;
}

/**
 * Per-action visibility + enable flags as posted on the wire.
 *
 * `reason` is an optional human-readable explanation for
 * why the action is disabled. Refined the
 * contract:
 *
 *   - **Populated when `visible === true && enabled === false`** AND
 *     the rule that produced the disable knows why (squash needs N≥2
 *     / contiguous / no-merges; compareVersions needs N=2). Hidden
 *     rows leave `reason` undefined because they have no tooltip
 *     surface — the apply-loop never reads `reason` for them.
 *   - The webview JS surfaces it as a `title=` tooltip on the disabled
 * row via `applyMenuEnableMap`. Consumers that don't care
 *     can ignore it.
 * - will add reasons for repo-state gating ("target branch is
 * checked out"); may extend the shape further.
 *
 * (See the field-level docstring on `reason` for the post-locale TODO
 * Dropped the duplicate marker here so the type-shape change,
 * when it lands, has exactly one anchor.)
 */
export interface IMenuItemState {
  /** `true` when the menu item should render (not hidden via class). */
  visible: boolean;
  /** `true` when the menu item should be clickable (not `.disabled`). */
  enabled: boolean;
  /**
   * Optional disabled-state explanation. Populated only when
   * `visible === true && enabled === false`; omitted otherwise. Not
   * every visible-disabled state has a reason — trivially-implied
   * disables (e.g., "checkoutRevision needs N=1, the visibility flag
   * already hid it") leave it undefined. The webview surfaces it as a
   * `title=` tooltip on the disabled row.
   *
   * TODO(post-locale): when locale work begins, refactor `reason: string`
   * to a discriminated message-id union (e.g.
   * `{ id: 'squash-needs-2-commits' }`) so the webview can map ID →
   * localized string. Wire format frozen across locales.
   */
  reason?: string;
}

/**
 * Map from menu action to whether it should be visible at the given
 * `selectedCount`. `false` means the row is hidden via
 * `.menu-multi-hidden`. The opposite of "enabled" — even
 * visible items can still be `.disabled` per {@link computeMenuEnableState}.
 *
 * Single-only items (hidden when N≥2):
 *   editCommitMessage, undoCommit, checkoutRevision, showRepoAtRevision,
 *   compareWithLocal, mergeIntoCurrent, interactiveRebase, resetToHere
 * (resetToHere reclassified single-only — it targets one
 *   commit and "reset to N points" is incoherent).
 *
 * Multi-also items (visible at N≥1): cherryPick, revert, dropCommit,
 * createPatch, copyHash.
 *
 * Multi-only items: squashCommits (N≥2), compareVersions (N=2).
 */
export function computeMenuVisibility(
  selectedCount: number
): Record<MultiSelectMenuAction, boolean> {
  const isMulti = selectedCount >= 2;

  return {
    // Multi-also
    copyHash: selectedCount >= 1,
    createPatch: selectedCount >= 1,
    cherryPick: selectedCount >= 1,
    revert: selectedCount >= 1,
    dropCommit: selectedCount >= 1,
    // Single-only
    editCommitMessage: !isMulti,
    undoCommit: !isMulti,
    checkoutRevision: !isMulti,
    showRepoAtRevision: !isMulti,
    compareWithLocal: !isMulti,
    interactiveRebase: !isMulti,
    resetToHere: !isMulti,
    // Multi-only
    squashCommits: selectedCount >= 2,
    compareVersions: selectedCount === 2,
    // single-only IntelliJ-parity entries.
    fixup: !isMulti,
    squashInto: !isMulti,
    compareWithBranch: !isMulti,
    // IntelliJ Git.PushUpToHere — single-only.
    pushUpToCommit: !isMulti,
    // G9: go-to-parent/child navigation — single-only.
    goToParent: !isMulti,
    goToChild: !isMulti,
  };
}

/**
 * Map from menu action to whether it should be enabled (clickable) given
 * the current selection state. Hidden items still get a definitive answer
 * here — callers apply visibility first, then this enable map. Returning
 * a complete record (rather than a partial) keeps the consumer code in
 * `_getInlineScript` a single shape-check away from a TypeScript error
 * on missing actions.
 *
 * Rules (spec, A3):
 *   - editCommitMessage:    N=1
 *   - undoCommit:           N=1 AND HEAD
 *   - dropCommit:           N≥1
 *   - revert:               N≥1
 *   - cherryPick:           N≥1
 *   - squashCommits:        N≥2 AND contiguous AND no merge commit
 *   - compareVersions:      N=2
 *   - copyHash / createPatch:                       N≥1
 *   - mergeIntoCurrent / checkoutRevision /
 *     showRepoAtRevision / compareWithLocal /
 *     interactiveRebase / resetToHere:              N=1
 */
export function computeMenuEnableState(
  inputs: IMultiSelectMenuInputs
): Record<MultiSelectMenuAction, boolean> {
  const {
    selectedCount,
    isContiguous,
    isHeadInSelection,
    hasMergeCommitInSelection,
    isSelectedInCurrentBranch,
  } = inputs;
  const isFirstParentChain = inputs.isFirstParentChain ?? true;
  const isSingle = selectedCount === 1;
  const isAtLeastOne = selectedCount >= 1;
  const isAtLeastTwo = selectedCount >= 2;

  return {
    // N≥1 actions
    copyHash: isAtLeastOne,
    createPatch: isAtLeastOne,
    cherryPick: isAtLeastOne,
    revert: isAtLeastOne,
    // Drop must reject merge commits. Silent history-
    // flattening (a multi-parent commit dropped via interactive rebase
    // loses one parent's reachable history without warning) is a
    // footgun. Gate at the UI surface and again at the handler entry
    // (defence in depth).
    dropCommit: isAtLeastOne && !hasMergeCommitInSelection && isSelectedInCurrentBranch,
    // N=1 actions (resetToHere added here)
    editCommitMessage: isSingle && isSelectedInCurrentBranch,
    checkoutRevision: isSingle,
    showRepoAtRevision: isSingle,
    compareWithLocal: isSingle,
    interactiveRebase: isSingle && isSelectedInCurrentBranch,
    resetToHere: isSingle,
    // N=1 + HEAD
    undoCommit: isSingle && isHeadInSelection,
    // N≥2 + contiguous + single first-parent chain + no merges, all in HEAD
    squashCommits:
      isAtLeastTwo &&
      isContiguous &&
      isFirstParentChain &&
      !hasMergeCommitInSelection &&
      isSelectedInCurrentBranch,
    // N=2
    compareVersions: selectedCount === 2,
    // single-only IntelliJ-parity entries (Git.Fixup.To.Commit /
    // Git.Squash.Into.Commit). Mirroring
    // GitCommitEditingActionBase.checkCommitsEditingAvailability: greyed for a
    // merge commit, or a commit not in the current branch (not an ancestor of
    // HEAD). The handler also guards at perform-time.
    fixup: isSingle && !hasMergeCommitInSelection && isSelectedInCurrentBranch,
    squashInto: isSingle && !hasMergeCommitInSelection && isSelectedInCurrentBranch,
    compareWithBranch: isSingle,
    // IntelliJ Git.PushUpToHere — single-only.
    pushUpToCommit: isSingle,
    // G9: go-to-parent/child navigation — single-only.
    goToParent: isSingle,
    goToChild: isSingle,
  };
}

/**
 * Composite host-precomputed wire payload.
 *
 * Bundles {@link computeMenuVisibility} + {@link computeMenuEnableState}
 * into a single call that takes the raw selection state plus the
 * display-ordered `commitNodes` slice and returns the full per-action
 * state to post to the webview. Computes contiguity, HEAD membership,
 * and merge-commit detection internally so callers don't have to.
 *
 * The webview JS receiving this payload is a tiny apply-loop: it
 * iterates the record and toggles CSS classes per `(visible, enabled)`.
 * No rule duplication.
 *
 * Hashes in `selectedHashes` that aren't in `commitNodes` are silently
 * ignored (virtualization edge case where the selection includes a
 * scrolled-out commit). This matches {@link isSelectionContiguous}'s
 * tolerance.
 */
export function computeMenuState(
  inputs: IMenuStateInputs
): Record<MultiSelectMenuAction, IMenuItemState> {
  const { selectedHashes, commitNodes, headHash, headHashes } = inputs;

  // Project commitNodes to a hash list once for index lookups.
  const allHashes: string[] = [];
  const indexByHash = new Map<string, number>();
  for (let i = 0; i < commitNodes.length; i++) {
    allHashes.push(commitNodes[i].hash);
    indexByHash.set(commitNodes[i].hash, i);
  }

  // Filter selectedHashes to those actually in commitNodes.
  const knownSelected: string[] = [];
  for (const h of selectedHashes) {
    if (indexByHash.has(h)) {
      knownSelected.push(h);
    }
  }
  const selectedCount = knownSelected.length;

  // Contiguity check (no display-order gaps).
  const selectedSet = new Set(knownSelected);
  const isContiguous = isSelectionContiguous(selectedSet, allHashes);
  // First-parent-chain check (one branch's spine — rejects a display-contiguous
  // range that spans interleaved branches).
  const isFirstParentChain = isContiguousFirstParentChain(selectedSet, commitNodes);

  // HEAD-in-selection: only matters at N=1, but compute literally so the
  // input is consistent with computeMenuEnableState's contract. In merged
  // scope the single `headHash` is suppressed, so membership in the per-root
  // HEAD set (`headHashes`) keeps `undoCommit` enabled for the clicked
  // commit's own-repo HEAD.
  const isHeadInSelection =
    selectedCount === 1 &&
    ((knownSelected[0] === headHash && headHash !== '') ||
      (headHashes?.has(knownSelected[0]) ?? false));

  // Merge-commit detection.
  let hasMergeCommitInSelection = false;
  for (const h of knownSelected) {
    const idx = indexByHash.get(h);
    if (idx !== undefined && commitNodes[idx].parentCount >= 2) {
      hasMergeCommitInSelection = true;
      break;
    }
  }

  // "Contained in the current branch": is EVERY selected commit an ancestor of
  // HEAD (inclusive)? Walk HEAD's ancestors over the loaded window following
  // parent hashes. The log window is a topo-ordered prefix, so every descendant
  // of an in-window commit is also in-window — making this walk EXACT for any
  // right-clickable (in-window) commit. Defaults `true` when HEAD is unknown or
  // off the loaded window (merged scope / far-detached) so we never falsely grey
  // an editable commit.
  let isSelectedInCurrentBranch = true;
  if (selectedCount >= 1 && headHash !== '' && indexByHash.has(headHash)) {
    const reachable = new Set<string>();
    const stack = [headHash];
    while (stack.length > 0) {
      const h = stack.pop()!;
      if (reachable.has(h)) {
        continue;
      }
      reachable.add(h);
      const idx = indexByHash.get(h);
      if (idx === undefined) {
        continue; // parent scrolled off-window — a harmless dead-end
      }
      const parents = commitNodes[idx].parents;
      if (parents) {
        for (const p of parents) {
          if (!reachable.has(p)) {
            stack.push(p);
          }
        }
      }
    }
    isSelectedInCurrentBranch = knownSelected.every((h) => reachable.has(h));
  }

  const visibility = computeMenuVisibility(selectedCount);
  const enableState = computeMenuEnableState({
    selectedCount,
    isContiguous,
    isHeadInSelection,
    hasMergeCommitInSelection,
    isSelectedInCurrentBranch,
    isFirstParentChain,
  });

  // Derive a human-readable disabled reason for the
  // multi-only actions whose enable rules are non-trivial.
  //
  // dead-code cleanup. The narrowing
  // `visible && !enabled` makes two earlier branches unreachable:
  //   - `squashReason` at `selectedCount < 2` produced "Squash needs at
  //     least 2 commits"; squashCommits is hidden when N<2 (visibility
  //     flag), so the gate excludes it.
  //   - `compareVersionsReason` was always set when N!=2; compareVersions
  //     is hidden whenever N!=2, so it's never visible+disabled — the
  //     reason was never reachable.
  // Both are deleted here. If a future spec needs a compareVersions
  // tooltip, it will be a new visible-disabled state to add then.
  const squashReason = ((): string | undefined => {
    if (hasMergeCommitInSelection) {
      return 'Squash cannot include merge commits.';
    }
    if (!isContiguous) {
      return 'Squash needs contiguous (consecutive) commits — gaps in the selection are not supported.';
    }
    if (!isFirstParentChain) {
      return 'Squash needs commits on a single branch (one first-parent chain) — the selection spans branches.';
    }
    if (!isSelectedInCurrentBranch) {
      return NOT_IN_CURRENT_BRANCH_REASON;
    }
    return undefined;
  })();

  // Explain why drop is disabled: a merge commit in the selection, or a commit
  // that isn't in the current branch. Only populated when visible+disabled
  // (narrowing in the apply loop below); other dropCommit disables (N=0) hide
  // the row entirely so no reason is needed.
  const dropReason = ((): string | undefined => {
    if (hasMergeCommitInSelection) {
      return 'Drop cannot include merge commits — use Reset to a non-merge ancestor instead.';
    }
    if (!isSelectedInCurrentBranch) {
      return NOT_IN_CURRENT_BRANCH_REASON;
    }
    return undefined;
  })();

  // Explain why Fixup / Squash Into are disabled (IntelliJ greys them for a
  // merge commit or a commit that isn't in the current branch).
  const commitEditReason = ((): string | undefined => {
    if (hasMergeCommitInSelection) {
      return 'Cannot fixup/squash a merge commit.';
    }
    if (!isSelectedInCurrentBranch) {
      return NOT_IN_CURRENT_BRANCH_REASON;
    }
    return undefined;
  })();

  // editCommitMessage / interactiveRebase are single-only; their only
  // non-trivial visible-disabled cause is a target outside the current branch.
  const rewriteReason = !isSelectedInCurrentBranch ? NOT_IN_CURRENT_BRANCH_REASON : undefined;

  // Walk all action keys via the visibility record so the result is
  // statically guaranteed to cover every MultiSelectMenuAction.
  const result = {} as Record<MultiSelectMenuAction, IMenuItemState>;
  (Object.keys(visibility) as MultiSelectMenuAction[]).forEach((action) => {
    const visible = visibility[action];
    const enabled = enableState[action];
    const entry: IMenuItemState = { visible, enabled };
    // Attach `reason` only when the row is BOTH
    // visible AND disabled. Hidden rows have no tooltip surface — the
    // webview apply-loop only reads `reason` for visible rows — so
    // shipping a string for hidden rows would just bloat the wire
    // payload with a string the consumer can't surface anyway.
    if (visible && !enabled) {
      let reason: string | undefined;
      if (action === 'squashCommits') {
        reason = squashReason;
      } else if (action === 'dropCommit') {
        // merge-commit + current-branch gate.
        reason = dropReason;
      } else if (action === 'fixup' || action === 'squashInto') {
        reason = commitEditReason;
      } else if (action === 'editCommitMessage' || action === 'interactiveRebase') {
        // Current-branch gate (their only non-trivial visible-disabled cause).
        reason = rewriteReason;
      }
      // compareVersions has no visible+disabled state by
      // construction, so no branch here. Other actions have trivial
      // reasons ("needs N=1") that the visibility-driven hide already
      // conveys. Will add reasons for them as repo-state
      // gating lands.
      if (reason !== undefined) {
        entry.reason = reason;
      }
    }
    result[action] = entry;
  });
  return result;
}

/**
 * Inclusive range from `anchorHash` to `clickHash` in display order.
 *
 * Display order is whatever order `allHashes` is in — callers project
 * `commitNodes.map(n => n.commit.hash)` (newest-first) here so range
 * semantics match what the user sees.
 *
 * Edge cases:
 *   - `clickHash` not in `allHashes` (caller bug) → return `[]`.
 *   - `anchorHash` is `null` → return `[clickHash]` (plain-click fallback).
 *   - `anchorHash` not in `allHashes` (scrolled out / virtualized away) →
 *     return `[clickHash]`.
 *
 * Order of the returned array follows `allHashes` (so the caller can iterate
 * to highlight rows top-to-bottom regardless of which end the user clicked).
 */
export function computeRangeSelection(
  anchorHash: string | null,
  clickHash: string,
  allHashes: readonly string[]
): string[] {
  const clickIdx = allHashes.indexOf(clickHash);
  if (clickIdx === -1) {
    return [];
  }
  if (anchorHash === null) {
    return [clickHash];
  }
  const anchorIdx = allHashes.indexOf(anchorHash);
  if (anchorIdx === -1) {
    return [clickHash];
  }
  const lo = Math.min(anchorIdx, clickIdx);
  const hi = Math.max(anchorIdx, clickIdx);
  return allHashes.slice(lo, hi + 1);
}

/**
 * `true` when the indices of `selectedHashes` (within `allHashes`) form a
 * consecutive run with no gaps. `false` for empty selections (a single
 * commit is trivially contiguous, but with `selectedCount < 2` the
 * `squashCommits` rule already rejects it). Hashes not present in
 * `allHashes` are ignored — callers should keep the projection tight.
 */
export function isSelectionContiguous(
  selectedHashes: ReadonlySet<string>,
  allHashes: readonly string[]
): boolean {
  const indices: number[] = [];
  for (const hash of selectedHashes) {
    const idx = allHashes.indexOf(hash);
    if (idx !== -1) {
      indices.push(idx);
    }
  }
  if (indices.length === 0) {
    return false;
  }
  indices.sort((a, b) => a - b);
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] - indices[i - 1] !== 1) {
      return false;
    }
  }
  return true;
}

/**
 * `true` when the selected commits form a single FIRST-PARENT chain — each
 * adjacent pair (in display order) is linked first-parent to child. This is the
 * squash/edit linearity rule: the commits lie on one branch's spine, so a
 * shift-range that is contiguous in display order yet mixes interleaved
 * branches/lanes (the reported "squash selects commits from all branches" bug)
 * is rejected. Mirrors IntelliJ `GitCommitEditingActionBase.checkHeadLinearHistory`,
 * which requires the selected commits to lie on HEAD's linear, merge-free path.
 *
 * The adjacency is checked in BOTH directions (`a.parents[0] === b` OR
 * `b.parents[0] === a`) so the result is independent of whether `commitNodes`
 * is ordered newest- or oldest-first. Verifying needs first-parent info: when
 * NEITHER node in a pair carries a usable `parents` array the link can't be
 * checked, so it's treated as valid (lenient — the display-order contiguity +
 * merge-commit gates still apply). One commit (or none) is trivially a chain;
 * hashes absent from `commitNodes` are ignored.
 */
export function isContiguousFirstParentChain(
  selectedHashes: ReadonlySet<string>,
  commitNodes: readonly IMenuStateNode[]
): boolean {
  const selected: IMenuStateNode[] = [];
  for (const node of commitNodes) {
    if (selectedHashes.has(node.hash)) {
      selected.push(node);
    }
  }
  for (let i = 0; i < selected.length - 1; i++) {
    const a = selected[i];
    const b = selected[i + 1];
    const aParent = a.parents?.[0];
    const bParent = b.parents?.[0];
    // No usable parent info on either side → can't verify, treat as connected.
    if (aParent === undefined && bParent === undefined) {
      continue;
    }
    if (aParent !== b.hash && bParent !== a.hash) {
      return false;
    }
  }
  return true;
}
