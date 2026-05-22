/**
 * Pure helpers for multi-commit selection in the Git Tool Window.
 *
 * Wave A introduces IntelliJ-parity multi-select on the log/graph:
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
 * Architectural invariant (R1, ADR-009): the **host** is the source of
 * truth for menu visibility/enable state. The webview JS does NOT mirror
 * the rules — instead the host calls {@link computeMenuState} and posts
 * the result via the `updateMenuEnableState` message; the JS just applies
 * the precomputed map by toggling CSS classes. This eliminates the
 * "two copies of the rules drift apart" failure mode that R1 review
 * flagged (TL-H-2/H-3/H-4 + Senior M-3).
 */

/**
 * All right-click menu actions that participate in multi-select gating.
 *
 * The 13 single-select originals plus the two new multi-select-only
 * actions introduced in Wave A: `squashCommits` (N≥2 contiguous) and
 * `compareVersions` (N=2).
 *
 * Relationship to {@link import('./GitToolWindowProvider').LogContextAction}
 * (R1 TL-L-3): every member of this union is also a member of
 * `LogContextAction` so the cast at `_handleCommitContextMenu` is safe.
 * `LogContextAction` may include legacy actions that pre-date multi-select
 * (none currently) — the structural test
 * "every data-action has a matching case in _handleAction" pins both ends.
 */
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
  | 'mergeIntoCurrent'
  | 'interactiveRebase'
  | 'squashCommits'
  | 'compareVersions';

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
   * loaded. Drives the `undoCommit` enable rule.
   */
  headHash: string;
}

/**
 * Per-action visibility + enable flags as posted on the wire.
 *
 * R3 (TL2-M-3): `reason` is an optional human-readable explanation for
 * why the action is disabled. R4 (Senior M-2 + TL3-H-1) refined the
 * contract:
 *
 *   - **Populated when `visible === true && enabled === false`** AND
 *     the rule that produced the disable knows why (squash needs N≥2
 *     / contiguous / no-merges; compareVersions needs N=2). Hidden
 *     rows leave `reason` undefined because they have no tooltip
 *     surface — the apply-loop never reads `reason` for them.
 *   - The webview JS surfaces it as a `title=` tooltip on the disabled
 *     row via `applyMenuEnableMap` (R4-1). Consumers that don't care
 *     can ignore it.
 *   - Wave B will add reasons for repo-state gating ("target branch is
 *     checked out"); Wave C may extend the shape further.
 *
 * (See the field-level docstring on `reason` for the post-locale TODO
 * — R5-4 dropped the duplicate marker here so the type-shape change,
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
 * `.menu-multi-hidden` (A2 rule). The opposite of "enabled" — even
 * visible items can still be `.disabled` per {@link computeMenuEnableState}.
 *
 * Single-only items (hidden when N≥2):
 *   editCommitMessage, undoCommit, checkoutRevision, showRepoAtRevision,
 *   compareWithLocal, mergeIntoCurrent, interactiveRebase, resetToHere
 *   (R1 H-1: resetToHere reclassified single-only — it targets one
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
    mergeIntoCurrent: !isMulti,
    interactiveRebase: !isMulti,
    resetToHere: !isMulti,
    // Multi-only
    squashCommits: selectedCount >= 2,
    compareVersions: selectedCount === 2,
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
 * Rules (Wave A spec, A3):
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
  const { selectedCount, isContiguous, isHeadInSelection, hasMergeCommitInSelection } = inputs;
  const isSingle = selectedCount === 1;
  const isAtLeastOne = selectedCount >= 1;
  const isAtLeastTwo = selectedCount >= 2;

  return {
    // N≥1 actions
    copyHash: isAtLeastOne,
    createPatch: isAtLeastOne,
    cherryPick: isAtLeastOne,
    revert: isAtLeastOne,
    dropCommit: isAtLeastOne,
    // N=1 actions (R1 H-1: resetToHere added here)
    editCommitMessage: isSingle,
    checkoutRevision: isSingle,
    showRepoAtRevision: isSingle,
    compareWithLocal: isSingle,
    mergeIntoCurrent: isSingle,
    interactiveRebase: isSingle,
    resetToHere: isSingle,
    // N=1 + HEAD
    undoCommit: isSingle && isHeadInSelection,
    // N≥2 + contiguous + no merges
    squashCommits: isAtLeastTwo && isContiguous && !hasMergeCommitInSelection,
    // N=2
    compareVersions: selectedCount === 2,
  };
}

/**
 * R1 — Composite host-precomputed wire payload.
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
  const { selectedHashes, commitNodes, headHash } = inputs;

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

  // Contiguity check.
  const isContiguous = isSelectionContiguous(new Set(knownSelected), allHashes);

  // HEAD-in-selection: only matters at N=1, but compute literally so the
  // input is consistent with computeMenuEnableState's contract.
  const isHeadInSelection = selectedCount === 1 && knownSelected[0] === headHash && headHash !== '';

  // Merge-commit detection.
  let hasMergeCommitInSelection = false;
  for (const h of knownSelected) {
    const idx = indexByHash.get(h);
    if (idx !== undefined && commitNodes[idx].parentCount >= 2) {
      hasMergeCommitInSelection = true;
      break;
    }
  }

  const visibility = computeMenuVisibility(selectedCount);
  const enableState = computeMenuEnableState({
    selectedCount,
    isContiguous,
    isHeadInSelection,
    hasMergeCommitInSelection,
  });

  // R3 (TL2-M-3) — derive a human-readable disabled reason for the
  // multi-only actions whose enable rules are non-trivial.
  //
  // R5-2 (Senior L-1) — dead-code cleanup. The R4-2 narrowing
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
    return undefined;
  })();

  // Walk all action keys via the visibility record so the result is
  // statically guaranteed to cover every MultiSelectMenuAction.
  const result = {} as Record<MultiSelectMenuAction, IMenuItemState>;
  (Object.keys(visibility) as MultiSelectMenuAction[]).forEach((action) => {
    const visible = visibility[action];
    const enabled = enableState[action];
    const entry: IMenuItemState = { visible, enabled };
    // R4-2 (Senior M-2): attach `reason` only when the row is BOTH
    // visible AND disabled. Hidden rows have no tooltip surface — the
    // webview apply-loop only reads `reason` for visible rows — so
    // shipping a string for hidden rows would just bloat the wire
    // payload with a string the consumer can't surface anyway.
    if (visible && !enabled) {
      let reason: string | undefined;
      if (action === 'squashCommits') {
        reason = squashReason;
      }
      // R5-2: compareVersions has no visible+disabled state by
      // construction, so no branch here. Other actions have trivial
      // reasons ("needs N=1") that the visibility-driven hide already
      // conveys. Wave B/C will add reasons for them as repo-state
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
