/**
 * Squash/fixup action for the commit context menu: contiguity + merge gates,
 * the seeded message editor, and the squash rebase plan.
 */

import * as vscode from 'vscode';
import {
  isSelectionContiguous,
  isContiguousFirstParentChain,
  type IMenuStateNode,
} from '../git-core/gitToolWindow/multiSelect';
import { getLogger } from '../utils/logger';
import { SquashMessageDialog } from './SquashMessageDialog';
import { buildSquashRebasePlan } from './squashPlan';
import { formatActionFailureToast } from '../git-core/gitError';
import {
  allHashesDisplayed,
  allHashesValid,
  selectionDisplayBounds,
} from './commitContextMenuShared';
import {
  runHistoryRewrite,
  resolveRewriteBase,
  type ICommitHistoryRewriteContext,
} from './commitHistoryRewriteRunner';
import { promptForMessageInEditor } from './commitMessageEditor';

/**
 * Squash N>=2 contiguous non-merge commits into one via a
 * single interactive rebase.
 *
 * Flow (IntelliJ semantics: dialog runs BEFORE the rebase):
 *   1. Validate hashes; in-order guard; defence-in-depth contiguity +
 *      no-merge checks (UI gates them in `computeMenuEnableState`).
 *   2. Determine the oldest selected commit (largest index in newest-
 *      first display order). An oldest with no parent (the initial
 *      commit) warns and proceeds via `--root`.
 *   3. Fetch each selected commit's full message via `getCommit`. Join
 *      with `\n\n` to seed the message editor.
 *   4. Open the squash-message dialog with the seed value. On cancel
 *      or a blank message, abort with no git side-effects.
 *   5. Hand off to {@link runHistoryRewrite}: rebase onto `oldest^`
 *      with the plan mirroring git4idea's unite model — the oldest
 *      selected commit (the unite root) becomes `reword` carrying the
 *      user's combined message; every other selected commit becomes
 *      `fixup` (its own message discarded); non-selected commits keep
 *      their action. The combined message is delivered through the
 *      reword override in the plan (realised as `pick` + a
 *      non-interactive `commit --amend -F`), so the rebase runs to
 *      completion without pausing for a message. On conflict the rebase
 *      stays paused and the resolve dialog opens
 *      (operation:'rebase', target:'squash').
 */
