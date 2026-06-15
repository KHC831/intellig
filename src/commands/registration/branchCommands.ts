import * as vscode from 'vscode';
import { registerLoggedCommand } from '../../utils/logger';
import { resolveRepo } from '../../utils/resolveRepo';
import { BranchPopup, createBranchComparisonView } from '../../services';
import type { IncomingOutgoingFetcher } from '../../branches/BranchPopup';
import type { ICommandContext } from './CommandContext';
import type { IRepository } from '../../git-core/interfaces/IGitService';
import type { IIncomingOutgoing } from '../../git-core/ops/IncomingOutgoingOps';

/**
 * Duck-type guard: check whether the gitService has `getIncomingOutgoingForBranch`
 * (it lives on the concrete GitService class, not the frozen IGitService interface
 * per ADR-001). Returns the method as an {@link IncomingOutgoingFetcher} when
 * present, undefined when not (e.g. in unit-test stubs).
 */
function getIncomingOutgoingFetcher(gitService: unknown): IncomingOutgoingFetcher | undefined {
  if (
    typeof gitService === 'object' &&
    gitService !== null &&
    'getIncomingOutgoingForBranch' in gitService &&
    typeof (gitService as Record<string, unknown>).getIncomingOutgoingForBranch === 'function'
  ) {
    const svc = gitService as {
      getIncomingOutgoingForBranch(repo: IRepository, branch: string): Promise<IIncomingOutgoing>;
    };
    return (repo: IRepository, branch: string) => svc.getIncomingOutgoingForBranch(repo, branch);
  }
  return undefined;
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
  const branchPopupCommand = registerLoggedCommand('intellig.showBranchPopup', async () => {
    // Get the Git service
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = ctx.services.gitService;

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

    // Seed the popup with the repo the user is most likely targeting.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
      pickerTitle: 'Branches — Choose Repository',
      pickerPlaceholder: 'Select a repository',
    });
    if (!repo) {
      return;
    }
    await ctx.branchPopup.show(repo);
  });

  // Compare with branch command
  const compareWithBranchCommand = registerLoggedCommand('intellig.compareWithBranch', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = ctx.services.gitService;
    // prefer the active-editor's repo in multi-root workspaces.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
    });
    if (!repo) {
      return;
    }

    // Create branch comparison view if not exists and show it
    if (!ctx.branchComparisonView) {
      ctx.branchComparisonView = createBranchComparisonView(gitService);
    }
    await ctx.branchComparisonView.show(repo);
  });

  // Compare with remote command
  const compareWithRemoteCommand = registerLoggedCommand('intellig.compareWithRemote', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = ctx.services.gitService;
    // prefer the active-editor's repo in multi-root workspaces.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
    });
    if (!repo) {
      return;
    }

    // Create branch comparison view if not exists and compare with remote
    if (!ctx.branchComparisonView) {
      ctx.branchComparisonView = createBranchComparisonView(gitService);
    }
    await ctx.branchComparisonView.compareWithRemote(repo);
  });

  return [branchPopupCommand, compareWithBranchCommand, compareWithRemoteCommand];
}
