/**
 * Drop actions for the commit context menu: single/multi drop-commit and
 * drop-selected-changes, riding the shared history-rewrite runner.
 */

import * as vscode from 'vscode';
import { IRepository } from '../git-core/interfaces/IGitService';
import { type IMenuStateNode } from '../git-core/gitToolWindow/multiSelect';
import { getLogger } from '../utils/logger';
import { saveLocalChanges, restoreLocalChanges } from '../git-core/ops/preservedChanges';
import { restorePathsToHead, IRestoreToHeadRequest } from '../git-core/worktree/restoreToHead';
import { formatActionFailureToast, sanitizeGitError } from '../git-core/gitError';
import {
  allHashesDisplayed,
  allHashesValid,
  hashesReferToSameCommit,
  previewCommitSubject,
  reloadAndRefresh,
  selectionContainsCommit,
  selectionDisplayBounds,
  STALE_SELECTION_TOAST,
} from './commitContextMenuShared';
import {
  runHistoryRewrite,
  resolveRewriteBase,
  isNoOperationInProgress,
  type ICommitHistoryRewriteContext,
} from './commitHistoryRewriteRunner';

/**
 * Implementation for Drop Selected Changes. See
 * {@link dropSelectedChangesFromCommit}.
 */
export async function handleDropSelectedChanges(
  ctx: ICommitHistoryRewriteContext,
  repo: IRepository,
  hash: string
): Promise<void> {
  const cwd = repo.rootUri.fsPath;
  const shortHash = hash.substring(0, 8);

  // 1. HEAD probe — selects the strategy, not a gate: HEAD rewrites via
  //    the soft-reset + re-commit fast path (no rebase); any other commit
  //    rides the history-rewrite runner with an `edit` pause (reference:
  //    the rebase-based GitDropSelectedChangesOperation works on ANY
  //    commit).
  let isHead = false;
  try {
    const headResult = await ctx.gitCli.exec(['rev-parse', 'HEAD'], { cwd });
    if (headResult.exitCode === 0) {
      isHead = headResult.stdout.trim() === hash;
    }
  } catch (error) {
    // Treat unknown state as "not HEAD" — the rebase path handles any
    // commit. Log the probe fault so it stays visible.
    getLogger()
      .child({ component: 'CommitContextMenuCommands' })
      .debug('dropSelectedChanges: HEAD probe failed', {
        err: error instanceof Error ? error.message : String(error),
      });
  }

  // 2. Safety: refuse while a rebase/sequencer is live (IntelliJ Prohibit
  //    policy) — a soft-reset mid-rebase corrupts the detached-HEAD state.
  if (!(await isNoOperationInProgress(repo, 'Drop selected changes'))) {
    return;
  }

  // 2b. Safety: refuse on commits published to a protected branch. (The
  //    reference blocks the protected list only — findProtectedRemoteBranch
  //    — not pushed-anywhere; unprotected published history stays editable.)
  if (!(await ctx.isNotOnProtectedBranch(cwd, hash, 'Drop Selected Changes'))) {
    return;
  }

  // 3. Safety: refuse on merge commits. A merge commit has two parents; the
  //    soft-reset + re-commit path records only the first parent, silently
  //    discarding the merge relationship with no warning. Mirror the guard
  //    that the regular Drop handler uses for the same reason.
  if (await ctx.anyIsMergeCommit(repo, [hash]).catch(() => false)) {
    void vscode.window.showErrorMessage(
      `${shortHash} is a merge commit. Drop Selected Changes cannot run on a merge — ` +
        `use Reset to a non-merge ancestor instead.`
    );
    return;
  }

  // 3b. Non-HEAD rides a `hash~1..HEAD` rebase — same containment
  //     requirement as every other history-rewriting flow.
  if (!isHead && !(await ctx.isOldestInCurrentBranch(repo, hash))) {
    return;
  }

  // 4. File picker — user selects files to DROP.
  let diffs;
  try {
    diffs = await ctx.gitService.getCommitDiff(repo, hash);
  } catch (error) {
    void vscode.window.showErrorMessage(
      formatActionFailureToast(`Failed to list files for ${shortHash}`, error)
    );
    return;
  }
  if (!diffs || diffs.length === 0) {
    void vscode.window.showInformationMessage(`Commit ${shortHash} has no files to drop.`);
    return;
  }

  const pickItems = diffs.map((d) => ({
    label: d.path,
    description: d.status,
    path: d.path,
  }));
  const dropPicks = await vscode.window.showQuickPick(pickItems, {
    title: `Drop changes from ${shortHash} — select files to remove`,
    placeHolder: 'These files will be excluded from the commit',
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!dropPicks || dropPicks.length === 0) {
    return;
  }

  // 4a. All-files selection removes the whole commit — the arm the
  //     reference DISABLES (GitDropSelectedChangesAction: "use Drop
  //     Commit"). Refuse with the same redirect.
  if (dropPicks.length === diffs.length) {
    void vscode.window.showErrorMessage(
      `Dropping every file removes commit ${shortHash} entirely — use Drop Commit instead.`
    );
    return;
  }

  // 4b. Single destructive-op confirm (safety policy).
  const confirm = await vscode.window.showWarningMessage(
    `Drop ${dropPicks.length} file(s) from commit ${shortHash}? This rewrites history.`,
    { modal: true },
    'Drop',
    'Cancel'
  );
  if (confirm !== 'Drop') {
    return;
  }

  const droppedPaths = dropPicks.map((p) => p.path);
  const diffByPath = new Map(diffs.map((d) => [d.path, d]));

  // Non-HEAD: ride the shared runner with an edit-pause rewrite; the fast
  // path below is HEAD-only (soft reset needs HEAD to be the target).
  if (!isHead) {
    await dropSelectedChangesViaRebase(ctx, repo, hash, droppedPaths, diffByPath);
    return;
  }

  // Map each dropped file to a restore-to-HEAD request for the shared
  // writer (which owns the added/renamed/tracked partition): an ADDED file
  // has no parent blob (unindex, keep on disk as untracked); a RENAMED or
  // COPIED file's new path is likewise absent from the parent while its
  // source is what gets restored; modified/deleted restore in place. At
  // apply time HEAD IS the parent (post soft-reset), so `inHead` is decided
  // against the parent tree.
  const restoreRequests: IRestoreToHeadRequest[] = droppedPaths.map((p) => {
    const diff = diffByPath.get(p);
    const status = diff?.status;
    if (status === 'added') {
      return { path: p, inHead: false };
    }
    if (status === 'renamed' || status === 'copied') {
      return { path: p, oldPath: diff?.oldPath, inHead: false };
    }
    return { path: p, inHead: true };
  });
  const addedDropped = droppedPaths.filter((p) => {
    const st = diffByPath.get(p)?.status;
    return st === 'added' || st === 'renamed' || st === 'copied';
  });

  // 4b. Save local changes around the rewrite (shared bracket — same
  //     discipline as the drop/squash rebase flows). Without it,
  //     `reset --soft HEAD^` merges the user's STAGED work into the index
  //     and `commit -C` silently absorbs it into the rewritten commit, and
  //     `checkout HEAD -- <dropped>` clobbers uncommitted edits to a
  //     dropped file.
  const saved = await saveLocalChanges(ctx.gitCli, cwd, 'Auto-stash before drop selected changes');
  if (saved.status === 'blocked-unmerged') {
    void vscode.window.showErrorMessage(
      'Cannot drop selected changes while you have unmerged files. Resolve the conflicts first.'
    );
    return;
  }
  const restoreSavedChanges = async (): Promise<void> => {
    if (saved.status !== 'saved') {
      return;
    }
    const restore = await restoreLocalChanges(ctx.gitCli, cwd, saved.stashSha);
    if (restore.status === 'failed') {
      void vscode.window.showWarningMessage(
        `Drop finished, but restoring your stashed local changes failed: ${restore.detail}. ` +
          `They remain in the stash list.`
      );
    }
  };

  // 5. Rewrite HEAD.
  //    Strategy (safer than interactive rebase for HEAD-only):
  //      a. git reset --soft HEAD^   (uncommit, keep index + working tree intact)
  //      b. for each dropped ADDED file: git rm --cached -- <path>
  //         (the file was newly introduced — the parent doesn't have it, so
  //         checkout would fail; rm --cached removes the staged copy only)
  //      c. for each other dropped file: git checkout HEAD -- <path>
  //         (at this point HEAD is the parent; restore parent's content
  //         in both index and working tree)
  //      d. if any files were kept, re-commit as `git commit -C <hash>`.
  //         If all files were dropped, HEAD is already at the parent.
  //    Rollback: if anything fails after the soft-reset un-commits HEAD,
  //    restore the original commit via `git reset --soft <hash>` so the
  //    repo is never left in a half-rewritten state.
  try {
    await ctx.gitCli.exec(['reset', '--soft', 'HEAD^'], { cwd, throwOnError: true });

    try {
      await restorePathsToHead(ctx.gitCli, cwd, restoreRequests);

      // `git rm --cached` removes newly-added files from the index but leaves
      // them as untracked files on disk. Clarify this in the success toast so
      // the user isn't surprised to find the file still in their working tree.
      const untrackedNote =
        addedDropped.length > 0
          ? `; ${addedDropped.length} file(s) new in this commit remain on disk as untracked: ${addedDropped.join(', ')}`
          : '';

      // Re-commit with original author + message from the saved hash. At
      // least one file is always kept — the all-files selection was
      // refused above (Drop Commit's job).
      await ctx.gitCli.exec(['commit', '-C', hash], { cwd, throwOnError: true });
      void vscode.window.showInformationMessage(
        `Dropped ${droppedPaths.length} file(s) from ${shortHash}${untrackedNote}`
      );
    } catch (innerError) {
      // Something failed after the soft-reset removed the commit from HEAD.
      // Restore the original commit pointer (best-effort). Note: soft-reset
      // only moves the branch ref — the index/worktree may still reflect
      // partial side-effects from rm --cached / checkout. Tell the user to
      // inspect git status rather than silently leaving them confused.
      await ctx.gitCli.exec(['reset', '--soft', hash], { cwd });
      await restoreSavedChanges();
      const msg = innerError instanceof Error ? innerError.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to drop changes: ${sanitizeGitError(msg)}. Original commit restored; check \`git status\` for any partially-applied changes.`
      );
      // Reload so the panel reflects the restored HEAD — the toast already
      // fired, so a reload failure must not mask it.
      try {
        await reloadAndRefresh(ctx, repo);
      } catch (reloadErr) {
        // Non-fatal: the error toast already fired. Log so it stays visible.
        getLogger()
          .child({ component: 'CommitContextMenuCommands' })
          .debug('dropSelectedChanges: reload after rollback failed', {
            err: reloadErr instanceof Error ? reloadErr.message : String(reloadErr),
          });
      }
      return;
    }

    await restoreSavedChanges();

    // Synchronously reload before refresh so panel sees fresh
    // `repo.head.commit` (history rewrite moved HEAD).
    await reloadAndRefresh(ctx, repo);
  } catch (error) {
    // The initial soft-reset itself failed — HEAD is untouched; still put
    // the user's saved changes back.
    await restoreSavedChanges();
    void vscode.window.showErrorMessage(formatActionFailureToast('Failed to drop changes', error));
  }
}

