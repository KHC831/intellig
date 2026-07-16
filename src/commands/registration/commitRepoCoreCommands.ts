import * as vscode from 'vscode';
import { readConfig } from '../../config/configKeys';
import { registerLoggedCommand, getLogger } from '../../utils/logger';
import { resolveRepo } from '../../utils/resolveRepo';
import { repoRelativePath } from '../../utils/repoRelativePath';
import { sanitizeGitError, formatActionFailureToast } from '../../git-core/gitError';
import type { ResultAsync } from 'neverthrow';
import type { GitError } from '../../git-core/errors';
import { findCommitByQuery } from '../../git-core/gitToolWindow/jumpToHash';
import {
  CommitDialog,
  GIT_TOOL_WINDOW_VIEW_ID,
  COMMIT_TOOL_WINDOW_VIEW_ID,
  isCommitToolWindowEnabled,
  showApplyPatchDialog,
  PatchWriteFailed,
  type IBranch,
  type ITag,
  type ICommit,
  type ICommitDialogResult,
  type PullDialogOutcome,
} from '../../services';
import type { ICommandContext } from './CommandContext';
import { registerBareCommand, registerFileCommand, registerRepoCommand } from './commandSpine';
import { fileStatusFor, revertPrecheck } from './explorerCommands';
import { extractCommitHash, runNewTagFlowFromContext, presentFileHistory } from './commitHelpers';
import {
  pickResolutionTarget,
  repoDisplayName,
  runUpdateProject,
  type IUpdateGitService,
  type UpdateMethod,
} from '../../sync/updateProject';
import { runConfigureRemotesFlow } from '../../sync/configureRemotes';
import { isValidPushHash } from '../../sync/PushDialog';
import { updateInfoHeadline } from '../../git-core/gitToolWindow/tabs/UpdateInfoTab';
import { buildUpdateNotification } from '../../ui-shell/updateNotification';
import { statusCodeToFileStatus } from '../../git-core/gitParser';
import type {
  IRollbackChange,
  IFileStatus,
  FileStatus,
} from '../../git-core/interfaces/IGitService';
import { loadPersisted, savePersisted, type PersistedSlot } from '../../utils/persistedState';

/** One row of the Create Patch from Local Changes multi-pick. */
export type CreateLocalPatchPick = 'file' | 'clipboard' | 'reverse';

/**
 * Validate the persisted Create Patch pick set: an array of known pick ids
 * carrying at least one destination (`file` / `clipboard`). Anything else —
 * junk entries, an options-only set — degrades to the caller's default.
 */
export function validateCreateLocalPatchPicks(raw: unknown): CreateLocalPatchPick[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const allowed: readonly string[] = ['file', 'clipboard', 'reverse'];
  if (!raw.every((v): v is CreateLocalPatchPick => typeof v === 'string' && allowed.includes(v))) {
    return undefined;
  }
  if (!raw.includes('file') && !raw.includes('clipboard')) {
    return undefined;
  }
  return [...new Set(raw)] as CreateLocalPatchPick[];
}

/**
 * Persisted pick set for Create Patch from Local Changes (destinations +
 * the Reverse option), so the multi-pick reopens with the user's last
 * choices — the IntelliJ Create Patch panel persists the same toggles
 * (CreatePatchConfigurationPanel / CreatePatchCommitExecutor).
 */
