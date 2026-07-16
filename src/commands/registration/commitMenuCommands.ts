import * as vscode from 'vscode';
import { getLogger } from '../../utils/logger';
import { sanitizeGitError, worktreeConflictMessage } from '../../git-core/gitError';
import { openRevisionDiff } from '../../git-core/diff/openRevisionDiff';
import { isTabbedGitToolWindowEnabled } from '../../git-core/gitToolWindow/config';
import { parseRemoteUrl } from '../../utils/remoteUrl';
import { commitUrl } from '../../utils/hostingLinks';
import type { IGitService, IRepository } from '../../services';
import type { LogContextAction } from '../../ui-shell/GitToolWindowProvider';
import type { ICommandContext } from './CommandContext';
import { registerBareCommand } from './commandSpine';
import {
  extractCommitHash,
  resolveRepoContainingCommit,
  resolveRepoForCommit,
} from './commitHelpers';

/**
 * Log-commit right-click menu parity commands (`intellig.commit.*` +
 * `intellig.rebase.interactiveFromHere`) extracted verbatim from
 * extension.ts's registerCommands. Where an existing handler lives in
 * `CommitContextMenuCommands._handleAction`, the command delegates through
 * `ctx.commitContextMenuCommands`; otherwise a thin flow is implemented in a
 * module-local helper.
 *
 * Reaches shared state through {@link ICommandContext}. No singleton
 * write-back in this domain. Returns its disposables; extension.ts owns the
 * single push (RULE E4).
 */
/**
 * Decide which parent a commit's diff is taken against. A normal commit diffs
 * vs its sole parent; a root commit vs the empty tree (`<hash>~1`). A merge
 * commit (2+ parents) defers to `pickMergeParent` so the user chooses which
 * parent line to diff against — IntelliJ shows the same parent popup — instead
 * of silently always using the first parent. Returns undefined when the user
 * cancels the picker.
 */
export async function resolveDiffParent(
  hash: string,
  parents: string[],
  pickMergeParent: (parents: string[]) => Promise<string | undefined>
): Promise<string | undefined> {
  if (parents.length === 0) {
    return `${hash}~1`;
  }
  if (parents.length === 1) {
    return parents[0];
  }
  return pickMergeParent(parents);
}

/** QuickPick glue: list a merge commit's parents (hash + subject) to diff against. */
async function _pickMergeParent(
  repo: IRepository,
  parents: string[],
  gitService: IGitService
): Promise<string | undefined> {
  const items = await Promise.all(
    parents.map(async (parent, i) => {
      let subject = '';
      try {
        subject = (await gitService.getCommit(repo, parent)).message.split('\n')[0];
      } catch {
        subject = '';
      }
      return { label: `Parent ${i + 1}: ${parent.slice(0, 8)}`, description: subject, parent };
    })
  );
  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: 'Merge commit — choose which parent to diff against',
  });
  return choice?.parent;
}

