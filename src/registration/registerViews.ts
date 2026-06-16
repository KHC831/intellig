import * as vscode from 'vscode';
import {
  GitToolWindowProvider,
  GIT_TOOL_WINDOW_VIEW_ID,
  ConsoleService,
  createMergeView,
  MergeView,
  createStatusBarService,
  createNotificationService,
  KeymapService,
  createStashView,
  createShelfView,
  createBranchComparisonView,
  createGutterBlameProvider,
  createRebaseProgressView,
  createBranchTreeProvider,
  createCommitToolWindow,
  COMMIT_TOOL_WINDOW_VIEW_ID,
} from '../services';
import type { IGitService, IGitServiceCli, IRepository } from '../services';
import { createCommandTitleProvider } from '../commits/CommandTitleProvider';
import { createBranchContextMenuCommands, createCommitContextMenuCommands } from '../commits';
import { getOutputChannel } from '../utils/outputChannel';
import { getLogger } from '../utils/logger';
import { resolveRepo } from '../utils/resolveRepo';
import { formatActionFailureToast } from '../git-core/gitError';
import { IViewRegistrationContext } from './ViewRegistrationContext';
import {
  loadAllPanelDataCore,
  wireRepositorySelection,
  wireRebasePausedWarning,
  provideGitShowContent,
} from './wiring';
import { createInProgressStatusBar } from '../ui-shell/InProgressStatusBar';

/**
 * Register views and view providers.
 *
 * @param ctx - The view-registration context (RULE E1 bridge to the
 *   module-level singletons owned by extension.ts)
 */
