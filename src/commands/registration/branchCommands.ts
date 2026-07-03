import * as vscode from 'vscode';
import { BranchPopup, createBranchComparisonView } from '../../services';
import { getIncomingOutgoingFetcher } from '../../branches/BranchPopup';
import type { IBranch } from '../../git-core/interfaces/IGitService';
import type { ICommandContext } from './CommandContext';
import { registerRepoCommand } from './commandSpine';

/** A merge-source quick-pick row carrying the branch to merge from. */
export interface IMergeBranchPickItem extends vscode.QuickPickItem {
  branchName: string;
}

/**
 * Build the quick-pick rows for the top-level "Merge…" command (IntelliJ
 * `Git.Merge`). Offers local and remote branches as merge sources and drops
 * the current (HEAD) branch — a branch cannot be merged into itself — and
 * tags, which are not merge sources in git4idea's Merge dialog.
 */
export function buildMergeBranchPickItems(branches: readonly IBranch[]): IMergeBranchPickItem[] {
  return branches
    .filter((b) => b.type !== 'tag' && !b.isHead)
    .map((b) => ({
      label: `${b.type === 'remote' ? '$(cloud)' : '$(git-branch)'} ${b.name}`,
      branchName: b.name,
    }));
}

/**
 * Branch-popup + branch-comparison command handlers extracted verbatim from
 * extension.ts's registerCommands: intellig.showBranchPopup,
 * intellig.compareWithBranch, intellig.compareWithRemote.
 *
 * Reaches shared state through {@link ICommandContext}. The branchPopup /
 * branchComparisonView singletons are lazily written back through the
 * read/WRITE ctx accessors (RULE E1). Returns its disposables; extension.ts
 * owns the single push (RULE E4).
 *
 * NOTE: the broader `intellig.branch.*` context-menu surface
 * (checkout/rename/delete/merge/rebase/etc.) is owned by
 * BranchContextMenuCommands, not registerCommands, and is unaffected by this
 * split.
 */
export function registerBranchCommands(ctx: ICommandContext): vscode.Disposable[] {
  // Branch popup command
  const branchPopupCommand = registerRepoCommand(ctx, {
    id: 'intellig.showBranchPopup',
    failureTitle: 'Failed to open branch popup',
    pickerTitle: 'Branches — Choose Repository',
    pickerPlaceholder: 'Select a repository',
    run: async ({ gitService, repo }) => {
      // Create branch popup if not exists. Wire the incoming/outgoing fetcher
      // when the concrete GitService exposes it so the popup shows ↓N/↑N
      // badges next to each tracked branch (ADR-001: the method is not on the
      // frozen IGitService interface, so we detect it via duck-typing).
      if (!ctx.branchPopup) {
        ctx.branchPopup = new BranchPopup(
          gitService,
          ctx.context.workspaceState,
          getIncomingOutgoingFetcher(gitService)
        );
      }
      await ctx.branchPopup.show(repo);
    },
  });

  // Compare with branch command
  const compareWithBranchCommand = registerRepoCommand(ctx, {
    id: 'intellig.compareWithBranch',
    failureTitle: 'Failed to compare with branch',
    run: async ({ gitService, repo }) => {
      if (!ctx.branchComparisonView) {
        ctx.branchComparisonView = createBranchComparisonView(gitService);
      }
      await ctx.branchComparisonView.show(repo);
    },
  });

  // Compare with remote command
  const compareWithRemoteCommand = registerRepoCommand(ctx, {
    id: 'intellig.compareWithRemote',
    failureTitle: 'Failed to compare with remote',
    run: async ({ gitService, repo }) => {
      if (!ctx.branchComparisonView) {
        ctx.branchComparisonView = createBranchComparisonView(gitService);
      }
      await ctx.branchComparisonView.compareWithRemote(repo);
    },
  });

  // Top-level "Merge…" command (IntelliJ Git.Merge): pick a branch and merge
  // it into the current one via the shared Merge Dialog, which owns option
  // selection (ff-only / no-ff / squash / -m) and conflict handoff. The branch
  // name reaches git through GitService.mergeBranch's `buildGitArgs` splice.
  const mergeFromCommand = registerRepoCommand(ctx, {
    id: 'intellig.mergeFrom',
    failureTitle: 'Failed to merge',
    run: async ({ gitService, repo }) => {
      const branches = await gitService.getBranches(repo);
      const items = buildMergeBranchPickItems(branches);
      if (items.length === 0) {
        void vscode.window.showInformationMessage('No other branches to merge from.');
        return;
      }

      const selected = await vscode.window.showQuickPick(items, {
        title: 'Merge',
        placeHolder: 'Select a branch to merge into the current branch',
      });
      if (!selected) {
        return;
      }

      ctx.openMergeDialog({ repo, sourceBranch: selected.branchName });
    },
  });

  return [branchPopupCommand, compareWithBranchCommand, compareWithRemoteCommand, mergeFromCommand];
}