export function registerCommitMenuCommands(ctx: ICommandContext): vscode.Disposable[] {
  // Delegate to an existing CommitContextMenuCommands action.
  async function _delegateLogAction(action: LogContextAction, commitArg: unknown): Promise<void> {
    const hash = extractCommitHash(commitArg);
    if (!hash) {
      void vscode.window.showErrorMessage(
        'No commit selected for this action. Right-click a commit in the log to use it.'
      );
      return;
    }
    if (!ctx.commitContextMenuCommands) {
      void vscode.window.showErrorMessage('Commit context menu handlers are not available yet.');
      return;
    }
    await ctx.commitContextMenuCommands._handleAction(action, [hash]);
  }

  const commitCopyHashCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.copyHash',
    failureTitle: 'Failed to copy commit hash',
    run: (_args, commitArg) => _delegateLogAction('copyHash', commitArg),
  });

  const commitCheckoutRevisionCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.checkoutRevision',
    failureTitle: 'Failed to checkout revision',
    run: (_args, commitArg) => _delegateLogAction('checkoutRevision', commitArg),
  });

  const commitRevertCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.revert',
    failureTitle: 'Failed to revert commit',
    run: (_args, commitArg) => _delegateLogAction('revert', commitArg),
  });

  const commitCherryPickCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.cherryPick',
    failureTitle: 'Cherry-pick failed',
    run: (_args, commitArg) => _delegateLogAction('cherryPick', commitArg),
  });

  const commitCreatePatchCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.createPatch',
    failureTitle: 'Failed to create patch',
    run: (_args, commitArg) => _delegateLogAction('createPatch', commitArg),
  });

  const commitResetToHereCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.resetToHere',
    failureTitle: 'Failed to reset',
    run: (_args, commitArg) => _delegateLogAction('resetToHere', commitArg),
  });

  // Drop Selected Changes — rewrites the HEAD commit to remove user-selected
  // files. Refuses on pushed or non-HEAD commits. Single destructive-op
  // confirm modal. Invoked via the palette or the log-commit context menu
  // entry declared in package.json.
  const commitDropSelectedChangesCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.dropSelectedChanges',
    failureTitle: 'Failed to drop selected changes',
    run: async (_args, commitArg) => {
      const hash = extractCommitHash(commitArg);
      if (!hash) {
        void vscode.window.showErrorMessage(
          'No commit selected. Right-click a commit in the log to use Drop Selected Changes.'
        );
        return;
      }
      if (!ctx.commitContextMenuCommands) {
        void vscode.window.showErrorMessage('Commit context menu handlers are not available yet.');
        return;
      }
      await ctx.commitContextMenuCommands.dropSelectedChangesFromCommit(hash);
    },
  });

  // ─── New-from-commit commands ───────────────────────────────────────────

  // New Branch from this commit.
  // Route through the New Branch Dialog webview so the user gets the
  // tracking / overwrite / checkout fields rather than a bare input box.
  const commitNewBranchCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.newBranch',
    failureTitle: 'Failed to create branch',
    run: async (_args, commitArg, repoRootArg) => {
      const hash = extractCommitHash(commitArg);
      // `repoRootArg` (when present) pins the new branch to the clicked
      // commit's OWN repo in the merged "all roots" log; absent, the usual
      // picker runs (single-repo / specific-scope / palette callers).
      const repo = await resolveRepoForCommit(ctx, repoRootArg);
      if (!repo || !ctx.services) {
        return;
      }
      ctx.openNewBranchDialog({ repo, startPoint: hash });
    },
  });

  // Show diff of this commit vs a parent (merge commits prompt for which parent).
  const commitShowDiffCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.showDiff',
    failureTitle: 'Failed to show diff',
    run: async (_args, commitArg) => {
      const hash = extractCommitHash(commitArg);
      if (!hash) {
        void vscode.window.showErrorMessage('No commit selected.');
        return;
      }
      const repo = await resolveRepoContainingCommit(ctx, hash);
      if (!repo || !ctx.services) {
        return;
      }
      try {
        const gitService = ctx.services.gitService;
        const commit = await gitService.getCommit(repo, hash);
        const parent = await resolveDiffParent(hash, commit.parents, (parents) =>
          _pickMergeParent(repo, parents, gitService)
        );
        if (parent === undefined) {
          return; // user cancelled the merge-parent picker
        }
        await _openCommitFileDiff(repo, hash, parent, gitService);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        void vscode.window.showErrorMessage(`Failed to show diff: ${sanitizeGitError(msg)}`);
      }
    },
  });

  // Compare this commit with HEAD (whole-commit diff).
  const commitCompareWithHeadCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.compareWithHead',
    failureTitle: 'Failed to compare',
    run: async (_args, commitArg) => {
      const hash = extractCommitHash(commitArg);
      if (!hash) {
        void vscode.window.showErrorMessage('No commit selected.');
        return;
      }
      const repo = await resolveRepoContainingCommit(ctx, hash);
      if (!repo || !ctx.services) {
        return;
      }
      await _openRefPairDiffPicker(repo, hash, 'HEAD', ctx.services.gitService);
    },
  });

  // Compare this commit with a user-chosen ref (branch/tag/recent commit).
  const commitCompareWithCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.compareWith',
    failureTitle: 'Failed to compare',
    run: async (_args, commitArg) => {
      const hash = extractCommitHash(commitArg);
      if (!hash) {
        void vscode.window.showErrorMessage('No commit selected.');
        return;
      }
      const repo = await resolveRepoContainingCommit(ctx, hash);
      if (!repo || !ctx.services) {
        return;
      }
      const gitService = ctx.services.gitService;
      const target = await _pickRefForComparison(repo, gitService);
      if (!target) {
        return;
      }
      await _openRefPairDiffPicker(repo, hash, target, gitService);
    },
  });

  // Show a file from this commit in a read-only editor.
  const commitShowFileInRevisionCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.showFileInRevision',
    failureTitle: 'Failed to open file at revision',
    run: async (_args, commitArg) => {
      const hash = extractCommitHash(commitArg);
      if (!hash) {
        void vscode.window.showErrorMessage('No commit selected.');
        return;
      }
      const repo = await resolveRepoContainingCommit(ctx, hash);
      if (!repo || !ctx.services) {
        return;
      }
      try {
        const gitService = ctx.services.gitService;
        const diffs = await gitService.getCommitDiff(repo, hash);
        if (diffs.length === 0) {
          void vscode.window.showInformationMessage('No files changed in this commit.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          diffs.map((d) => ({ label: d.path, description: d.status })),
          {
            title: `Files in ${hash.substring(0, 8)}`,
            placeHolder: 'Select a file to open at this revision',
          }
        );
        if (!picked) {
          return;
        }
        const uri = vscode.Uri.parse(`intellig-git:${picked.label}?${encodeURIComponent(hash)}`);
        await vscode.commands.executeCommand('vscode.open', uri);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        void vscode.window.showErrorMessage(
          `Failed to open file at revision: ${sanitizeGitError(msg)}`
        );
      }
    },
  });

  // File history starting at this commit. When the caller supplies the file
  // (the details-panel file context menu), open the History tab for that file
  // anchored at the revision (reference TabbedShowHistoryForRevisionAction);
  // otherwise fall back to the active-file history flow.
  const commitFileHistoryFromHereCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.fileHistoryFromHere',
    failureTitle: 'Failed to open file history',
    run: async (_args, commitArg) => {
      const hash = extractCommitHash(commitArg);
      const path =
        commitArg &&
        typeof commitArg === 'object' &&
        typeof (commitArg as { path?: unknown }).path === 'string'
          ? (commitArg as { path: string }).path
          : undefined;
      if (hash && path && ctx.gitToolWindowProvider && isTabbedGitToolWindowEnabled()) {
        const repo = await resolveRepoContainingCommit(ctx, hash);
        if (!repo) {
          return;
        }
        await ctx.gitToolWindowProvider.revealLogHost();
        await ctx.gitToolWindowProvider.loadFileHistory(path, repo.rootUri.fsPath, hash);
        return;
      }
      await vscode.commands.executeCommand(
        'intellig.showHistory',
        hash ? { startRef: hash } : undefined
      );
    },
  });

  // Interactively rebase starting at this commit — delegates to the existing
  // interactive-rebase command, pre-selecting the commit as the onto target.
  const rebaseInteractiveFromHereCommand = registerBareCommand(ctx, {
    id: 'intellig.rebase.interactiveFromHere',
    failureTitle: 'Failed to open the rebase dialog',
    run: async (_args, commitArg) => {
      const hash = extractCommitHash(commitArg);
      await vscode.commands.executeCommand(
        'intellig.rebase.interactive',
        hash ? { onto: hash } : undefined
      );
    },
  });

  // Open this commit on the configured hosting provider (GitHub / GitLab /
  // Bitbucket, auto-detected from the repo's origin remote URL).
  const commitOpenOnHostCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.openOnHost',
    failureTitle: 'Open on Host failed',
    run: async (_args, commitArg) => {
      const hash = extractCommitHash(commitArg);
      if (!hash) {
        void vscode.window.showErrorMessage(
          'No commit selected. Right-click a commit in the log first.'
        );
        return;
      }
      await _openCommitOnHost(hash);
    },
  });

  // ─── Cherry-Pick variants ──────────────────────────────────────────────

  // Cherry-Pick Without Commit: applies the commit to the index + worktree
  // with `--no-commit` so the user can inspect / amend before committing.
  const commitCherryPickWithoutCommitCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.cherryPickWithoutCommit',
    failureTitle: 'Cherry-pick failed',
    run: async (_args, commitArg) => {
      await _runCherryPickVariant(commitArg, { noCommit: true });
    },
  });

  // Apply Selected Changes…: QuickPick commit's files, apply only the
  // selected subset to the index + worktree (cherry-pick-n + revert of
  // non-selected files). Unicode ellipsis on the palette label because
  // the dialog prompts.
  const commitApplySelectedChangesCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.applySelectedChanges',
    failureTitle: 'Cherry-pick failed',
    run: async (_args, commitArg) => {
      const hash = extractCommitHash(commitArg);
      if (!hash) {
        void vscode.window.showErrorMessage('No commit selected.');
        return;
      }
      const repo = await resolveRepoContainingCommit(ctx, hash);
      if (!repo || !ctx.services) {
        return;
      }
      const gitService = ctx.services.gitService;
      const files = await _pickCommitFiles(gitService, repo, hash, 'Apply Selected Changes');
      if (!files || files.length === 0) {
        return;
      }
      await _runCherryPickVariant(commitArg, { noCommit: true, files });
    },
  });

  // Apply Files to Branch…: QuickPick commit's files, QuickPick a target
  // branch, stash if dirty, switch, cherry-pick-n with file subset onto the
  // target branch, then switch back. User can then commit on the target
  // branch or discard via reset.
  const commitApplyFilesToBranchCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.applyFilesToBranch',
    failureTitle: 'Apply Files to Branch failed',
    run: async (_args, commitArg) => {
      await _runApplyFilesToBranchFlow(commitArg);
    },
  });

  // ─── Module-local helpers (moved verbatim from extension.ts) ────────────

  /**
   * Pick a subset of files touched by `hash` via a multi-select QuickPick.
   * Returns `undefined` when the user cancels. Returns an empty array when
   * the user submits without picking anything; callers should treat that as
   * cancel (short-circuit to "apply nothing").
   */
  async function _pickCommitFiles(
    gitService: IGitService,
    repo: IRepository,
    hash: string,
    title: string
  ): Promise<string[] | undefined> {
    const diffs = await gitService.getCommitDiff(repo, hash);
    if (diffs.length === 0) {
      void vscode.window.showInformationMessage('No files changed in this commit.');
      return undefined;
    }
    const items = diffs.map((d) => ({
      label: d.path,
      description: d.status,
      picked: true, // IntelliJ pre-selects all files; users deselect to narrow.
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: `${title} — ${hash.substring(0, 8)}`,
      placeHolder: 'Select files to apply (Enter to confirm, Esc to cancel)',
      canPickMany: true,
      matchOnDescription: true,
    });
    if (!picked) {
      return undefined;
    }
    return picked.map((p) => p.label);
  }

  /**
   * Shared variant runner for Cherry-Pick Without Commit + Apply Selected
   * Changes. Picks a repo, extracts the hash, invokes
   * {@link IGitService.cherryPick} with the variant options, and routes
   * conflicts through the Resolve Conflicts dialog when available.
   */
  async function _runCherryPickVariant(
    commitArg: unknown,
    options: { noCommit?: boolean; files?: string[] }
  ): Promise<void> {
    const hash = extractCommitHash(commitArg);
    if (!hash) {
      void vscode.window.showErrorMessage('No commit selected.');
      return;
    }
    const repo = await resolveRepoContainingCommit(ctx, hash);
    if (!repo || !ctx.services) {
      return;
    }
    const gitService = ctx.services.gitService;
    const conflictService = ctx.services.conflictResolutionService;
    const shortHash = hash.substring(0, 8);

    try {
      const result = await gitService.cherryPick(repo, [hash], options).match(
        (r) => r,
        (e) => {
          throw e;
        }
      );
      if (result.success) {
        const verb = options.files
          ? 'Applied selected changes from'
          : options.noCommit
            ? 'Cherry-picked (without commit)'
            : 'Cherry-picked';
        void vscode.window.showInformationMessage(`${verb} ${shortHash}`);
        // top-level cherry-pick advanced HEAD;
        // reload before refresh so panel sees fresh state.
        await gitService.reloadRepository(repo);
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }
        return;
      }
      if (result.conflicts && result.conflicts.length > 0 && conflictService) {
        await conflictService.openResolveConflictsDialog(
          repo,
          result.conflicts.map((p) => ({ path: p, resolved: false })),
          {
            operation: 'cherryPick',
            target: shortHash,
            canAbort: true,
            canContinue: true,
          }
        );
        // Partial cherry-pick may have advanced HEAD
        // before the conflict; reload before refresh.
        await gitService.reloadRepository(repo);
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }
        return;
      }
      // Defensive: no conflicts, no success — surface a generic error.
      // sanitize-exempt: sha-prefix: shortHash is a 7-char SHA fragment, bounded charset cannot embed credentials
      void vscode.window.showWarningMessage(`Cherry-pick of ${shortHash} completed with warnings.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Cherry-pick failed: ${sanitizeGitError(msg)}`);
    }
  }

  /**
   * Apply Files to Branch flow: prompts for file subset + target branch,
   * stashes any dirty state on the current branch, checks out the target,
   * cherry-picks (with file subset, no-commit) onto it, then returns to the
   * original branch if a stash was taken. The user decides on the target
   * branch whether to commit the staged changes.
   *
   * Data-loss safeguard: if the working tree is dirty and stash fails, we
   * refuse to switch branches.
   */
  async function _runApplyFilesToBranchFlow(commitArg: unknown): Promise<void> {
    const hash = extractCommitHash(commitArg);
    if (!hash) {
      void vscode.window.showErrorMessage('No commit selected.');
      return;
    }
    const repo = await resolveRepoContainingCommit(ctx, hash);
    if (!repo || !ctx.services) {
      return;
    }
    const gitService = ctx.services.gitService;
    const shortHash = hash.substring(0, 8);

    // Pick the target branch.
    const branches = await gitService.getBranches(repo);
    const localBranches = branches.filter((b) => b.type === 'local');
    const currentBranchName = repo.head?.name?.replace(/^refs\/heads\//, '');
    const otherBranches = localBranches.filter((b) => b.name !== currentBranchName);
    if (otherBranches.length === 0) {
      void vscode.window.showErrorMessage(
        'Apply Files to Branch needs at least one other local branch.'
      );
      return;
    }
    const branchPick = await vscode.window.showQuickPick(
      otherBranches.map((b) => ({ label: b.name, description: b.commit?.substring(0, 8) })),
      {
        title: `Apply Files to Branch — ${shortHash}`,
        placeHolder: 'Pick a target branch',
      }
    );
    if (!branchPick) {
      return;
    }
    const targetBranch = branchPick.label;

    // Pick the file subset.
    const files = await _pickCommitFiles(gitService, repo, hash, 'Apply Files to Branch');
    if (!files || files.length === 0) {
      return;
    }

    // Stash dirty state (best-effort), switch, cherry-pick, restore. The
    // created entry's sha is captured right after the push so the restore
    // pops exactly that entry — `stash@{0}` is not stable between the push
    // and the pop (another flow or the user can push an entry, renumbering
    // the stack).
    let stashed = false;
    let stashSha: string | undefined;
    try {
      const status = await gitService.getStatus(repo);
      if (status.length > 0) {
        await gitService.stash(repo, `Auto-stash before applying files to ${targetBranch}`).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        stashed = true;
        try {
          stashSha = (await gitService.stashList(repo))[0]?.hash;
        } catch {
          // Legacy no-hash listing — the pop falls back to the head.
          stashSha = undefined;
        }
      }
    } catch (stashError) {
      const msg = stashError instanceof Error ? stashError.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Refusing to switch branch — failed to stash dirty state: ${sanitizeGitError(msg)}`
      );
      return;
    }

    // When the flow ends on the TARGET branch — a routed conflict, or staged
    // changes left uncommitted — the cleanup below must neither switch back
    // over that state nor pop the original branch's stash onto it.
    let stayOnTarget = false;
    try {
      await gitService.checkout(repo, targetBranch).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      const result = await gitService
        .cherryPick(repo, [hash], {
          noCommit: true,
          files,
        })
        .match(
          (r) => r,
          (e) => {
            throw e;
          }
        );
      if (result.success) {
        // `-n` leaves the applied files STAGED. Uncommitted changes travel
        // with the worktree, so they cannot be "left on" the target across a
        // branch switch — commit them here before returning. A cancelled
        // prompt keeps the user on the target with the changes staged.
        const message = await vscode.window.showInputBox({
          prompt: `Commit message for the ${files.length} file(s) applied to '${targetBranch}'`,
          value: `Apply changes from ${shortHash}`,
          validateInput: (v) => (v && v.trim() ? undefined : 'Commit message cannot be empty'),
        });
        if (message && message.trim()) {
          try {
            await gitService.commit(repo, message.trim(), {}).match(
              () => undefined,
              (e) => {
                throw e;
              }
            );
            void vscode.window.showInformationMessage(
              `Committed ${files.length} file(s) from ${shortHash} onto '${targetBranch}'.`
            );
          } catch (commitError) {
            // Keep the staged application on the target rather than dragging
            // it back to the original branch with the switch.
            stayOnTarget = true;
            const msg = commitError instanceof Error ? commitError.message : 'Unknown error';
            void vscode.window.showErrorMessage(
              `Failed to commit on '${targetBranch}': ${sanitizeGitError(msg)}. ` +
                `The changes remain staged there.` +
                (stashed ? ' Your original changes remain in the stash.' : '')
            );
          }
        } else {
          stayOnTarget = true;
          void vscode.window.showWarningMessage(
            `Changes from ${shortHash} are staged on '${targetBranch}' but not committed — ` +
              `commit or reset them there.` +
              (stashed ? ' Your original changes remain in the stash.' : '')
          );
        }
      } else if (result.conflicts && result.conflicts.length > 0) {
        const conflictService = ctx.services.conflictResolutionService;
        if (conflictService) {
          await conflictService.openResolveConflictsDialog(
            repo,
            result.conflicts.map((p) => ({ path: p, resolved: false })),
            {
              operation: 'cherryPick',
              target: `${shortHash} → ${targetBranch}`,
              canAbort: true,
              canContinue: true,
            }
          );
        } else {
          void vscode.window.showWarningMessage(
            `Conflicts in ${result.conflicts.length} file(s) on '${targetBranch}'. Resolve and commit manually.`
          );
        }
        // Leave the user on the target branch so they can resolve; the
        // finally's reload/refresh shows the post-checkout conflicted state.
        stayOnTarget = true;
        if (stashed) {
          void vscode.window.showWarningMessage(
            `Your original changes remain in the stash — pop them after resolving ` +
              `('git stash pop').`
          );
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      // The target-branch checkout (`gitService.checkout` above) can hit
      // git's "already used by another worktree" refusal — surface the
      // actionable worktree message instead of the raw fatal. The checkout
      // failed atomically, so HEAD never moved; the finally below returns to
      // the original branch (a no-op when we never left) and pops the stash.
      const worktreeMessage = worktreeConflictMessage(msg);
      if (worktreeMessage) {
        void vscode.window.showErrorMessage(worktreeMessage);
      } else {
        void vscode.window.showErrorMessage(
          `Apply Files to Branch failed: ${sanitizeGitError(msg)}`
        );
      }
    } finally {
      // Return to the original branch and restore the stash — UNLESS the
      // flow deliberately ended on the target (routed conflict, or staged
      // changes left uncommitted): switching back would fail over an
      // unmerged index or drag the staged application along, and popping
      // would dump the original branch's dirt onto the target.
      if (!stayOnTarget) {
        if (currentBranchName) {
          try {
            await gitService.checkout(repo, currentBranchName).match(
              () => undefined,
              (e) => {
                throw e;
              }
            );
          } catch (backError) {
            const msg = backError instanceof Error ? backError.message : 'Unknown error';
            void vscode.window.showWarningMessage(
              `Could not return to '${currentBranchName}': ${sanitizeGitError(msg)}. ` +
                `You may be on '${targetBranch}' now.`
            );
          }
        }
        if (stashed) {
          await _popApplyFlowStash(gitService, repo, stashSha);
        }
      }
      // Finally block runs after multi-step pipeline
      // (stash → checkout → cherry-pick → checkout-back → stashPop); reload
      // before refresh so the panel reflects the final restored state on
      // the original branch.
      await gitService.reloadRepository(repo);
      if (ctx.gitToolWindowProvider) {
        ctx.gitToolWindowProvider.refresh();
      }
    }
  }

  /**
   * Pop the auto-stash created by the apply-files flow, pinned to the entry's
   * sha: the stack may have been renumbered by entries pushed in between, so
   * the entry's CURRENT index is resolved from a fresh listing first. A sha
   * that has vanished from the list warns instead of popping a stranger's
   * entry; a legacy no-hash capture (`stashSha === undefined`) falls back to
   * the head.
   */
  async function _popApplyFlowStash(
    gitService: IGitService,
    repo: IRepository,
    stashSha: string | undefined
  ): Promise<void> {
    let index = 0;
    if (stashSha !== undefined) {
      try {
        const entries = await gitService.stashList(repo);
        const entry = entries.find((e) => e.hash === stashSha);
        if (!entry) {
          void vscode.window.showWarningMessage(
            'The auto-stash created for this apply is no longer in the stash list — ' +
              'your changes were not restored.'
          );
          return;
        }
        index = entry.index;
      } catch (listError) {
        // Listing failed — fall back to the head, matching the pre-pin behavior.
        getLogger()
          .child({ component: 'commitMenuCommands' })
          .warn('apply-files stash pop: stash list failed; falling back to stash@{0}', {
            err: listError instanceof Error ? listError.message : String(listError),
          });
      }
    }
    try {
      // Explicit --index: this pops the extension's OWN bracket stash, so the
      // exact staged/unstaged split it captured must come back.
      await gitService.stashPop(repo, index, true).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
    } catch (popError) {
      const msg = popError instanceof Error ? popError.message : 'Unknown error';
      void vscode.window.showWarningMessage(
        `Could not pop auto-stash: ${sanitizeGitError(msg)}. Run 'git stash pop' manually.`
      );
    }
  }

  /**
   * Open the given commit on its hosting provider's web UI.
   *
   * Resolves the repo's `origin` remote, parses the URL, and builds the
   * provider-specific commit URL. If the provider isn't recognised or the
   * repo has no origin, we surface an explanatory error toast instead of
   * silently doing nothing.
   */
  async function _openCommitOnHost(hash: string): Promise<void> {
    const repo = await resolveRepoContainingCommit(ctx, hash);
    if (!repo || !ctx.services) {
      return;
    }

    try {
      const remotes = await ctx.services.gitService.getRemotes(repo).match(
        (r) => r,
        (e) => {
          throw e;
        }
      );
      if (!remotes || remotes.length === 0) {
        void vscode.window.showInformationMessage(
          'Open on Host: no remotes configured for this repository.'
        );
        return;
      }
      // Prefer `origin`; fall back to first remote with a fetch URL.
      const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
      const url = origin.fetchUrl ?? origin.pushUrl;
      const parsed = parseRemoteUrl(url);
      if (!parsed) {
        // A remote URL can embed `user:token@host` credentials — scrub before
        // it lands in a toast / notification history.
        void vscode.window.showErrorMessage(
          `Open on Host: could not parse remote URL "${url ? sanitizeGitError(url) : '(none)'}".`
        );
        return;
      }
      const link = commitUrl(parsed, hash);
      if (!link) {
        void vscode.window.showErrorMessage(
          `Open on Host: provider "${parsed.host}" is not supported yet.`
        );
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(link));
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Open on Host failed: ${sanitizeGitError(msg)}`);
    }
  }

  /**
   * Open a diff picker for a single commit vs. a reference point. For each
   * changed file in the commit, the user can open a side-by-side diff using
   * the `intellig-git:` content-provider scheme.
   */
  async function _openCommitFileDiff(
    repo: IRepository,
    commitHash: string,
    parentRef: string,
    gitService: IGitService
  ): Promise<void> {
    const diffs = await gitService.getCommitDiff(repo, commitHash);
    if (diffs.length === 0) {
      void vscode.window.showInformationMessage('No changes in this commit.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      diffs.map((d) => ({ label: d.path, description: d.status })),
      {
        title: `Changed files in ${commitHash.substring(0, 8)}`,
        placeHolder: 'Select a file to diff',
      }
    );
    if (!picked) {
      return;
    }
    const filePath = picked.label;
    const leftUri = vscode.Uri.parse(`intellig-git:${filePath}?${encodeURIComponent(parentRef)}`);
    const rightUri = vscode.Uri.parse(`intellig-git:${filePath}?${encodeURIComponent(commitHash)}`);
    // Bare (re-throws); the caller owns error reporting.
    await openRevisionDiff({
      leftUri,
      rightUri,
      title: `${filePath} (${parentRef.substring(0, 8)} ↔ ${commitHash.substring(0, 8)})`,
    });
  }

  /**
   * Given a commit hash and a comparison target (branch name / commit / 'HEAD'),
   * list files that differ between the two and open a diff for the chosen file.
   *
   * Used by `compareWithHead` and `compareWith`. Simple implementation: we
   * get the diff of `commitHash` vs its parent and the diff of `target` vs
   * its parent, then merge file lists. Not a proper 3-way diff.
   */
  async function _openRefPairDiffPicker(
    repo: IRepository,
    commitHash: string,
    target: string,
    gitService: IGitService
  ): Promise<void> {
    try {
      // Files that DIFFER between the two refs (`git diff --name-status
      // target commit`) — not just the commit's own touched files, which
      // missed everything changed by other commits in between. Falls back to
      // the commit's own diff when the capability is absent (mock services).
      const entries =
        typeof gitService.getChangedFilesBetweenRefs === 'function'
          ? await gitService.getChangedFilesBetweenRefs(repo, target, commitHash)
          : await gitService.getCommitDiff(repo, commitHash);
      if (entries.length === 0) {
        void vscode.window.showInformationMessage('No differences to compare.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        entries.map((d) => ({ label: d.path, description: d.status })),
        {
          title: `Compare ${commitHash.substring(0, 8)} ↔ ${target.substring(0, 8)}`,
          placeHolder: 'Select a file to diff',
        }
      );
      if (!picked) {
        return;
      }
      const filePath = picked.label;
      const leftUri = vscode.Uri.parse(`intellig-git:${filePath}?${encodeURIComponent(target)}`);
      const rightUri = vscode.Uri.parse(
        `intellig-git:${filePath}?${encodeURIComponent(commitHash)}`
      );
      // Bare (re-throws) into the surrounding catch, which also covers
      // `getCommitDiff` + the picker above.
      await openRevisionDiff({
        leftUri,
        rightUri,
        title: `${filePath} (${target} ↔ ${commitHash.substring(0, 8)})`,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to compare: ${sanitizeGitError(msg)}`);
    }
  }

  /**
   * Prompt the user to pick a ref (branch or recent commit) for a pairwise
   * comparison. Returns the selected ref name, or `undefined` on cancel.
   */
  async function _pickRefForComparison(
    repo: IRepository,
    gitService: IGitService
  ): Promise<string | undefined> {
    const [branches, commits] = await Promise.all([
      gitService.getBranches(repo),
      gitService.getLog(repo, { maxCount: 20 }),
    ]);
    const branchItems = branches.map((b) => ({
      label: b.name,
      description: b.type === 'remote' ? 'remote' : 'local',
      detail: b.commit.substring(0, 8),
    }));
    const commitItems = commits.map((c) => ({
      label: c.shortHash,
      description: c.message.split('\n')[0].substring(0, 60),
      detail: `${c.author.name} — ${c.authorDate.toLocaleDateString()}`,
    }));
    const items: vscode.QuickPickItem[] = [
      { label: 'Branches', kind: vscode.QuickPickItemKind.Separator },
      ...branchItems,
      { label: 'Recent Commits', kind: vscode.QuickPickItemKind.Separator },
      ...commitItems,
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Compare with…',
      placeHolder: 'Choose a branch or commit',
    });
    if (!picked || picked.kind === vscode.QuickPickItemKind.Separator) {
      return undefined;
    }
    return picked.label;
  }

  return [
    commitCopyHashCommand,
    commitCheckoutRevisionCommand,
    commitRevertCommand,
    commitCherryPickCommand,
    commitCreatePatchCommand,
    commitResetToHereCommand,
    commitDropSelectedChangesCommand,
    commitNewBranchCommand,
    commitShowDiffCommand,
    commitCompareWithHeadCommand,
    commitCompareWithCommand,
    commitShowFileInRevisionCommand,
    commitFileHistoryFromHereCommand,
    rebaseInteractiveFromHereCommand,
    commitOpenOnHostCommand,
    commitCherryPickWithoutCommitCommand,
    commitApplySelectedChangesCommand,
    commitApplyFilesToBranchCommand,
  ];
}