export function registerViews(ctx: IViewRegistrationContext): void {
  // Hoisted so the second `if (ctx.services)` block — which creates
  // the BranchTreeProvider — can pass this helper into
  // `wireRepositorySelection(...)` and refresh both the Log/Graph view and
  // the Branches tree view from a single `onDidSelectRepository` event.
  // Bound to the block-local `loadLogCommitsForRepo` inside the first
  // `if (ctx.services)` block where its closure dependencies
  // (gitService, gitToolWindowProvider) are in scope.
  let hoistedLoadLogCommitsForRepo: ((repo: IRepository) => Promise<void>) | undefined;

  // Create and register the Git Tool Window Provider (single webview, 2-panel layout)
  ctx.gitToolWindowProvider = new GitToolWindowProvider(
    ctx.context.extensionUri,
    ctx.context.workspaceState
  );

  // Connect the Console Service to the Git Tool Window Provider
  // This enables real-time Git command output display
  if (ctx.services) {
    const consoleService = ctx.services.consoleService;
    if (consoleService instanceof ConsoleService) {
      consoleService.connectToToolWindow(ctx.gitToolWindowProvider);
    }

    // Wire the History tab to the GitService now that the service registry
    // is up. Safe to call multiple times (last-writer-wins).
    ctx.gitToolWindowProvider.attachGitService(ctx.services.gitService);
  }

  const gitToolWindowRegistration = vscode.window.registerWebviewViewProvider(
    GIT_TOOL_WINDOW_VIEW_ID,
    ctx.gitToolWindowProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }
  );

  ctx.context.subscriptions.push(gitToolWindowRegistration);

  // Register the Commit tool window. The view contribution in package.json
  // is gated by `config.intellig.useCommitToolWindow`, so when the flag is
  // off the view slot is hidden and users see zero change.
  if (ctx.services) {
    ctx.commitToolWindow = createCommitToolWindow(
      ctx.context.extensionUri,
      ctx.services.gitService,
      ctx.services.changelistService,
      ctx.services.shelfService,
      ctx.context.workspaceState
    );

    // Bind shelf/stash row controllers so the combined Shelf tab can
    // dispatch context-menu actions. ShelfView / StashView already hold the
    // QuickPick + error-handling UX; the controllers are thin adapters.
    const gs = ctx.services.gitService;
    const cs = ctx.services.conflictResolutionService;
    const shelfSvc = ctx.services.shelfService;

    // Ensure the ShelfView / StashView singletons exist — both are built
    // lazily elsewhere in this file. Re-using them keeps the Shelf tab
    // consistent with the palette commands (same UX, same confirm flow).
    if (!ctx.shelfView) {
      ctx.shelfView = createShelfView(shelfSvc, (r) => gs.getStatus(r), cs);
    }
    if (!ctx.stashView) {
      ctx.stashView = createStashView(gs, cs);
    }
    const shelfViewRef = ctx.shelfView;
    const stashViewRef = ctx.stashView;

    // When the user first opens the Commit tool window, neither view has
    // had `.show()` called, so their internal `_repository` is `undefined`.
    // Controller methods assert `_repository` — delegate to an async helper
    // that binds it on first use from the active repo.
    const bindShelfRepo = async (): Promise<IRepository | undefined> => {
      const repos = gs.getRepositories();
      const repo = repos[0];
      if (!repo) {
        return undefined;
      }
      // StashView/ShelfView expose a private _repository; they're safe to
      // seed through their `show()` entry points, but we don't want the
      // QuickPick side effect. Instead set the field directly via the
      // existing public `refresh(repo)` pattern — both views accept repo
      // via `show()` as the only path, so we fall back to `show()` for the
      // initial binding (it's a no-op beyond storing the repo).
      (shelfViewRef as unknown as { _repository: IRepository })._repository = repo;
      (stashViewRef as unknown as { _repository: IRepository })._repository = repo;
      // refresh() returns { error? }; a bind-time refresh failure is
      // usually a transient FS race and won't block the caller from
      // running the subsequent unshelve/view/delete — but we mirror it
      // into the shared OutputChannel so a persistent breakage is
      // debuggable from `Output → IntelliG` in a shipped user's host.
      const refreshResult = await shelfViewRef.refresh();
      if (refreshResult.error) {
        getOutputChannel().appendLine(
          `[${new Date().toISOString()}] [intellig] extension.bindShelfRepo: refresh failed: ${refreshResult.error}`
        );
      }
      return repo;
    };

    ctx.commitToolWindow.setShelfTabControllers(
      {
        apply: async (id): Promise<void> => {
          await bindShelfRepo();
          await shelfViewRef.unshelve(id);
        },
        showDiff: async (id): Promise<void> => {
          await bindShelfRepo();
          await shelfViewRef.viewShelfItem(id);
        },
        delete: async (id): Promise<void> => {
          await bindShelfRepo();
          await shelfViewRef.deleteShelfItem(id);
        },
        rename: async (id): Promise<void> => {
          await bindShelfRepo();
          await shelfViewRef.renameShelfItem(id);
        },
        restore: async (id): Promise<void> => {
          await bindShelfRepo();
          shelfViewRef.restoreShelfItem(id);
        },
        importPatches: async (): Promise<void> => {
          await bindShelfRepo();
          await shelfViewRef.importPatches();
        },
        createPatch: async (id): Promise<void> => {
          await bindShelfRepo();
          await shelfViewRef.createPatchFromShelf(id);
        },
      },
      {
        apply: async (idx): Promise<void> => {
          await bindShelfRepo();
          await stashViewRef.applyStash(idx);
        },
        pop: async (idx): Promise<void> => {
          await bindShelfRepo();
          await stashViewRef.popStash(idx);
        },
        drop: async (idx): Promise<void> => {
          await bindShelfRepo();
          await stashViewRef.dropStash(idx);
        },
        showDiff: async (idx): Promise<void> => {
          await bindShelfRepo();
          await stashViewRef.viewStash(idx);
        },
        rename: async (idx): Promise<void> => {
          await bindShelfRepo();
          await stashViewRef.renameStash(idx);
        },
        branchFromStash: async (idx): Promise<void> => {
          await bindShelfRepo();
          await stashViewRef.branchFromStash(idx);
        },
      }
    );

    const commitToolWindowRegistration = vscode.window.registerWebviewViewProvider(
      COMMIT_TOOL_WINDOW_VIEW_ID,
      ctx.commitToolWindow,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    );
    ctx.context.subscriptions.push(commitToolWindowRegistration);
  }

  // Wire up Log tab data loading
  // When the Log tab becomes active, fetch commits and display the graph
  if (ctx.services) {
    const gitService = ctx.services.gitService;

    // Helper to discover all repositories from all workspace folders
    const discoverAllRepositories = async (): Promise<IRepository[]> => {
      let repositories = gitService.getRepositories();
      // If no repositories discovered yet, try to discover from workspace folders
      if (repositories.length === 0) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
          for (const folder of workspaceFolders) {
            const repo = await gitService.getRepository(folder.uri);
            if (repo) {
              repositories = gitService.getRepositories();
              if (repositories.length > 0) {
                break;
              }
            }
          }
          // Re-fetch after discovery attempts
          repositories = gitService.getRepositories();
        }
      }
      return repositories;
    };

    // Helper to load commits into the log view for a specific repository.
    // Kept as a block-local `const` so type narrowing inside this block
    // continues to work. We then bind it to the hoisted
    // `hoistedLoadLogCommitsForRepo` below so the second
    // `if (ctx.services)` block can pass it into
    // `wireRepositorySelection(...)`.
    const loadLogCommitsForRepo = async (
      repo: IRepository,
      filter?: {
        branch?: string;
        author?: string;
        since?: Date;
        until?: Date;
        path?: string;
        searchText?: string;
        noMerges?: boolean;
        firstParent?: boolean;
        simplifyMerges?: boolean;
        minParents?: number;
        maxParents?: number;
        logRange?: string;
        searchRegex?: boolean;
        searchCaseSensitive?: boolean;
      }
    ): Promise<void> => {
      try {
        // A branch or range filter scopes the log to that ref; suppress `--all`
        // so we don't union every branch back in. Without one we walk all refs
        // (minus refs/stash) for the full graph.
        const branchRef = filter?.branch;
        const logRange = filter?.logRange;
        const commits = await gitService.getLog(repo, {
          maxCount: 500,
          all: !branchRef && !logRange,
          ref: branchRef,
          logRange,
          // The graph algorithm needs topological order: a commit's
          // parent MUST appear later in the list (or off-window).
          // Without --topo-order, git falls back to date order; after
          // a squash/rebase/cherry-pick, fresh committerDate values
          // shuffle divergent branches between a commit and its
          // parent, which the algorithm reads as "linear" — exactly
          // the user-visible bug post-squash.
          topoOrder: true,
          author: filter?.author,
          since: filter?.since,
          until: filter?.until,
          path: filter?.path,
          grep: filter?.searchText,
          noMerges: filter?.noMerges,
          firstParent: filter?.firstParent,
          simplifyMerges: filter?.simplifyMerges,
          minParents: filter?.minParents,
          maxParents: filter?.maxParents,
          regex: filter?.searchRegex,
          caseSensitive: filter?.searchCaseSensitive,
        });

        // Build branch map: commit hash -> branch refs (name + type).
        // Carry `branch.type` (local/remote, derived by parseBranches from
        // the refs/heads vs refs/remotes prefix) instead of guessing from
        // the name — `feature/foo` is local even though it has a `/`.
        const branchMap = new Map<string, Array<{ name: string; type: 'local' | 'remote' }>>();
        try {
          const branches = await gitService.getBranches(repo);
          for (const branch of branches) {
            // getBranches only returns refs/heads + refs/remotes, so type is
            // always 'local' or 'remote' here; tags travel through tagMap.
            if (branch.commit && branch.type !== 'tag') {
              const existing = branchMap.get(branch.commit) || [];
              existing.push({ name: branch.name, type: branch.type });
              branchMap.set(branch.commit, existing);
            }
          }
        } catch {
          // Branches are optional for graph rendering
        }

        // Build tag map: commit hash -> tag names
        const tagMap = new Map<string, string[]>();
        try {
          const tags = await gitService.getTags(repo);
          for (const tag of tags) {
            if (tag.commit) {
              const existing = tagMap.get(tag.commit) || [];
              existing.push(tag.name);
              tagMap.set(tag.commit, existing);
            }
          }
        } catch {
          // Tags are optional for graph rendering
        }

        if (ctx.gitToolWindowProvider) {
          // Strip the `refs/heads/` prefix so the chip filter compares
          // against the same shape `IBranchRef.name` carries.
          const headBranchName = repo.head?.name?.replace(/^refs\/heads\//, '');
          ctx.gitToolWindowProvider.updateLogState(
            commits,
            branchMap,
            tagMap,
            repo.head?.commit,
            headBranchName
          );

          // Compute the cherry-mark map in the background and push it into
          // the provider. We don't block the log render on it — cherry marks
          // are a visual nicety, and the call is throttled by git spawn
          // overhead (typically <100ms). Gated by the
          // `intellig.log.highlightCherryPicked` flag.
          void loadCherryMarksForRepo(repo, ctx.gitToolWindowProvider?.getManualCherryCompareRef());
        }
      } catch (error) {
        getLogger()
          .child({ component: 'extension' })
          .error('failed to load git log', error instanceof Error ? error : undefined);
      }
    };

    /**
     * Compute `git log --cherry-mark` for the given repo against its
     * upstream and push the `=`-marked hashes into the Log tab's state.
     * Runs in the background; errors are swallowed so the UI stays calm.
     */
    const loadCherryMarksForRepo = async (
      repo: IRepository,
      overrideRef?: string
    ): Promise<void> => {
      if (!ctx.gitToolWindowProvider) {
        return;
      }
      const flagOn =
        vscode.workspace
          .getConfiguration('intellig.log')
          .get<boolean>('highlightCherryPicked', true) ?? true;
      if (!flagOn) {
        ctx.gitToolWindowProvider.setCherryPickedHashes(undefined);
        return;
      }
      let baseRef: string;
      if (overrideRef) {
        // User manually set a cherry-compare ref — validate and use it.
        if (overrideRef.startsWith('-') || overrideRef.startsWith('.')) {
          ctx.gitToolWindowProvider.setCherryPickedHashes(undefined);
          return;
        }
        baseRef = overrideRef;
      } else {
        // Auto-upstream: resolve the upstream ref for the current branch.
        const headUpstream = repo.head?.upstream;
        if (!headUpstream) {
          ctx.gitToolWindowProvider.setCherryPickedHashes(undefined);
          return;
        }
        baseRef = `${headUpstream.remote}/${headUpstream.name}`;
      }
      try {
        const gitServiceAny = gitService as IGitService & {
          getCherryMarks?: (r: IRepository, b: string) => Promise<Map<string, string>>;
        };
        if (typeof gitServiceAny.getCherryMarks !== 'function') {
          return;
        }
        const marks = await gitServiceAny.getCherryMarks(repo, baseRef);
        const equivalent = new Set<string>();
        for (const [hash, mark] of marks) {
          if (mark === '=') {
            equivalent.add(hash);
          }
        }
        ctx.gitToolWindowProvider.setCherryPickedHashes(equivalent, baseRef);
      } catch {
        // Swallow — the feature degrades cleanly when git doesn't support
        // --cherry-mark or the repo state is unusual.
      }
    };

    // Helper to load commits into the log view (uses selected or active-editor repository)
    const loadLogCommits = async (filter?: {
      branch?: string;
      author?: string;
      since?: Date;
      until?: Date;
      path?: string;
      searchText?: string;
      noMerges?: boolean;
      firstParent?: boolean;
      simplifyMerges?: boolean;
      minParents?: number;
      maxParents?: number;
      logRange?: string;
      searchRegex?: boolean;
      searchCaseSensitive?: boolean;
    }): Promise<void> => {
      // Use the provider's selected repository if available
      if (ctx.gitToolWindowProvider) {
        const selectedRepo = ctx.gitToolWindowProvider.getSelectedRepository();
        if (selectedRepo) {
          await loadLogCommitsForRepo(selectedRepo, filter);
          return;
        }
      }

      // prefer the active-editor's repo in multi-root workspaces
      // on initial load when no tool-window repo selection has been made yet.
      const preferred = await resolveRepo(gitService, {
        preferActive: true,
        silent: true,
      });
      if (preferred) {
        await loadLogCommitsForRepo(preferred, filter);
        return;
      }

      // Fall back to discovering repositories (cold start — git service empty).
      const repositories = await discoverAllRepositories();
      if (repositories.length === 0) {
        return;
      }
      // ALLOWED: deterministic fallback on cold start when git service is
      // still empty AND the active-editor's repo couldn't be resolved —
      // no better signal is available. preferActive above handles the
      // populated-service multi-root case.
      const repo = repositories[0];
      await loadLogCommitsForRepo(repo, filter);
    };

    // Define the filter shape shared across log-loading helpers (G8).
    type LogFilter = {
      branch?: string;
      author?: string;
      since?: Date;
      until?: Date;
      path?: string;
      searchText?: string;
      noMerges?: boolean;
      firstParent?: boolean;
      simplifyMerges?: boolean;
      minParents?: number;
      maxParents?: number;
      logRange?: string;
      searchRegex?: boolean;
      searchCaseSensitive?: boolean;
    };

    // Multi-root log loader (G8). When intellig.log.showAllRoots is true AND
    // more than one repository exists, loads commits from ALL workspace repos
    // in parallel, tags each with its repoRoot, and merges them sorted newest-first.
    // Falls back to the single-repo path when only one repo is present.
    const loadAllRootsLog = async (filter?: LogFilter): Promise<void> => {
      const showAllRoots = ctx.gitToolWindowProvider?._isShowAllRootsEnabled() ?? false;
      if (!showAllRoots) {
        await loadLogCommits(filter);
        return;
      }

      const repos = await discoverAllRepositories();
      if (repos.length <= 1) {
        await loadLogCommits(filter);
        return;
      }

      try {
        const branchRef = filter?.branch;
        const logRange = filter?.logRange;
        // Load up to 200 commits per repo — lower per-repo cap keeps the
        // merged view snappy while still giving meaningful cross-repo history.
        const allCommitsArrays = await Promise.all(
          repos.map(async (repo) => {
            const commits = await gitService.getLog(repo, {
              maxCount: 200,
              all: !branchRef && !logRange,
              ref: branchRef,
              logRange,
              topoOrder: true,
              author: filter?.author,
              since: filter?.since,
              until: filter?.until,
              path: filter?.path,
              grep: filter?.searchText,
              noMerges: filter?.noMerges,
              firstParent: filter?.firstParent,
              simplifyMerges: filter?.simplifyMerges,
              minParents: filter?.minParents,
              maxParents: filter?.maxParents,
              regex: filter?.searchRegex,
              caseSensitive: filter?.searchCaseSensitive,
            });
            // Tag each commit with the source repo root path.
            return commits.map((c) => ({ ...c, repoRoot: repo.rootUri.fsPath }));
          })
        );

        // Merge and sort newest-first; cap at 500 for performance.
        const merged = allCommitsArrays
          .flat()
          .sort((a, b) => b.commitDate.getTime() - a.commitDate.getTime())
          .slice(0, 500);

        // Build combined branch and tag maps from all repos.
        const combinedBranchMap = new Map<
          string,
          Array<{ name: string; type: 'local' | 'remote' }>
        >();
        const combinedTagMap = new Map<string, string[]>();

        await Promise.all(
          repos.map(async (repo) => {
            try {
              const branches = await gitService.getBranches(repo);
              for (const branch of branches) {
                if (branch.commit && branch.type !== 'tag') {
                  const existing = combinedBranchMap.get(branch.commit) || [];
                  existing.push({ name: branch.name, type: branch.type });
                  combinedBranchMap.set(branch.commit, existing);
                }
              }
            } catch {
              // Branches are optional for graph rendering
            }
            try {
              const tags = await gitService.getTags(repo);
              for (const tag of tags) {
                if (tag.commit) {
                  const existing = combinedTagMap.get(tag.commit) || [];
                  existing.push(tag.name);
                  combinedTagMap.set(tag.commit, existing);
                }
              }
            } catch {
              // Tags are optional
            }
          })
        );

        // Use the selected repo's HEAD for graph-spine anchoring.
        const headRepo = ctx.gitToolWindowProvider?.getSelectedRepository() ?? repos[0];
        const combinedHeadHash = headRepo.head?.commit;
        const combinedHeadBranchName = headRepo.head?.name?.replace(/^refs\/heads\//, '');

        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.updateLogState(
            merged,
            combinedBranchMap,
            combinedTagMap,
            combinedHeadHash,
            combinedHeadBranchName
          );
        }
      } catch (error) {
        getLogger()
          .child({ component: 'extension' })
          .error('failed to load multi-root git log', error instanceof Error ? error : undefined);
      }
    };

    // Helper to load all panel data (commits) and update repository list
    const loadAllPanelData = async (): Promise<void> => {
      // Delegate to the exported core so the no-repository wiring (Requirement
      // 3.4) is unit-testable at the fix's call site. The core reports the
      // detection outcome to the provider via
      // `setHasRepository(repositories.length > 0)`, which always resolves the
      // transient Loading_State: repo present → leaves Loading, then the graph
      // fills via `loadLogCommits`; no repo → lands in No_Repository_State.
      // Route through loadAllRootsLog so multi-root mode is respected on the
      // initial load and every refresh, not just on explicit filter changes.
      await loadAllPanelDataCore({
        discoverAllRepositories,
        provider: ctx.gitToolWindowProvider,
        loadLogCommits: () => loadAllRootsLog(),
      });
    };

    // Wire up onDidRequestInitialData to load all data when webview first opens
    const initialDataListener = ctx.gitToolWindowProvider.onDidRequestInitialData(() => {
      void loadAllPanelData();
    });
    ctx.context.subscriptions.push(initialDataListener);

    // Wire up onDidRequestRefresh to reload all data when repository changes
    const refreshListener = ctx.gitToolWindowProvider.onDidRequestRefresh(() => {
      void loadAllPanelData();
    });
    ctx.context.subscriptions.push(refreshListener);

    // Auto-refresh the graph when the git repository changes (new commits, branch switches, etc.)
    const repoChangeListener = gitService.onDidChangeRepository(() => {
      void loadAllPanelData();
    });
    ctx.context.subscriptions.push(repoChangeListener);

    // Load commits when log filter changes. Routes through loadAllRootsLog so
    // that when intellig.log.showAllRoots is on, all workspace repos are merged;
    // when off, loadAllRootsLog delegates back to loadLogCommits (single-repo).
    const filterChangeListener = ctx.gitToolWindowProvider.onDidRequestLogFilter((filter) => {
      void loadAllRootsLog(
        filter
          ? {
              branch: filter.branch,
              author: filter.author,
              since: filter.since,
              until: filter.until,
              path: filter.path,
              searchText: filter.searchText,
              noMerges: filter.noMerges,
              firstParent: filter.firstParent,
              simplifyMerges: filter.simplifyMerges,
              minParents: filter.minParents,
              maxParents: filter.maxParents,
              logRange: filter.logRange,
              searchRegex: filter.searchRegex,
              searchCaseSensitive: filter.searchCaseSensitive,
            }
          : undefined
      );
    });
    ctx.context.subscriptions.push(filterChangeListener);

    // Re-run cherry-mark computation when the user sets a manual compare ref.
    const cherryCompareRefListener = ctx.gitToolWindowProvider.onDidRequestCherryCompareRef(
      async (ref) => {
        const repo =
          ctx.gitToolWindowProvider?.getSelectedRepository() ??
          (await resolveRepo(gitService, { preferActive: true, silent: true }));
        if (!repo) {
          return;
        }
        await loadCherryMarksForRepo(repo, ref);
      }
    );
    ctx.context.subscriptions.push(cherryCompareRefListener);

    // The repository-selector wiring (onDidSelectRepository → graph reload +
    // branch tree refresh) is registered in the second `if (ctx.services)`
    // block below, where `branchTreeProvider` is in scope. Both wirings live
    // there as a single unit so the dropdown can never update one view while
    // silently desyncing the other.

    // Wire up onDidSelectCommit to fetch changed files for the selected commit
    const commitSelectListener = ctx.gitToolWindowProvider.onDidSelectCommit(async (hash) => {
      // prefer the tool-window's selected repo (that's where the
      // commit was clicked), falling back to the active-editor's repo in
      // multi-root workspaces. The cold-start discovery path stays as a
      // last-resort fallback.
      let repo =
        ctx.gitToolWindowProvider?.getSelectedRepository() ??
        (await resolveRepo(gitService, { preferActive: true, silent: true }));
      if (!repo) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          repo = await gitService.getRepository(workspaceFolders[0].uri);
        }
      }
      if (!repo) {
        return;
      }
      try {
        const diffs = await gitService.getCommitDiff(repo, hash);
        const changedFiles = diffs.map((d) => ({
          path: d.path,
          oldPath: d.oldPath,
          status: d.status || ('modified' as const),
        }));
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.updateCommitDetails(hash, changedFiles);
        }
      } catch (error) {
        if (ctx.gitToolWindowProvider) {
          ctx.gitToolWindowProvider.updateCommitDetails(hash, [], error);
        }
      }
    });
    ctx.context.subscriptions.push(commitSelectListener);

    // Wire up onDidRequestCommitDiff to open diff view on file double-click
    const commitDiffListener = ctx.gitToolWindowProvider.onDidRequestCommitDiff(
      async ({ commitHash, filePath }) => {
        // prefer the tool-window's selected repo (that's where the
        // diff was requested), falling back to the active-editor's repo in
        // multi-root workspaces. The cold-start discovery path stays as a
        // last-resort fallback.
        let repo =
          ctx.gitToolWindowProvider?.getSelectedRepository() ??
          (await resolveRepo(gitService, { preferActive: true, silent: true }));
        if (!repo) {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders && workspaceFolders.length > 0) {
            repo = await gitService.getRepository(workspaceFolders[0].uri);
          }
        }
        if (!repo) {
          return;
        }
        try {
          const diffs = await gitService.getCommitDiff(repo, commitHash);
          const fileDiff = diffs.find((d) => d.path === filePath || d.oldPath === filePath);
          if (fileDiff) {
            const parentRef = commitHash + '~1';
            const leftUri = vscode.Uri.parse(`intellig-git:${filePath}?${parentRef}`);
            const rightUri = vscode.Uri.parse(`intellig-git:${filePath}?${commitHash}`);
            await vscode.commands.executeCommand(
              'vscode.diff',
              leftUri,
              rightUri,
              `${filePath} (${commitHash.substring(0, 7)})`
            );
          }
        } catch (error) {
          void vscode.window.showErrorMessage(
            formatActionFailureToast('Failed to open diff', error)
          );
        }
      }
    );
    ctx.context.subscriptions.push(commitDiffListener);

    // Bind the block-local helper to the hoisted reference so the second
    // `if (ctx.services)` block (which creates the BranchTreeProvider)
    // can pass it into `wireRepositorySelection(...)`.
    hoistedLoadLogCommitsForRepo = (repo: IRepository): Promise<void> =>
      loadLogCommitsForRepo(repo);

    // In the 2-panel layout, load all data immediately
    void loadAllPanelData();
  }

  // Register branch context menu commands and other services
  if (ctx.services) {
    const gitService = ctx.services.gitService;

    // Create BranchTreeProvider and tree view for context menu support
    // The tree view is used by CommandTitleProvider to listen for selection changes
    // and dynamically update command titles with branch names.
    const branchTreeProvider = createBranchTreeProvider(gitService);
    const branchTreeView = vscode.window.createTreeView('intellig.branchTree', {
      treeDataProvider: branchTreeProvider,
      showCollapseAll: true,
    });
    // Register the provider too so its EventEmitter
    // onDidChangeRepository subscription are torn down on deactivation.
    ctx.context.subscriptions.push(branchTreeView, branchTreeProvider);

    // Wire the repository selector to BOTH downstream views: the Log/Graph
    // (Git) view AND the Branches tree view. Without the branch-tree side,
    // switching repos in the dropdown updates the graph but leaves the
    // branches tree pointing at the previously-selected repo. The dual
    // wiring is centralized in `wireRepositorySelection` so the behavior
    // is unit-testable end-to-end (see repoSelectionWiring.test.ts).
    //
    // `hoistedLoadLogCommitsForRepo` is bound in the first
    // `if (ctx.services)` block above. Both blocks share this
    // top-level guard, so the helper is always defined here in production;
    // the `?? noop` fallback keeps the wiring resilient if that invariant
    // is ever broken by a future refactor.
    if (ctx.gitToolWindowProvider) {
      const noopLoadLog = (_repo: IRepository): Promise<void> => Promise.resolve();
      const loadLog = hoistedLoadLogCommitsForRepo ?? noopLoadLog;
      const repoSelectionDisposables = wireRepositorySelection({
        toolWindowProvider: ctx.gitToolWindowProvider,
        branchTreeProvider,
        loadLogCommitsForRepo: loadLog,
      });
      ctx.context.subscriptions.push(...repoSelectionDisposables);
    }

    // Link native BRANCHES tree view selection to the git graph.
    // When the user clicks a branch in the tree view, scroll the graph
    // panel to that branch's HEAD commit.
    if (ctx.gitToolWindowProvider) {
      const branchSelectionListener = branchTreeView.onDidChangeSelection((e) => {
        if (e.selection.length > 0) {
          const selectedItem = e.selection[0];
          // Only navigate for actual branch items (not category headers)
          if (selectedItem.branch) {
            ctx.gitToolWindowProvider!.navigateToBranch(selectedItem.branch.name);
          }
        }
      });
      ctx.context.subscriptions.push(branchSelectionListener);

      // `intellig.branch.focusOnGraph` inline icon command.
      // Routes the click on the branch tree's eye icon to the provider's
      // setFocusedBranch so the graph chip outlines, the scroll lands,
      // and the focused-path commits brighten while the rest dim.
      //
      // Toggle semantics: clicking the SAME
      // branch's eye icon a second time clears focus. Matches IntelliJ
      // parity (the eye icon turns into a toggle once focus is active).
      const focusOnGraphCommand = vscode.commands.registerCommand(
        'intellig.branch.focusOnGraph',
        async (item?: { branch?: { name?: string } }) => {
          const branchName = item?.branch?.name;
          if (typeof branchName !== 'string' || branchName.length === 0) {
            return;
          }
          const currentName = ctx.gitToolWindowProvider!.getFocusedBranchName();
          const nextTarget = currentName === branchName ? null : branchName;
          await ctx.gitToolWindowProvider!.setFocusedBranch(nextTarget);
        }
      );
      ctx.context.subscriptions.push(focusOnGraphCommand);
    }

    // Create and register CommandTitleProvider for dynamic label resolution
    const commandTitleProvider = createCommandTitleProvider(gitService, branchTreeProvider);
    commandTitleProvider.register(ctx.context, branchTreeView);
    ctx.context.subscriptions.push(commandTitleProvider);

    // Register branch context menu commands for the native BRANCHES tree view.
    // These are the actual VS Code command handlers invoked by the tree view context menus.
    // - conflictResolutionService: conflict-producing ops auto-open the dialog.
    // - pullDialog accessor: pullUsingRebase/pullUsingMerge route through the dialog.
    // - pushDialog opener: branch.push routes through the dialog.
    // - merge + new-branch dialog openers: branch.mergeInto and
    //   branch.newBranchFrom / tag.newBranchFrom route through their webview dialogs.
    const branchContextMenuCommands = createBranchContextMenuCommands(
      gitService,
      branchTreeProvider,
      ctx.services.conflictResolutionService,
      () => ctx.getPullDialog(),
      (p) => ctx.openPushDialog(p),
      (p) => ctx.openMergeDialog(p),
      (p) => ctx.openNewBranchDialog(p),
      (p) => ctx.openRebaseDialog(p)
    );
    branchContextMenuCommands.register(ctx.context);

    // Register commit context menu commands for the Git Graph Panel.
    // These handle right-click actions on commit rows in the graph view.
    // Pass conflictResolutionService so cherry-pick/revert/merge route
    // through the Resolve Conflicts dialog on conflict.
    if (ctx.gitToolWindowProvider) {
      ctx.commitContextMenuCommands = createCommitContextMenuCommands(
        gitService,
        ctx.services.rebaseService,
        ctx.gitToolWindowProvider,
        (gitService as unknown as IGitServiceCli).gitCli,
        ctx.services.conflictResolutionService
      );
      ctx.commitContextMenuCommands.register(ctx.context);
      // Late-bind the commit composer so Undo Commit restores the message.
      if (ctx.commitToolWindow) {
        ctx.commitContextMenuCommands.setCommitComposer(ctx.commitToolWindow);
      }
    }

    // Initialize Status Bar Service
    ctx.statusBarService = createStatusBarService(gitService);
    ctx.context.subscriptions.push(ctx.statusBarService);

    // Initialize Notification Service. It owns no disposables of its
    // own — the shared `IntelliG` OutputChannel it consumes is
    // registered against `context.subscriptions` by
    // `initOutputChannel(context)` earlier in activate — so we do NOT
    // push the service itself onto the subscriptions list (it has no
    // `dispose()` to call).
    ctx.notificationService = createNotificationService();

    // Initialize Keymap Service
    ctx.keymapService = new KeymapService(ctx.services.configurationService);
    ctx.context.subscriptions.push(ctx.keymapService);

    // Eagerly create the MergeView singleton so the Resolve Conflicts dialog
    // can subscribe to `onDidResolve` from the moment the service is wired.
    // MergeView is otherwise cheap — it only opens a panel on `show()`.
    if (!ctx.mergeView) {
      ctx.mergeView = createMergeView(ctx.context.extensionUri, gitService);
    }
    const conflictService = ctx.services.conflictResolutionService;
    if (
      conflictService &&
      typeof (conflictService as { setResolveConflictsDependencies?: unknown })
        .setResolveConflictsDependencies === 'function'
    ) {
      (
        conflictService as unknown as {
          setResolveConflictsDependencies: (
            ctx: vscode.ExtensionContext,
            mv: MergeView | undefined
          ) => void;
        }
      ).setResolveConflictsDependencies(ctx.context, ctx.mergeView);
    }

    // Initialize Stash View — pass conflictResolutionService so that
    // `apply`/`pop` conflicts route through the Resolve Conflicts dialog.
    ctx.stashView = createStashView(gitService, ctx.services.conflictResolutionService);
    ctx.context.subscriptions.push(ctx.stashView);

    // Initialize Shelf View — pass conflictResolutionService so that
    // unshelve conflicts route through the Resolve Conflicts dialog.
    ctx.shelfView = createShelfView(
      ctx.services.shelfService,
      (repo) => gitService.getStatus(repo),
      ctx.services.conflictResolutionService
    );
    ctx.context.subscriptions.push(ctx.shelfView);

    // Initialize Branch Comparison View
    ctx.branchComparisonView = createBranchComparisonView(gitService);
    ctx.context.subscriptions.push(ctx.branchComparisonView);

    // late-bind the branch comparison view onto the
    // commit context menu commands so the new "Compare with Branch..."
    // menu entry can route through it. The comparison view is
    // constructed AFTER `commitContextMenuCommands` in this activate()
    // sequence, so the constructor injection isn't possible without
    // reshuffling the wiring order.
    if (ctx.commitContextMenuCommands) {
      ctx.commitContextMenuCommands.setBranchComparisonView(ctx.branchComparisonView);
    }

    // Initialize Gutter Blame Provider
    ctx.gutterBlameProvider = createGutterBlameProvider(
      ctx.services.blameService,
      gitService,
      ctx.services.blameOptionsSource
    );
    ctx.context.subscriptions.push(ctx.gutterBlameProvider);

    // Initialize Rebase Progress View
    ctx.rebaseProgressView = createRebaseProgressView(
      ctx.context.extensionUri,
      ctx.services.rebaseService
    );
    ctx.context.subscriptions.push(ctx.rebaseProgressView);
  }
}