/**
 * Drop selected files from a NON-HEAD commit by riding the shared
 * history-rewrite runner: the target pauses at an `edit` step (HEAD is
 * then the target itself), the dropped changes are unwound in place —
 * paths the commit ADDED are removed (index + worktree, so descendant
 * replays that re-touch them apply cleanly), everything else restores
 * from the parent (`HEAD^`, always present there) — the commit is amended
 * preserving its message + author, and the rebase continues. Descendant
 * replays that conflict pause into the resolve dialog like every other
 * runner flow. Reference: the rebase-based
 * GitDropSelectedChangesOperation (git4idea
 * rebase/log/changes/GitDropSelectedChangesAction.kt).
 */
async function dropSelectedChangesViaRebase(
  ctx: ICommitHistoryRewriteContext,
  repo: IRepository,
  hash: string,
  droppedPaths: string[],
  diffByPath: Map<string, { status: string; oldPath?: string }>
): Promise<void> {
  // rebase-containment-exempt: the sole caller (handleDropSelectedChanges)
  // runs isOldestInCurrentBranch on this hash before delegating here.
  const cwd = repo.rootUri.fsPath;
  const shortHash = hash.substring(0, 8);
  try {
    await runHistoryRewrite(ctx, repo, {
      onto: `${hash}~1`,
      oldest: hash,
      opLabel: 'Drop selected changes',
      target: 'drop',
      successToast: `Dropped ${droppedPaths.length} file(s) from ${shortHash}`,
      buildPlan: (session) => {
        const targetCommit = session.commits.find((c) => hashesReferToSameCommit(c.hash, hash));
        if (!targetCommit) {
          void vscode.window.showErrorMessage(`Commit ${shortHash} not found in rebase session.`);
          return 'stale';
        }
        return session.commits.map((c) =>
          c.hash === targetCommit.hash
            ? { hash: c.hash, action: 'edit' as const }
            : { hash: c.hash, action: c.action }
        );
      },
      drivePaused: async (first) => {
        if (!(first.success && first.status === 'paused')) {
          // Conflict / cleared-stale before the edit step — the runner's
          // outcome switch owns it.
          return first;
        }
        for (const p of droppedPaths) {
          const diff = diffByPath.get(p);
          const status = diff?.status;
          if (status === 'added' || status === 'renamed' || status === 'copied') {
            await ctx.gitCli.exec(['rm', '-f', '--', p], { cwd, throwOnError: true });
            if ((status === 'renamed' || status === 'copied') && diff?.oldPath) {
              await ctx.gitCli.exec(['checkout', 'HEAD^', '--', diff.oldPath], {
                cwd,
                throwOnError: true,
              });
            }
          } else {
            await ctx.gitCli.exec(['checkout', 'HEAD^', '--', p], {
              cwd,
              throwOnError: true,
            });
          }
        }
        await ctx.gitCli.exec(['commit', '--amend', '-C', 'HEAD'], {
          cwd,
          throwOnError: true,
        });
        return ctx.rebaseService.continueRebase(repo);
      },
    });
  } catch (error) {
    void vscode.window.showErrorMessage(
      `${formatActionFailureToast(`Failed to drop changes from ${shortHash}`, error)}. ` +
        `A rebase may be paused — use the Rebase Progress panel to continue or abort.`
    );
    await reloadAndRefresh(ctx, repo);
  }
}

