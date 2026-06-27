/**
 * Multi-select selection UX tests.
 *
 * Covers the pure helpers in `services/gitToolWindow/multiSelect.ts`:
 *   - computeMenuVisibility   (A2 — single-only / multi-also / multi-only)
 *   - computeMenuEnableState  (A3 — per-action enable rules)
 *   - computeRangeSelection   (A1 — anchor → click range)
 *   - isSelectionContiguous   (A3 supporting predicate)
 * - computeMenuState (composite host-precomputed wire payload)
 *
 * The DOM-coupled bits (A0 menu disable wiring, A4 details-header text,
 * `_extendedLogState.anchorHash`) are tested via the provider-level specs
 * elsewhere in this file tree; here we drive the pure logic directly.
 */

import '../../../setup';
import * as assert from 'assert';
import {
  computeMenuVisibility,
  computeMenuEnableState,
  computeMenuState,
  computeRangeSelection,
  isSelectionContiguous,
  isContiguousFirstParentChain,
  type MultiSelectMenuAction,
  type IMenuStateInputs,
} from '../../../../src/git-core/gitToolWindow/multiSelect';

describe('multiSelect — pure helpers', () => {
  // ─── A1: computeRangeSelection ───────────────────────────────────────────
  describe('computeRangeSelection (A1 — shift+click range)', () => {
    const hashes = ['a', 'b', 'c', 'd', 'e'];

    it('returns [click] when anchor is null (first-click fallback)', () => {
      assert.deepStrictEqual(computeRangeSelection(null, 'c', hashes), ['c']);
    });

    it('returns inclusive range from anchor down to click in display order', () => {
      // anchor=b (idx 1), click=d (idx 3) → [b, c, d]
      assert.deepStrictEqual(computeRangeSelection('b', 'd', hashes), ['b', 'c', 'd']);
    });

    it('returns inclusive range from click up to anchor (reverse direction)', () => {
      // anchor=d (idx 3), click=b (idx 1) → [b, c, d] (display order)
      assert.deepStrictEqual(computeRangeSelection('d', 'b', hashes), ['b', 'c', 'd']);
    });

    it('returns [click] when anchor=click (zero-length range collapses to single)', () => {
      assert.deepStrictEqual(computeRangeSelection('c', 'c', hashes), ['c']);
    });

    it('returns full list when anchor and click are the endpoints', () => {
      assert.deepStrictEqual(computeRangeSelection('a', 'e', hashes), ['a', 'b', 'c', 'd', 'e']);
    });

    it('falls back to [click] when anchor scrolled out of rendered list (virtualization)', () => {
      // anchor was 'z', no longer in the rendered array.
      assert.deepStrictEqual(computeRangeSelection('z', 'c', hashes), ['c']);
    });

    it('returns [] when click hash not in list (caller bug guard)', () => {
      assert.deepStrictEqual(computeRangeSelection('a', 'zz', hashes), []);
    });
  });

  // ─── A3 supporting: isSelectionContiguous ────────────────────────────────
  describe('isSelectionContiguous (A3 supporting predicate)', () => {
    const hashes = ['a', 'b', 'c', 'd', 'e'];

    it('returns true for two adjacent commits', () => {
      assert.strictEqual(isSelectionContiguous(new Set(['b', 'c']), hashes), true);
    });

    it('returns true for three consecutive commits in display order', () => {
      assert.strictEqual(isSelectionContiguous(new Set(['b', 'c', 'd']), hashes), true);
    });

    it('returns true regardless of insertion order into the Set', () => {
      // Set iteration order != display order — helper must sort indices.
      assert.strictEqual(isSelectionContiguous(new Set(['d', 'b', 'c']), hashes), true);
    });

    it('returns false when there is a gap', () => {
      // a (0) and c (2) skip b (1) → gap of 1 → not contiguous.
      assert.strictEqual(isSelectionContiguous(new Set(['a', 'c']), hashes), false);
    });

    it('returns false for an empty selection', () => {
      assert.strictEqual(isSelectionContiguous(new Set<string>(), hashes), false);
    });

    it('returns true for a single-element selection (degenerate)', () => {
      // Single index has no gap; A3 enable rule guards N≥2 separately.
      assert.strictEqual(isSelectionContiguous(new Set(['c']), hashes), true);
    });

    it('ignores hashes not present in display list (virtualization safety)', () => {
      assert.strictEqual(isSelectionContiguous(new Set(['b', 'zz', 'c']), hashes), true);
    });
  });

  // ─── A2: computeMenuVisibility ───────────────────────────────────────────
  describe('computeMenuVisibility (A2 — show/hide per N)', () => {
    it('hides single-only items when N≥2', () => {
      const v = computeMenuVisibility(3);
      const singleOnly: MultiSelectMenuAction[] = [
        'editCommitMessage',
        'undoCommit',
        'checkoutRevision',
        'showRepoAtRevision',
        'compareWithLocal',
        'interactiveRebase',
        // resetToHere is now single-only too.
        'resetToHere',
      ];
      for (const a of singleOnly) {
        assert.strictEqual(v[a], false, `${a} should be hidden at N=3`);
      }
    });

    it('shows single-only items when N=1', () => {
      const v = computeMenuVisibility(1);
      const singleOnly: MultiSelectMenuAction[] = [
        'editCommitMessage',
        'undoCommit',
        'checkoutRevision',
        'showRepoAtRevision',
        'compareWithLocal',
        'interactiveRebase',
        'resetToHere',
      ];
      for (const a of singleOnly) {
        assert.strictEqual(v[a], true, `${a} should be visible at N=1`);
      }
    });

    it('shows multi-also items at any N≥1', () => {
      // resetToHere moved out; multi-also is now the cross-N actions only.
      const multiAlso: MultiSelectMenuAction[] = [
        'cherryPick',
        'revert',
        'dropCommit',
        'createPatch',
        'copyHash',
      ];
      for (const n of [1, 2, 5]) {
        const v = computeMenuVisibility(n);
        for (const a of multiAlso) {
          assert.strictEqual(v[a], true, `${a} should be visible at N=${n}`);
        }
      }
    });

    it('shows squashCommits only at N≥2', () => {
      assert.strictEqual(computeMenuVisibility(1).squashCommits, false);
      assert.strictEqual(computeMenuVisibility(2).squashCommits, true);
      assert.strictEqual(computeMenuVisibility(5).squashCommits, true);
    });

    it('shows compareVersions only at N=2', () => {
      assert.strictEqual(computeMenuVisibility(1).compareVersions, false);
      assert.strictEqual(computeMenuVisibility(2).compareVersions, true);
      assert.strictEqual(computeMenuVisibility(3).compareVersions, false);
    });
  });

  // ─── A0/A3: computeMenuEnableState ───────────────────────────────────────
  describe('computeMenuEnableState (A3 — per-action enable rules)', () => {
    const baseInputs = {
      selectedCount: 0,
      isContiguous: false,
      isHeadInSelection: false,
      hasMergeCommitInSelection: false,
      isSelectedInCurrentBranch: true,
    };

    it('A0 — enables editCommitMessage when N=1 (regression for line 3650 hard-disable)', () => {
      const e = computeMenuEnableState({ ...baseInputs, selectedCount: 1 });
      assert.strictEqual(
        e.editCommitMessage,
        true,
        'editCommitMessage MUST be enabled when exactly one commit is selected'
      );
    });

    it('A0 — disables editCommitMessage when N=0', () => {
      const e = computeMenuEnableState({ ...baseInputs, selectedCount: 0 });
      assert.strictEqual(e.editCommitMessage, false);
    });

    it('A0 — disables editCommitMessage when N≥2', () => {
      const e = computeMenuEnableState({ ...baseInputs, selectedCount: 3 });
      assert.strictEqual(e.editCommitMessage, false);
    });

    it('enables undoCommit only when N=1 AND HEAD', () => {
      const headSingle = computeMenuEnableState({
        ...baseInputs,
        selectedCount: 1,
        isHeadInSelection: true,
      });
      assert.strictEqual(headSingle.undoCommit, true);

      const nonHeadSingle = computeMenuEnableState({
        ...baseInputs,
        selectedCount: 1,
        isHeadInSelection: false,
      });
      assert.strictEqual(nonHeadSingle.undoCommit, false);

      const multi = computeMenuEnableState({
        ...baseInputs,
        selectedCount: 3,
        isHeadInSelection: true,
      });
      assert.strictEqual(multi.undoCommit, false, 'HEAD-flag must be ignored for N>=2');
    });

    it('enables dropCommit / revert / cherryPick for any N≥1', () => {
      const single = computeMenuEnableState({ ...baseInputs, selectedCount: 1 });
      const multi = computeMenuEnableState({ ...baseInputs, selectedCount: 4 });
      assert.strictEqual(single.dropCommit, true);
      assert.strictEqual(single.revert, true);
      assert.strictEqual(single.cherryPick, true);
      assert.strictEqual(multi.dropCommit, true);
      assert.strictEqual(multi.revert, true);
      assert.strictEqual(multi.cherryPick, true);
    });

    it('disables N≥1 actions when selection is empty', () => {
      const e = computeMenuEnableState(baseInputs);
      assert.strictEqual(e.cherryPick, false);
      assert.strictEqual(e.dropCommit, false);
      assert.strictEqual(e.revert, false);
      assert.strictEqual(e.copyHash, false);
      assert.strictEqual(e.createPatch, false);
    });

    it('enables Fixup / Squash Into only for a single non-merge commit in the current branch', () => {
      const ok = computeMenuEnableState({
        ...baseInputs,
        selectedCount: 1,
        isSelectedInCurrentBranch: true,
        hasMergeCommitInSelection: false,
      });
      assert.strictEqual(ok.fixup, true);
      assert.strictEqual(ok.squashInto, true);
    });

    it('greys Fixup / Squash Into for a merge commit (IntelliJ checkNotMergeCommit)', () => {
      const merge = computeMenuEnableState({
        ...baseInputs,
        selectedCount: 1,
        isSelectedInCurrentBranch: true,
        hasMergeCommitInSelection: true,
      });
      assert.strictEqual(merge.fixup, false);
      assert.strictEqual(merge.squashInto, false);
    });

    it('greys Fixup / Squash Into for a commit not in the current branch', () => {
      const offHead = computeMenuEnableState({
        ...baseInputs,
        selectedCount: 1,
        isSelectedInCurrentBranch: false,
      });
      assert.strictEqual(offHead.fixup, false);
      assert.strictEqual(offHead.squashInto, false);
    });

    // Drop must reject merge commits. Silent history-flattening
    // (a multi-parent commit dropped via interactive rebase loses one
    // parent's reachable history without warning) is a footgun, so the UI
    // disables the action entirely. Tooltip surfaces the reason via
    // computeMenuState.
    it('Wave C D3 — disables dropCommit when any selected commit is a merge', () => {
      const cleanSingle = computeMenuEnableState({ ...baseInputs, selectedCount: 1 });
      const cleanMulti = computeMenuEnableState({ ...baseInputs, selectedCount: 3 });
      assert.strictEqual(cleanSingle.dropCommit, true);
      assert.strictEqual(cleanMulti.dropCommit, true);

      const mergeSingle = computeMenuEnableState({
        ...baseInputs,
        selectedCount: 1,
        hasMergeCommitInSelection: true,
      });
      const mergeMulti = computeMenuEnableState({
        ...baseInputs,
        selectedCount: 3,
        hasMergeCommitInSelection: true,
      });
      assert.strictEqual(
        mergeSingle.dropCommit,
        false,
        'drop on a merge commit must be disabled (defence-in-depth at single-select too)'
      );
      assert.strictEqual(
        mergeMulti.dropCommit,
        false,
        'drop on a multi-select containing a merge commit must be disabled'
      );
    });

    it('enables squashCommits only when N≥2 AND contiguous AND no merges', () => {
      const ok = computeMenuEnableState({
        ...baseInputs,
        selectedCount: 3,
        isContiguous: true,
        hasMergeCommitInSelection: false,
      });
      assert.strictEqual(ok.squashCommits, true);

      const tooFew = computeMenuEnableState({
        ...baseInputs,
        selectedCount: 1,
        isContiguous: true,
      });
      assert.strictEqual(tooFew.squashCommits, false);

      const gap = computeMenuEnableState({
        ...baseInputs,
        selectedCount: 3,
        isContiguous: false,
      });
      assert.strictEqual(gap.squashCommits, false);

      const merge = computeMenuEnableState({
        ...baseInputs,
        selectedCount: 3,
        isContiguous: true,
        hasMergeCommitInSelection: true,
      });
      assert.strictEqual(
        merge.squashCommits,
        false,
        'squash must reject merge commits even when N>=2 and contiguous'
      );
    });

    it('enables compareVersions only at exactly N=2', () => {
      assert.strictEqual(
        computeMenuEnableState({ ...baseInputs, selectedCount: 2 }).compareVersions,
        true
      );
      assert.strictEqual(
        computeMenuEnableState({ ...baseInputs, selectedCount: 1 }).compareVersions,
        false
      );
      assert.strictEqual(
        computeMenuEnableState({ ...baseInputs, selectedCount: 3 }).compareVersions,
        false
      );
    });

    it('disables resetToHere at N≥2 (single-commit-only action)', () => {
      const single = computeMenuEnableState({ ...baseInputs, selectedCount: 1 });
      const multi = computeMenuEnableState({ ...baseInputs, selectedCount: 3 });
      assert.strictEqual(single.resetToHere, true);
      assert.strictEqual(multi.resetToHere, false);
    });

    it('enables N=1-only actions only when N=1', () => {
      // resetToHere reclassified single-only.
      const singleOnly: MultiSelectMenuAction[] = [
        'checkoutRevision',
        'showRepoAtRevision',
        'compareWithLocal',
        'interactiveRebase',
        'resetToHere',
      ];
      const single = computeMenuEnableState({ ...baseInputs, selectedCount: 1 });
      const multi = computeMenuEnableState({ ...baseInputs, selectedCount: 3 });
      for (const a of singleOnly) {
        assert.strictEqual(single[a], true, `${a} should be enabled at N=1`);
        assert.strictEqual(multi[a], false, `${a} should be disabled at N=3`);
      }
    });

    it('returns a complete record (every action key present)', () => {
      const e = computeMenuEnableState({ ...baseInputs, selectedCount: 1 });
      const expectedKeys: MultiSelectMenuAction[] = [
        'copyHash',
        'createPatch',
        'cherryPick',
        'checkoutRevision',
        'showRepoAtRevision',
        'compareWithLocal',
        'resetToHere',
        'revert',
        'undoCommit',
        'dropCommit',
        'editCommitMessage',
        'interactiveRebase',
        'squashCommits',
        'compareVersions',
      ];
      for (const k of expectedKeys) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(e, k),
          `enable state must include key "${k}"`
        );
      }
    });
  });

  // ───: computeMenuState — composite wire payload ───────────────────────
  describe('computeMenuState (R1 — host-precomputed visibility+enable map)', () => {
    function mkNode(hash: string, parentCount = 1): { hash: string; parentCount: number } {
      return { hash, parentCount };
    }

    const nodes = [mkNode('aaa'), mkNode('bbb'), mkNode('ccc'), mkNode('ddd'), mkNode('eee')];

    it('returns one entry per MultiSelectMenuAction with both visible and enabled flags', () => {
      const inputs: IMenuStateInputs = {
        selectedHashes: new Set(['ccc']),
        commitNodes: nodes,
        headHash: 'aaa',
      };
      const state = computeMenuState(inputs);
      const keys: MultiSelectMenuAction[] = [
        'copyHash',
        'createPatch',
        'cherryPick',
        'checkoutRevision',
        'showRepoAtRevision',
        'compareWithLocal',
        'resetToHere',
        'revert',
        'undoCommit',
        'dropCommit',
        'editCommitMessage',
        'interactiveRebase',
        'squashCommits',
        'compareVersions',
      ];
      for (const k of keys) {
        assert.ok(state[k], `state[${k}] missing`);
        assert.strictEqual(typeof state[k].visible, 'boolean', `${k}.visible not boolean`);
        assert.strictEqual(typeof state[k].enabled, 'boolean', `${k}.enabled not boolean`);
      }
    });

    it('A0 wire-payload — single selection enables editCommitMessage', () => {
      const state = computeMenuState({
        selectedHashes: new Set(['bbb']),
        commitNodes: nodes,
        headHash: 'aaa',
      });
      assert.strictEqual(state.editCommitMessage.visible, true);
      assert.strictEqual(state.editCommitMessage.enabled, true);
    });

    it('infers HEAD membership from selection vs headHash', () => {
      const headSelected = computeMenuState({
        selectedHashes: new Set(['aaa']),
        commitNodes: nodes,
        headHash: 'aaa',
      });
      assert.strictEqual(headSelected.undoCommit.enabled, true);

      const nonHead = computeMenuState({
        selectedHashes: new Set(['bbb']),
        commitNodes: nodes,
        headHash: 'aaa',
      });
      assert.strictEqual(nonHead.undoCommit.enabled, false);
    });

    it('enables Fixup/Squash for an ancestor of HEAD, greys an off-branch commit', () => {
      // HEAD=aaa → bbb → ccc (linear); xxx is on another branch (not an
      // ancestor of HEAD). Reachability walks parents from HEAD over the window.
      const chain = [
        { hash: 'aaa', parentCount: 1, parents: ['bbb'] },
        { hash: 'bbb', parentCount: 1, parents: ['ccc'] },
        { hash: 'ccc', parentCount: 0, parents: [] },
        { hash: 'xxx', parentCount: 0, parents: [] },
      ];
      const ancestor = computeMenuState({
        selectedHashes: new Set(['ccc']),
        commitNodes: chain,
        headHash: 'aaa',
      });
      assert.strictEqual(ancestor.fixup.enabled, true, 'ancestor of HEAD is editable');
      assert.strictEqual(ancestor.squashInto.enabled, true);

      const offBranch = computeMenuState({
        selectedHashes: new Set(['xxx']),
        commitNodes: chain,
        headHash: 'aaa',
      });
      assert.strictEqual(offBranch.fixup.enabled, false, 'off-branch commit is greyed');
      assert.strictEqual(offBranch.squashInto.enabled, false);
    });

    it('does not grey Fixup/Squash when HEAD is off the loaded window (no false-grey)', () => {
      // headHash not present in commitNodes → reachability unknown → default
      // enabled rather than greying a possibly-editable commit.
      const state = computeMenuState({
        selectedHashes: new Set(['bbb']),
        commitNodes: [
          { hash: 'bbb', parentCount: 1, parents: ['ccc'] },
          { hash: 'ccc', parentCount: 0, parents: [] },
        ],
        headHash: 'zzz-not-in-window',
      });
      assert.strictEqual(state.fixup.enabled, true);
      assert.strictEqual(state.squashInto.enabled, true);
    });

    it('enables undoCommit in merged scope when the selected commit is any root HEAD (headHash suppressed)', () => {
      // Merged "All Repositories": the single-repo HEAD spine/highlight is
      // suppressed (headHash ''), so undoCommit decouples to per-root HEAD
      // membership — 'ccc' is repo B's HEAD even though no single headHash is set.
      const onRootHead = computeMenuState({
        selectedHashes: new Set(['ccc']),
        commitNodes: nodes,
        headHash: '',
        headHashes: new Set(['aaa', 'ccc']),
      });
      assert.strictEqual(onRootHead.undoCommit.enabled, true);
    });

    it('leaves undoCommit disabled in merged scope when the selected commit is no root HEAD', () => {
      const offAllHeads = computeMenuState({
        selectedHashes: new Set(['bbb']),
        commitNodes: nodes,
        headHash: '',
        headHashes: new Set(['aaa', 'ccc']),
      });
      assert.strictEqual(offAllHeads.undoCommit.enabled, false);
    });

    it('squashCommits enabled when 3 contiguous non-merge commits selected', () => {
      const state = computeMenuState({
        selectedHashes: new Set(['bbb', 'ccc', 'ddd']),
        commitNodes: nodes,
        headHash: 'aaa',
      });
      assert.strictEqual(state.squashCommits.enabled, true);
      assert.strictEqual(state.squashCommits.visible, true);
    });

    it('squashCommits disabled when selection has a gap', () => {
      const state = computeMenuState({
        selectedHashes: new Set(['bbb', 'ddd']), // skips ccc
        commitNodes: nodes,
        headHash: 'aaa',
      });
      assert.strictEqual(state.squashCommits.enabled, false);
    });

    it('squashCommits disabled when any selected commit is a merge (parents>=2)', () => {
      const withMerge = [
        mkNode('aaa'),
        mkNode('bbb'),
        { hash: 'ccc', parentCount: 2 }, // merge
        mkNode('ddd'),
      ];
      const state = computeMenuState({
        selectedHashes: new Set(['bbb', 'ccc', 'ddd']),
        commitNodes: withMerge,
        headHash: 'aaa',
      });
      assert.strictEqual(state.squashCommits.enabled, false);
    });

    it('compareVersions enabled at N=2, disabled otherwise', () => {
      const at2 = computeMenuState({
        selectedHashes: new Set(['bbb', 'ccc']),
        commitNodes: nodes,
        headHash: 'aaa',
      });
      assert.strictEqual(at2.compareVersions.enabled, true);
      assert.strictEqual(at2.compareVersions.visible, true);

      const at3 = computeMenuState({
        selectedHashes: new Set(['bbb', 'ccc', 'ddd']),
        commitNodes: nodes,
        headHash: 'aaa',
      });
      assert.strictEqual(at3.compareVersions.enabled, false);
      assert.strictEqual(at3.compareVersions.visible, false);
    });

    it('resetToHere disabled at N≥2', () => {
      const state = computeMenuState({
        selectedHashes: new Set(['bbb', 'ccc']),
        commitNodes: nodes,
        headHash: 'aaa',
      });
      assert.strictEqual(state.resetToHere.enabled, false);
      assert.strictEqual(state.resetToHere.visible, false);
    });

    // visible+disabled dropCommit gets a reason tooltip
    // explaining why merge commits are rejected. Hidden rows leave reason
    // undefined (the apply-loop never reads reason for them).
    it('Wave C D3 — populates dropCommit reason when a merge commit is in selection', () => {
      const withMerge = [
        mkNode('aaa'),
        mkNode('bbb'),
        { hash: 'ccc', parentCount: 2 }, // merge
        mkNode('ddd'),
      ];
      const state = computeMenuState({
        selectedHashes: new Set(['ccc']),
        commitNodes: withMerge,
        headHash: 'aaa',
      });
      assert.strictEqual(state.dropCommit.visible, true);
      assert.strictEqual(state.dropCommit.enabled, false);
      assert.ok(
        typeof state.dropCommit.reason === 'string' && state.dropCommit.reason.length > 0,
        'expected a non-empty reason explaining why drop is disabled on a merge'
      );
      // Phrasing must mention "merge" so the user understands the gate.
      assert.ok(
        /merge/i.test(state.dropCommit.reason ?? ''),
        `dropCommit reason should reference "merge"; got "${state.dropCommit.reason}"`
      );
    });

    it('Wave C D3 — leaves dropCommit reason undefined when selection is clean', () => {
      const state = computeMenuState({
        selectedHashes: new Set(['bbb', 'ccc']),
        commitNodes: nodes,
        headHash: 'aaa',
      });
      assert.strictEqual(state.dropCommit.visible, true);
      assert.strictEqual(state.dropCommit.enabled, true);
      assert.strictEqual(state.dropCommit.reason, undefined);
    });

    it('handles selectedHashes that include hashes not in commitNodes (safety)', () => {
      const state = computeMenuState({
        selectedHashes: new Set(['bbb', 'unknown-hash']),
        commitNodes: nodes,
        headHash: 'aaa',
      });
      // Treat unknown hashes as non-existent — selectedCount counts only
      // what's in commitNodes (contiguity & merge-detection both work on
      // commitNodes only).
      assert.strictEqual(state.compareVersions.enabled, false);
    });
  });

  // ─── squash first-parent-chain gate (cross-branch rejection) ───────────────
  describe('isContiguousFirstParentChain', () => {
    // Newest-first display order: a linear branch a3→a2→a1.
    const linear = [
      { hash: 'a3', parentCount: 1, parents: ['a2'] },
      { hash: 'a2', parentCount: 1, parents: ['a1'] },
      { hash: 'a1', parentCount: 1, parents: ['a0'] },
    ];

    it('true for a real first-parent chain (one branch)', () => {
      assert.strictEqual(isContiguousFirstParentChain(new Set(['a3', 'a2']), linear), true);
      assert.strictEqual(isContiguousFirstParentChain(new Set(['a3', 'a2', 'a1']), linear), true);
    });

    it('false when display-adjacent commits are NOT first-parent linked (interleaved branches)', () => {
      // Display order interleaves two branches: a-commit, b-commit, a-commit.
      // Selecting the two display-adjacent a2 + b1 spans branches — b1 is not
      // a2's first parent, nor a2 b1's.
      const interleaved = [
        { hash: 'a2', parentCount: 1, parents: ['a1'] },
        { hash: 'b1', parentCount: 1, parents: ['a1'] },
        { hash: 'a1', parentCount: 1, parents: ['a0'] },
      ];
      assert.strictEqual(isContiguousFirstParentChain(new Set(['a2', 'b1']), interleaved), false);
    });

    it('order-agnostic: holds for oldest-first arrays too', () => {
      const oldestFirst = [
        { hash: 'a1', parentCount: 1, parents: ['a0'] },
        { hash: 'a2', parentCount: 1, parents: ['a1'] },
        { hash: 'a3', parentCount: 1, parents: ['a2'] },
      ];
      assert.strictEqual(isContiguousFirstParentChain(new Set(['a2', 'a3']), oldestFirst), true);
    });

    it('lenient when parent info is absent (cannot verify)', () => {
      const noParents = [
        { hash: 'a2', parentCount: 1 },
        { hash: 'a1', parentCount: 1 },
      ];
      assert.strictEqual(isContiguousFirstParentChain(new Set(['a2', 'a1']), noParents), true);
    });

    it('squashCommits is DISABLED for a cross-branch (display-contiguous) selection', () => {
      // A shift-range over interleaved branches: display-contiguous but spanning
      // two branches. feat1 and trunk5 are siblings — neither is the other's
      // first parent — so squash must be disabled with a single-branch reason.
      const interleaved = [
        { hash: 'feat1', parentCount: 1, parents: ['feat0'] },
        { hash: 'trunk5', parentCount: 1, parents: ['trunk4'] },
      ];
      const state = computeMenuState({
        selectedHashes: new Set(['feat1', 'trunk5']),
        commitNodes: interleaved,
        headHash: 'feat1',
      });
      assert.strictEqual(
        state.squashCommits.enabled,
        false,
        'cross-branch squash must be disabled'
      );
      assert.ok(
        /single branch|first-parent/i.test(state.squashCommits.reason ?? ''),
        `expected a single-branch reason, got: ${state.squashCommits.reason}`
      );
    });

    it('squashCommits is ENABLED for a genuine same-branch chain', () => {
      const state = computeMenuState({
        selectedHashes: new Set(['a3', 'a2']),
        commitNodes: linear,
        headHash: 'a3',
      });
      assert.strictEqual(state.squashCommits.enabled, true, 'same-branch squash must be enabled');
    });
  });
});