/**
 * Register a TextDocumentContentProvider for the 'intellig-git' URI scheme.
 * This allows opening file content at specific git revisions using URIs like:
 *   intellig-git:path/to/file.ts?ref=<commitHash>
 *
 * Used by the commit diff feature to show file content at parent and current commits.
 */
export function registerGitContentProvider(ctx: IViewRegistrationContext): void {
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: async (uri: vscode.Uri): Promise<string> => {
      if (!ctx.services) {
        throw new Error('Extension services not initialized');
      }
      return provideGitShowContent(uri, ctx.services.gitService);
    },
  };

  const registration = vscode.workspace.registerTextDocumentContentProvider(
    'intellig-git',
    provider
  );
  ctx.context.subscriptions.push(registration);
}

/**
 * Set up event listeners for workspace and Git changes.
 *
 * @param ctx - The view-registration context
 */
export function setupEventListeners(ctx: IViewRegistrationContext): void {
  // Surface a warning toast for any repository that's already in a paused-
  // rebase state at activation, plus on every subsequent
  // `onDidChangeRepository` transition into `rebasing`. Without this, users
  // who reloaded VS Code mid-rebase saw no signal until they re-triggered a
  // rebase command. See `wireRebasePausedWarning` for the implementation
  // contract.
  if (ctx.services) {
    const rebaseWarningDisposables = wireRebasePausedWarning({
      gitService: ctx.services.gitService,
      window: vscode.window,
      commands: vscode.commands,
    });
    ctx.context.subscriptions.push(...rebaseWarningDisposables);

    // Persistent companion to the transient rebase toast: a status-bar item
    // that stays visible for ANY in-progress op (merge / rebase / cherry-pick
    // / revert) until it's resolved, clicking through to the unified
    // Resolve-Conflicts surface (#28).
    ctx.context.subscriptions.push(
      createInProgressStatusBar({
        getRepositories: () => ctx.services!.gitService.getRepositories(),
        onDidChangeRepository: ctx.services.gitService.onDidChangeRepository,
      })
    );
  }

  // Listen for workspace folder changes and update the repository list
  const workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
    getLogger().child({ component: 'extension' }).info('workspace folders changed', {
      added: event.added.length,
      removed: event.removed.length,
    });

    // Update the repository list when workspace folders change
    if (ctx.services && ctx.gitToolWindowProvider) {
      const gitService = ctx.services.gitService;

      // Discover repositories from all current workspace folders
      for (const folder of event.added) {
        await gitService.getRepository(folder.uri);
      }

      const repositories = gitService.getRepositories();
      ctx.gitToolWindowProvider.setAvailableRepositories(repositories);
    }
  });

  // Listen for configuration changes
  const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('intellig')) {
      getLogger().child({ component: 'extension' }).debug('intellig configuration changed');
    }
  });

  // Listen for active editor changes (for blame annotations)
  const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      // Placeholder: blame annotations refresh on editor change is not yet wired.
    }
  });

  // Register all listeners with the extension context
  ctx.context.subscriptions.push(
    workspaceFoldersListener,
    configurationListener,
    activeEditorListener
  );
}
