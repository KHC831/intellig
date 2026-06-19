import * as vscode from 'vscode';
import { registerLoggedCommand, getLogger } from '../../utils/logger';
import { resolveRepo } from '../../utils/resolveRepo';
import { repoRelativePath } from '../../utils/repoRelativePath';
import { sanitizeGitError, formatActionFailureToast } from '../../git-core/gitError';
import { findCommitByQuery } from '../../git-core/gitToolWindow/jumpToHash';
import { isTabbedGitToolWindowEnabled } from '../../git-core/gitToolWindow/config';
import {
  CommitDialog,
  GIT_TOOL_WINDOW_VIEW_ID,
  COMMIT_TOOL_WINDOW_VIEW_ID,
  isCommitToolWindowEnabled,
  showApplyPatchDialog,
  PatchWriteFailed,
  type IBranch,
  type ITag,
  type ICommitDialogResult,
  type PullDialogOutcome,
} from '../../services';
import type { ICommandContext } from './CommandContext';
import { extractCommitHash, runNewTagFlowFromContext } from './commitHelpers';
import {
  runUpdateProject,
  type IUpdateGitService,
  type UpdateMethod,
} from '../../sync/updateProject';
import { updateInfoHeadline } from '../../git-core/gitToolWindow/tabs/UpdateInfoTab';
import { buildUpdateNotification } from '../../ui-shell/NotificationService';
import { statusCodeToFileStatus } from '../../git-core/gitParser';
import type { IRollbackChange, FileStatus } from '../../git-core/interfaces/IGitService';

/**
 * Build the modal confirmation text for the Rollback / Revert Local Changes
 * action — IntelliJ's RollbackChangesDialog lists every affected file before
 * the (irreversible) revert. Returns the headline + a `detail` block that
 * enumerates the files and, when untracked files are in the set, spells out
 * that those will be deleted from disk (no recovery).
 *
 * Pure so the file-listing + data-loss wording can be unit-tested without the
 * VS Code modal.
 */
export function buildRollbackConfirmMessage(changes: readonly IRollbackChange[]): {
  message: string;
  detail: string;
} {
  const count = changes.length;
  const noun = count === 1 ? 'file' : 'files';
  const untracked = changes.filter((c) => c.status === 'untracked');

  const lines = changes.map((c) => `• ${c.path} (${c.status})`);
  let detail = `The following ${count} ${noun} will be reverted to their last committed state:\n${lines.join('\n')}`;
  if (untracked.length > 0) {
    const un = untracked.length === 1 ? 'file is' : 'files are';
    detail += `\n\n${untracked.length} of these ${un} untracked and will be DELETED from disk — this cannot be undone.`;
  }

  return {
    message: `Roll back local changes to ${count} ${noun}? This reverts your changes and cannot be undone.`,
    detail,
  };
}

const ROLLBACK_STATUSES = new Set<FileStatus>([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'untracked',
]);

/**
 * Narrow the untyped command argument into a list of {@link IRollbackChange}.
 * Callers (webview / context menu) pass `{ path, status }[]`; anything that
 * doesn't match — including the palette's no-arg invocation — yields
 * `undefined`, signalling the command to gather + prompt for the file set.
 */
