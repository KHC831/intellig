/**
 * Interactive-rebase entry points for the commit context menu: the editor
 * hand-off and the autosquash (fixup!/squash!) driver.
 */

import * as vscode from 'vscode';
import { IRepository } from '../git-core/interfaces/IGitService';
import { IRebaseAction } from '../git-core/interfaces/IRebaseService';
import { revParseVerified } from '../git-core/gitCli';
import { isFirstParentAncestor } from '../git-core/rebaseRange';
import { formatActionFailureToast } from '../git-core/gitError';
import {
  runHistoryRewrite,
  resolveRewriteBase,
  isNoOperationInProgress,
  type ICommitHistoryRewriteContext,
} from './commitHistoryRewriteRunner';
import { reloadAndRefresh } from './commitContextMenuShared';

/**
 * "Interactively Rebase from Here" — open the rebase plan editor with the
 * clicked commit INCLUDED: the plan rebases onto the commit's FIRST PARENT
 * (IntelliJ GitInteractiveRebaseAction / getRebaseUpstreamFor). The editor
 * owns all further UX (plan, execute, pause, abort); this handler only
 * resolves the base and refreshes after an executed plan. Calling the
 * rebase SERVICE directly here produced a headless planning session — a
 * toast and no UI.
 */
export async function handleInteractiveRebase(
  ctx: ICommitHistoryRewriteContext,
  commitHashes: string[]
): Promise<void> {
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  if (!repo || commitHashes.length === 0) {
    return;
  }

  const hash = commitHashes[0];

  // In-progress pre-flight (IntelliJ Prohibit-during-rebase policy): the
  // editor's execute would collide with the live rebase's state directory.
  if (!(await isNoOperationInProgress(repo, 'Start an interactive rebase'))) {
    return;
  }

  // HEAD-containment gate (before opening the editor): rebasing onto the
  // clicked commit's parent rewrites `clicked^..HEAD` — for a commit HEAD
  // doesn't contain that would transplant / move the checked-out branch.
  if (!(await ctx.isOldestInCurrentBranch(repo, hash))) {
    return;
  }

  try {
    const onto = await resolveFirstParent(ctx, repo, hash);
    if (onto === undefined) {
      void vscode.window.showWarningMessage(
        'Cannot interactively rebase from the root commit — it has no parent to rebase onto.'
      );
      return;
    }
    if (!ctx.openRebaseEditor) {
      void vscode.window.showErrorMessage(
        'Interactive rebase editor is not available — reload the window and try again.'
      );
      return;
    }
    // Pre-flight: a base on a merged side branch renders visually adjacent
    // to HEAD, but `<onto>..HEAD` spans everything the mainline gained since
    // that branch forked, and a plain interactive rebase FLATTENS every
    // merge in the range. Refuse before opening the editor; a merge-free
    // range (the common linear case) stays silent. The refusal hint keys
    // off the CLICKED commit, not the rebase base (its parent): for the
    // first commit of a merged branch — the whole branch, in the common
    // single-commit case — the parent is the mainline fork point, so a
    // base-side check would stay silent exactly where the hint matters most.
    const refused = !(await ctx.isRangeMergeFree(repo, onto, 'Interactive rebase', async () => {
      const clickedOnMainline = await isFirstParentAncestor(ctx.gitCli, repo.rootUri.fsPath, hash);
      return clickedOnMainline
        ? ''
        : ` '${hash.substring(0, 8)}' is on a merged branch, not the main line — to edit ` +
            `recent commits, pick a commit on the main line instead.`;
    }));
    if (refused) {
      return;
    }
    const result = await ctx.openRebaseEditor(repo, onto);
    if (result.executed) {
      // The rebase moved HEAD; reload before refresh.
      await reloadAndRefresh(ctx, repo);
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      formatActionFailureToast('Failed to start interactive rebase', error)
    );
  }
}

/**
 * First parent of `hash`, from the clicked row when the dispatch carries
 * it (no subprocess), else via `git rev-parse <hash>^`. `undefined` for a
 * root commit.
 */