/**
 * Defence-in-depth merge gate shared by the single- and multi-commit Drop
 * paths: when any selected commit is a merge (parentCount >= 2), toast the
 * refusal and return true so the caller aborts. The UI hides Drop for merge
 * selections; palette / scripted entry points still reach the handlers.
 */
function refuseMergeCommitDrop(
  commitNodes: readonly IMenuStateNode[],
  selected: readonly string[]
): boolean {
  const selectedSet = new Set(selected);
  const hasMerge = commitNodes.some((n) => selectedSet.has(n.hash) && n.parentCount >= 2);
  if (hasMerge) {
    void vscode.window.showErrorMessage(
      'Drop cannot include merge commits — use Reset to a non-merge ancestor instead.'
    );
  }
  return hasMerge;
}

export async function handleDropCommit(
  ctx: ICommitHistoryRewriteContext,
  commitHashes: string[],
  commitNodes: readonly IMenuStateNode[] = []
): Promise<void> {
  if (commitHashes.length === 0) {
    return;
  }
  // Guard a merged-log selection that straddles repos before any routing —
  // a single rebase can't drop foreign-repo commits.
  if (ctx.isCrossRepoSelection(commitHashes)) {
    return;
  }

  // hash-format validation applies to BOTH the single- and multi-commit
  // drop paths. Lifted above the N>=2 routing so palette / scripted entry
  // points hitting either branch get the same defence-in-depth. (The
  // initial-commit arm is handled per-path via resolveRewriteBase — warn
  // then `--root`, per the reference.)
  if (!allHashesValid(commitHashes)) {
    return;
  }

  // N>=2 routes to the multi-commit drop flow. Single
  // entry point keeps the dispatcher simple and preserves the
  // dispatch-property invariant.
  if (commitHashes.length >= 2) {
    await handleDropCommitMulti(ctx, commitHashes, commitNodes);
    return;
  }

  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  if (!repo) {
    return;
  }

  const hash = commitHashes[0];

  // defence-in-depth merge-commit gate. The UI hides the
  // action entirely when the selection contains a merge commit, but
  // a palette / scripted entry point could still call this handler
  // with a merge hash. Refuse with a friendly toast.
  if (refuseMergeCommitDrop(commitNodes, [hash])) {
    return;
  }
  const dropTargetParents = commitNodes.find((n) => n.hash === hash)?.parentCount;

  // HEAD-containment gate (before any confirm / stash / rebase): dropping a
  // commit HEAD doesn't contain would rebase and move the checked-out branch.
  if (!(await ctx.isOldestInCurrentBranch(repo, hash))) {
    return;
  }

  // Initial-commit arm: warn-and-proceed via --root (reference parity).
  const onto = await resolveRewriteBase(hash, dropTargetParents === 0, 'Drop');
  if (onto === undefined) {
    return;
  }

  // Confirm modal — dropping a commit rewrites history; single and multi
  // paths both confirm (feedback_data_loss_confirms minimal-confirm
  // policy). Show the short-sha + subject for disambiguation.
  const shortSha = hash.substring(0, 8);
  const subject = await previewCommitSubject(ctx, repo, hash);
  const confirmChoice = await vscode.window.showWarningMessage(
    `Drop commit ${shortSha}${subject ? ` — ${subject}` : ''}? This rewrites history.`,
    { modal: true },
    'Drop'
  );
  if (confirmChoice !== 'Drop') {
    return;
  }

  try {
    await runHistoryRewrite(ctx, repo, {
      onto,
      oldest: hash,
      opLabel: 'Drop',
      target: 'drop',
      successToast: `Dropped commit ${hash.substring(0, 8)}`,
      buildPlan: (session) => {
        const targetCommit = session.commits.find((c) => hashesReferToSameCommit(c.hash, hash));
        if (!targetCommit) {
          void vscode.window.showErrorMessage(
            `Commit ${hash.substring(0, 8)} not found in rebase session.`
          );
          return 'stale';
        }
        return session.commits.map((c) =>
          c.hash === targetCommit.hash
            ? { hash: c.hash, action: 'drop' as const }
            : { hash: c.hash, action: c.action }
        );
      },
    });
  } catch (error) {
    void vscode.window.showErrorMessage(formatActionFailureToast('Failed to drop commit', error));
  }
}