export async function handleSquashCommits(
  ctx: ICommitHistoryRewriteContext,
  commitHashes: string[],
  commitNodes: readonly IMenuStateNode[] = [],
  // Optional mode flag distinguishing the
  // user-visible squash variant from a `git --fixup` variant. The latter
  // skips the message-edit dialog and reuses the parent commit's
  // existing message verbatim, matching git's `--fixup` semantics. The
  // existing single-source-of-truth squash plan is preserved; only the
  // pre-rebase prompt + post-rebase squash-message marshalling differ.
  options?: { mode?: 'squash' | 'fixup' }
): Promise<void> {
  const mode = options?.mode ?? 'squash';
  const log = getLogger().child({ component: 'CommitContextMenuCommands' });
  log.debug('squash commits handler invoked', {
    mode,
    commitHashesCount: commitHashes.length,
    commitNodesCount: commitNodes.length,
  });
  if (ctx.isCrossRepoSelection(commitHashes)) {
    return;
  }
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  if (!repo) {
    log.warn('squash aborted: no repository resolved');
    void vscode.window.showWarningMessage(
      `Cannot ${mode === 'fixup' ? 'fixup' : 'squash'} commits: no repository found.`
    );
    return;
  }
  if (commitHashes.length < 2) {
    // Squash needs ≥ 2 commits. Surface a toast so the user knows
    // their click was received but the action requires more
    // selection.
    log.warn('squash aborted: fewer than 2 commits selected', {
      commitHashesCount: commitHashes.length,
    });
    void vscode.window.showWarningMessage(
      `Cannot ${mode === 'fixup' ? 'fixup' : 'squash'} commits: select 2 or more commits first.`
    );
    return;
  }

  // 1. Hash format validation.
  if (!allHashesValid(commitHashes)) {
    // Hash format failure — should not happen in practice given the
    // webview only sends rendered hashes, but if it does the user
    // needs to know the click was received and rejected for a real
    // reason rather than silently dropped.
    log.warn('squash aborted: hash format validation failed', { commitHashes });
    void vscode.window.showErrorMessage(
      'Squash aborted: one or more selected commit hashes are malformed.'
    );
    return;
  }

  // 1b. In-order guard.
  if (
    !allHashesDisplayed(
      commitHashes,
      commitNodes.map((n) => n.hash)
    )
  ) {
    log.warn('squash aborted: stale selection (commit hashes not in current commitNodes)');
    return;
  }

  // 1c. Defence-in-depth — squash must be contiguous + non-merge.
  const displayOrder = commitNodes.map((n) => n.hash);
  if (!isSelectionContiguous(new Set(commitHashes), displayOrder)) {
    void vscode.window.showErrorMessage(
      'Squash needs contiguous (consecutive) commits — gaps in the selection are not supported.'
    );
    return;
  }
  const selectedSet = new Set(commitHashes);
  const hasMerge = commitNodes.some((n) => selectedSet.has(n.hash) && n.parentCount >= 2);
  if (hasMerge) {
    void vscode.window.showErrorMessage('Squash cannot include merge commits.');
    return;
  }
  // The selection must be a single first-parent chain (one branch), not just
  // display-contiguous — a shift-range can span interleaved branches. Re-check
  // at perform time (the menu-enable gate is advisory and can race a stale
  // selection), mirroring IntelliJ's checkHeadLinearHistory.
  if (!isContiguousFirstParentChain(selectedSet, commitNodes)) {
    void vscode.window.showErrorMessage(
      'Squash needs commits on a single branch (one first-parent chain) — the selection spans branches.'
    );
    return;
  }

  // 2. Oldest selected commit in newest-first display order.
  const bounds = selectionDisplayBounds(
    commitHashes,
    commitNodes.map((n) => n.hash)
  );
  if (!bounds) {
    return;
  }
  const { oldestHash, oldestIdx } = bounds;

  // 2b. HEAD-containment gate (before the message dialog / stash / rebase):
  // squashing commits HEAD doesn't contain would rebase `oldest^..HEAD` and
  // move the checked-out branch instead of the target's branch.
  if (!(await ctx.isOldestInCurrentBranch(repo, oldestHash))) {
    return;
  }

  // 2c. Initial-commit arm — the root is a non-merge commit with no parent,
  // so `oldest^` cannot resolve; warn-and-proceed via --root.
  const onto = await resolveRewriteBase(
    oldestHash,
    commitNodes[oldestIdx].parentCount === 0,
    mode === 'fixup' ? 'Fixup' : 'Squash'
  );
  if (onto === undefined) {
    return;
  }

  // 3. Fetch each selected commit's full message and join in oldest-
  // first order (chronological: oldest commit's message comes first
  // in the seed). commitHashes is newest-first; oldest-first =
  // .slice().reverse().
  const oldestFirst = [...commitHashes].reverse();
  const messages = await Promise.all(
    oldestFirst.map(async (h) => {
      try {
        return (await ctx.gitService.getCommit(repo, h)).message ?? '';
      } catch {
        // If lookup fails, fall back to the short-sha so the seed
        // still has a marker for the user to edit.
        return h.substring(0, 8);
      }
    })
  );
  const seedMessage = messages.filter((m) => m.length > 0).join('\n\n');

  // 4. Show the squash-message editor: a webview-hosted modal dialog with
  // a multi-line textarea seeded with the `\n\n`-joined messages; it
  // resolves with the user's message on submit or `undefined` on cancel.
  // Falls back to the temp-file editor when the extension context isn't
  // available (palette / scripted callers that didn't go through
  // `register()`).
  //
  // `mode === 'fixup'` skips the dialog entirely: the oldest selected
  // commit stays `pick`, so it keeps its own message verbatim (matching
  // `git commit --fixup`) — no message needs to be collected or applied.
  let userMessage: string | undefined;
  if (mode === 'squash') {
    log.debug('squash: opening message dialog', {
      commitCount: commitHashes.length,
    });
    if (ctx.context) {
      const dialog = new SquashMessageDialog(ctx.context, {
        seedMessage,
        commitCount: commitHashes.length,
      });
      userMessage = await dialog.prompt();
    } else {
      userMessage = await promptForMessageInEditor(seedMessage, {
        tmpInfix: 'squash',
        opName: 'Squash',
        fallbackPrompt: `Squashed commit message (${commitHashes.length} commits)`,
      });
    }
    // A blank message is a cancel, not an override: carrying an empty
    // string into the plan would fail hasRewordOverride and silently fall
    // back to a classic reword (which keeps the target's own message under
    // GIT_EDITOR=true). Treat undefined AND blank as a clean cancel so the
    // combined-message contract holds regardless of which dialog produced it.
    if (userMessage === undefined || userMessage.trim().length === 0) {
      log.debug('squash cancelled: user dismissed the message dialog');
      return;
    }
  }

  try {
    // 5-7. The shared runner: rebase onto `oldest^` with the squash plan
    // (reword the unite root with the combined message, fixup the rest —
    // git4idea parity; see {@link buildSquashRebasePlan}. Fixup carries no
    // message, so the target keeps its own — the root stays pick). The
    // combined message is delivered through the plan (a reword override on
    // the squash target), so the rebase runs non-interactively — it never
    // pauses for the message. On conflict the rebase stays paused and the
    // resolve dialog opens (operation:'rebase', target:'squash').
    const verb = mode === 'fixup' ? 'Fixup' : 'Squash';
    await runHistoryRewrite(ctx, repo, {
      onto,
      oldest: oldestHash,
      opLabel: verb,
      target: 'squash',
      successToast: `${mode === 'fixup' ? "Fixup'd" : 'Squashed'} ${commitHashes.length} commits successfully.`,
      buildPlan: (session) =>
        mode === 'fixup'
          ? buildSquashRebasePlan(session.commits, commitHashes, oldestHash)
          : buildSquashRebasePlan(session.commits, commitHashes, oldestHash, userMessage),
    });
  } catch (error) {
    const verb = mode === 'fixup' ? 'fixup commits' : 'squash commits';
    void vscode.window.showErrorMessage(formatActionFailureToast(`Failed to ${verb}`, error));
  }
}