export const CREATE_LOCAL_PATCH_PICKS_SLOT: PersistedSlot<CreateLocalPatchPick[]> = {
  key: 'intellig.patch.createFromLocalPicks',
  version: 1,
  validate: validateCreateLocalPatchPicks,
};

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
      // `oldPath` (a rename/copy's HEAD path) must survive the narrowing —
      // dropping it makes the rollback delete the renamed file without
      // restoring the original.
      const oldPath = (item as { oldPath?: unknown }).oldPath;
      out.push({
        path: (item as { path: string }).path,
        status: (item as { status: FileStatus }).status,
        ...(typeof oldPath === 'string' && oldPath.length > 0 ? { oldPath } : {}),
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Re-derive each arg-supplied change's status and rename source from a fresh
 * `git status` read. Arg callers (webview rows, context menus) often carry a
 * bare `{path, status}` — and a stale or oldPath-less 'renamed' entry makes
 * the rollback delete the renamed file WITHOUT restoring the original. The
 * porcelain read is authoritative, so it wins whenever the path appears in
 * it; a path absent from status keeps the caller's claim (the git op then
 * fails informatively rather than us guessing).
 */
export function enrichRollbackChanges(
  changes: readonly IRollbackChange[],
  statuses: readonly IFileStatus[]
): IRollbackChange[] {
  const byPath = new Map(statuses.map((s) => [s.path, s]));
  return changes.map((c) => {
    const s = byPath.get(c.path);
    if (!s) {
      return c;
    }
    return {
      path: c.path,
      status: statusCodeToFileStatus(s.indexStatus, s.workTreeStatus),
      ...(s.renamed ? { oldPath: s.renamed } : {}),
    };
  });
}

/**
 * Resolve the file `intellig.showHistory` targets: an explicit file-Uri
 * argument (the CTW Local-Changes context menu passes the clicked row) wins
 * over the active editor; a non-Uri argument (or none) falls back to the
 * active editor; no editor → undefined (repo-level history).
 */
export function resolveShowHistoryTargetFsPath(
  rawArg: unknown,
  activeEditorFsPath: string | undefined
): string | undefined {
  const argFsPath =
    rawArg &&
    typeof rawArg === 'object' &&
    typeof (rawArg as { fsPath?: unknown }).fsPath === 'string'
      ? (rawArg as { fsPath: string }).fsPath
      : undefined;
  return argFsPath ?? activeEditorFsPath;
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
 * Follow-up toast for `intellig.commitAndPush` when the commit leg revealed
 * the Commit tool window instead of running a modal commit: the reveal
 * returns no result, so the chained push is (correctly) skipped — but the
 * user asked for commit AND push, so say where the push went. Quiet when the
 * push ran, and quiet on the modal path (a cancelled dialog is the user's
 * own choice).
 */
export function commitAndPushFollowUp(
  pushed: boolean,
  toolWindowPathTaken: boolean
): string | undefined {
  if (pushed || !toolWindowPathTaken) {
    return undefined;
  }
  return "Commit tool window opened — use its 'Commit and Push' button to push after committing.";
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
/** Seams {@link runJumpToCommitFlow} needs, kept discrete for testing. */
export interface IJumpToCommitFlowDeps {
  /** Prompt the user for the query; undefined/empty cancels. */
  promptQuery(): Promise<string | undefined>;
  /** The currently-loaded log window (re-read after a grow). */
  getLoadedCommits(): ICommit[];
  /** Branches + tags for ref-name matching (empty arrays on failure). */
  getRefs(): Promise<{ branches: IBranch[]; tags: ITag[] }>;
  /** Grow the log window to the active scope's full history; false = couldn't. */
  ensureFullLogLoaded(): Promise<boolean>;
  revealLogHost(): Promise<void>;
  /** Scroll to a loaded commit; false when the hash isn't in the window. */
  scrollToCommit(hash: string): boolean;
  warn(message: string): void;
}

/**
 * Jump-to-Commit resolution flow — jumpToRefOrHash parity. Resolves the query
 * ref-prefix-first via `findCommitByQuery`; a miss grows the log window to
 * the full history ONCE and retries (the reference retries as data packs
 * load until the pack is full, so any commit in the repo is found). A ref
 * match whose tip commit sits outside the loaded window grows the same way
 * before scrolling. Warnings fire only once growth is exhausted.
 */
export async function runJumpToCommitFlow(deps: IJumpToCommitFlowDeps): Promise<void> {
  const query = await deps.promptQuery();
  if (!query) {
    return;
  }

  const refs = await deps.getRefs();
  const find = (): string | undefined =>
    findCommitByQuery(query, deps.getLoadedCommits(), refs.branches, refs.tags);

  let match = find();
  if (!match && (await deps.ensureFullLogLoaded())) {
    match = find();
  }
  if (!match) {
    // sanitize-exempt: user-input: query.trim() is the user-typed search string echoed back, not git stderr
    deps.warn(`No commit found matching '${query.trim()}'`);
    return;
  }

  await deps.revealLogHost();
  if (deps.scrollToCommit(match)) {
    return;
  }
  // A ref matched but its tip commit is outside the loaded window — grow to
  // full history and retry the scroll.
  if (!(await deps.ensureFullLogLoaded()) || !deps.scrollToCommit(match)) {
    deps.warn(`Commit ${match.substring(0, 7)} is not currently loaded in the graph`);
  }
}

export function registerCommitRepoCoreCommands(ctx: ICommandContext): vscode.Disposable[] {
  // Open Git Tool Window command
  // spine-exempt: pure focus route with no services dependency
  const openGitToolWindowCommand = registerLoggedCommand('intellig.openGitToolWindow', () => {
    // Surface the live log host: the undocked panel when one exists,
    // otherwise the sidebar view.
    if (ctx.gitToolWindowProvider) {
      void ctx.gitToolWindowProvider.revealLogHost();
    } else {
      void vscode.commands.executeCommand(`${GIT_TOOL_WINDOW_VIEW_ID}.focus`);
    }
  });

  // Commit command
  // spine-exempt: RETURNS ICommitDialogResult through executeCommand (commitAndPush
  // gates its push on it); the spine's run contract is void
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
  // spine-exempt: view reveal with its own tool-window/fallback routing
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
  // spine-exempt: PushDialog owns targeting and all outcome toasts
  const pushCommand = registerLoggedCommand('intellig.push', () => {
    ctx.openPushDialog();
  });

  // Push All Tags — a standalone palette command that runs
  // `git push <remote> --tags` on the active repo. Lives alongside the main
  // Push dialog (which also surfaces the tag push radio) so IntelliJ users
  // get a one-click entry point. The remote is resolved explicitly (tracked
  // upstream remote, else the single remote, else a prompt) so the push
  // target and the toast always agree — a bare `git push --tags` lets git
  // resolve its own default, which can differ from any name we display.
  const pushAllTagsCommand = registerRepoCommand(ctx, {
    id: 'intellig.pushAllTags',
    failureTitle: 'Failed to push tags',
    pickerTitle: 'Push All Tags — Choose Repository',
    pickerPlaceholder: 'Select a repository',
    run: async ({ gitService, repo }) => {
      let remoteName = repo.head?.upstream?.remote;
      if (!remoteName) {
        const remotes = await gitService.getRemotes(repo).match(
          (r) => r,
          () => []
        );
        if (remotes.length === 0) {
          void vscode.window.showErrorMessage('Cannot push tags: no remotes configured.');
          return;
        }
        if (remotes.length === 1) {
          remoteName = remotes[0].name;
        } else {
          const picked = await vscode.window.showQuickPick(
            remotes.map((r) => ({ label: r.name })),
            {
              title: 'Push All Tags — Choose Remote',
              placeHolder: 'No upstream configured — select the remote to push tags to',
            }
          );
          if (!picked) {
            return;
          }
          remoteName = picked.label;
        }
      }
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Pushing all tags to ${remoteName}…`,
            cancellable: false,
          },
          () => gitService.push(repo, { remote: remoteName, tags: true })
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
    },
  });

  // Pull command — Pull dialog (2-step QuickPick: source then flags). Branch
  // on the dialog's outcome. The dialog handles its own pulled/conflict/error
  // toasts internally (see `runPullDialog`); we only add a debug log on
  // cancellation so a dismissed dialog is observable in the IntelliG
  // OutputChannel (no toast — cancel is a normal user action).
  // spine-exempt: PullDialog owns targeting and all outcome toasts
  const pullCommand = registerLoggedCommand('intellig.pull', async () => {
    const dialog = ctx.getPullDialog();
    if (!dialog) {
      return;
    }
    const outcome = await dialog.show();
    handlePullDialogOutcome(outcome);
  });

  // Fetch command — GitFetch.java parity: one invocation fetches all remotes
  // of ALL repositories (no repo picker), continues past per-repo failures,
  // and refuses to stack while a manual fetch is still running (the reference
  // action disables itself via isFetchRunning).
  let manualFetchInFlight = false;
  const fetchCommand = registerBareCommand(ctx, {
    id: 'intellig.fetch',
    failureTitle: 'Fetch failed',
    run: async ({ services, gitService }) => {
      if (manualFetchInFlight) {
        void vscode.window.showInformationMessage('Fetch is already running.');
        return;
      }
      const repos = gitService.getRepositories();
      if (repos.length === 0) {
        void vscode.window.showErrorMessage('No Git repository found in workspace');
        return;
      }
      manualFetchInFlight = true;
      try {
        const outcomes = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title:
              repos.length > 1
                ? `Fetching all remotes of ${repos.length} repositories…`
                : 'Fetching from all remotes…',
            cancellable: false,
          },
          () =>
            Promise.all(
              repos.map((repo) =>
                gitService.fetch(repo, { all: true, prune: true }).match(
                  (result) => ({ repo, result, error: undefined }),
                  (error) => ({ repo, result: undefined, error })
                )
              )
            )
        );

        // Reset auto-fetch backoff so the next scheduled tick isn't right on top
        // of this manual one.
        if (services.hasService('autoFetchService')) {
          services.autoFetchService.resetBackoff();
        }

        // follow-up: fetch advances remote-tracking refs so the
        // ahead/behind counts on the branch tree go stale until the watcher's
        // 250ms debounce. Reload-then-refresh closes the visible window the
        // same way the other mutation sites do.
        for (const { repo } of outcomes) {
          await gitService.reloadRepository(repo);
        }
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }

        const failed = outcomes.filter((o) => o.error !== undefined);
        const updates = outcomes.flatMap((o) => o.result?.updatedRefs ?? []);
        const prunedCount = updates.filter((u) => /^0+$/.test(u.newSha)).length;
        const refCount = updates.length - prunedCount;
        const scope =
          repos.length > 1
            ? `${repos.length} repositories`
            : `${repos[0].remotes.length || 1} remote(s)`;
        const parts = [
          refCount > 0 ? `${refCount} ref(s) updated` : 'already up to date',
          ...(prunedCount > 0 ? [`${prunedCount} stale ref(s) pruned`] : []),
        ];
        if (failed.length > 0) {
          const names = failed.map((o) => repoDisplayName(o.repo)).join(', ');
          const firstMessage =
            failed[0].error instanceof Error ? failed[0].error.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Fetch failed for ${names}: ${sanitizeGitError(firstMessage)}`
          );
        }
        if (failed.length < outcomes.length) {
          void vscode.window.showInformationMessage(`Fetched ${scope}; ${parts.join('; ')}`);
        }
      } finally {
        manualFetchInFlight = false;
      }
    },
  });

  // Configure Remotes — IntelliJ's GitConfigureRemotesDialog as a QuickPick
  // wizard (add / rename / change-URL / remove; see sync/configureRemotes.ts).
  const configureRemotesCommand = registerRepoCommand(ctx, {
    id: 'intellig.configureRemotes',
    failureTitle: 'Failed to configure remotes',
    pickerTitle: 'Configure Remotes — Choose Repository',
    pickerPlaceholder: 'Select a repository',
    run: async ({ services, gitService, repo }) => {
      await runConfigureRemotesFlow({
        repo,
        gitService,
        showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
        showInputBox: (options) => vscode.window.showInputBox(options),
        showInformationMessage: (msg) => vscode.window.showInformationMessage(msg),
        showErrorMessage: (msg) => vscode.window.showErrorMessage(msg),
        showWarningMessage: (msg, options, ...items) =>
          vscode.window.showWarningMessage(msg, options, ...items),
        fetchRemote: async (remoteName) => {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Fetching '${remoteName}'…`,
              cancellable: false,
            },
            () =>
              gitService.fetch(repo, { remote: remoteName }).match(
                () => undefined,
                (e) => {
                  throw e;
                }
              )
          );
        },
        // `probeRemoteUrl` is a concrete-GitService capability (ADR-001:
        // the IGitService composite is frozen), so narrow to the role shape.
        probeRemoteUrl: async (url) =>
          vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Checking remote URL…',
              cancellable: false,
            },
            () =>
              (
                gitService as unknown as {
                  probeRemoteUrl: (r: typeof repo, u: string) => ResultAsync<void, GitError>;
                }
              )
                .probeRemoteUrl(repo, url)
                .match(
                  () => ({ ok: true }),
                  (e) => ({ ok: false, message: e.message })
                )
          ),
        onRemotesChanged: async () => {
          // Remote changes alter remote-tracking refs and the branch tree;
          // reload-then-refresh like the other mutation sites.
          await services.gitService.reloadRepository(repo);
          ctx.gitToolWindowProvider?.refresh();
        },
      });
    },
  });

  // Refresh command - refreshes all Git views
  // spine-exempt: provider-only view refresh; needs no repo resolution
  const refreshCommand = registerLoggedCommand('intellig.refresh', () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    // Refresh the Git Tool Window
    if (ctx.gitToolWindowProvider) {
      // In the 2-panel layout, always refresh all panels
      ctx.gitToolWindowProvider.refresh();
      void vscode.window.showInformationMessage('Git views refreshed');
    } else {
      void vscode.window.showInformationMessage('Git tool window is not initialized yet.');
    }
  });

  // Update Project — IntelliJ's Vcs.UpdateProject (GitUpdateOptionsDialog +
  // GitUpdateProcess parity). Asks the user for an update method
  // (Merge / Rebase / Branch default), updates ALL repositories in the
  // workspace (multi-root), and produces an Update Info summary. Each repo:
  // preflight-guard → fetch --all --prune → pull with the resolved strategy.
  const updateProjectCommand = registerBareCommand(ctx, {
    id: 'intellig.updateProject',
    failureTitle: 'Update failed',
    run: async ({ services, gitService }) => {
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

      const pullRebaseDefault = readConfig('pullRebase');

      // The 0a getIncomingOutgoing lives on the concrete GitService (ADR-001 —
      // not the frozen IGitService composite). The runtime instance is always a
      // GitService, so we narrow to the IUpdateGitService role interface.
      const updateGit = gitService as unknown as IUpdateGitService;

      let summary;
      try {
        summary = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title:
              repos.length > 1 ? `Updating ${repos.length} repositories…` : 'Updating project…',
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

      // Install the summary into the Update Info tab BEFORE the refresh + the
      // deep-link, so the tab renders the results the moment the user opens it.
      ctx.gitToolWindowProvider?.setUpdateSummary(summary);

      if (ctx.gitToolWindowProvider) {
        ctx.gitToolWindowProvider.refresh();
      }

      // Surface the structured outcome with a deep-link to the Update Info tab.
      // The notification's deep-link focuses that tab via
      // intellig.toolWindow.focusTab.
      const notification = buildUpdateNotification(
        summary.allClean,
        sanitizeGitError(updateInfoHeadline(summary))
      );
      // GitUpdateProcess offers resolution for roots blocked on an
      // in-progress merge/rebase or unresolved conflicts, instead of a
      // dead-end error row.
      const resolveTarget = pickResolutionTarget(summary);
      const RESOLVE_LABEL = 'Resolve Conflicts…';
      const labels = [
        ...(notification.deepLinks ?? []).map((l) => l.label),
        ...(resolveTarget ? [RESOLVE_LABEL] : []),
      ];
      const choice =
        notification.severity === 'warning'
          ? await vscode.window.showWarningMessage(notification.message, ...labels)
          : await vscode.window.showInformationMessage(notification.message, ...labels);
      if (choice === RESOLVE_LABEL && resolveTarget) {
        const blockedRepo = repos.find((r) => r.rootUri.fsPath === resolveTarget.rootPath);
        const conflictService = services.conflictResolutionService;
        if (blockedRepo && conflictService) {
          const conflicts = await conflictService.getConflictedFiles(blockedRepo);
          await conflictService.openResolveConflictsDialog(blockedRepo, conflicts, {
            operation: resolveTarget.operation,
            canAbort: true,
            canContinue: true,
          });
        }
        return;
      }
      const link = (notification.deepLinks ?? []).find((l) => l.label === choice);
      if (link) {
        await vscode.commands.executeCommand(link.commandId, ...(link.commandArgs ?? []));
      }
    },
  });

  // Focus a specific tab in the Git tool window. Declared in package.json;
  // bound here so the StatusBarService incoming badge (and future callers)
  // can jump straight to a tab.
  // spine-exempt: provider-only tab router with its own arg validation
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
      // Deep links must surface the log host, not switch tabs invisibly.
      await ctx.gitToolWindowProvider.revealLogHost();
      await ctx.gitToolWindowProvider.focusTab(tab as TabId);
    }
  );

  // Undock the git log into an editor-tab panel (which the user can float to
  // a separate window via VS Code's "Move into New Window"). The provider
  // owns the panel spec and keeps one live instance: while the panel exists
  // the sidebar shows a placeholder, and a re-invocation reveals the panel.
  const openLogInEditorCommand = registerBareCommand(ctx, {
    id: 'intellig.openLogInEditor',
    failureTitle: 'Failed to open the Git log in an editor tab',
    run: () => {
      const provider = ctx.gitToolWindowProvider;
      if (!provider) {
        void vscode.window.showErrorMessage('Git tool window not ready');
        return Promise.resolve();
      }
      provider.openInEditor();
      return Promise.resolve();
    },
  });

  // Jump to a commit hash / branch / tag. Accepts user input via an
  // InputBox and runs {@link runJumpToCommitFlow}: ref-prefix-first
  // resolution via `findCommitByQuery`, growing the log window to the full
  // history on a miss (reference: tryJumpTo retries as packs load until the
  // pack is full), then `GitToolWindowProvider.scrollToCommit`.
  const jumpToHashCommand = registerBareCommand(ctx, {
    id: 'intellig.toolWindow.jumpToHash',
    failureTitle: 'Failed to jump to commit',
    run: async ({ gitService }) => {
      const provider = ctx.gitToolWindowProvider;
      if (!provider) {
        void vscode.window.showErrorMessage('Git tool window not ready');
        return;
      }

      await runJumpToCommitFlow({
        promptQuery: () =>
          Promise.resolve(
            vscode.window.showInputBox({
              title: 'Jump to Commit',
              prompt: 'Enter a commit SHA, branch name, or tag name',
              placeHolder: 'e.g., abc1234 or main or v1.0.0',
            })
          ),
        getLoadedCommits: () => provider.getExtendedLogState().commitNodes.map((n) => n.commit),
        getRefs: async () => {
          // Branches and tags for name-based matching. Fall back to empty
          // arrays on error so the command degrades to pure SHA matching
          // rather than failing outright. Prefer the tool-window's selected
          // repo; fall back to the active-editor's repo in multi-root
          // workspaces.
          const repo =
            provider.getSelectedRepository() ??
            (await resolveRepo(gitService, { preferActive: true, silent: true }));
          let branches: IBranch[] = [];
          let tags: ITag[] = [];
          if (repo) {
            try {
              branches = await gitService.getBranches(repo);
            } catch (error) {
              // Fall through to SHA-only matching; log so the swallowed fault stays visible.
              getLogger()
                .child({ component: 'extension' })
                .debug('findCommit: getBranches failed', {
                  err: error instanceof Error ? error.message : String(error),
                });
            }
            try {
              tags = await gitService.getTags(repo);
            } catch (error) {
              // Fall through to SHA-only matching; log so the swallowed fault stays visible.
              getLogger()
                .child({ component: 'extension' })
                .debug('findCommit: getTags failed', {
                  err: error instanceof Error ? error.message : String(error),
                });
            }
          }
          return { branches, tags };
        },
        ensureFullLogLoaded: () => provider.ensureFullLogLoaded(),
        revealLogHost: () => provider.revealLogHost(),
        scrollToCommit: (hash) => provider.scrollToCommit(hash),
        warn: (message) => {
          void vscode.window.showWarningMessage(message);
        },
      });
    },
  });

  // Reveal a specific commit (by hash) in the Git tool window: focus the graph
  // and scroll-to + highlight that commit. Invoked from the blame hover's
  // commit links (the hash travels with the click) so clicking a blame commit
  // navigates the graph below instead of opening a quick-pick. Programmatic-only
  // (no package.json contribution), mirroring jumpToHash's reveal path.
  // spine-exempt: provider-only reveal, programmatic hash argument
  const revealCommitCommand = registerLoggedCommand(
    'intellig.editor.revealCommitInGraph',
    async (commitHashArg?: unknown) => {
      if (!ctx.gitToolWindowProvider) {
        void vscode.window.showErrorMessage('Git tool window not ready');
        return;
      }
      const hash = typeof commitHashArg === 'string' ? commitHashArg : '';
      if (!hash) {
        return;
      }
      await ctx.gitToolWindowProvider.revealLogHost();
      const scrolled = ctx.gitToolWindowProvider.scrollToCommit(hash);
      if (!scrolled) {
        void vscode.window.showWarningMessage(
          `Commit ${hash.substring(0, 7)} is not currently loaded in the graph`
        );
      }
    }
  );

  // Stage selected files command
  // Stage the ACTIVE EDITOR file (the palette title says "Active File";
  // explorer selections go through intellig.explorer.stage instead).
  const stageSelectedCommand = registerFileCommand(ctx, {
    id: 'intellig.stageSelected',
    noTargetMessage: 'No file selected to stage',
    failureTitle: 'Failed to stage file',
    refreshOnSuccess: true,
    run: async ({ gitService, repo, path: filePath }) => {
      await gitService.stage(repo, [filePath]).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      void vscode.window.showInformationMessage(`Staged: ${filePath}`);
    },
  });

  // Unstage selected files command
  // Unstage the ACTIVE EDITOR file (the palette title says "Active File";
  // explorer selections go through intellig.explorer.unstage instead).
  const unstageSelectedCommand = registerFileCommand(ctx, {
    id: 'intellig.unstageSelected',
    noTargetMessage: 'No file selected to unstage',
    failureTitle: 'Failed to unstage file',
    refreshOnSuccess: true,
    run: async ({ gitService, repo, path: filePath }) => {
      await gitService.unstage(repo, [filePath]).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      void vscode.window.showInformationMessage(`Unstaged: ${filePath}`);
    },
  });

  const applyPatchCommand = registerRepoCommand(ctx, {
    id: 'intellig.patch.apply',
    failureTitle: 'Failed to open Apply Patch',
    pickerTitle: 'Apply Patch — Choose Repository',
    pickerPlaceholder: 'Select a repository',
    hintFromRawUri: true,
    run: ({ services, repo }, rawUri) => {
      const initialUri =
        rawUri &&
        typeof rawUri === 'object' &&
        typeof (rawUri as { fsPath?: unknown }).fsPath === 'string'
          ? (rawUri as vscode.Uri)
          : undefined;
      showApplyPatchDialog(ctx.context, {
        repo,
        patchService: services.patchService,
        conflictResolutionService: services.conflictResolutionService,
        initialPatchPath: initialUri?.fsPath,
      });
      return Promise.resolve();
    },
  });

  // Create Patch from Local Changes… — prompts for target (file /
  // clipboard) and writes the current diff.
  const createPatchFromLocalCommand = registerRepoCommand(ctx, {
    id: 'intellig.patch.createFromLocal',
    failureTitle: 'Failed to create patch',
    pickerTitle: 'Create Patch — Choose Repository',
    pickerPlaceholder: 'Select a repository',
    run: async ({ services, repo }) => {
      // Multi-pick mirroring the reference Create Patch panel's checkboxes:
      // destinations (file / clipboard — both allowed at once) plus the
      // Reverse option, reopened with the user's last picks.
      const persisted = loadPersisted(
        ctx.context.workspaceState,
        CREATE_LOCAL_PATCH_PICKS_SLOT
      ) ?? ['file'];
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: '$(file) Save to file…',
            id: 'file' as const,
            picked: persisted.includes('file'),
          },
          {
            label: '$(clippy) Copy to clipboard',
            id: 'clipboard' as const,
            picked: persisted.includes('clipboard'),
          },
          {
            label: '$(arrow-swap) Reverse (-R)',
            description: 'Applying the patch undoes the local changes',
            id: 'reverse' as const,
            picked: persisted.includes('reverse'),
          },
        ],
        {
          canPickMany: true,
          placeHolder: 'Choose where to write the patch (and options)',
        }
      );
      if (!picked) {
        return;
      }
      const picks = picked.map((item) => item.id);
      if (!picks.includes('file') && !picks.includes('clipboard')) {
        void vscode.window.showInformationMessage(
          'Pick at least one destination (file or clipboard).'
        );
        return;
      }
      await savePersisted(ctx.context.workspaceState, CREATE_LOCAL_PATCH_PICKS_SLOT, picks);
      const reverse = picks.includes('reverse');
      const toClipboard = picks.includes('clipboard');

      try {
        let outputPath: string | undefined;
        if (picks.includes('file')) {
          const defaultUri = vscode.Uri.joinPath(repo.rootUri, 'changes.patch');
          const uri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { 'Patch files': ['patch', 'diff'], 'All files': ['*'] },
            saveLabel: 'Save Patch',
          });
          if (!uri) {
            return;
          }
          outputPath = uri.fsPath;
        }

        const patch = await services.patchService.createPatchFromLocalChanges(repo, {
          toClipboard,
          outputPath,
          reverse,
        });
        if (!patch || patch.trim().length === 0) {
          void vscode.window.showInformationMessage('No local changes to diff.');
          return;
        }
        void vscode.window.showInformationMessage(
          outputPath
            ? toClipboard
              ? `Patch created: ${outputPath} (also copied to clipboard).`
              : `Patch created: ${outputPath}`
            : 'Patch copied to clipboard.'
        );
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
    },
  });

  // Show History command (command palette / keybinding / CTW file rows).
  const showHistoryCommand = registerRepoCommand(ctx, {
    id: 'intellig.showHistory',
    failureTitle: 'Failed to get history',
    pickerTitle: 'Show History — Choose Repository',
    pickerPlaceholder: 'Select a repository',
    hintFromRawUri: true,
    run: async ({ gitService, repo }, rawArg) => {
      const targetFsPath = resolveShowHistoryTargetFsPath(
        rawArg,
        vscode.window.activeTextEditor?.document.uri.fsPath
      );

      // git runs with `cwd = repo.rootUri.fsPath`, so it needs the REPO-root-
      // relative path. `asRelativePath` is workspace-folder-relative and breaks
      // for nested/multi-root repos (see repoRelativePath).
      const filePath = targetFsPath
        ? repoRelativePath(repo.rootUri.fsPath, targetFsPath)
        : undefined;

      // For a file, present its history via the shared helper — identical to the
      // explorer right-click entry point (tab when the tabbed window is on, else a
      // QuickPick). Repo-level history (no active file) stays a QuickPick here
      // because the History tab is per-file.
      if (filePath) {
        await presentFileHistory(ctx, repo, filePath);
        return;
      }

      try {
        const history = await gitService.getLog(repo, { maxCount: 50 });

        if (history.length === 0) {
          void vscode.window.showInformationMessage('No commit history found');
          return;
        }

        const items = history.map((commit) => ({
          label: commit.shortHash,
          description: commit.message.substring(0, 60),
          detail: `${commit.author.name} - ${commit.authorDate.toLocaleDateString()}`,
          commit,
        }));

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Repository History',
          title: 'Show History',
        });

        if (selected) {
          // sanitize-exempt: non-error-data: selected.commit.message is the user-authored commit subject from `git log`, not git stderr; cannot embed credentials git emits in error paths
          void vscode.window.showInformationMessage(
            `Commit ${selected.commit.shortHash}: ${selected.commit.message}`
          );
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to get history', error)
        );
      }
    },
  });

  // Revert File command (command palette / keybinding)
  const revertFileCommand = registerFileCommand(ctx, {
    id: 'intellig.revertFile',
    noTargetMessage: 'No file selected to revert',
    failureTitle: 'Failed to revert file',
    pickerTitle: 'Revert File — Choose Repository',
    pickerPlaceholder: 'Select a repository',
    run: async ({ gitService, repo, path: filePath }) => {
      // Nothing-to-revert pre-check (untracked / clean file): inform instead of
      // confirming a no-op that would then toast "Reverted".
      const precheckMsg = revertPrecheck(
        fileStatusFor(await gitService.getStatus(repo), filePath),
        filePath
      );
      if (precheckMsg) {
        void vscode.window.showInformationMessage(precheckMsg);
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to revert changes to ${filePath}? This cannot be undone.`,
        { modal: true },
        'Revert'
      );

      if (confirm !== 'Revert') {
        return;
      }

      try {
        await gitService.revertFile(repo, filePath).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        void vscode.window.showInformationMessage(`Reverted: ${filePath}`);
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.refresh();
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to revert file', error)
        );
      }
    },
  });

  // Rollback / Revert Local Changes — IntelliJ's "Rollback" (Ctrl+Alt+Z).
  // Reverts the selected changed files back to their committed state after a
  // confirmation that lists every affected file (data loss). When invoked
  // without an explicit selection it reads `git status` and lets the user pick
  // which files to roll back, mirroring RollbackChangesDialog's file list.
  const rollbackChangesCommand = registerRepoCommand(ctx, {
    id: 'intellig.rollbackChanges',
    failureTitle: 'Failed to roll back changes',
    pickerTitle: 'Rollback — Choose Repository',
    pickerPlaceholder: 'Select a repository',
    run: async ({ gitService, repo }, arg) => {
      // The caller (webview / context menu) may hand us the exact changes to
      // roll back. Otherwise gather the working-tree changes and let the user
      // choose.
      let changes = extractRollbackChanges(arg);
      if (changes) {
        // Arg-supplied entries are re-derived against fresh porcelain so a
        // renamed file's oldPath (and any stale status) is corrected before
        // the destructive op.
        changes = enrichRollbackChanges(changes, await gitService.getStatus(repo));
      }
      if (!changes) {
        const statuses = await gitService.getStatus(repo);
        const candidates: IRollbackChange[] = statuses
          .map((s) => ({
            path: s.path,
            status: statusCodeToFileStatus(s.indexStatus, s.workTreeStatus),
            // Carry the pre-rename path so a rename rolls back to its OLD path
            // instead of a fatal checkout of the HEAD-absent new path.
            ...(s.renamed ? { oldPath: s.renamed } : {}),
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
        await gitService.rollbackChanges(repo, changes, { deleteUntracked: true }).match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
        void vscode.window.showInformationMessage(`Rolled back ${changes.length} file(s).`);
        ctx.gitToolWindowProvider?.refresh();
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to roll back changes', error)
        );
      }
    },
  });

  // New Tag — command-palette entry, defaults to HEAD.
  // spine-exempt: delegates to runNewTagFlowFromContext which owns targeting + toasts
  const newTagCommand = registerLoggedCommand('intellig.tag.new', async () => {
    await runNewTagFlowFromContext(ctx, undefined);
  });

  // New Tag — invoked from the log commit context menu with a commit arg.
  const commitNewTagCommand = registerBareCommand(ctx, {
    id: 'intellig.commit.newTag',
    failureTitle: 'Failed to create tag',
    run: async (_args, commitArg, repoRootArg) => {
      const ref = extractCommitHash(commitArg);
      // `repoRootArg` (merged "all roots" log) pins the tag to the clicked
      // commit's OWN repo; absent, the usual repository picker runs.
      await runNewTagFlowFromContext(ctx, ref, repoRootArg);
    },
  });

  // Commit and Push — IntelliJ's "Commit and Push…" (Ctrl+Alt+K). IntelliJ's
  // GitCommitAndPushExecutor pushes as a post-commit step gated on the commit
  // (and its before-commit checks) succeeding; a cancelled/failed commit does
  // NOT push. VS Code's commit surface is a separate modal, so we chain the
  // two via the canonical `intellig.commit` / `intellig.push` entry points —
  // reusing both rather than re-implementing either — and only push when the
  // commit reported `committed: true`.
  // spine-exempt: executeCommand chain over intellig.commit/intellig.push, which own feedback
  const commitAndPushCommand = registerLoggedCommand('intellig.commitAndPush', async () => {
    const toolWindowPathTaken = isCommitToolWindowEnabled() && !!ctx.commitToolWindow;
    const { pushed } = await commitThenPush(
      async () =>
        vscode.commands.executeCommand<ICommitDialogResult | undefined>('intellig.commit'),
      async () => {
        await vscode.commands.executeCommand('intellig.push');
      }
    );
    const followUp = commitAndPushFollowUp(pushed, toolWindowPathTaken);
    if (followUp) {
      void vscode.window.showInformationMessage(followUp);
    }
  });

  // Push up to here — IntelliJ's Git.PushUpToHere. Accepts a commit hash,
  // resolves the branch CONTAINING it (the current branch when the commit is
  // on HEAD, else the first containing local branch, else a detached source —
  // GitPushUpToCommitAction semantics) and opens the PUSH DIALOG with that
  // revision source for preview. The dialog owns the submit, so protected-
  // target and force rules apply through the normal path; the push moves the
  // target ref to that exact commit (`<hash>:refs/heads/<target>`).
  // Single-only; invoked programmatically from the log commit context menu
  // (not shown in menus).
  const pushUpToCommitCommand = registerBareCommand(ctx, {
    id: 'intellig.pushUpToCommit',
    failureTitle: 'Push failed',
    run: async ({ gitService }, rawHash, repoRootArg) => {
      const hash = typeof rawHash === 'string' ? rawHash : '';
      if (!hash || !isValidPushHash(hash)) {
        void vscode.window.showErrorMessage('Cannot push: invalid commit hash.');
        return;
      }
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
      // Resolve the branch that CONTAINS the commit. Seeding the dialog row
      // from the current branch regardless of containment would propose
      // moving that ref to a foreign-branch commit. A commit on no local
      // branch becomes a detached source (GitPushSource.createDetached), not
      // an error — the dialog previews the raw hash.
      const headBranch = repo.head?.name?.replace(/^refs\/heads\//, '');
      const containing = await gitService.getContainingBranches(repo, hash);
      const locals = new Map(
        (await gitService.getBranches(repo))
          .filter((b) => b.type === 'local')
          .map((b) => [b.name, b])
      );
      const chosen =
        headBranch && containing.includes(headBranch)
          ? (locals.get(headBranch) ?? { name: headBranch, upstream: repo.head?.upstream })
          : containing.map((name) => locals.get(name)).find((b) => b !== undefined);

      // The hash's own ahead-of-target count for the dialog's commits badge —
      // an older commit pushes fewer commits than the branch tip.
      const upstream = chosen?.upstream;
      const ahead = upstream
        ? (await gitService.compareBranches(repo, hash, `${upstream.remote}/${upstream.name}`))
            .aheadCount
        : 0;

      ctx.openPushDialog(
        chosen
          ? {
              repo,
              branch: chosen.name,
              upstream,
              ahead,
              behind: 0,
              pushSource: { hash, detached: false },
            }
          : { repo, ahead, behind: 0, pushSource: { hash, detached: true } }
      );
    },
  });

  // VCS Operations Popup — IntelliJ's Alt+` quick-list of common VCS actions.
  // Distinct from the branch popup (Ctrl+Shift+`): this is a flat menu of the
  // most-used Git operations, each dispatching to its existing command. New
  // entries are additive; the popup is intentionally a thin command router.
  // spine-exempt: pure QuickPick router dispatching to commands that own feedback
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
    configureRemotesCommand,
    updateProjectCommand,
    refreshCommand,
    focusTabCommand,
    openLogInEditorCommand,
    jumpToHashCommand,
    revealCommitCommand,
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
