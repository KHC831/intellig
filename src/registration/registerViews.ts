import * as vscode from 'vscode';
import {
  GitToolWindowProvider,
  GIT_TOOL_WINDOW_VIEW_ID,
  GIT_LOG_PANEL_VIEW_TYPE,
  createLogPanelSerializer,
  ConsoleService,
  createMergeView,
  MergeView,
  createStatusBarService,
  KeymapService,
  createStashView,
  createShelfView,
  createBranchComparisonView,
  createGutterBlameProvider,
  createLineStatusTracker,
  createLineStatusHoverProvider,
  createRebaseProgressView,
  createBranchTreeProvider,
  createCommitToolWindow,
  COMMIT_TOOL_WINDOW_VIEW_ID,
} from '../services';
import type { IGitService, IGitServiceCli, IRepository } from '../services';
import { graphTargetForTreeSelection } from '../branches/BranchTreeProvider';
import { graphRowKey } from '../git-core/commitGraph';
import { createCommandTitleProvider } from '../commits/CommandTitleProvider';
import { createBranchContextMenuCommands, createCommitContextMenuCommands } from '../commits';
import { getOutputChannel } from '../utils/outputChannel';
import { getLogger } from '../utils/logger';
import { resolveRepo } from '../utils/resolveRepo';
import { normalizeRepoPath, normalizeRepoPathString } from '../utils/normalizeRepoPath';
import { formatActionFailureToast, sanitizeGitError } from '../git-core/gitError';
import { openRevisionDiff } from '../git-core/diff/openRevisionDiff';
import { IViewRegistrationContext } from './ViewRegistrationContext';
import { createCoalescedRunner } from './coalesceAsync';
import {
  loadAllPanelDataCore,
  wireRepositorySelection,
  wireAvailableRepositorySync,
  resolveCommitRepoByRoot,
  resolveRepoForCommitDiff,
  resolveLogHeadAnchor,
  wireRebasePausedWarning,
  provideGitShowContent,
  buildCommitFileDiffUris,
} from './wiring';
import { createInProgressStatusBar } from '../ui-shell/InProgressStatusBar';
import {
  createGraphLoadMoreController,
  wireGraphLoadMore,
  type IGraphLoadMoreController,
} from './graphLoadMore';
import { fetchGraphPage, buildLogScope, narrowRefsForRepo } from './graphLogPage';
import { createStalenessGuard } from './stalenessGuard';

/**
 * Initial commit-graph window — the small first chunk loaded for a FAST startup
 * paint, then grown by {@link GRAPH_PAGE} on each scroll-to-bottom load-more.
 * IntelliJ shows a 100-commit "small data pack" first (registry
 * `vcs.log.small.data.pack.commits.count`) before streaming the rest; we mirror
 * that so the graph appears immediately instead of waiting on a large first page.
 */
const GRAPH_INITIAL_PAGE = 100;

/** Per-load-more increment grown on each scroll-to-bottom (kept larger than the
 * initial page so scrolling stays smooth without inflating first paint). */
const GRAPH_PAGE = 500;

/**
 * Choose the repository the Shelf/Stash tab actions should target: the tool
 * window's currently-SELECTED repo (the same selector the graph + log use), or
 * — when there is no explicit selection — the single open repo. Returns
 * `undefined` only when no repository is open. Pure so it's unit-testable
 * without the full view wiring.
 */
export function selectBoundShelfRepo(
  provider: { getSelectedRepository?(): IRepository | undefined } | undefined,
  repositories: readonly IRepository[]
): IRepository | undefined {
  // ALLOWED: the explicit tool-window selection is preferred; repos[0] is only
  // the single-repo / no-selection fallback, not an arbitrary multi-root pick.
  return provider?.getSelectedRepository?.() ?? repositories[0];
}

/**
 * Wire the provider's initial-data request to the coalesced loader, clearing
 * the provider's cold-start latch if the load rejects. The provider latches
 * "initial data requested" so a simultaneous attach + resolve fire only one
 * fetch; that latch is cleared when data lands (setHasRepository /
 * updateLogState), but a load that rejects before either would wedge it — so
 * the rejection path resets it here, guaranteeing a later cold entry can retry.
 * Extracted so this settle-on-failure contract is unit-testable at its seam.
 */