/**
 * Drop N>=2 contiguous-or-not commits via a single
 * interactive rebase.
 *
 * Flow:
 *   1. Validate every hash is hex (belt-and-suspenders).
 *   2. In-order guard: every selected hash must still be in the
 *      rendered commitNodes; otherwise toast "selection changed" and
 *      abort. Mirror of `_handleCommitContextMenu`.
 *   3. Defence-in-depth — refuse if any selected commit is a merge.
 *      The UI gates this in `computeMenuEnableState`; this is the
 *      handler-side mirror.
 *   4. Initial-commit edge — `oldest^` doesn't resolve when oldest
 *      is the initial commit. Detect via parentCount=0 and toast.
 *   5. Confirm modal — N>=2 only. List up to 5 short-shas.
 *   6. Hand off to {@link runHistoryRewrite}: rebase onto `oldest^`
 *      with every commit in the window staying `pick` unless its hash is
 *      in the selected set (which becomes `drop`); on conflict the rebase
 *      stays paused and the resolve dialog opens
 *      (operation:'rebase', target:'drop').
 *
 * Replay direction (trap #3): commitHashes arrives newest-first from
 * the webview. The rebase window is built oldest-first by
 * `RebaseService.getCommitsToRebase` (it walks `<onto>..HEAD --reverse`),
 * so we don't need to manage replay order ourselves — we just turn
 * each plan entry to drop/pick by membership in the selected set.
 */