export function extractRollbackChanges(arg: unknown): IRollbackChange[] | undefined {
  if (!Array.isArray(arg)) {
    return undefined;
  }
  const out: IRollbackChange[] = [];
  for (const item of arg) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { path?: unknown }).path === 'string' &&
      ROLLBACK_STATUSES.has((item as { status?: FileStatus }).status as FileStatus)
    ) {
      out.push({
        path: (item as { path: string }).path,
        status: (item as { status: FileStatus }).status,
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Handle the outcome of the generic `intellig.pull` PullDialog.
 *
 * The dialog (`runPullDialog`) shows its own toasts for the `pulled`,
 * `conflict`, and `error` outcomes, so this helper deliberately does NOT
 * re-toast for those — doing so would double-handle. For `cancelled`, the
 * dialog shows nothing (Esc / dismissing is a normal user action), so we
 * emit a single debug-level structured log record naming the step the user
 * cancelled at. That keeps a dismissed dialog observable in the IntelliG
 * OutputChannel without surfacing a toast.
 *
 * Extracted as a pure, exported function so the outcome-branching is unit
 * testable without driving the registered command through the extension
 * host. Relocated verbatim from extension.ts and re-exported there so the
 * by-name import in `branchContextMenu.fixes.test.ts` is preserved (RULE E2).
 *
 * @param outcome the result returned by `PullDialog.show()`
 */
export function handlePullDialogOutcome(outcome: PullDialogOutcome): void {
  if (outcome.status === 'cancelled') {
    getLogger()
      .child({ component: 'extension' })
      .debug('pull dialog cancelled', { step: outcome.step });
    return;
  }
  // pulled / conflict / error: the dialog already surfaced the appropriate
  // toast internally (see `runPullDialog`). Nothing more to do here.
}

/**
 * Orchestrate "Commit and Push" by chaining the canonical commit and push
 * entry points. Push runs ONLY when the commit reported success — mirroring
 * git4idea's `GitCommitAndPushExecutor` (plugins/git4idea/backend/src/checkin/
 * GitCommitAndPushExecutor.kt), which pushes as a post-commit step gated on the
 * commit (and its sync before-commit checks) succeeding. A cancelled commit
 * (`committed: false`), a no-result path (e.g. the Commit tool window reveal,
 * which returns `undefined`), or a thrown/blocked commit must NOT push.
 *
 * Extracted as a pure, vscode-free function so the failure-guard is unit
 * testable without driving the registered command through the extension host.
 * The caller injects `commit`/`push` as thin `executeCommand` wrappers so this
 * stays a thin orchestrator over the existing `intellig.commit` /
 * `intellig.push` handlers — no commit or push logic is re-implemented here.
 *
 * @param commit invokes the existing commit flow; resolves to the dialog
 *   result, or `undefined` when no synchronous commit occurred.
 * @param push invokes the existing push flow.
 * @returns whether the push was run.
 */
export async function commitThenPush(
  commit: () => Promise<ICommitDialogResult | undefined>,
  push: () => Promise<void>
): Promise<{ pushed: boolean }> {
  const result = await commit();
  if (result?.committed) {
    await push();
    return { pushed: true };
  }
  return { pushed: false };
}

/**
 * Commit + repo-core command handlers extracted verbatim from extension.ts's
 * registerCommands: intellig.openGitToolWindow, intellig.commit,
 * intellig.showCommitToolWindow, intellig.push, intellig.pushAllTags,
 * intellig.pull, intellig.fetch, intellig.refresh,
 * intellig.toolWindow.focusTab, intellig.toolWindow.jumpToHash,
 * intellig.stageSelected, intellig.unstageSelected, intellig.patch.apply,
 * intellig.patch.createFromLocal, intellig.showHistory, intellig.revertFile,
 * intellig.tag.new, intellig.commit.newTag.
 *
 * Reaches shared state through {@link ICommandContext}. The commitDialog
 * singleton lazy-init write-back goes THROUGH the read/WRITE ctx accessor
 * (RULE E1); commitToolWindow / gitToolWindowProvider are read-only. Returns
 * its disposables; extension.ts owns the single push (RULE E4).
 */
export function registerCommitRepoCoreCommands(ctx: ICommandContext): vscode.Disposable[] {
  // Open Git Tool Window command
  const openGitToolWindowCommand = registerLoggedCommand('intellig.openGitToolWindow', () => {
    // Focus the Git Tool Window view
    void vscode.commands.executeCommand(`${GIT_TOOL_WINDOW_VIEW_ID}.focus`);
  });

  // Commit command
  const commitCommand = registerLoggedCommand('intellig.commit', async () => {
    // Get the Git service and find a repository
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    // When the Commit Tool Window flag is on, reveal the view instead of
    // opening the modal CommitDialog.
    if (isCommitToolWindowEnabled() && ctx.commitToolWindow) {
      await ctx.commitToolWindow.show();
      return;
    }

    const gitService = ctx.services.gitService;

    // Multi-root repo targeting. Prefer the active editor's repo, fall
    // back to QuickPick in multi-root workspaces.
    let repo = await resolveRepo(gitService, {
      preferActive: true,
      pickerTitle: 'Commit — Choose Repository',
      pickerPlaceholder: 'Select a repository to commit to',
      silent: true,
    });

    if (!repo) {
      // Last-ditch: try to discover a repo from the first workspace folder so
      // invocations in a brand-new workspace (no repos cached yet) still work.
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        repo = await gitService.getRepository(workspaceFolders[0].uri);
      }
      if (!repo) {
        void vscode.window.showErrorMessage('No Git repository found in workspace');
        return;
      }
    }

    // Show commit dialog. Return its result so callers chaining off the
    // commit (e.g. intellig.commitAndPush) can gate on whether the user
    // actually committed.
    if (!ctx.commitDialog) {
      ctx.commitDialog = new CommitDialog(
        ctx.context.extensionUri,
        gitService,
        ctx.context.workspaceState
      );
    }
    return ctx.commitDialog.show(repo);
  });

  // Focus the Commit tool window (Alt+0).
  const showCommitToolWindowCommand = registerLoggedCommand(
    'intellig.showCommitToolWindow',
    async () => {
      if (ctx.commitToolWindow) {
        await ctx.commitToolWindow.show();
      } else {
        await vscode.commands.executeCommand(`${COMMIT_TOOL_WINDOW_VIEW_ID}.focus`);
      }
    }
  );

  // Push command — Push dialog (webview table w/ per-row targets,
  // force-with-lease default, protected-branch guard, multi-repo submit).
  const pushCommand = registerLoggedCommand('intellig.push', () => {
    ctx.openPushDialog();
  });

  // Push All Tags — a standalone palette command that runs
  // `git push --tags` on the active repo. Lives alongside the main Push
  // dialog (which also surfaces the tag push radio) so IntelliJ users get
  // a one-click entry point.
  const pushAllTagsCommand = registerLoggedCommand('intellig.pushAllTags', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }
    const gitService = ctx.services.gitService;
    const repo = await resolveRepo(gitService, {
      preferActive: true,
      pickerTitle: 'Push All Tags — Choose Repository',
      pickerPlaceholder: 'Select a repository',
    });
    if (!repo) {
      return;
    }
    // Pick the default remote to display in the toast. `getRemotes()` is
    // async; fall back to `'origin'` if the user's config doesn't list
    // any remote (edge case — the push will still fail informatively).
    let remoteName = 'origin';
    try {
      const remotes = await gitService.getRemotes(repo);
      if (remotes.length > 0) {
        remoteName = remotes[0].name;
      }
    } catch {
      // Non-fatal — the push below surfaces the real error.
    }
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pushing all tags to ${remoteName}…`,
          cancellable: false,
        },
        () => gitService.push(repo, { tags: true })
      );
      void vscode.window.showInformationMessage(`Pushed all tags to ${remoteName}`);
      // Push --tags updated remote-tracking refs for tags; reload + refresh so
      // the panel reflects fresh tag-on-remote state.
      await gitService.reloadRepository(repo);
      if (ctx.gitToolWindowProvider) {
        ctx.gitToolWindowProvider.refresh();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to push tags: ${sanitizeGitError(message)}`);
    }
  });

  // Pull command — Pull dialog (2-step QuickPick: source then flags). Branch
  // on the dialog's outcome. The dialog handles its own pulled/conflict/error
  // toasts internally (see `runPullDialog`); we only add a debug log on
  // cancellation so a dismissed dialog is observable in the IntelliG
  // OutputChannel (no toast — cancel is a normal user action).
  const pullCommand = registerLoggedCommand('intellig.pull', async () => {
    const dialog = ctx.getPullDialog();
    if (!dialog) {
      return;
    }
    const outcome = await dialog.show();
    handlePullDialogOutcome(outcome);
  });

  // Fetch command. Fetches all remotes for the selected repository,
  // with a QuickPick when there are multiple repositories in the workspace.
  const fetchCommand = registerLoggedCommand('intellig.fetch', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = ctx.services.gitService;

    // Unified multi-root resolver; preferActive lets the resolver seed
    // from the file the user is currently editing.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
      pickerTitle: 'Fetch — Choose Repository',
      pickerPlaceholder: 'Select a repository to fetch',
    });
    if (!repo) {
      return;
    }

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Fetching from all remotes…',
          cancellable: false,
        },
        () => gitService.fetch(repo, { all: true, prune: true })
      );

      // Reset auto-fetch backoff so the next scheduled tick isn't right on top
      // of this manual one.
      if (ctx.services.hasService('autoFetchService')) {
        ctx.services.autoFetchService.resetBackoff();
      }

      // follow-up: fetch advances remote-tracking refs so the
      // ahead/behind counts on the branch tree go stale until the watcher's
      // 250ms debounce. Reload-then-refresh closes the visible window the
      // same way the other mutation sites do.
      await gitService.reloadRepository(repo);
      if (ctx.gitToolWindowProvider) {
        ctx.gitToolWindowProvider.refresh();
      }

      const remoteCount = repo.remotes.length || 1;
      const refCount = result.updatedRefs.length;
      const message =
        refCount > 0
          ? `Fetched ${remoteCount} remote(s); ${refCount} ref(s) updated`
          : `Fetched ${remoteCount} remote(s); already up to date`;
      void vscode.window.showInformationMessage(message);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Fetch failed: ${sanitizeGitError(msg)}`);
    }
  });

  // Refresh command - refreshes all Git views
  const refreshCommand = registerLoggedCommand('intellig.refresh', () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    // Refresh the Git Tool Window
    if (ctx.gitToolWindowProvider) {
      // In the 2-panel layout, always refresh all panels
      ctx.gitToolWindowProvider.refresh();
    }

    void vscode.window.showInformationMessage('Git views refreshed');
  });

  // Update Project — IntelliJ's Vcs.UpdateProject (GitUpdateOptionsDialog +
  // GitUpdateProcess parity). Asks the user for an update method
  // (Merge / Rebase / Branch default), updates ALL repositories in the
  // workspace (multi-root), and produces an Update Info summary. Each repo:
  // preflight-guard → fetch --all --prune → pull with the resolved strategy.
  const updateProjectCommand = registerLoggedCommand('intellig.updateProject', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }
    const gitService = ctx.services.gitService;

    const repos = gitService.getRepositories();
    if (repos.length === 0) {
      void vscode.window.showErrorMessage('No Git repository found in workspace');
      return;
    }

    // Step 1 — choose the update method (GitUpdateOptionsDialog).
    interface IMethodItem extends vscode.QuickPickItem {
      method: UpdateMethod;
    }
    const methodItems: IMethodItem[] = [
      {
        label: '$(git-merge) Merge',
        description: 'git pull (merge fetched commits)',
        method: 'merge',
      },
      {
        label: '$(git-pull-request) Rebase',
        description: 'git pull --rebase (replay local commits on top)',
        method: 'rebase',
      },
      {
        label: '$(settings-gear) Branch default',
        description: "use the branch's configured pull strategy",
        method: 'branch-default',
      },
    ];
    const pickedMethod = await vscode.window.showQuickPick(methodItems, {
      title:
        repos.length > 1
          ? `Update ${repos.length} Repositories — Choose Method`
          : 'Update Project — Choose Method',
      placeHolder: 'How should fetched commits be integrated?',
      matchOnDescription: true,
    });
    if (!pickedMethod) {
      return;
    }

    const pullRebaseDefault = vscode.workspace
      .getConfiguration('intellig')
      .get<boolean>('pullRebase', false);

    // The 0a getIncomingOutgoing lives on the concrete GitService (ADR-001 —
    // not the frozen IGitService composite). The runtime instance is always a
    // GitService, so we narrow to the IUpdateGitService role interface.
    const updateGit = gitService as unknown as IUpdateGitService;

    let summary;
    try {
      summary = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: repos.length > 1 ? `Updating ${repos.length} repositories…` : 'Updating project…',
          cancellable: false,
        },
        () =>
          runUpdateProject({
            repos,
            gitService: updateGit,
            method: pickedMethod.method,
            pullRebaseDefault,
          })
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Update failed: ${sanitizeGitError(msg)}`);
      return;
    }

    if (ctx.gitToolWindowProvider) {
      ctx.gitToolWindowProvider.refresh();
    }

    // Surface the structured outcome with a deep-link to the Update Info tab.
    // The full Update Info tab rendering is wired by the Log/Graph workstream
    // (see UpdateInfoTab.setSummary); the notification's deep-link focuses that
    // tab via intellig.toolWindow.focusTab.
    const notification = buildUpdateNotification(
      summary.allClean,
      sanitizeGitError(updateInfoHeadline(summary))
    );
    const labels = (notification.deepLinks ?? []).map((l) => l.label);
    const choice =
      notification.severity === 'warning'
        ? await vscode.window.showWarningMessage(notification.message, ...labels)
        : await vscode.window.showInformationMessage(notification.message, ...labels);
    const link = (notification.deepLinks ?? []).find((l) => l.label === choice);
    if (link) {
      await vscode.commands.executeCommand(link.commandId, ...(link.commandArgs ?? []));
    }
  });

  // Focus a specific tab in the Git tool window. Declared in package.json;
  // bound here so the StatusBarService incoming badge (and future callers)
  // can jump straight to a tab.
  const focusTabCommand = registerLoggedCommand(
    'intellig.toolWindow.focusTab',
    async (tab: string) => {
      if (!ctx.gitToolWindowProvider) {
        // Provider not yet ready — fall back to opening the tool window so
        // the user still gets a reasonable response.
        await vscode.commands.executeCommand('intellig.openGitToolWindow');
        return;
      }
      const validTabs = ['log', 'console', 'incoming', 'updateInfo', 'history'] as const;
      type TabId = (typeof validTabs)[number];
      if (!validTabs.includes(tab as TabId)) {
        return;
      }
      await ctx.gitToolWindowProvider.focusTab(tab as TabId);
    }
  );

  // Jump to a commit hash / branch / tag within the currently-loaded
  // log. Accepts user input via an InputBox, resolves via `findCommitByQuery`
  // (pure helper, operates only on already-loaded commits per spec), then
  // delegates to `GitToolWindowProvider.scrollToCommit` which posts the
  // webview message + re-renders with the scroll target.
  const jumpToHashCommand = registerLoggedCommand('intellig.toolWindow.jumpToHash', async () => {
    if (!ctx.services || !ctx.gitToolWindowProvider) {
      void vscode.window.showErrorMessage('Git tool window not ready');
      return;
    }

    const query = await vscode.window.showInputBox({
      title: 'Jump to Commit',
      prompt: 'Enter a commit SHA, branch name, or tag name',
      placeHolder: 'e.g., abc1234 or main or v1.0.0',
    });
    if (!query) {
      return;
    }

    const state = ctx.gitToolWindowProvider.getExtendedLogState();
    const loadedCommits = state.commitNodes.map((n) => n.commit);

    // Branches and tags for name-based matching. We fall back to empty
    // arrays on error so the command degrades to pure SHA matching rather
    // than failing outright.
    const gitService = ctx.services.gitService;
    // prefer the tool-window's selected repo when set, otherwise
    // fall back to the active-editor's repo in multi-root workspaces.
    const repo =
      ctx.gitToolWindowProvider.getSelectedRepository() ??
      (await resolveRepo(gitService, { preferActive: true, silent: true }));
    let branches: IBranch[] = [];
    let tags: ITag[] = [];
    if (repo) {
      try {
        branches = await gitService.getBranches(repo);
      } catch {
        /* ignore — fall through to SHA-only matching */
      }
      try {
        tags = await gitService.getTags(repo);
      } catch {
        /* ignore */
      }
    }

    const match = findCommitByQuery(query, loadedCommits, branches, tags);
    if (!match) {
      // sanitize-exempt: user-input: query.trim() is the user-typed search string echoed back, not git stderr
      void vscode.window.showWarningMessage(`No commit found matching '${query.trim()}'`);
      return;
    }

    await vscode.commands.executeCommand(`${GIT_TOOL_WINDOW_VIEW_ID}.focus`);
    const scrolled = ctx.gitToolWindowProvider.scrollToCommit(match);
    if (!scrolled) {
      // Shouldn't happen given findCommitByQuery matched against the same
      // loaded set, but surface a warning just in case (e.g. state drifted
      // between the two calls).
      void vscode.window.showWarningMessage(
        `Commit ${match.substring(0, 7)} is not currently loaded in the graph`
      );
    }
  });

  // Stage selected files command
  const stageSelectedCommand = registerLoggedCommand('intellig.stageSelected', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = ctx.services.gitService;
    // prefer the active-editor's repo (that's the file being
    // staged) in multi-root workspaces.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
    });
    if (!repo) {
      return;
    }

    // Get the active editor's file or selected files from explorer
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      // git runs with `cwd = repo.rootUri.fsPath`, so it needs the REPO-root-
      // relative path. `asRelativePath` is workspace-folder-relative and breaks
      // for nested/multi-root repos (see repoRelativePath).
      const filePath = repoRelativePath(repo.rootUri.fsPath, activeEditor.document.uri.fsPath);
      try {
        await gitService.stage(repo, [filePath]);
        void vscode.window.showInformationMessage(`Staged: ${filePath}`);
        // Refresh views
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to stage file', error)
        );
      }
    } else {
      void vscode.window.showInformationMessage('No file selected to stage');
    }
  });

  // Unstage selected files command
  const unstageSelectedCommand = registerLoggedCommand('intellig.unstageSelected', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = ctx.services.gitService;
    // prefer the active-editor's repo (that's the file being
    // unstaged) in multi-root workspaces.
    const repo = await resolveRepo(gitService, {
      preferActive: true,
    });
    if (!repo) {
      return;
    }

    // Get the active editor's file or selected files from explorer
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      // git runs with `cwd = repo.rootUri.fsPath`, so it needs the REPO-root-
      // relative path. `asRelativePath` is workspace-folder-relative and breaks
      // for nested/multi-root repos (see repoRelativePath).
      const filePath = repoRelativePath(repo.rootUri.fsPath, activeEditor.document.uri.fsPath);
      try {
        await gitService.unstage(repo, [filePath]);
        void vscode.window.showInformationMessage(`Unstaged: ${filePath}`);
        // Refresh views
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to unstage file', error)
        );
      }
    } else {
      void vscode.window.showInformationMessage('No file selected to unstage');
    }
  });

  const applyPatchCommand = registerLoggedCommand(
    'intellig.patch.apply',
    async (initialUri?: vscode.Uri) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      const gitService = ctx.services.gitService;
      // Resolve with active-editor preference.
      const repo = await resolveRepo(gitService, {
        preferActive: true,
        pickerTitle: 'Apply Patch — Choose Repository',
        pickerPlaceholder: 'Select a repository',
      });
      if (!repo) {
        return;
      }
      showApplyPatchDialog(ctx.context, {
        repo,
        patchService: ctx.services.patchService,
        conflictResolutionService: ctx.services.conflictResolutionService,
        initialPatchPath: initialUri?.fsPath,
      });
    }
  );

  // Create Patch from Local Changes… — prompts for target (file /
  // clipboard) and writes the current diff.
  const createPatchFromLocalCommand = registerLoggedCommand(
    'intellig.patch.createFromLocal',
    async () => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      const gitService = ctx.services.gitService;
      // Resolve with active-editor preference.
      const repo = await resolveRepo(gitService, {
        preferActive: true,
        pickerTitle: 'Create Patch — Choose Repository',
        pickerPlaceholder: 'Select a repository',
      });
      if (!repo) {
        return;
      }

      const target = await vscode.window.showQuickPick(
        [
          { label: '$(file) Save to file…', id: 'file' as const },
          { label: '$(clippy) Copy to clipboard', id: 'clipboard' as const },
        ],
        { placeHolder: 'Where should the patch be written?' }
      );
      if (!target) {
        return;
      }

      try {
        if (target.id === 'clipboard') {
          const patch = await ctx.services.patchService.createPatchFromLocalChanges(repo, {
            toClipboard: true,
          });
          if (!patch || patch.trim().length === 0) {
            void vscode.window.showInformationMessage('No local changes to diff.');
            return;
          }
          void vscode.window.showInformationMessage('Patch copied to clipboard.');
          return;
        }

        const defaultUri = vscode.Uri.joinPath(repo.rootUri, 'changes.patch');
        const uri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { 'Patch files': ['patch', 'diff'], 'All files': ['*'] },
          saveLabel: 'Save Patch',
        });
        if (!uri) {
          return;
        }
        const patch = await ctx.services.patchService.createPatchFromLocalChanges(repo, {
          outputPath: uri.fsPath,
        });
        if (!patch || patch.trim().length === 0) {
          void vscode.window.showInformationMessage('No local changes to diff.');
          return;
        }
        void vscode.window.showInformationMessage(`Patch created: ${uri.fsPath}`);
      } catch (error) {
        // PatchWriteFailed means the service has already surfaced a
        // sanitised toast — we must not re-toast or the user sees two
        // error banners for one failure.
        if (error instanceof PatchWriteFailed) {
          return;
        }
        const errMsg = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to create patch: ${sanitizeGitError(errMsg)}`);
      }
    }
  );

  // Show History command (command palette / keybinding)
  const showHistoryCommand = registerLoggedCommand('intellig.showHistory', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = ctx.services.gitService;

    // Resolve via the active editor's file path when available so multi-root
    // invocations don't silently pick the wrong repo.
    const activeEditor = vscode.window.activeTextEditor;
    const hintRepoPath =
      activeEditor && activeEditor.document.uri.scheme === 'file'
        ? activeEditor.document.uri.fsPath
        : undefined;
    const repo = await resolveRepo(gitService, {
      hintRepoPath,
      preferActive: true,
      pickerTitle: 'Show History — Choose Repository',
      pickerPlaceholder: 'Select a repository',
    });
    if (!repo) {
      return;
    }

    // git runs with `cwd = repo.rootUri.fsPath`, so it needs the REPO-root-
    // relative path. `asRelativePath` is workspace-folder-relative and breaks
    // for nested/multi-root repos (see repoRelativePath).
    const filePath = activeEditor
      ? repoRelativePath(repo.rootUri.fsPath, activeEditor.document.uri.fsPath)
      : undefined;

    // When the tabbed Git tool window is enabled and we have a file path,
    // route to the embedded History tab instead of the legacy QuickPick.
    // Repo-level history (filePath === undefined) still uses the QuickPick
    // because the tab only supports per-file scope.
    if (filePath && isTabbedGitToolWindowEnabled() && ctx.gitToolWindowProvider) {
      await vscode.commands.executeCommand(`${GIT_TOOL_WINDOW_VIEW_ID}.focus`);
      await ctx.gitToolWindowProvider.loadFileHistory(filePath);
      return;
    }

    try {
      const history = filePath
        ? await gitService.getFileHistory(repo, filePath)
        : await gitService.getLog(repo, { maxCount: 50 });

      if (history.length === 0) {
        void vscode.window.showInformationMessage(
          filePath ? `No history found for ${filePath}` : 'No commit history found'
        );
        return;
      }

      const items = history.map((commit) => ({
        label: commit.shortHash,
        description: commit.message.substring(0, 60),
        detail: `${commit.author.name} - ${commit.authorDate.toLocaleDateString()}`,
        commit,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: filePath ? `History for ${filePath}` : 'Repository History',
        title: 'Show History',
      });

      if (selected) {
        // sanitize-exempt: non-error-data: selected.commit.message is the user-authored commit subject from `git log`, not git stderr; cannot embed credentials git emits in error paths
        void vscode.window.showInformationMessage(
          `Commit ${selected.commit.shortHash}: ${selected.commit.message}`
        );
      }
    } catch (error) {
      void vscode.window.showErrorMessage(formatActionFailureToast('Failed to get history', error));
    }
  });

  // Revert File command (command palette / keybinding)
  const revertFileCommand = registerLoggedCommand('intellig.revertFile', async () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    const gitService = ctx.services.gitService;

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      void vscode.window.showErrorMessage('No file selected to revert');
      return;
    }

    // The revert must land in the repo that owns the active file.
    const hintRepoPath =
      activeEditor.document.uri.scheme === 'file' ? activeEditor.document.uri.fsPath : undefined;
    const repo = await resolveRepo(gitService, {
      hintRepoPath,
      pickerTitle: 'Revert File — Choose Repository',
      pickerPlaceholder: 'Select a repository',
    });
    if (!repo) {
      return;
    }

    // git runs with `cwd = repo.rootUri.fsPath`, so it needs the REPO-root-
    // relative path. `asRelativePath` is workspace-folder-relative and breaks
    // for nested/multi-root repos (see repoRelativePath).
    const filePath = repoRelativePath(repo.rootUri.fsPath, activeEditor.document.uri.fsPath);

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to revert changes to ${filePath}? This cannot be undone.`,
      { modal: true },
      'Revert'
    );

    if (confirm !== 'Revert') {
      return;
    }

    try {
      await gitService.revertFile(repo, filePath);
      void vscode.window.showInformationMessage(`Reverted: ${filePath}`);
      if (ctx.gitToolWindowProvider) {
        ctx.gitToolWindowProvider.refresh();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(formatActionFailureToast('Failed to revert file', error));
    }
  });

  // Rollback / Revert Local Changes — IntelliJ's "Rollback" (Ctrl+Alt+Z).
  // Reverts the selected changed files back to their committed state after a
  // confirmation that lists every affected file (data loss). When invoked
  // without an explicit selection it reads `git status` and lets the user pick
  // which files to roll back, mirroring RollbackChangesDialog's file list.
  const rollbackChangesCommand = registerLoggedCommand(
    'intellig.rollbackChanges',
    async (arg?: unknown) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      const gitService = ctx.services.gitService;

      const repo = await resolveRepo(gitService, {
        pickerTitle: 'Rollback — Choose Repository',
        pickerPlaceholder: 'Select a repository',
      });
      if (!repo) {
        return;
      }

      // The caller (webview / context menu) may hand us the exact changes to
      // roll back. Otherwise gather the working-tree changes and let the user
      // choose.
      let changes = extractRollbackChanges(arg);
      if (!changes) {
        const statuses = await gitService.getStatus(repo);
        const candidates: IRollbackChange[] = statuses
          .map((s) => ({
            path: s.path,
            status: statusCodeToFileStatus(s.indexStatus, s.workTreeStatus),
          }))
          .filter((c) => c.status !== 'ignored' && c.status !== 'conflicted');
        if (candidates.length === 0) {
          void vscode.window.showInformationMessage('No local changes to roll back.');
          return;
        }
        const picks = await vscode.window.showQuickPick(
          candidates.map((c) => ({ label: c.path, description: c.status, change: c })),
          {
            title: 'Rollback — select files to revert',
            placeHolder: 'These files will be reverted to their committed state',
            canPickMany: true,
            matchOnDescription: true,
          }
        );
        if (!picks || picks.length === 0) {
          return;
        }
        changes = picks.map((p) => p.change);
      }

      if (changes.length === 0) {
        return;
      }

      const { message, detail } = buildRollbackConfirmMessage(changes);
      const confirm = await vscode.window.showWarningMessage(
        message,
        { modal: true, detail },
        'Rollback'
      );
      if (confirm !== 'Rollback') {
        return;
      }

      try {
        // Untracked files reach this point only because the user explicitly
        // selected them, so honor the include-to-delete contract.
        await gitService.rollbackChanges(repo, changes, { deleteUntracked: true });
        void vscode.window.showInformationMessage(`Rolled back ${changes.length} file(s).`);
        ctx.gitToolWindowProvider?.refresh();
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to roll back changes', error)
        );
      }
    }
  );

  // New Tag — command-palette entry, defaults to HEAD.
  const newTagCommand = registerLoggedCommand('intellig.tag.new', async () => {
    await runNewTagFlowFromContext(ctx, undefined);
  });

  // New Tag — invoked from the log commit context menu with a commit arg.
  const commitNewTagCommand = registerLoggedCommand(
    'intellig.commit.newTag',
    async (commitArg?: unknown, repoRootArg?: unknown) => {
      const ref = extractCommitHash(commitArg);
      // `repoRootArg` (merged "all roots" log) pins the tag to the clicked
      // commit's OWN repo; absent, the usual repository picker runs.
      await runNewTagFlowFromContext(ctx, ref, repoRootArg);
    }
  );

  // Commit and Push — IntelliJ's "Commit and Push…" (Ctrl+Alt+K). IntelliJ's
  // GitCommitAndPushExecutor pushes as a post-commit step gated on the commit
  // (and its before-commit checks) succeeding; a cancelled/failed commit does
  // NOT push. VS Code's commit surface is a separate modal, so we chain the
  // two via the canonical `intellig.commit` / `intellig.push` entry points —
  // reusing both rather than re-implementing either — and only push when the
  // commit reported `committed: true`.
  const commitAndPushCommand = registerLoggedCommand('intellig.commitAndPush', async () => {
    await commitThenPush(
      async () =>
        vscode.commands.executeCommand<ICommitDialogResult | undefined>('intellig.commit'),
      async () => {
        await vscode.commands.executeCommand('intellig.push');
      }
    );
  });

  // Push up to here — IntelliJ's Git.PushUpToHere. Accepts a commit hash,
  // resolves the current branch + remote, and pushes `<hash>:refs/heads/<branch>`
  // so the remote moves to that exact commit. Single-only; invoked
  // programmatically from the log commit context menu (not shown in menus).
  const PUSH_HASH_RE = /^[0-9a-f]{4,64}$/i;
  const pushUpToCommitCommand = registerLoggedCommand(
    'intellig.pushUpToCommit',
    async (hash: string, repoRootArg?: unknown) => {
      if (!hash || !PUSH_HASH_RE.test(hash)) {
        void vscode.window.showErrorMessage('Cannot push: invalid commit hash.');
        return;
      }
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }
      const gitService = ctx.services.gitService;
      // Prefer the clicked commit's OWN repo root when threaded through from
      // the merged "all roots" log — pushing a foreign hash against the
      // active-editor repo would move the WRONG remote branch. Falls back to
      // the active-editor / picker resolution for single-repo / palette callers
      // or when the recorded root no longer resolves.
      const rootHint =
        typeof repoRootArg === 'string' && repoRootArg.length > 0 ? repoRootArg : undefined;
      const repo =
        (rootHint ? await gitService.getRepository(vscode.Uri.file(rootHint)) : undefined) ??
        (await resolveRepo(gitService, {
          preferActive: true,
          pickerTitle: 'Push up to here — Choose Repository',
          pickerPlaceholder: 'Select a repository',
        }));
      if (!repo) {
        return;
      }
      const branch = repo.head?.name;
      const remote = repo.head?.upstream?.remote ?? 'origin';
      if (!branch) {
        void vscode.window.showErrorMessage('Cannot push: HEAD is detached (no current branch).');
        return;
      }
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Pushing up to ${hash.slice(0, 7)} on ${remote}/${branch}…`,
            cancellable: false,
          },
          () =>
            gitService.push(repo, {
              remote,
              refspec: `${hash}:refs/heads/${branch}`,
            })
        );
        void vscode.window.showInformationMessage(`Pushed up to ${hash.slice(0, 7)}.`);
        await gitService.reloadRepository(repo);
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Push failed.';
        void vscode.window.showErrorMessage(sanitizeGitError(msg));
      }
    }
  );

  // VCS Operations Popup — IntelliJ's Alt+` quick-list of common VCS actions.
  // Distinct from the branch popup (Ctrl+Shift+`): this is a flat menu of the
  // most-used Git operations, each dispatching to its existing command. New
  // entries are additive; the popup is intentionally a thin command router.
  const vcsOperationsPopupCommand = registerLoggedCommand(
    'intellig.vcsOperationsPopup',
    async () => {
      interface IVcsOpItem extends vscode.QuickPickItem {
        commandId: string;
      }
      const items: IVcsOpItem[] = [
        { label: '$(git-commit) Commit…', commandId: 'intellig.commit' },
        { label: '$(git-commit) Commit and Push…', commandId: 'intellig.commitAndPush' },
        { label: '$(arrow-up) Push…', commandId: 'intellig.push' },
        { label: '$(arrow-down) Pull…', commandId: 'intellig.pull' },
        { label: '$(sync) Fetch', commandId: 'intellig.fetch' },
        { label: '$(sync) Update Project', commandId: 'intellig.updateProject' },
        { label: '$(git-branch) Branches…', commandId: 'intellig.showBranchPopup' },
        { label: '$(history) Show History', commandId: 'intellig.showHistory' },
        { label: '$(list-unordered) Shelf…', commandId: 'intellig.showShelfList' },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: 'VCS Operations',
        placeHolder: 'Select a Git operation',
        matchOnDescription: true,
      });
      if (picked) {
        await vscode.commands.executeCommand(picked.commandId);
      }
    }
  );

  return [
    openGitToolWindowCommand,
    commitCommand,
    showCommitToolWindowCommand,
    pushCommand,
    pushAllTagsCommand,
    pullCommand,
    fetchCommand,
    updateProjectCommand,
    refreshCommand,
    focusTabCommand,
    jumpToHashCommand,
    stageSelectedCommand,
    unstageSelectedCommand,
    applyPatchCommand,
    createPatchFromLocalCommand,
    showHistoryCommand,
    revertFileCommand,
    rollbackChangesCommand,
    newTagCommand,
    commitNewTagCommand,
    commitAndPushCommand,
    vcsOperationsPopupCommand,
    pushUpToCommitCommand,
  ];
}