export function wireInitialDataLoad(
  provider: {
    onDidRequestInitialData: vscode.Event<void>;
    resetInitialDataRequest(): void;
  },
  loadAllPanelData: () => Promise<unknown>
): vscode.Disposable {
  return provider.onDidRequestInitialData(() => {
    void loadAllPanelData().then(undefined, () => provider.resetInitialDataRequest());
  });
}

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
  // the Branches tree view from a single `onDidChangeRepositoryScope` event.
  // Bound to the block-local `loadLogCommitsForRepo` inside the first
  // `if (ctx.services)` block where its closure dependencies
  // (gitService, gitToolWindowProvider) are in scope.
  let hoistedLoadLogCommitsForRepo: ((repo: IRepository) => Promise<void>) | undefined;
  // Hoisted alongside the single-repo loader so the second `if (ctx.services)`
  // block can route the selector's "All Repositories" scope to the merged
  // multi-root log via `wireRepositorySelection(...)`.
  let hoistedLoadAllRootsLog: (() => Promise<void>) | undefined;

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

    // Command to reveal the Git Console OutputChannel, the IntelliJ "open VCS
    // Console" analog. Captured by value so the closure doesn't depend on
    // `ctx.services` still being live at invocation time.
    const showGitConsoleCommand = vscode.commands.registerCommand('intellig.showGitConsole', () => {
      consoleService.showConsole();
    });
    ctx.context.subscriptions.push(showGitConsoleCommand);

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

  // Revive an undocked Git Log tab after a window reload by re-attaching it
  // to the provider (paired with the onWebviewPanel activation event).
  ctx.context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(
      GIT_LOG_PANEL_VIEW_TYPE,
      createLogPanelSerializer(() => ctx.gitToolWindowProvider)
    )
  );

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
      ctx.shelfView = createShelfView(
        shelfSvc,
        (r) => gs.getStatus(r),
        cs,
        ctx.services.changelistService
      );
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
      // Target the tool window's SELECTED repo (the same selector the graph +
      // log use), not an arbitrary first repo — otherwise unshelve/apply-stash
      // can hit the wrong repository in a multi-root workspace.
      const repo = selectBoundShelfRepo(ctx.gitToolWindowProvider, gs.getRepositories());
      if (!repo) {
        return undefined;
      }
      // Bind via the views' public no-side-effect seam (no QuickPick, unlike
      // `show()`), replacing the former private `_repository` field poke.
      shelfViewRef.setRepository(repo);
      stashViewRef.setRepository(repo);
      // refresh() returns { error? }; a bind-time refresh failure is
      // usually a transient FS race and won't block the caller from
      // running the subsequent unshelve/view/delete — but we mirror it
      // into the shared OutputChannel so a persistent breakage is
      // debuggable from `Output → IntelliG` in a shipped user's host.
      const refreshResult = await shelfViewRef.refresh();
      if (refreshResult.error) {
        getOutputChannel().appendLine(
          `[${new Date().toISOString()}] [intellig] extension.bindShelfRepo: refresh failed: ${sanitizeGitError(refreshResult.error)}`
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
    // Shared staleness guard for all graph loaders (single-repo and merged).
    // Each load bumps the generation at start; before calling updateLogState it
    // checks isCurrent() so a slow, older load that resolves after a newer one
    // started cannot overwrite the newer result. Also guards the background
    // total-count resolution (the existing count-guard pattern).
    const stalenessGuard = createStalenessGuard();

    // Per-repo snapshot of the last DEFAULT (unfiltered, first-page) log render.
    // Switching repos via the selector re-ran the full git log + count +
    // branches + tags + graph layout every time, so a switch back to an
    // already-viewed repo paid the whole cost again and felt laggy. We now keep
    // the last rendered state per repo root and paint it INSTANTLY on switch,
    // then fetch fresh in the background (stale-while-revalidate). The
    // background fetch always corrects any staleness, so the cache only ever
    // shortens the time-to-first-paint — it never shows persistently stale data.
    type LogSnapshot = {
      commits: Awaited<ReturnType<typeof fetchGraphPage>>['commits'];
      branchMap: Map<string, Array<{ name: string; type: 'local' | 'remote' }>>;
      tagMap: Map<string, string[]>;
      headHash: string | undefined;
      headBranchName: string | undefined;
      totalAvailable: number | undefined;
    };
    const defaultLogCache = new Map<string, LogSnapshot>();

    // Drop a repo's cached snapshot whenever its state changes (commit /
    // checkout / fetch / reset), so the next switch to it never paints
    // known-stale content before the background refresh lands.
    ctx.context.subscriptions.push(
      gitService.onDidChangeRepository((changed) => {
        defaultLogCache.delete(changed.rootUri.fsPath);
      })
    );

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
      },
      // Present only on a scroll-to-bottom load-more re-run: an explicit grown
      // limit. Absent on a fresh load (repo switch / filter change / refresh),
      // which resets the limit back to one page and resets scroll to the top.
      loadMore?: { limit: number }
    ): Promise<void> => {
      try {
        const myGeneration = stalenessGuard.bump();

        // Navigational = a different (repo, filter) than the previous
        // committed load: a repo switch, a filter change, or the first load.
        // Only navigation resets scroll, paints the stale cache, or collapses
        // the load-more window back to one page; a repeat of the same pair —
        // watcher tick, refresh button, post-action reload — refreshes in
        // place and preserves both. The staged target is committed only after
        // its data renders (below), so a failed load re-classifies as
        // navigational on retry.
        const isNavigational = !loadMore && graphLoadMore.beginLoad(repo, filter);

        // Stale-while-revalidate: a default (unfiltered, first-page)
        // navigational load is a repo switch. Paint the last cached render for
        // this repo IMMEDIATELY so the switch feels instant, then fall through
        // to the fresh fetch below which repaints in place once git returns.
        // The cached paint consumes the scroll reset; the fresh repaint then
        // preserves the (top) position.
        const isDefaultLoad = !loadMore && filter === undefined;
        let paintedFromCache = false;
        if (isDefaultLoad && isNavigational && ctx.gitToolWindowProvider) {
          const cached = defaultLogCache.get(repo.rootUri.fsPath);
          if (cached) {
            ctx.gitToolWindowProvider.markResetScrollOnNextRender();
            ctx.gitToolWindowProvider.updateLogState(
              cached.commits,
              cached.branchMap,
              cached.tagMap,
              cached.headHash,
              cached.headBranchName,
              cached.totalAvailable
            );
            paintedFromCache = true;
          }
        }

        // A load-more re-run carries the explicit grown limit through;
        // otherwise the controller answers: one base page for a navigational
        // load, the grown window for an in-place refresh (so a background
        // reload can't shrink the list under the user).
        const limit = loadMore ? loadMore.limit : graphLoadMore.currentLimit();

        // Fetch the windowed commit list now; the honest total (`getLogCount`,
        // a `rev-list --count` that walks the WHOLE history on a big repo) comes
        // back as a background promise so it never blocks the first paint behind
        // "Loading git graph…". Both share ONE scope (fetchGraphPage builds it
        // once) so the loaded list and the eventual total can't diverge — the
        // divergence that otherwise leaves hasMore stuck true or makes "X of Y"
        // lie. Topo order is requested on the log: a commit's parent MUST appear
        // later in the list (or off-window), else git's date order shuffles
        // divergent branches between a commit and its parent after a
        // squash/rebase and the algorithm renders it "linear" (the post-squash bug).
        const { commits, totalAvailable } = await fetchGraphPage(gitService, repo, filter, limit);

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
        } catch (error) {
          // Branches are optional for graph rendering; log+degrade so the fault stays visible.
          getLogger()
            .child({ component: 'extension' })
            .debug('graph load: getBranches failed', {
              err: error instanceof Error ? error.message : String(error),
            });
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
        } catch (error) {
          // Tags are optional for graph rendering; log+degrade so the fault stays visible.
          getLogger()
            .child({ component: 'extension' })
            .debug('graph load: getTags failed', {
              err: error instanceof Error ? error.message : String(error),
            });
        }

        if (ctx.gitToolWindowProvider) {
          // Single-repo / specific scope: anchor to this repo's own HEAD (the
          // helper de-prefixes the branch name to match `IBranchRef.name`).
          const { headHash, headBranchName } = resolveLogHeadAnchor(false, repo);
          // Load-more grows the window in place; scroll is preserved by default
          // (only a fresh navigational load above flips on the reset flag), so
          // growing the window keeps the user on the commit they were viewing.
          //
          // Guard: a faster, newer load may have already rendered. If so, skip
          // — the newer result stands; don't overwrite it with our stale data.
          if (!stalenessGuard.isCurrent(myGeneration)) {
            return;
          }
          // Navigation resets the webview to the top. Armed HERE — after the
          // fetch succeeded and the staleness guard passed — so a failed or
          // superseded navigational load can't leave a pending reset that a
          // later in-place render would consume. When the cached paint above
          // already ran, the reset was consumed there and this fresh repaint
          // preserves the position.
          if (isNavigational && !paintedFromCache) {
            ctx.gitToolWindowProvider.markResetScrollOnNextRender();
          }
          // Render NOW with the total unknown (undefined → "all loaded", no
          // spinner). The exact total folds in below when its background promise
          // resolves — first paint renders without waiting on the count.
          ctx.gitToolWindowProvider.updateLogState(
            commits,
            branchMap,
            tagMap,
            headHash,
            headBranchName,
            undefined
          );
          // The staged (repo, filter) becomes the committed baseline only now
          // that its data rendered; this also hands the controller the fresh
          // repo snapshot for load-more replays. No-op on load-more re-runs.
          graphLoadMore.commitLoad();

          // Cache the fresh default-page render so a later switch back to this
          // repo paints instantly (see the stale-while-revalidate paint above).
          // Only the unfiltered first page is cached — that is exactly the state
          // a repo switch loads.
          if (isDefaultLoad) {
            defaultLogCache.set(repo.rootUri.fsPath, {
              commits,
              branchMap,
              tagMap,
              headHash,
              headBranchName,
              // `totalAvailable` is now a background promise; the cached paint
              // mirrors main's fresh paint (render with the count unknown, no
              // spinner) and lets the in-flight fresh load fold the real total in.
              totalAvailable: undefined,
            });
          }

          // Re-arm the webview's load-more debounce now the grown page has
          // rendered, so the next scroll-to-bottom can fire. Explicit + reload
          // independent (see notifyCommitsLoaded). Only needed on a load-more
          // re-run; a fresh load already starts with the debounce clear.
          if (loadMore) {
            ctx.gitToolWindowProvider.notifyCommitsLoaded();
          }

          // Fold the honest total in once it resolves — but only if no newer
          // load has started since (generation guard), so a stale count from a
          // superseded repo/filter/load-more never clobbers the current view.
          // This is a LIGHTWEIGHT attribute update (re-enables scroll load-more +
          // the "X of Y" indicator), NOT a full updateLogState re-render — a late
          // re-render would destroy the DOM (scroll, in-progress layout,
          // selection) mid-interaction, which a slow count (5–10s) made
          // user-visible as the graph "resetting" when you clicked a commit.
          void totalAvailable.then((total) => {
            if (total === undefined || !stalenessGuard.isCurrent(myGeneration)) {
              return;
            }
            ctx.gitToolWindowProvider?.applyGraphTotalAvailable(total);
          });

          // Compute the cherry-mark map in the background and push it into
          // the provider. We don't block the log render on it — cherry marks
          // are a visual nicety, and the call is throttled by git spawn
          // overhead (typically <100ms). Gated by the
          // `intellig.log.highlightCherryPicked` flag. Compares HEAD against its
          // upstream (auto).
          void loadCherryMarksForRepo(repo);
        }
      } catch (error) {
        getLogger()
          .child({ component: 'extension' })
          .error('failed to load git log', error instanceof Error ? error : undefined);
      }
    };

    // Build the load-more controller (its reload re-runs the single-repo
    // loader at the grown limit) and subscribe it to the provider's
    // `onDidRequestLoadMoreCommits` emitter.
    const graphLoadMore: IGraphLoadMoreController<LogFilter> =
      createGraphLoadMoreController<LogFilter>(
        GRAPH_INITIAL_PAGE,
        (repo, filter, opts) => {
          void loadLogCommitsForRepo(repo, filter, opts);
        },
        GRAPH_PAGE
      );
    ctx.context.subscriptions.push(
      wireGraphLoadMore(ctx.gitToolWindowProvider, () => graphLoadMore.handleLoadMore())
    );

    /**
     * Compute `git log --cherry-mark` for the given repo against its
     * upstream and push the `=`-marked hashes into the Log tab's state.
     * Runs in the background; errors are swallowed so the UI stays calm.
     */
    const loadCherryMarksForRepo = async (repo: IRepository): Promise<void> => {
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
      // Auto-upstream: resolve the upstream ref for the current branch.
      const headUpstream = repo.head?.upstream;
      if (!headUpstream) {
        ctx.gitToolWindowProvider.setCherryPickedHashes(undefined);
        return;
      }
      const baseRef = `${headUpstream.remote}/${headUpstream.name}`;
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
      } catch (error) {
        // The feature degrades cleanly when git doesn't support --cherry-mark
        // or the repo state is unusual; log+degrade so the fault stays visible.
        getLogger()
          .child({ component: 'extension' })
          .debug('graph load: cherry-mark computation failed', {
            err: error instanceof Error ? error.message : String(error),
          });
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
      branches?: string[];
      branchesNone?: boolean;
      author?: string;
      since?: Date;
      until?: Date;
      path?: string;
      paths?: string[];
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

    // Multi-root log loader (G8). When the repository scope is "all" (see
    // `_isShowAllRootsEnabled()`, which now derives from the selector scope —
    // the showAllRoots config only seeds the initial default) AND more than
    // one repository exists, loads commits from ALL workspace repos in
    // parallel, tags each with its repoRoot, and merges them sorted
    // newest-first. Falls back to the single-repo path otherwise.
    const loadAllRootsLog = async (filter?: LogFilter): Promise<void> => {
      const showAllRoots = ctx.gitToolWindowProvider?._isShowAllRootsEnabled() ?? false;
      if (!showAllRoots) {
        await loadLogCommits(filter);
        return;
      }

      // Bump immediately on every entry into the merged path — before any async
      // work — so ANY older in-flight load (single-repo or a previous merged
      // load that already bumped its own generation) is invalidated as soon as
      // we decide we're doing a merged/show-none render. One bump per
      // loadAllRootsLog invocation; the merged path's isCurrent check below
      // references this same myGeneration.
      const myGeneration = stalenessGuard.bump();

      const discovered = await discoverAllRepositories();
      // Honor a "some but not all roots" subset from the Repository filter: load
      // only the visible roots' commits. `null` means every root (show all).
      const visible = ctx.gitToolWindowProvider?.getVisibleRepoRoots() ?? null;
      // An explicit empty subset is the "show none" state — render an empty graph
      // rather than falling through to the single-repo load below.
      if (visible && visible.length === 0) {
        // Guard the empty render: a subsequent loadAllRootsLog call that started
        // while discoverAllRepositories was awaiting will have bumped past us,
        // and its result (or a newer show-none) should stand instead.
        if (stalenessGuard.isCurrent(myGeneration)) {
          ctx.gitToolWindowProvider?.updateLogState([], new Map(), new Map(), undefined, undefined);
          ctx.gitToolWindowProvider?.setMergedHeadCommitHashes([]);
        }
        return;
      }
      const repos = visible
        ? discovered.filter((r) => {
            const norm = normalizeRepoPath(r.rootUri);
            return visible.some((p) => normalizeRepoPathString(p) === norm);
          })
        : discovered;
      if (repos.length <= 1) {
        await loadLogCommits(filter);
        return;
      }

      // Entering merged mode: disable single-repo load-more so a scroll-to-
      // bottom cannot re-run a stale single-repo load over the merged graph.
      graphLoadMore.noteMergedLoad();

      // myGeneration was captured at the top of this function (before
      // discoverAllRepositories), so it already invalidates any in-flight
      // single-repo load. No second bump here — one bump per invocation.
      try {
        // ONE scope object (buildLogScope) so the merged view applies the same
        // filter mapping as the single-repo graph — including the "Message or
        // hash" box's hash-filter detection.
        const scope = buildLogScope(filter);

        // Fetch each repo's branches UP FRONT — needed both for the combined
        // branch map AND to intersect a branch SUBSET against the refs that
        // actually exist in each repo. A multi-ref `git log <a> <b>` fails
        // ENTIRELY ("fatal: unknown revision") if ONE ref is missing in that
        // repo, which would silently drop that repo's whole history. Selecting
        // {main, feature/b} must still show repo A's `main` even if A lacks
        // feature/b — so we narrow the refs per repo and skip a repo that has
        // none of the selected branches.
        const perRepoBranches = await Promise.all(
          repos.map((repo) =>
            gitService.getBranches(repo).catch((error) => {
              getLogger()
                .child({ component: 'extension' })
                .debug('graph load (merged): getBranches failed', {
                  err: error instanceof Error ? error.message : String(error),
                });
              return [];
            })
          )
        );

        // Keyed by (hash, root) — graphRowKey — so a ref only ever labels the
        // row of the repo that carries it. Two checkouts of the same repo
        // share every hash; a bare-hash map pooled all their refs onto one row.
        const combinedBranchMap = new Map<
          string,
          Array<{ name: string; type: 'local' | 'remote' }>
        >();
        perRepoBranches.forEach((branches, repoIndex) => {
          const root = repos[repoIndex].rootUri.fsPath;
          for (const branch of branches) {
            if (branch.commit && branch.type !== 'tag') {
              const key = graphRowKey(branch.commit, root);
              const existing = combinedBranchMap.get(key) || [];
              existing.push({ name: branch.name, type: branch.type });
              combinedBranchMap.set(key, existing);
            }
          }
        });

        // Load up to 200 commits per repo — lower per-repo cap keeps the
        // merged view snappy while still giving meaningful cross-repo history.
        const allCommitsArrays = await Promise.all(
          repos.map(async (repo, i) => {
            const narrowed = narrowRefsForRepo(
              scope.refs,
              perRepoBranches[i].map((b) => b.name)
            );
            // None of the selected branches exist in this repo → contribute
            // nothing (don't run a poisoned multi-ref command).
            if (narrowed.skip) {
              return [];
            }
            const repoScope = narrowed.refs ? { ...scope, refs: narrowed.refs } : scope;
            const commits = await gitService.getLog(repo, {
              maxCount: 200,
              topoOrder: true,
              ...repoScope,
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

        // Same (hash, root) keying as the branch map above.
        const combinedTagMap = new Map<string, string[]>();
        await Promise.all(
          repos.map(async (repo) => {
            try {
              const tags = await gitService.getTags(repo);
              for (const tag of tags) {
                if (tag.commit) {
                  const key = graphRowKey(tag.commit, repo.rootUri.fsPath);
                  const existing = combinedTagMap.get(key) || [];
                  existing.push(tag.name);
                  combinedTagMap.set(key, existing);
                }
              }
            } catch (error) {
              // Tags are optional for graph rendering; log+degrade so the fault stays visible.
              getLogger()
                .child({ component: 'extension' })
                .debug('graph load (merged): getTags failed', {
                  err: error instanceof Error ? error.message : String(error),
                });
            }
          })
        );

        // Merged scope: suppress the single-repo HEAD spine / current-branch
        // highlight so the interleaved graph doesn't misleadingly single out
        // the context repo's HEAD. See resolveLogHeadAnchor.
        const { headHash, headBranchName } = resolveLogHeadAnchor(true, undefined);

        if (ctx.gitToolWindowProvider) {
          // Guard: skip if a newer load (single-repo switch or a second merged
          // load) started while we were fetching. The newer result stands.
          if (!stalenessGuard.isCurrent(myGeneration)) {
            return;
          }
          ctx.gitToolWindowProvider.updateLogState(
            merged,
            combinedBranchMap,
            combinedTagMap,
            headHash,
            headBranchName
          );
          // The single-repo HEAD anchor is suppressed above; record EVERY
          // root's HEAD so undoCommit stays enabled for the clicked commit's
          // own-repo HEAD (decoupled from the suppressed spine).
          const rootHeadHashes = repos.map((r) => r.head?.commit).filter((c): c is string => !!c);
          ctx.gitToolWindowProvider.setMergedHeadCommitHashes(rootHeadHashes);
        }
      } catch (error) {
        getLogger()
          .child({ component: 'extension' })
          .error('failed to load multi-root git log', error instanceof Error ? error : undefined);
      }
    };

    // Helper to load all panel data (commits) and update repository list.
    //
    // Coalesced: `onDidRequestInitialData`, `onDidRequestRefresh` and
    // `onDidChangeRepository` all fire within the same activation tick, so an
    // unwrapped loader launches three concurrent graph loads — three CPU-bound
    // `git log --topo-order` walks racing each other (each ~2s walk stretches to
    // ~5s under the contention on a large repo with no commit-graph). The runner
    // collapses the burst to one uncontended run (fast first paint) plus a
    // single trailing reload so a real mid-load change is never dropped.
    const loadAllPanelData = createCoalescedRunner(() =>
      // Delegate to the exported core so the no-repository wiring (Requirement
      // 3.4) is unit-testable at the fix's call site. The core reports the
      // detection outcome to the provider via
      // `setHasRepository(repositories.length > 0)`, which always resolves the
      // transient Loading_State: repo present → leaves Loading, then the graph
      // fills via `loadLogCommits`; no repo → lands in No_Repository_State.
      // Route through loadAllRootsLog so multi-root mode is respected on the
      // initial load and every refresh, not just on explicit filter changes.
      loadAllPanelDataCore({
        discoverAllRepositories,
        provider: ctx.gitToolWindowProvider,
        // Reapply the tool window's active filter (persisted across reloads)
        // on the initial load and every refresh-triggered reload.
        activeLogFilter: () => ctx.gitToolWindowProvider?.getActiveLogFilter(),
        loadLogCommits: (filter) => loadAllRootsLog(filter),
      })
    );

    // Wire up onDidRequestInitialData to load all data when webview first opens.
    // Resets the provider's cold-start latch if the load rejects (see
    // wireInitialDataLoad), so a failed initial fetch can be retried.
    ctx.context.subscriptions.push(
      wireInitialDataLoad(ctx.gitToolWindowProvider, loadAllPanelData)
    );

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
    // that in "all" scope all workspace repos are merged; in a specific-repo
    // scope loadAllRootsLog delegates back to loadLogCommits (single-repo).
    const filterChangeListener = ctx.gitToolWindowProvider.onDidRequestLogFilter((filter) => {
      void loadAllRootsLog(
        filter
          ? {
              branch: filter.branch,
              branches: filter.branches,
              branchesNone: filter.branchesNone,
              author: filter.author,
              since: filter.since,
              until: filter.until,
              path: filter.path,
              paths: filter.paths,
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

    // The repository-selector wiring (onDidChangeRepositoryScope → graph
    // reload + branch tree refresh) is registered in the second
    // `if (ctx.services)` block below, where `branchTreeProvider` is in scope.
    // Both wirings live there as a single unit so the dropdown can never
    // update one view while silently desyncing the other.

    // Wire up onDidSelectCommit to fetch changed files for the selected commit
    const commitSelectListener = ctx.gitToolWindowProvider.onDidSelectCommit(async (hash) => {
      // In the merged "all roots" log the clicked commit may belong to a repo
      // other than the context repo, so resolve by the commit's own recorded
      // root first. Then fall back to the selected (context) repo, the
      // active-editor's repo, and finally cold-start discovery.
      let repo =
        (await resolveCommitRepoByRoot(ctx.gitToolWindowProvider, gitService, hash)) ??
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
      // Fetch the "Contained in branches" list in parallel with the diff so a
      // slow branch query never delays the changed-files render. Each posts its
      // own partial details update; getContainingBranches degrades to [] on
      // failure, so this never rejects.
      void gitService
        .getContainingBranches(repo, hash)
        .then((branches) => {
          ctx.gitToolWindowProvider?.updateContainingBranches(hash, branches);
        })
        // getContainingBranches itself never rejects, but updateContainingBranches
        // posts to the webview — swallow any throw there so it can't surface as an
        // unhandled rejection.
        .catch(() => {});

      try {
        const diffs = await gitService.getCommitDiff(repo, hash);
        const changedFiles = diffs.map((d) => {
          // Per-file +/- line counts from the already-parsed diff hunks (no extra
          // git call). Binary files have no hunks → counts stay undefined so the
          // UI shows no stat.
          let additions = 0;
          let deletions = 0;
          for (const hunk of d.hunks) {
            for (const line of hunk.lines) {
              if (line.type === 'add') {
                additions++;
              } else if (line.type === 'delete') {
                deletions++;
              }
            }
          }
          return {
            path: d.path,
            oldPath: d.oldPath,
            status: d.status || ('modified' as const),
            additions: d.binary ? undefined : additions,
            deletions: d.binary ? undefined : deletions,
          };
        });
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
        // Resolve the repo that actually CONTAINS this commit, non-interactively
        // — recorded source root → tool-window selection → probe open repos.
        // Never prompt (a "Choose Repository" QuickPick here is an unwanted
        // popup) and never open against a repo that lacks the commit (that
        // produced an empty, blank diff).
        const repo = await resolveRepoForCommitDiff(
          ctx.gitToolWindowProvider,
          gitService,
          commitHash
        );
        if (!repo) {
          void vscode.window.showErrorMessage(
            `Could not find the repository containing commit ${commitHash.substring(0, 7)}.`
          );
          return;
        }
        try {
          const diffs = await gitService.getCommitDiff(repo, commitHash);
          const fileDiff = diffs.find((d) => d.path === filePath || d.oldPath === filePath);
          if (fileDiff) {
            // Encode the resolved repo root so the content provider resolves the
            // diff against the repo that actually owns this commit (vs. guessing
            // in a multi-root workspace — which prompted for a repo and opened a
            // blank or all-added "all green" diff on a wrong/empty resolution).
            const { leftUri, rightUri } = buildCommitFileDiffUris(
              filePath,
              commitHash,
              repo.rootUri.fsPath
            );
            // Bare (re-throws) into the surrounding catch, which also covers
            // `getCommitDiff` above.
            await openRevisionDiff({
              leftUri,
              rightUri,
              title: `${filePath} (${commitHash.substring(0, 7)})`,
            });
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
    hoistedLoadAllRootsLog = (): Promise<void> => loadAllRootsLog();

    // In the 2-panel layout, load all data immediately
    void loadAllPanelData();
  }

  // Register branch context menu commands and other services
  if (ctx.services) {
    const gitService = ctx.services.gitService;

    // Create BranchTreeProvider and tree view for context menu support
    // The tree view is used by CommandTitleProvider to listen for selection changes
    // and dynamically update command titles with branch names.
    // Inject the shared favorites store so the tree and the branch popup star
    // the same set (git4idea parity: one GitRepositoryModel.favoriteRefs;
    // globalState-backed, so favorites persist across sessions).
    const branchTreeProvider = createBranchTreeProvider(gitService, ctx.branchFavoritesStore);
    const branchTreeView = vscode.window.createTreeView('intellig.branchTree', {
      treeDataProvider: branchTreeProvider,
      showCollapseAll: true,
      // Multi-select: context commands receive (clicked, selection[]) and the
      // tree-item spine folds the selection into `batch` (delete acts on all).
      canSelectMany: true,
    });
    // Register the provider too so its EventEmitter
    // onDidChangeRepository subscription are torn down on deactivation.
    ctx.context.subscriptions.push(branchTreeView, branchTreeProvider);

    // Branches-tree search (IntelliJ speed-search analogue): an InputBox
    // narrows every section to substring matches; the view description and
    // the `intellig.branchSearchActive` context (which reveals the clear
    // button) mirror the active query.
    const applyBranchSearch = (query: string | undefined): void => {
      branchTreeProvider.setSearchQuery(query);
      const active = branchTreeProvider.getSearchQuery();
      branchTreeView.description = active ? `Search: ${active}` : undefined;
      void vscode.commands.executeCommand('setContext', 'intellig.branchSearchActive', !!active);
    };
    const branchSearchCommand = vscode.commands.registerCommand(
      'intellig.branch.search',
      async () => {
        const query = await vscode.window.showInputBox({
          prompt: 'Search branches and tags (substring match)',
          value: branchTreeProvider.getSearchQuery() ?? '',
          placeHolder: 'e.g. feature/auth',
        });
        if (query === undefined) {
          return; // cancelled — keep the current filter
        }
        applyBranchSearch(query);
      }
    );
    const branchClearSearchCommand = vscode.commands.registerCommand(
      'intellig.branch.clearSearch',
      () => applyBranchSearch(undefined)
    );
    ctx.context.subscriptions.push(branchSearchCommand, branchClearSearchCommand);

    // `intellig.branch.toggleFavorite` — star/unstar the selected local
    // branch. Mirrors git4idea's toggle_favorite action; the provider
    // persists the favorite set and refreshes the tree.
    const toggleFavoriteCommand = vscode.commands.registerCommand(
      'intellig.branch.toggleFavorite',
      (item?: { branch?: { name?: string } }) => {
        const branchName = item?.branch?.name;
        if (typeof branchName === 'string' && branchName.length > 0) {
          branchTreeProvider.toggleFavorite(branchName);
        }
      }
    );
    ctx.context.subscriptions.push(toggleFavoriteCommand);

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
      const noopLoadAllRoots = (): Promise<void> => Promise.resolve();
      const loadLog = hoistedLoadLogCommitsForRepo ?? noopLoadLog;
      const loadAllRoots = hoistedLoadAllRootsLog ?? noopLoadAllRoots;
      const repoSelectionDisposables = wireRepositorySelection({
        toolWindowProvider: ctx.gitToolWindowProvider,
        branchTreeProvider,
        loadLogCommitsForRepo: loadLog,
        loadAllRootsLog: loadAllRoots,
      });
      ctx.context.subscriptions.push(...repoSelectionDisposables);
    }

    // Link native BRANCHES tree view selection to the git graph.
    // When the user clicks a branch in the tree view, scroll the graph
    // panel to that branch's HEAD commit.
    if (ctx.gitToolWindowProvider) {
      const branchSelectionListener = branchTreeView.onDidChangeSelection((e) => {
        if (e.selection.length > 0) {
          const target = graphTargetForTreeSelection(e.selection[0]);
          if (target?.kind === 'branch') {
            ctx.gitToolWindowProvider!.navigateToBranch(target.name);
          } else if (target?.kind === 'commit') {
            ctx.gitToolWindowProvider!.navigateToCommit(target.hash);
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

    // Initialize Keymap Service
    ctx.keymapService = new KeymapService(ctx.services.configurationService);
    ctx.context.subscriptions.push(ctx.keymapService);

    // Eagerly create the MergeView singleton so the Resolve Conflicts dialog
    // can subscribe to `onDidResolve` from the moment the service is wired.
    // MergeView is otherwise cheap — it only opens a panel on `show()`.
    if (!ctx.mergeView) {
      const sideNamesService = ctx.services.conflictResolutionService;
      ctx.mergeView = createMergeView(
        ctx.context.extensionUri,
        gitService,
        sideNamesService
          ? {
              context: ctx.context,
              getSideNames: (repo) => sideNamesService.getConflictSideNames(repo),
            }
          : undefined
      );
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
      ctx.services.conflictResolutionService,
      ctx.services.changelistService
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

    // Initialize the live changed-line gutter tracker (LineStatusTracker
    // parity). Self-contained and config-driven, so it isn't stored on the
    // context — just registered for disposal.
    ctx.context.subscriptions.push(createLineStatusTracker(gitService));

    // Inline-diff hover popup on a change marker (LineStatusMarkerPopup parity):
    // shows the committed content for the hovered range + revert/copy actions.
    ctx.context.subscriptions.push(createLineStatusHoverProvider(gitService));

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
      // Suppress the generic toast for a rebase the extension is driving itself
      // (squash / interactive rebase); those own their progress/conflict/pause
      // messaging and only transiently look `rebasing` while they run.
      isManagedRebase: (repo) => ctx.services!.rebaseService.isManagingRebase(repo),
    });
    ctx.context.subscriptions.push(...rebaseWarningDisposables);

    // Persistent companion to the transient rebase toast: a status-bar item
    // that stays visible for ANY in-progress op (merge / rebase / cherry-pick
    // / revert) until it's resolved, clicking through to the unified
    // Resolve-Conflicts surface.
    ctx.context.subscriptions.push(
      createInProgressStatusBar({
        getRepositories: () => ctx.services!.gitService.getRepositories(),
        onDidChangeRepository: ctx.services.gitService.onDidChangeRepository,
      })
    );
  }

  // Keep the repository selector in sync with GitService's authoritative repo
  // set. GitService owns workspace-folder discovery + watcher lifecycle (its own
  // onDidChangeWorkspaceFolders listener); the tool window only needs to follow
  // the resulting set — including nested repos discovered asynchronously — which
  // `wireAvailableRepositorySync` derives from onDidChangeRepository /
  // onDidRemoveRepository, pushing only when the root set changes.
  if (ctx.services && ctx.gitToolWindowProvider) {
    ctx.context.subscriptions.push(
      ...wireAvailableRepositorySync({
        provider: ctx.gitToolWindowProvider,
        gitService: ctx.services.gitService,
      })
    );
  }

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
  ctx.context.subscriptions.push(configurationListener, activeEditorListener);
}