export async function handleDropCommitMulti(
  ctx: ICommitHistoryRewriteContext,
  commitHashes: string[],
  commitNodes: readonly IMenuStateNode[] = []
): Promise<void> {
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  if (!repo || commitHashes.length < 2) {
    return;
  }

  // 1. Hash format validation.
  if (!allHashesValid(commitHashes)) {
    return;
  }

  // 2. In-order guard — every selected hash must be in commitNodes.
  if (
    !allHashesDisplayed(
      commitHashes,
      commitNodes.map((n) => n.hash)
    )
  ) {
    return;
  }

  // 3. Defence-in-depth — refuse merge-commit selections.
  if (refuseMergeCommitDrop(commitNodes, commitHashes)) {
    return;
  }
  const selectedSet = new Set(commitHashes);

  // Oldest selected commit in newest-first display order.
  const bounds = selectionDisplayBounds(
    commitHashes,
    commitNodes.map((n) => n.hash)
  );
  if (!bounds) {
    return;
  }
  const { oldestHash, oldestIdx } = bounds;

  // 4. HEAD-containment gate (before any confirm / stash / rebase): if the
  // oldest selected commit isn't reachable from HEAD, the `oldest^..HEAD`
  // rebase would rewrite and move the checked-out branch instead.
  if (!(await ctx.isOldestInCurrentBranch(repo, oldestHash))) {
    return;
  }

  // 4b. Initial-commit arm — `oldest^` cannot resolve; warn-and-proceed
  // via --root (reference parity).
  const onto = await resolveRewriteBase(
    oldestHash,
    commitNodes[oldestIdx].parentCount === 0,
    'Drop'
  );
  if (onto === undefined) {
    return;
  }

  // 5. Confirm modal (N>=2 only). Surface up to 5 rows formatted
  // as `<short-sha> — <subject>` so the user can verify exactly which
  // commits the destructive op will rewrite; a failed / timed-out
  // subject lookup falls back to the bare short-sha, so the user still
  // sees the destructive-op confirm with valid disambiguation.
  //
  // Bare 'Drop' label is intentional per
  // `feedback_data_loss_confirms.md`'s minimal-confirm policy.
  const previewLimit = 5;
  const previewRows = await Promise.all(
    commitHashes.slice(0, previewLimit).map(async (h) => {
      const subject = await previewCommitSubject(ctx, repo, h);
      return subject ? `${h.substring(0, 8)} — ${subject}` : h.substring(0, 8);
    })
  );
  const preview =
    previewRows.join('\n') +
    (commitHashes.length > previewLimit
      ? `\n… and ${commitHashes.length - previewLimit} more`
      : '');
  const confirmChoice = await vscode.window.showWarningMessage(
    `Drop ${commitHashes.length} commits? This rewrites history.\n\n${preview}`,
    { modal: true },
    'Drop'
  );
  if (confirmChoice !== 'Drop') {
    return;
  }

  try {
    // 6-8. The shared runner: rebase onto `oldest^` (the window covers
    // every commit reachable from HEAD that's newer than oldestHash^ —
    // including non-selected commits that must stay), pause on conflict,
    // hand off to the resolve dialog.
    await runHistoryRewrite(ctx, repo, {
      onto,
      oldest: oldestHash,
      opLabel: 'Drop',
      target: 'drop',
      successToast: `Dropped ${commitHashes.length} commits successfully.`,
      buildPlan: (session) => {
        // Each commit in the session stays `pick` unless its hash is in
        // the selected drop set. Session hashes are full SHAs while the
        // dispatch can be abbreviated — match by the shared tolerant rule.
        const plan = session.commits.map((c) =>
          selectionContainsCommit(commitHashes, c.hash)
            ? { hash: c.hash, action: 'drop' as const }
            : { hash: c.hash, action: c.action }
        );

        // Empty rebase-window or partial-coverage guard. If
        // `getCommitsToRebase` returned fewer commits than the user
        // selected (the most plausible cause: a force-push landed between
        // dispatch and rebase, mutating reachable history), the empty plan
        // would `executeRebase` to a no-op success and we'd surface a
        // misleading "dropped N commits" toast. Detect via "every selected
        // hash must be a drop in the plan"; toast STALE_SELECTION_TOAST
        // and refuse. Compare against `selectedSet.size`, not
        // `commitHashes.length`, so a duplicate-hash payload from a future
        // palette / scripted entry point keeps the guard robust.
        const planDropCount = plan.filter((p) => p.action === 'drop').length;
        if (planDropCount < selectedSet.size) {
          void vscode.window.showWarningMessage(STALE_SELECTION_TOAST);
          return 'stale';
        }
        return plan;
      },
    });
  } catch (error) {
    void vscode.window.showErrorMessage(formatActionFailureToast('Failed to drop commits', error));
  }
}