async function resolveFirstParent(
  ctx: ICommitHistoryRewriteContext,
  repo: IRepository,
  hash: string
): Promise<string | undefined> {
  const row = ctx.dispatchNodes.find((n) => n.hash === hash);
  if (row) {
    if (row.parents && row.parents.length > 0) {
      return row.parents[0];
    }
    if (row.parentCount === 0) {
      return undefined;
    }
    // parentCount > 0 but hashes not threaded — fall through to git.
  }
  // revParseVerified, not a flagless rev-parse: the flagless form echoes a
  // literal `--end-of-options` line into stdout, corrupting the returned rev.
  // `hash^` fails to resolve exactly when there is no parent (root commit).
  return revParseVerified(ctx.gitCli, repo.rootUri.fsPath, `${hash}^`);
}

/**
 * "Rebase Now" leg of Fixup / Squash Into: fold the just-created HEAD
 * `fixup!/squash!` commit into `targetHash` via the shared runner — the
 * plan moves it right after the target as a `fixup` line (git-autosquash
 * equivalent for a single commit). Squash mode combines messages the way
 * autosquash editing would: the target message plus the squash! commit's
 * body (its `squash! <subject>` marker line dropped), delivered through a
 * non-interactive reword override on the target.
 */
export async function runAutosquashNow(
  ctx: ICommitHistoryRewriteContext,
  repo: IRepository,
  targetHash: string,
  mode: 'fixup' | 'squash'
): Promise<void> {
  const verb = mode === 'fixup' ? 'Fixup' : 'Squash';
  try {
    if (!(await ctx.isOldestInCurrentBranch(repo, targetHash))) {
      return;
    }
    // The dialog committed onto HEAD — that IS the fixup!/squash! commit.
    // Independent lookups; fetch concurrently.
    const [created, target] = await Promise.all([
      ctx.gitService.getCommit(repo, 'HEAD'),
      mode === 'squash' ? ctx.gitService.getCommit(repo, targetHash) : Promise.resolve(undefined),
    ]);
    let combinedMessage: string | undefined;
    if (mode === 'squash' && target) {
      const extra = created.message
        .split('\n')
        .filter((line, i) => !(i === 0 && line.startsWith('squash!')))
        .join('\n')
        .trim();
      combinedMessage = extra.length > 0 ? `${target.message.trim()}\n\n${extra}` : undefined;
    }

    const node = ctx.dispatchNodes.find((n) => n.hash === targetHash);
    const onto = await resolveRewriteBase(targetHash, node?.parentCount === 0, verb);
    if (onto === undefined) {
      return;
    }

    await runHistoryRewrite(ctx, repo, {
      onto,
      oldest: targetHash,
      opLabel: verb,
      target: 'squash',
      successToast: `${verb} applied to ${targetHash.substring(0, 8)}.`,
      buildPlan: (session) => {
        const target = session.commits.find(
          (c) =>
            c.hash === targetHash || c.hash.startsWith(targetHash) || targetHash.startsWith(c.hash)
        );
        const createdEntry = session.commits.find(
          (c) => c.hash === created.hash || created.hash.startsWith(c.hash)
        );
        if (!target || !createdEntry || target.hash === createdEntry.hash) {
          void vscode.window.showErrorMessage(
            `Commit ${targetHash.substring(0, 8)} not found in rebase session.`
          );
          return 'stale';
        }
        const plan: IRebaseAction[] = [];
        for (const c of session.commits) {
          if (c.hash === createdEntry.hash) {
            continue;
          }
          if (c.hash === target.hash) {
            plan.push(
              combinedMessage !== undefined
                ? { hash: c.hash, action: 'reword', newMessage: combinedMessage }
                : { hash: c.hash, action: c.action }
            );
            plan.push({ hash: createdEntry.hash, action: 'fixup' });
          } else {
            plan.push({ hash: c.hash, action: c.action });
          }
        }
        return plan;
      },
    });
  } catch (error) {
    void vscode.window.showErrorMessage(
      formatActionFailureToast(`Failed to rebase the ${verb.toLowerCase()}! commit`, error)
    );
  }
}
