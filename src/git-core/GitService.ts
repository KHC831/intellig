import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { canonicalizeFsPath } from '../utils/repoRelativePath';
import {
  IGitService,
  IGitServiceCli,
  IRepository,
  IBranch,
  ICommit,
  ITag,
  IStash,
  IRemote,
  IFileStatus,
  IDiff,
  IHunk,
  IBlameLine,
  ICommitOptions,
  ICommitFixupResult,
  ICheckoutOptions,
  IPullOptions,
  IPushOptions,
  IFetchOptions,
  IFetchResult,
  IStashOptions,
  ILogOptions,
  IFileHistoryOptions,
  ICreateBranchOptions,
  IMergeOptions,
  IRebaseOptions,
  IMergeResult,
  IBasicRebaseResult,
  ICherryPickOptions,
  ICherryPickResult,
  IRevertOptions,
  IRevertResult,
  IBranchComparison,
  IRefDiffFile,
  ResetMode,
  RepositoryState,
  IRollbackChange,
  IRollbackOptions,
  ILineSelection,
} from './interfaces/IGitService';
import { GitCli, IGitCommandOptions, createGitCli, buildGitArgs } from './gitCli';
import { scanFolderForGitRepos, defaultRepoScanFs, IRepoScanFs } from './repoScan';
import {
  isPathInsideOrEqual,
  repoRootFromGitDir,
  isNewRepoPathIgnored,
  resolveWorktreeGitDir,
} from './repo/RepositoryDiscovery';
import { parseRemotes, parseHead } from './gitParser';
import { sanitizeGitError } from './gitError';
import { IGitOpsContext, createGitOpsContext } from './ops/GitOpsContext';
import { StagingOps } from './ops/StagingOps';
import { DiffOps } from './ops/DiffOps';
import { CherryPickRevertOps } from './ops/CherryPickRevertOps';
import { BranchOps } from './ops/BranchOps';
import { StashTagHistoryOps } from './ops/StashTagHistoryOps';
import { RemoteOps } from './ops/RemoteOps';
import { IncomingOutgoingOps, IIncomingOutgoing } from './ops/IncomingOutgoingOps';
import { WorktreeOps, IWorktreeEntry, IAddWorktreeOptions } from './ops/WorktreeOps';
import type { ResultAsync } from 'neverthrow';
import type { GitError } from './errors';
import { readInProgressOperation } from './gitInProgress';
import { resolveGitDir } from './gitDirMarkers';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { getLogger, type Logger } from '../utils/logger';

/**
 * Cache entry for repository information
 */
interface IRepositoryCache {
  repository: IRepository;
  lastUpdated: number;
}

/**
 * Git Service implementation.
 * Provides all Git operations through the Git CLI.
 */
export class GitService implements IGitService, IGitServiceCli {
  private _gitCli: GitCli;
  private readonly _staging: StagingOps;
  private readonly _diff: DiffOps;
  private readonly _cherryRevert: CherryPickRevertOps;
  private readonly _branches: BranchOps;
  private readonly _stashTagHistory: StashTagHistoryOps;
  private readonly _remoteOps: RemoteOps;
  private readonly _incomingOutgoing: IncomingOutgoingOps;
  private readonly _worktrees: WorktreeOps;
  private _repositories: Map<string, IRepositoryCache> = new Map();
  private _onDidChangeRepository: vscode.EventEmitter<IRepository>;
  /**
   * (#213): fired when a previously-discovered repository is removed
   * from `_repositories` — either because the user removed its workspace
   * folder, or because its `.git/HEAD` was deleted mid-session
   * (`rm -rf .git`). Subscribers (BranchTreeProvider, StatusBarService,
   * BranchPopup, ChangelistService, etc.) listen so they can drop the
   * repo from their UI without polling.
   */
  private _onDidRemoveRepository: vscode.EventEmitter<IRepository>;
  private _onDidFetch: vscode.EventEmitter<{ repo: IRepository; result: IFetchResult }>;
  private _disposables: vscode.Disposable[] = [];
  /**
   * File watchers per repository root. One root may have multiple watchers
   * because we watch a narrow allow-list of `.git/` entries (HEAD, index,
   * refs/**, packed-refs, in-progress markers) rather than a single `**\/*`
   * glob — the broad glob causes a refresh loop because every `git status`
   * / `git log` / `git rev-parse` touches `.git/index`, `.git/logs/**`, or
   * `.git/objects/**`, re-triggering the watcher → `loadRepository` → the
   * same git reads again.
   */
  private _fileWatchers: Map<string, vscode.FileSystemWatcher[]> = new Map();
  /** Per-rootPath debounce timers for coalescing watcher event bursts. */
  private _refreshTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** In-flight `loadRepository` promises, keyed by rootPath. */
  private _reloading: Map<string, Promise<IRepository>> = new Map();
  /**
   * Per-rootPath removal counter, bumped whenever a root is torn down
   * ({@link removeRepositoryWatcher}). A `loadRepository` captures the count at
   * entry and re-checks it before its final cache-write/announce: if the root
   * was removed while the load was in flight (rapid add→remove), the resolved
   * load must NOT resurrect it (re-cache + re-watch + re-fire).
   */
  private _removalGeneration: Map<string, number> = new Map();
  /**
   * In-flight `getStatus` promises, keyed by rootPath. On activation several
   * subscribers (SCM provider, changelist + shelf views) request the same
   * repo's status at once; each `git status --porcelain` walks the whole work
   * tree to enumerate untracked files (multi-second on a large repo), so the
   * concurrent duplicates saturate the disk and starve the graph's `git log`.
   * Coalescing identical overlapping calls into one walk removes that storm.
   */
  private _statusInFlight: Map<string, Promise<IFileStatus[]>> = new Map();
  /**
   * In-flight `getLog` promises. The graph's `git log --topo-order` is CPU-bound
   * on a large repo with no commit-graph (~2s on a 500k-commit tree); letting
   * the heavy `git status --porcelain` untracked walk run alongside it starves
   * the first paint. `getStatus` waits on these (bounded by `_statusLogGateMs`)
   * so the graph paints first, with no effect when the two don't overlap.
   */
  private _logInFlight: Set<Promise<unknown>> = new Set();
  /** Safety cap on how long getStatus yields to an in-flight getLog. */
  private _statusLogGateMs = 4000;
  /**
   * Startup race fix: the SCM status refresh and the graph's getLog both fire on
   * activation events in nondeterministic order. If status checks
   * `_logInFlight` a tick before getLog registers, it would miss the gate and
   * race the log. During the startup window, a status call that finds no log yet
   * waits a short grace for an imminent getLog to register before deciding.
   */
  private readonly _createdAt = Date.now();
  private _statusGateStartupWindowMs = 8000;
  private _statusGateGraceMs = 500;
  /** Resolvers woken when the next getLog registers (see `_waitForLogRegistration`). */
  private _logRegisterWaiters: Array<() => void> = [];
  /**
   * Latched on `dispose()`. Guards every watcher callback path so that an
   * in-flight `loadRepository` promise can't schedule a fresh debounce timer
   * or fire the change emitter against a disposed service.
   *
   * Without this, a window reload that lands mid-reload leaks an untracked
   * timer via the `.finally(() => handleChange())` chain — `dispose()` clears
   * `_refreshTimers`/`_reloading`, but the still-pending in-flight promise
   * later resolves and re-enters `handleChange`, which schedules a new 250 ms
   * timer and ends up calling `git spawn` + `_onDidChangeRepository.fire()`
   * on objects whose `dispose()` has already run.
   */
  private _disposed = false;

  /**
   * Component-bound Logger emitted on construction, repository-discovery,
   * `reloadRepository` entry/exit, watcher teardown, watcher errors,
   * and transient `index.lock` retries. Routed uniformly through the
   * IntelliG OutputChannel via the structured Logger module so every
   * GitService waypoint is correlatable with the rest of the service
   * graph.
   */
  private readonly _logger: Logger;

  /**
   * Filesystem injection seam for {@link scanFolderForGitRepos}. Production
   * uses {@link defaultRepoScanFs}; unit tests overwrite this through the
   * `_repoScanFs` private to drive scans against an in-memory tree without
   * touching the disk.
   */
  private _repoScanFs: IRepoScanFs = defaultRepoScanFs;

  /**
   * Watchers that fire when a NEW `.git/` directory is created mid-session
   * (e.g. user runs `git init` in a workspace subfolder). Keyed by
   * workspace-folder path so we can dispose them when the folder is
   * removed.
   *
   * Distinct from `_fileWatchers` (per-repo `.git/HEAD`/index/refs/**
   * watchers) — those activate after a repo is discovered. These fire
   * BEFORE discovery so we can pick up brand-new repos.
   *
   * ** (#219) shape note:** stored as `Disposable[]` (single-element
   * arrays in practice) so this map fits the shared `_watcherMaps`
   * registry signature. The previous shape was `Map<string,
   * vscode.FileSystemWatcher>` (single value); the registry walker
   * iterates per-key and calls dispose on each entry, which the
   * single-element-array shape supports without bespoke handling.
   */
  private _newRepoWatchers: Map<string, vscode.FileSystemWatcher[]> = new Map();

  /**
   * ** (#219) — watcher families registry.**
   *
   * Each watcher family (per-repo `.git/<entry>` watchers, mid-session
   * `**\/.git` new-repo watchers, hypothetical future families like
   * submodule-init or worktree-add watchers) registers the Map that owns
   * its lifecycle here. `removeRepositoryWatcher(rootPath)` walks every
   * registered Map uniformly, disposing entries whose key is `rootPath`
   * itself OR a path-child of `rootPath` per the /
   * cleanup contract.
   *
   * Without the registry, every new family would silently leak unless the
   * contributor remembered to extend the cleanup loop. The registry
   * pattern makes "I added a new watcher family" → "register its map" the
   * single line of code needed for correct lifecycle.
   *
   * Order is non-significant; cleanup walks all maps regardless of
   * registration order. Initialized at constructor time so the references
   * `_fileWatchers` / `_newRepoWatchers` are stable.
   */
  private readonly _watcherMaps: Array<Map<string, vscode.Disposable[]>> = [];

  /** Cache TTL in milliseconds (5 seconds) */
  private static readonly CACHE_TTL = 5000;

  /**
   * Debounce window for coalescing watcher bursts before triggering a
   * repository refresh. 250 ms matches the VS Code built-in git extension's
   * debounce and is long enough to absorb the stream of `.git/index` /
   * `.git/refs/**` writes a single user-visible operation (commit, fetch,
   * checkout) produces while still feeling responsive.
   */
  private static readonly WATCHER_DEBOUNCE_MS = 250;

  /**
   * Narrow allow-list of `.git/` entries we react to. Ordered roughly by
   * hit frequency; each entry becomes its own `FileSystemWatcher` with a
   * `RelativePattern(gitDir, entry)` glob.
   *
   * Deliberately EXCLUDED:
   *  - `objects/**` — every git read/write touches this; watching it causes
   *    an infinite refresh loop.
   *  - `logs/**` — reflog updates fire on every command; no user-visible
   *    state the UI needs to re-render.
   *  - `FETCH_HEAD` — redundant with `onDidFetch` which fires when our own
   *    `fetch()` call completes.
   *  - `ORIG_HEAD` — a side-effect file written by reset/merge; the real
   *    branch change is captured by HEAD/refs/** which we already watch.
   *  - `config` — remote URL / user / alias edits are rare and editor-driven;
   *    deliberately not watched. Fresh values are picked up via the 5 s cache
   *    TTL on `_repositories` plus any explicit reload path.
   *  - `modules/**` — submodule state changes surface through the parent
   *    repo's `HEAD` / `index` updates; the inner `.git/modules/<name>/`
   *    tree is deliberately not watched. Relies on the 5 s cache TTL +
   *    explicit reload.
   *  - `worktrees/**` — linked-worktree metadata (`git worktree add/remove`)
   *    mutates here but the active worktree's state is already reflected
   *    through the other allow-listed entries. Deliberately not watched;
   *    relies on the 5 s cache TTL + explicit reload.
   */
  private static readonly WATCHED_GIT_PATTERNS: readonly string[] = [
    'HEAD',
    'index',
    'refs/**',
    'packed-refs',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
    'rebase-merge/**',
    'rebase-apply/**',
  ];

  /**
   * Event fired when a repository changes
   */
  readonly onDidChangeRepository: vscode.Event<IRepository>;

  /**
   * Event fired when a previously-discovered repository is removed from
   * tracking (workspace folder removed OR `.git/HEAD` deleted mid-session
   * per issue #213). Fires exactly once per repo per removal cause.
   */
  readonly onDidRemoveRepository: vscode.Event<IRepository>;

  /**
   * Event fired when a fetch completes (successful or not)
   */
  readonly onDidFetch: vscode.Event<{ repo: IRepository; result: IFetchResult }>;

  constructor(gitPath?: string) {
    this._gitCli = createGitCli(gitPath);
    this._onDidChangeRepository = new vscode.EventEmitter<IRepository>();
    this.onDidChangeRepository = this._onDidChangeRepository.event;
    this._onDidRemoveRepository = new vscode.EventEmitter<IRepository>();
    this.onDidRemoveRepository = this._onDidRemoveRepository.event;
    this._onDidFetch = new vscode.EventEmitter<{ repo: IRepository; result: IFetchResult }>();
    this.onDidFetch = this._onDidFetch.event;

    this._logger = getLogger().child({ component: 'GitService' });
    this._logger.info('GitService constructed', { gitPath });

    // Register the two known watcher families with the
    // shared cleanup registry. Future families add a single line here
    // and `removeRepositoryWatcher` automatically walks them.
    //
    // The structural guard
    // `scripts/check-watcher-families-registered.mjs` enforces that
    // EVERY field matching the watcher-family declaration shape
    // (`Map<string, vscode.Disposable[] | vscode.FileSystemWatcher[]>`)
    // is pushed onto `_watcherMaps` here. Adding a new family without
    // this line fails CI.
    this._watcherMaps.push(this._fileWatchers);
    this._watcherMaps.push(this._newRepoWatchers);

    // Shared read-through context handed to every *Ops collaborator. The
    // `ctx.gitCli` getter re-reads `this._gitCli` on EVERY call so the
    // test-time `(service as any)._gitCli = mock` swap (RULE G1) reaches the
    // collaborators; the cli is never captured at construction.
    const ctx: IGitOpsContext = createGitOpsContext(
      () => this._gitCli,
      (rootPath) => this.invalidateCache(rootPath),
      (payload) => this._onDidFetch.fire(payload)
    );
    this._staging = new StagingOps(ctx);
    this._diff = new DiffOps(ctx);
    this._cherryRevert = new CherryPickRevertOps(ctx);
    this._branches = new BranchOps(ctx);
    this._stashTagHistory = new StashTagHistoryOps(ctx);
    this._remoteOps = new RemoteOps(ctx);
    this._incomingOutgoing = new IncomingOutgoingOps(ctx);
    this._worktrees = new WorktreeOps(ctx);

    // Forward Git command events through the structured Logger. Debug
    // level so the firehose of every git invocation is filtered out by
    // default but available with `intellig.log.level = 'debug'`.
    this._disposables.push(
      this._gitCli.onCommandExecuted((event) => {
        this._logger.debug('git command executed', { args: event.args });
      })
    );

    // Set up workspace folder change listener
    this._disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        // Remove watchers for removed folders
        for (const folder of event.removed) {
          this.removeRepositoryWatcher(folder.uri.fsPath);
        }
        // Discover repositories in added folders. Bucket C:
        // discovery failures here are transient (`.git/**` mid-clone,
        // unmounted NFS, permission denied); downstream commands will
        // retry on next invocation. Surface to console so a broken
        // folder is debuggable without spamming the user.
        for (const folder of event.added) {
          safeFireAndForget(
            this.discoverRepository(folder.uri.fsPath),
            `GitService.onDidChangeWorkspaceFolders: discover added folder ${folder.uri.fsPath}`
          );
        }
      })
    );

    // Re-run discovery on all workspace folders when the
    // repository-scan-related settings change. Without this, the two settings
    // (`intellig.repositoryScanMaxDepth` + `intellig.repositoryScanIgnoredFolders`)
    // would only be read at workspace-folder-add time; mid-session edits would
    // have no effect until window reload, with no signal to the user.
    //
    // Idempotency: `discoverRepository` short-circuits via `_repositories.has(root)`
    // for repos already tracked, so a re-scan after a no-op config tweak does
    // not re-fire `onDidChangeRepository` for known repos. Newly-discovered
    // repos (e.g. after a depth increase) fire the emitter per repo per the
    // existing contract.
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          !event.affectsConfiguration('intellig.repositoryScanMaxDepth') &&
          !event.affectsConfiguration('intellig.repositoryScanIgnoredFolders')
        ) {
          return;
        }
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) {
          return;
        }
        for (const folder of folders) {
          safeFireAndForget(
            this.discoverRepository(folder.uri.fsPath),
            `GitService.onDidChangeConfiguration: rediscover ${folder.uri.fsPath}`
          );
        }
      })
    );

    // Initial repository discovery. Bucket C: same rationale as
    // above — startup race conditions (extension host activates before
    // the workspace is ready) are the usual failure mode, and the
    // workspace-folder listener above will pick up any late-arriving
    // folders.
    safeFireAndForget(
      this.discoverRepositories(),
      'GitService.constructor: initial repository discovery'
    );
  }

  /**
   * Get the Git CLI instance for direct access
   */
  get gitCli(): GitCli {
    return this._gitCli;
  }

  // ============================================
  // Repository Operations
  // ============================================

  /**
   * Get a repository for the given URI.
   *
   * @param uri - The URI to find a repository for
   * @returns The repository, or undefined if not found
   */
  async getRepository(uri: vscode.Uri): Promise<IRepository | undefined> {
    const filePath = uri.fsPath;

    // Check cache first (exact key — a repo ROOT path).
    const cached = this.getCachedRepository(filePath);
    if (cached) {
      return cached;
    }

    // Resolve a FILE (or any non-root path) to its owning repository by
    // ancestor-matching against already-known repositories — no subprocess.
    // This is the common case for file URIs (blame, line-status, merge view):
    // the exact-key cache above never matches a file path because it's keyed by
    // repo root, and the `git rev-parse` fallback below cannot take a file as
    // its cwd. Without this, `getRepository(fileUri)` returned `undefined` for
    // every file that wasn't itself a cached repo root.
    const owner = this.findOwningRepository(filePath);
    if (owner) {
      return owner;
    }

    // Try to find repository root. `git rev-parse --show-toplevel` must run with
    // a DIRECTORY cwd: `spawn` rejects a file cwd with ENOTDIR, which silently
    // turned file-path discovery into a no-op. Use the file's parent dir.
    //
    // The probe returns a Result: Ok(root) when found, Ok(undefined) when the
    // dir simply isn't a repo (expected absence → no repository), and Err on a
    // genuine system fault. A fault is LOGGED, not swallowed, so it can't again
    // masquerade as "no repository found".
    const rootPath = await this._gitCli.getRepositoryRoot(this.toDirectoryCwd(filePath)).match(
      (root) => root,
      (error) => {
        this._logger.error('getRepository: repository-root probe failed', { filePath }, error);
        return undefined;
      }
    );
    if (!rootPath) {
      return undefined;
    }

    // Check if we have this root cached
    const cachedRoot = this.getCachedRepository(rootPath);
    if (cachedRoot) {
      return cachedRoot;
    }

    // Coalesce concurrent discovery: if a load for this root is already in
    // flight, share it instead of launching another full probe. At activation
    // many subscribers (SCM, changelist, branch tree, status bar, blame, the
    // graph) call getRepository for the same repo at once; without this each
    // call spawned its own ~6-command load storm (symbolic-ref / rev-parse /
    // upstream / rev-list / status / remote), and N concurrent storms saturate
    // the CPU and starve the graph's `git log`. `_reloading` already tracks the
    // in-flight load — reuse it as the coalescing slot.
    const inFlight = this._reloading.get(rootPath);
    if (inFlight) {
      return inFlight;
    }

    // Load repository information.
    //
    // Enroll the load promise into `_reloading` so test infrastructure
    // (and any other in-flight-aware path) can drain pending repository
    // discovery before tearing down disk fixtures. Without this enrollment
    // the async tail of `loadRepository` (rev-parse / status / remote -v
    // git spawns) can race a synchronous `fs.rmSync(rootPath)` from a
    // test's afterEach and resurrect a stale `_repositories` cache entry
    // pointing at a deleted directory. See
    // `gitServiceDrainPendingReloads.test.ts`.
    return this._enrollReload(rootPath, this.loadRepository(rootPath));
  }

  /**
   * Get all discovered repositories — **identity/membership only**, NOT a
   * freshness guarantee.
   *
   * Unlike {@link getCachedRepository} / {@link findOwningRepository}, this does
   * NOT apply {@link GitService.CACHE_TTL}: a repo not touched for longer than
   * the TTL is returned with its last-loaded `head` / `state` / `remotes`. Use
   * this to enumerate which repositories are open (and their identities), and to
   * subscribe to changes via {@link onDidChangeRepository}. Watchers refresh
   * actively-used repos, so the snapshot is usually current — but a caller that
   * makes a DECISION off a returned `head` / ahead-behind / `state` /
   * `inProgress` (e.g. rendering ahead/behind, gating on `inProgress.kind`)
   * must re-`await getRepository(repo.rootUri)` (or `reloadRepository`) first to
   * read guaranteed-fresh state. The known hot caller — the push dialog —
   * already reloads after a push (`_openPushDialog` `onPushComplete`); the
   * rebase-paused warning's initial scan runs at activation when discovery has
   * just loaded fresh state.
   *
   * @returns Array of repositories (snapshot; see freshness note above)
   */
  getRepositories(): IRepository[] {
    return Array.from(this._repositories.values()).map((cache) => cache.repository);
  }

  /**
   * Synchronously invalidate + reload a repository's cache entry.
   *
   * Mirrors the internal {@link _performDebouncedRefresh} flow minus the
   * debounce + in-flight-guard scaffolding (callers `await` directly).
   * Same defensive pattern as `_performDebouncedRefresh`: log on failure
   * but don't re-throw, so caller `provider.refresh()` still runs and the
   * watcher's eventual reload picks up the change.
   */
  async reloadRepository(repo: IRepository): Promise<IRepository | undefined> {
    const rootPath = repo.rootUri.fsPath;
    this._logger.info('reloadRepository entry', { rootPath });
    this.invalidateCache(rootPath);
    try {
      // Enroll into `_reloading` so drain paths see this in-flight load.
      const fresh = await this._enrollReload(rootPath, this.loadRepository(rootPath));
      if (!this._disposed) {
        this._onDidChangeRepository.fire(fresh);
      }
      this._logger.info('reloadRepository exit', { rootPath, ok: true });
      return fresh;
    } catch (err) {
      this._logger.error(
        `GitService.reloadRepository: reload for ${rootPath} failed`,
        err instanceof Error ? err : undefined
      );
      this._logger.info('reloadRepository exit', { rootPath, ok: false });
      return undefined;
    }
  }

  /**
   * Discover repositories in the workspace.
   */
  private async discoverRepositories(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return;
    }

    for (const folder of workspaceFolders) {
      await this.discoverRepository(folder.uri.fsPath);
    }
  }

  /**
   * Discover a repository — or a set of nested repositories — at the given
   * path.
   *
   * (#204) — previously this only checked `path` itself for
   * `.git/`, which missed the common workspace-with-nested-repos shape
   * (e.g. opening `~/work/` with `~/work/projectA/.git` +
   * `~/work/projectB/.git`). Now it delegates to {@link scanFolderForGitRepos}
   * which honors the `intellig.repositoryScanMaxDepth` (default 1) +
   * `intellig.repositoryScanIgnoredFolders` settings, mirroring VS Code's
   * built-in git extension.
   *
   * Also installs a mid-session new-repo watcher (see
   * {@link setupNewRepoWatcher}) so subsequent `git init`s in subfolders
   * are picked up automatically.
   *
   * @param folderPath - Workspace folder root to scan (not necessarily a
   *   repo root itself; nested repos within will be discovered subject to
   *   `intellig.repositoryScanMaxDepth`).
   */
  private async discoverRepository(rawFolderPath: string): Promise<void> {
    // Normalize before using as a `_newRepoWatchers` map key. On
    // Windows, VS Code's `Uri.fsPath` has known drive-letter case
    // inconsistency across versions (`c:\work` vs `C:\work`); without
    // normalization the watcher-dedup short-circuit (`_newRepoWatchers
    // .has(folderPath)`) misses the duplicate and stacks watchers.
    // `path.normalize` is platform-aware and cheap; on macOS/Linux it's
    // an idempotent no-op for already-canonical paths.
    const folderPath = path.normalize(rawFolderPath);
    const config = vscode.workspace.getConfiguration('intellig');
    const maxDepth = config.get<number>('repositoryScanMaxDepth', 1);
    const ignoredFolders = config.get<string[]>('repositoryScanIgnoredFolders', []);

    const repoRoots = await scanFolderForGitRepos(folderPath, {
      maxDepth,
      ignoredFolders,
      fs: this._repoScanFs,
      resolveRepoRoot: (p): Promise<string | undefined> =>
        this._gitCli.getRepositoryRoot(p).match(
          (root) => root,
          (error) => {
            // A system fault while probing one candidate dir must not abort the
            // scan — log it and treat this dir as "no repo here", letting the
            // scan continue to siblings instead of swallowing silently.
            this._logger.error(
              'discoverRepository: repository-root probe failed',
              { path: p },
              error
            );
            return undefined;
          }
        ),
    });

    for (const root of repoRoots) {
      if (!this._repositories.has(root)) {
        // Enroll into `_reloading` so drain paths see this in-flight load.
        // `loadRepository` installs the watcher + fires `onDidChangeRepository`
        // on first insertion (see its first-insertion funnel) — so the 6
        // event-driven subscribers (BranchTreeProvider, StatusBarService,
        // BranchPopup, ChangelistService, ConflictResolutionService,
        // GitToolWindowProvider) see the freshly-discovered repo even for an
        // empty `git init` with no internal `.git/` writes to trigger a refresh.
        await this._enrollReload(root, this.loadRepository(root));
      }
    }

    // Install the mid-session new-repo watcher AFTER initial discovery so
    // `discoverRepository` is idempotent — re-discovery (e.g. config change)
    // doesn't stack watchers.
    this.setupNewRepoWatcher(folderPath);
  }

  /**
   * Install a `FileSystemWatcher` for `**\/.git` directory creations under
   * a workspace folder. Fires when the user runs `git init` in a subfolder
   * mid-session so IntelliG picks up the new repo without a window reload.
   *
   * **Submodule auto-load behavior:**
   * The `**\/.git` glob fires on EVERY `.git/` directory created under the
   * watched folder, including `.git/` directories that belong to submodules
   * (or, more rarely, nested non-submodule sibling repos). When a
   * submodule's `.git/` is created during a clone or submodule update, this
   * watcher will report it and `discoverRepository` will register the
   * submodule's working directory as a separate top-level repo in
   * `getRepositories()`. This is intentional and matches VS Code's built-in
   * git extension policy — IntelliG users opening a project with submodules
   * see each submodule as an addressable repo in the multi-repo picker.
   * The ignored-folder filter (`INTERNAL_IGNORED_FOLDERS ∪ user-config`)
   * still prevents auto-loading of `node_modules/<pkg>/.git` style
   * npm-packaged repos.
   *
   * **Why this is safe vs. the infinite-loop guards:**
   *   - Listens to creation events ONLY (`ignoreChangeEvents: true`,
   * `ignoreDeleteEvents: true`). The loop was caused by
   *     `**\/*` watching every modify of `.git/objects/**`; we don't watch
   *     modifies and we restrict to `.git` basename.
   *   - The handler re-runs `discoverRepository` on the parent dir, which
   *     dedupes via `_repositories.has(root)` — so a clone that creates a
   *     `.git/` won't kick off a second `loadRepository` for the same root.
   *   - `_disposed` is checked before any work.
   *   - Ignored-folder filter (basename match against
   *     `INTERNAL_IGNORED_FOLDERS ∪ user-config`) prevents auto-loading
   *     `node_modules/<pkg>/.git` style npm-packaged repos.
   *
   * @param folderPath - Workspace folder to watch.
   */
  private setupNewRepoWatcher(folderPath: string): void {
    if (this._newRepoWatchers.has(folderPath) || this._disposed) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(folderPath), '**/.git'),
      false /* ignoreCreateEvents */,
      true /* ignoreChangeEvents */,
      true /* ignoreDeleteEvents */
    );
    watcher.onDidCreate((uri) => {
      if (this._disposed) {
        return;
      }
      // The URI is the `.git` directory itself; the repo root is its parent.
      const repoParentDir = repoRootFromGitDir(uri.fsPath);
      if (repoParentDir === undefined) {
        return;
      }

      // Filter against ignored folders. Re-read config in case it changed
      // since `discoverRepository` ran. The path-topology filter (outside-
      // folder defense + ancestor-segment ignore match) lives in the
      // stateless RepositoryDiscovery helper.
      const config = vscode.workspace.getConfiguration('intellig');
      const userIgnored = config.get<string[]>('repositoryScanIgnoredFolders', []);
      if (isNewRepoPathIgnored(folderPath, repoParentDir, userIgnored)) {
        return;
      }

      if (this._repositories.has(repoParentDir)) {
        return;
      }
      // Dispatch through the same discovery entry point so the new repo
      // gets a `.git/` watcher installed (guards apply) and the
      // change-emitter fires. Bucket C: discovery failures here are the
      // same flavor as the constructor path (mid-init races, permission
      // denied), so we route through `safeFireAndForget` with the shared
      // OutputChannel.
      safeFireAndForget(
        this.discoverRepository(repoParentDir),
        `GitService.setupNewRepoWatcher: discover new repo at ${repoParentDir}`
      );
    });

    // Single-element-array shape so the map fits the shared
    // `_watcherMaps` registry walker uniformly with `_fileWatchers`.
    this._newRepoWatchers.set(folderPath, [watcher]);
  }

  /**
   * Load repository information from Git.
   *
   * @param rootPath - The repository root path
   * @returns The repository
   */
  private async loadRepository(rootPath: string): Promise<IRepository> {
    const options: IGitCommandOptions = { cwd: rootPath };
    // Snapshot the removal counter at entry; if the root is torn down while
    // this load is in flight, the post-await guard below skips the cache-write
    // + announce so a removed root isn't resurrected.
    const removalGenAtEntry = this._removalGeneration.get(rootPath) ?? 0;

    // Get HEAD information.
    //
    // Split the symbolic-ref / rev-parse paths so an empty repo
    // (`symbolic-ref` succeeds with `refs/heads/<initial>`, `rev-parse HEAD`
    // fails because no commit exists yet) still surfaces the initial
    // branch name as `(no commits yet)`.
    //
    // Distinguish empty-repo from corrupt-HEAD via the rev-parse stderr:
    //   - Empty repo: stderr contains `fatal: ambiguous argument 'HEAD'`
    //     or `fatal: bad default revision`. Surface the symbolic branch
    //     with empty commit.
    //   - Corrupt HEAD / FS error / packed-refs mismatch: stderr does NOT
    //     match the empty-repo signature. Leave head undefined so the UI
    //     falls back to its indeterminate-state treatment instead of
    //     promising the user a phantom "first commit will land here".
    let head;
    let branchResult;
    try {
      branchResult = await this._gitCli.exec(['symbolic-ref', 'HEAD'], options);
    } catch {
      // symbolic-ref itself fails on detached HEAD (typically exit 128).
      branchResult = undefined;
    }
    let commitResult;
    try {
      commitResult = await this._gitCli.exec(['rev-parse', 'HEAD'], options);
    } catch {
      // rev-parse HEAD fails on empty repos and (rarely) on corrupted
      // refs. Recovery is gated below by the empty-repo stderr check.
      commitResult = undefined;
    }

    const branchSucceeded = branchResult?.exitCode === 0;
    const commitSucceeded = commitResult?.exitCode === 0;
    const isEmptyRepoSignature =
      branchSucceeded && !commitSucceeded && isEmptyRepoStderr(commitResult?.stderr);

    if (commitSucceeded || isEmptyRepoSignature) {
      let upstreamResult;
      let aheadBehindResult;
      try {
        upstreamResult = await this._gitCli.exec(
          ['rev-parse', '--abbrev-ref', '@{upstream}'],
          options
        );
        if (upstreamResult.exitCode === 0) {
          aheadBehindResult = await this._gitCli.exec(
            ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
            options
          );
        }
      } catch (error) {
        // `options` has no `throwOnError`, so a non-zero "no tracking branch"
        // exit is handled by the exitCode guard above — this catch only fires
        // on a genuine spawn/system fault, which we degrade to "no upstream".
        // Log so that swallowed fault stays visible.
        this._logger.debug('loadRepository: upstream resolution failed', {
          rootPath,
          err: error instanceof Error ? error.message : String(error),
        });
      }

      head = parseHead(
        branchSucceeded && branchResult ? branchResult.stdout : '',
        commitSucceeded && commitResult ? commitResult.stdout : '',
        upstreamResult?.exitCode === 0 ? upstreamResult.stdout : undefined,
        aheadBehindResult?.exitCode === 0 ? aheadBehindResult.stdout : undefined
      );
    }
    // When BOTH probes fail OR rev-parse fails with a non-empty-repo
    // stderr, leave head undefined.

    // Repository operation state comes from the on-disk in-progress markers
    // (`MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` / `rebase-merge|
    // rebase-apply/`), which are also the source of the StatusBar verb-form
    // label ("Rebasing onto main", "Cherry-picking abc1234"). The markers are
    // authoritative and complete for every operation the conflict UI handles:
    // merge/rebase/cherry-pick/revert each leave a marker, while unstash /
    // unshelve / apply-patch leave NONE and are correctly `idle` (their recorded
    // operation drives ours/theirs reversal). We deliberately do NOT parse `git
    // status` prose for state: it is localized (a non-English locale hides the
    // header phrases, misdetecting a conflict as idle and flipping the accepted
    // side), it substring-collides with conflicted file paths, and it would be a
    // redundant subprocess on the graph-load critical path. Marker file NAMES
    // are neither localized nor ambiguous. Cherry-pick + revert markers carry a
    // 40-char SHA abbreviated via `git rev-parse --short` (one git invocation,
    // only when such a marker exists). `resolveGitDir` handles the linked-
    // worktree / submodule `.git`-file pointer.
    let inProgress;
    try {
      const gitDir = await resolveGitDir(rootPath);
      inProgress = await readInProgressOperation(gitDir, async (sha) => {
        const result = await this._gitCli.exec(
          buildGitArgs('rev-parse', ['--short'], [sha]),
          options
        );
        return result.exitCode === 0 ? result.stdout.trim() : sha.substring(0, 7);
      });
    } catch (error) {
      // A marker-read failure leaves state at the 'idle' default; log so the
      // swallowed read failure stays visible rather than masking a real state.
      this._logger.debug('loadRepository: in-progress marker read failed', {
        rootPath,
        err: error instanceof Error ? error.message : String(error),
      });
    }

    // `inProgress.kind` (`merging`/`rebasing`/`cherry-picking`/`reverting`) IS
    // the non-idle RepositoryState; no marker ⇒ idle.
    const state: RepositoryState = inProgress?.kind ?? 'idle';

    // Get remotes
    let remotes: IRemote[] = [];
    try {
      const remotesResult = await this._gitCli.exec(['remote', '-v'], options);
      if (remotesResult.exitCode === 0) {
        remotes = parseRemotes(remotesResult.stdout);
      }
    } catch (error) {
      // A remotes-read failure leaves `remotes` empty; log so the swallowed
      // error is visible rather than silently masking a real failure.
      this._logger.debug('loadRepository: remotes read failed', {
        rootPath,
        err: error instanceof Error ? error.message : String(error),
      });
    }

    const repository: IRepository = {
      rootUri: vscode.Uri.file(rootPath),
      state,
      head,
      remotes,
      ...(inProgress ? { inProgress } : {}),
    };

    // First-insertion funnel: a root reached for the FIRST time — by EITHER the
    // workspace scan (`discoverRepository`) or a lazy `getRepository(fileUri)` —
    // must become a first-class repo: install its `.git/` watcher so it
    // live-refreshes, and fire `onDidChangeRepository` so the SCM provider,
    // branch tree, status bar, etc. learn it exists. Routing this here keeps the
    // two discovery paths from diverging (a lazy repo used to be cached but
    // silently unwatched + unannounced).
    //
    // `_fileWatchers.has` is the insertion signal that survives
    // `invalidateCache`: a reload (`reloadRepository` / `_performDebouncedRefresh`)
    // deletes the cache entry but keeps the watcher, so a reload is NOT a first
    // insertion and those paths still own their single post-reload fire.
    // Zombie guard: if this root was disposed/removed while the load ran (the
    // service tore down, or a folder was removed before discovery resolved), do
    // NOT resurrect it — skip the cache-write, watcher install, and announce.
    // Returning the parsed snapshot still satisfies the in-flight caller; it
    // just never re-enters `_repositories`.
    if (this._disposed || (this._removalGeneration.get(rootPath) ?? 0) !== removalGenAtEntry) {
      return repository;
    }

    const isFirstInsertion = !this._fileWatchers.has(rootPath);

    // Cache the repository
    this._repositories.set(rootPath, {
      repository,
      lastUpdated: Date.now(),
    });

    if (isFirstInsertion) {
      this.setupRepositoryWatcher(rootPath);
      this._logger.info('repository discovered', { rootPath });
      this._onDidChangeRepository.fire(repository);
    }

    return repository;
  }

  /**
   * Get a cached repository if still valid.
   *
   * @param path - The path to check
   * @returns The cached repository, or undefined
   */
  private getCachedRepository(path: string): IRepository | undefined {
    const cached = this._repositories.get(path);
    if (cached && Date.now() - cached.lastUpdated < GitService.CACHE_TTL) {
      return cached.repository;
    }
    return undefined;
  }

  /**
   * Resolve a path to the open repository that owns it via deepest-ancestor
   * match, comparing canonicalized (realpath'd) paths so a symlinked path
   * (macOS `/var` → `/private/var`) still matches a root git reported as a
   * realpath. Pure (no subprocess); mirrors `findRepoContainingPath` /
   * `resolveBlameRepo`. Returns `undefined` when no FRESH open repo is an
   * ancestor.
   *
   * Only entries within {@link GitService.CACHE_TTL} are considered: a stale
   * entry must not short-circuit here, otherwise the ancestor match would
   * bypass the freshness backstop `getCachedRepository` enforces and make the
   * TTL effectively infinite for any in-workspace path. A stale owner falls
   * through to the rev-parse + reload path, which refreshes it.
   */
  private findOwningRepository(filePath: string): IRepository | undefined {
    const target = canonicalizeFsPath(filePath);
    let best: IRepository | undefined;
    let bestLen = -1;
    for (const [, cache] of this._repositories) {
      if (Date.now() - cache.lastUpdated >= GitService.CACHE_TTL) {
        continue;
      }
      const root = canonicalizeFsPath(cache.repository.rootUri.fsPath);
      if (target === root || target.startsWith(root + path.sep)) {
        if (root.length > bestLen) {
          best = cache.repository;
          bestLen = root.length;
        }
      }
    }
    return best;
  }

  /**
   * Coerce a path into a directory usable as a git `cwd`. `git rev-parse` with
   * `cwd` set to a regular file fails with ENOTDIR (verified), so an existing
   * file is mapped to its parent directory. Existing directories and
   * non-existent paths pass through unchanged (the latter preserves prior
   * rev-parse-fails-gracefully behavior).
   */
  private toDirectoryCwd(p: string): string {
    try {
      if (fs.statSync(p).isDirectory()) {
        return p;
      }
      return path.dirname(p);
    } catch {
      return p;
    }
  }

  /**
   * Invalidate the cache for a repository.
   *
   * @param rootPath - The repository root path
   */
  private invalidateCache(rootPath: string): void {
    this._repositories.delete(rootPath);
  }

  /**
   * Set up file watchers for repository changes.
   *
   * This installs one `FileSystemWatcher` per entry in
   * {@link GitService.WATCHED_GIT_PATTERNS}. All watchers feed into a
   * single debounced handler that:
   *   1. Coalesces bursts (typical: a user commit writes `index`, `HEAD`,
   *      and several `refs/**` entries back-to-back) into one refresh.
   *   2. Guards against self-triggered reloads — if a `loadRepository`
   *      call is still in flight when the debounce fires, we wait for
   *      that call before re-debouncing. This prevents the refresh loop
   *      where the reload's own git subprocesses cause more watcher
   *      events that fire while the reload is still running.
   *
   * @param rootPath - The repository root path
   */
  private setupRepositoryWatcher(rootPath: string): void {
    if (this._fileWatchers.has(rootPath)) {
      return;
    }

    // Root the watchers at the per-worktree git directory. For a normal
    // checkout this is `<root>/.git` (a directory); for a LINKED WORKTREE or
    // submodule `<root>/.git` is a FILE holding a `gitdir:` pointer — globbing
    // it directly would match nothing (no live refresh) and `handleHeadDelete`'s
    // readdir would throw on a file. `resolveWorktreeGitDir` follows the pointer.
    const gitDir = vscode.Uri.file(resolveWorktreeGitDir(rootPath));

    const handleChange = (): void => {
      // First-line dispose gate: chained re-entries from `.finally()` below
      // or late-arriving watcher events must become no-ops once dispose()
      // has latched.
      if (this._disposed) {
        return;
      }
      const existing = this._refreshTimers.get(rootPath);
      if (existing) {
        clearTimeout(existing);
      }
      const timer = setTimeout(() => {
        // Same gate inside the timer callback — dispose() may have landed
        // between scheduling and firing.
        if (this._disposed) {
          return;
        }
        this._refreshTimers.delete(rootPath);
        // If a reload is already in flight, chain onto it and re-debounce
        // the trailing-edge event. This is the in-flight guard that breaks
        // the self-triggered refresh loop: we never start a second reload
        // while the first is still running. The `_disposed` check inside
        // handleChange() ensures the chained re-entry is a no-op if
        // dispose() runs while the in-flight reload is still pending.
        const inFlight = this._reloading.get(rootPath);
        if (inFlight) {
          void inFlight.finally(() => {
            if (!this._disposed) {
              handleChange();
            }
          });
          return;
        }
        // Bucket C: `_performDebouncedRefresh` already catches its
        // own errors internally (see the try/catch that logs via
        // `this._logger.error` around `loadRepository`), but we still route
        // the outer call through safeFireAndForget so a future unhandled-
        // rejection path doesn't regress silently.
        safeFireAndForget(
          this._performDebouncedRefresh(rootPath),
          `GitService.setupRepositoryWatcher: debounced refresh for ${rootPath}`
        );
      }, GitService.WATCHER_DEBOUNCE_MS);
      this._refreshTimers.set(rootPath, timer);
    };

    // A deletion of `.git/HEAD` is the strongest signal that
    // the repo was destroyed (`rm -rf .git`, an aggressive `git worktree
    // remove`, etc.). HEAD is required for any working repo, so its
    // disappearance is unambiguous. We treat it specially: instead of the
    // debounced refresh path (which would swallow the consequent
    // `git symbolic-ref` failures and leave a stale entry), we route to
    // `removeRepositoryWatcher(rootPath)` and fire the new
    // `onDidRemoveRepository` event so subscribers can drop the repo.
    //
    // Other entries in WATCHED_GIT_PATTERNS still go to `handleChange` for
    // delete events because they're transient by design (e.g. `MERGE_HEAD`
    // disappears when a merge resolves; `index` may briefly be deleted by
    // `git reset --hard` and then recreated). HEAD is the one with no
    // legitimate "transient delete" interpretation.
    const handleHeadDelete = (): void => {
      if (this._disposed) {
        return;
      }
      // Idempotency: `_repositories.has(rootPath)` short-circuits a duplicated
      // delete event (and the second of a delete/workspace-removal pair).
      if (!this._repositories.has(rootPath)) {
        return;
      }
      // A HEAD delete event is NOT always a real repo deletion. Git updates a
      // ref by writing `HEAD.lock` and renaming it over `HEAD`, and some file
      // watchers (notably macOS FSEvents) surface that rename as delete+create.
      // Evicting on every HEAD delete dropped LIVE repos from the Map when an
      // unrelated tool ran git ops in them — they vanished from the tool window
      // and "All Repositories" couldn't bring them back until a window reload.
      // So verify `.git/HEAD` is actually gone before evicting; if it is still
      // there the delete was transient and we just refresh the repo instead.
      // `removeRepositoryWatcher` fires `onDidRemoveRepository` internally (the
      // shared cleanup path for both HEAD deletion AND workspace-folder removal).
      safeFireAndForget(
        (async (): Promise<void> => {
          let headExists: boolean;
          try {
            const entries = await this._repoScanFs.readdir(gitDir.fsPath, {
              withFileTypes: true,
            });
            headExists = entries.some((entry) => entry.name === 'HEAD');
          } catch {
            // `.git` unreadable/gone → genuine deletion.
            headExists = false;
          }
          if (this._disposed || !this._repositories.has(rootPath)) {
            return;
          }
          if (headExists) {
            handleChange();
            return;
          }
          this.removeRepositoryWatcher(rootPath);
        })(),
        `GitService.setupRepositoryWatcher: confirm HEAD deletion for ${rootPath}`
      );
    };

    // Per-root watchers live in `_fileWatchers` which is the sole lifecycle
    // owner — `removeRepositoryWatcher` disposes and removes from that map,
    // and `dispose()` walks the same map. Watchers must NOT ALSO be pushed
    // into `_disposables`: that leaves a dangling entry after a
    // workspace-folder removal which accumulates across the session
    // (Disposable.dispose() is idempotent, so it's not user-visible). Only the
    // _onDidChangeRepository emitter and other process-lifetime disposables
    // belong in `_disposables`.
    const watchers: vscode.FileSystemWatcher[] = [];
    for (const pattern of GitService.WATCHED_GIT_PATTERNS) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(gitDir, pattern)
      );
      watcher.onDidChange(handleChange);
      watcher.onDidCreate(handleChange);
      // Only the HEAD watcher routes deletes to handleHeadDelete;
      // all other patterns continue to go through the debounced refresh
      // path (whose `_performDebouncedRefresh` already tolerates transient
      // delete-then-recreate sequences via the cache invalidation +
      // reload chain).
      if (pattern === 'HEAD') {
        watcher.onDidDelete(handleHeadDelete);
      } else {
        watcher.onDidDelete(handleChange);
      }
      watchers.push(watcher);
    }

    this._fileWatchers.set(rootPath, watchers);
  }

  /**
   * Execute the debounced refresh: invalidate cache, reload, fire the
   * repository-change event. Records the in-flight promise so concurrent
   * watcher bursts can chain onto it rather than stacking.
   *
   * Errors are swallowed (logged to stderr) — a transient git failure
   * must not crash the watcher callback chain, or we'd silently stop
   * reacting to future file changes.
   */
  private async _performDebouncedRefresh(rootPath: string): Promise<void> {
    // Re-check the dispose latch at the start of the async tail — the timer
    // callback that scheduled us may have won the race against dispose().
    if (this._disposed) {
      return;
    }
    this.invalidateCache(rootPath);
    // Enroll the reload promise into `_reloading` via the shared
    // `_enrollReload` helper so every in-flight load registers uniformly.
    // The watcher's in-flight guard at `setupRepositoryWatcher` and the
    // test-only `_drainPendingReloads()` path both rely on this entry.
    // Resolve inside try/catch so the emitter fires *outside* the catch
    // block: otherwise a subscriber throwing synchronously gets re-wrapped
    // as a "repository reload failed" error, which hides the real bug
    // location.
    let repo: IRepository | undefined;
    try {
      repo = await this._enrollReload(rootPath, this.loadRepository(rootPath));
    } catch (err) {
      // Watcher-driven refresh failure: warn rather
      // than error because the next watcher event will retry and the
      // failure is typically transient (mid-clone, momentary lock
      // contention, etc.).
      const errMessage = err instanceof Error ? err.message : String(err);
      this._logger.warn('watcher-driven repository reload failed', {
        rootPath,
        errorMessage: errMessage,
      });
    }
    if (repo && !this._disposed) {
      this._onDidChangeRepository.fire(repo);
    }
  }

  /**
   * Enroll an in-flight `loadRepository` promise into `_reloading` so the
   * watcher's in-flight guard and the test-only `_drainPendingReloads()`
   * path both observe it.
   *
   * Idempotency: if multiple call sites race to load the same `rootPath`
   * concurrently, the LAST writer wins the `_reloading` slot. Both promises
   * still resolve correctly because the helper returns the SAME promise it
   * was handed; the map entry is purely a tracking signal, not a coalescing
   * mechanism.
   *
   * The entry is cleared in `.finally()` so failures still release the
   * tracking slot. We do NOT re-throw or transform the rejection — the
   * caller's surrounding logic owns the error handling.
   *
   * @internal — called by every load path (`getRepository`,
   * `discoverRepository`, `reloadRepository`, `_performDebouncedRefresh`).
   */
  private _enrollReload(rootPath: string, p: Promise<IRepository>): Promise<IRepository> {
    this._reloading.set(rootPath, p);
    void p.finally(() => {
      // Only clear if our entry is still the live one — a later writer may
      // have replaced us. Without this guard, a long-running first load
      // racing a quick second load would clear the second's entry early.
      if (this._reloading.get(rootPath) === p) {
        this._reloading.delete(rootPath);
      }
    });
    return p;
  }

  /**
   * Drain all in-flight `loadRepository` promises. Resolves once every
   * tracked load has settled (success or failure).
   *
   * @internal — test-only seam. Called from
   * `src/test/e2e/support/workspaceHelper.ts` to flush pending repository
   * discovery before a test's `afterEach` runs `fs.rmSync(fixture-dir)`.
   * Without this drain, the async tail of `loadRepository` (rev-parse /
   * status / remote -v) races the directory removal, yields ENOENT errors
   * that `loadRepository` swallows in its per-call try/catches, and then
   * `loadRepository`'s final unconditional `_repositories.set(rootPath, ...)`
   * resurrects a stale cache entry pointing at the deleted path. The next
   * test sees that stale entry through `_resolveRepo` and surfaces a
   * "working directory missing" error against a path it never touched.
   *
   * Production code does NOT call this method — production teardown
   * goes through `dispose()` which simply clears `_reloading` along with
   * everything else.
   */
  async _drainPendingReloads(): Promise<void> {
    await Promise.allSettled([...this._reloading.values()]);
  }

  /**
   * Remove a repository watcher.
   *
   * @param rootPath - The repository root path
   */
  private removeRepositoryWatcher(rootPath: string): void {
    // (lifecycle leak): the workspace
    // folder path was always identical to the repo root path, so a single
    // exact-match cleanup sufficed. With nested-repo
    // discovery, opening `~/work/` may register `~/work/projectA` and
    // `~/work/projectB` as separate repos — so when the user removes
    // `~/work` from the workspace mid-session, we must dispose every
    // watcher / cache entry whose key is `~/work` itself OR a path-child
    // of `~/work`. Otherwise the orphans live on, spawn `git status`
    // against an unmounted/deleted folder, and degrade the post-activate
    // idle invariant.
    //
    // Use `path.relative` rather than string `startsWith(rootPath + sep)`
    // so we correctly distinguish `/work/projectA` (path-child of /work)
    // from `/workspace/other` (sibling that shares only a string prefix).
    // The pure path-child predicate lives in the stateless
    // RepositoryDiscovery helper.
    const isInsideOrEqual = (candidate: string): boolean =>
      isPathInsideOrEqual(rootPath, candidate);

    // Walk EVERY registered watcher-family map uniformly. Walking the
    // `_watcherMaps` registry (rather than hardcoding `_fileWatchers` and a
    // separate `_newRepoWatchers.get(rootPath)` exact-match cleanup) makes
    // "register the new map" the single touchpoint for correct lifecycle, so
    // a new watcher family can't silently leak.
    //
    // Per-map cleanup applies the path-child rule (key === rootPath OR
    // path.relative descendant) so removing `/work` correctly disposes
    // `/work/projectA` + `/work/projectB` watchers across ALL maps,
    // not just `_fileWatchers`. Sibling-prefix names like `/workspace`
    // stay untouched.
    for (const map of this._watcherMaps) {
      const keysToRemove: string[] = [];
      for (const key of map.keys()) {
        if (isInsideOrEqual(key)) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        const disposables = map.get(key);
        if (disposables) {
          for (const d of disposables) {
            d.dispose();
          }
          map.delete(key);
        }
      }
    }

    // Refresh-timer + in-flight-reload cleanup remains keyed off the same
    // path-child rule but lives outside `_watcherMaps` because it's not a
    // watcher family — it's the per-repo state that the watcher feeds.
    const stateKeysToRemove: string[] = [];
    for (const key of this._refreshTimers.keys()) {
      if (isInsideOrEqual(key)) {
        stateKeysToRemove.push(key);
      }
    }
    for (const key of this._reloading.keys()) {
      if (isInsideOrEqual(key) && !stateKeysToRemove.includes(key)) {
        stateKeysToRemove.push(key);
      }
    }
    for (const key of stateKeysToRemove) {
      const timer = this._refreshTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        this._refreshTimers.delete(key);
      }
      this._reloading.delete(key);
      // Bump the removal counter so an in-flight `loadRepository` (tracked in
      // `_reloading`) that resolves AFTER this teardown sees the change and
      // skips its cache-write/announce instead of resurrecting the root.
      this._removalGeneration.set(key, (this._removalGeneration.get(key) ?? 0) + 1);
    }

    // Fire `onDidRemoveRepository` for EVERY
    // matched repo BEFORE deleting from `_repositories`. The JSDoc contract
    // promises both removal causes (workspace-folder removal AND `.git/HEAD`
    // deletion) trigger the event. Subscribers (BranchTreeProvider,
    // StatusBarService, BranchPopup, ChangelistService,
    // ConflictResolutionService, GitToolWindowProvider) need this on the
    // COMMON folder-removal path, not just the EXOTIC `rm -rf .git` path.
    //
    // Capture the IRepository handles BEFORE delete so subscribers receive
    // valid objects (post-delete the cache is gone). Idempotency: if the
    // same call arrives twice (e.g. `handleHeadDelete` → workspace-folder-
    // removal listener firing in close succession), the second call's
    // `repoKeysToRemove` will be empty because the first call already
    // emptied `_repositories` for the matching keys.
    const repoKeysToRemove: string[] = [];
    const reposToFire: IRepository[] = [];
    for (const key of this._repositories.keys()) {
      if (isInsideOrEqual(key)) {
        repoKeysToRemove.push(key);
        const cache = this._repositories.get(key);
        if (cache) {
          reposToFire.push(cache.repository);
        }
      }
    }
    for (const key of repoKeysToRemove) {
      this._repositories.delete(key);
      // Cover a cached root with no in-flight reload entry (not in
      // stateKeysToRemove): still bump so any later load can't resurrect it.
      this._removalGeneration.set(key, (this._removalGeneration.get(key) ?? 0) + 1);
    }
    if (!this._disposed) {
      for (const repo of reposToFire) {
        this._onDidRemoveRepository.fire(repo);
      }
    }
  }

  // ============================================
  // Commit Operations
  // ============================================

  /**
   * Commit staged changes to the repository.
   *
   * @param repo - The repository to commit to
   * @param message - The commit message
   * @param options - Commit options (amend, signOff, noVerify, allowEmpty)
   * @throws Error if commit message is empty (unless amending or allowEmpty is true)
   */
  commit(
    repo: IRepository,
    message: string,
    options: ICommitOptions = {}
  ): ResultAsync<void, GitError> {
    return this._remoteOps.commit(repo, message, options);
  }

  amend(repo: IRepository, message: string): ResultAsync<void, GitError> {
    return this._remoteOps.amend(repo, message);
  }

  /**
   * Commit the currently-staged changes as a `fixup!`/`squash!` of the
   * selected commit — IntelliJ git4idea's Fixup… / Squash Into….
   */
  commitFixup(
    repo: IRepository,
    targetHash: string,
    mode: 'fixup' | 'squash'
  ): ResultAsync<ICommitFixupResult, GitError> {
    return this._remoteOps.commitFixup(repo, targetHash, mode);
  }

  // ============================================
  // Branch Operations
  // ============================================

  getBranches(repo: IRepository): Promise<IBranch[]> {
    // Absorbs the ops Result: the branch list tolerates absence with no failure
    // toast, so a system fault is LOGGED (not swallowed) and degraded to [].
    return this._branches.getBranches(repo).match(
      (branches) => branches,
      (error) => {
        this._logger.error('getBranches failed', { rootPath: repo.rootUri.fsPath }, error);
        return [];
      }
    );
  }

  getContainingBranches(repo: IRepository, hash: string): Promise<string[]> {
    // Absorbs the ops Result: the containing-branch list tolerates absence with
    // no failure toast (git4idea swallow contract), so a system fault is LOGGED
    // (not swallowed) and degraded to [].
    return this._branches.getContainingBranches(repo, hash).match(
      (branches) => branches,
      (error) => {
        this._logger.error(
          'getContainingBranches failed',
          { rootPath: repo.rootUri.fsPath, hash },
          error
        );
        return [];
      }
    );
  }

  /**
   * Distinct commit authors across all refs, in descending commit-count
   * order, formatted as `"Name <email>"`. Powers the ref-aware author
   * datalist in the log filter bar. Capped at 500 entries.
   */
  async getLogContributors(repo: IRepository): Promise<string[]> {
    const options: IGitCommandOptions = { cwd: repo.rootUri.fsPath };
    const result = await this._gitCli.exec(['shortlog', '-sne', '--all', 'HEAD'], options);
    const seen = new Set<string>();
    for (const line of result.stdout.split('\n')) {
      // shortlog -sne lines: `<count>\t<Name> <email>`.
      const tab = line.indexOf('\t');
      if (tab === -1) {
        continue;
      }
      const contributor = line.slice(tab + 1).trim();
      if (contributor) {
        seen.add(contributor);
      }
      if (seen.size >= 500) {
        break;
      }
    }
    return [...seen];
  }

  createBranch(
    repo: IRepository,
    name: string,
    startPointOrOptions?: string | ICreateBranchOptions
  ): ResultAsync<void, GitError> {
    // FORWARD: the UI caller `.match`es and surfaces a sanitized toast on a
    // validation reject or git failure.
    return this._branches.createBranch(repo, name, startPointOrOptions);
  }

  checkout(
    repo: IRepository,
    ref: string,
    options?: ICheckoutOptions
  ): ResultAsync<void, GitError> {
    // FORWARD: the UI caller `.match`es and surfaces a sanitized toast; a
    // conflict-bearing CommandFailedError still carries `result.combined` for
    // callers that classify checkout conflict output.
    return this._branches.checkout(repo, ref, options);
  }

  deleteBranch(repo: IRepository, name: string, force?: boolean): ResultAsync<void, GitError> {
    // FORWARD: the UI caller `.match`es and surfaces a sanitized toast.
    return this._branches.deleteBranch(repo, name, force);
  }

  /**
   * `git branch --set-upstream-to=<upstreamRef>
   * <localName>`. Used by `Track Remote Branch` when an existing local
   * branch with no/different upstream needs to adopt the right-clicked
   * remote ref. Same input-validation discipline as deleteBranch /
   * renameBranch: reject names starting with `-` or `.` so a
   * hostile name can't masquerade as a CLI flag, and splice
   * `--end-of-options` between the `--set-upstream-to=…` flag and the
   * positional local-name. The remote part of the upstream ref carries
   * the same guard — the form is `<remote>/<branch>` and either segment
   * starting with `-`/`.` is rejected.
   */
  setBranchUpstream(
    repo: IRepository,
    localName: string,
    upstreamRef: string
  ): ResultAsync<void, GitError> {
    // FORWARD: the UI caller `.match`es and surfaces a sanitized toast.
    return this._branches.setBranchUpstream(repo, localName, upstreamRef);
  }

  renameBranch(repo: IRepository, oldName: string, newName: string): ResultAsync<void, GitError> {
    // FORWARD: the UI caller `.match`es and surfaces a sanitized toast.
    return this._branches.renameBranch(repo, oldName, newName);
  }

  mergeBranch(repo: IRepository, branch: string, options?: IMergeOptions): Promise<IMergeResult> {
    // Absorbs the ops Result. Domain conflicts/failures already land in
    // Ok(IMergeResult); only a spawn/system fault reaches the Err arm, where it
    // is LOGGED and degraded to a failed result carrying the sanitized reason —
    // strictly better than today, where a spawn fault was an uncaught rejection.
    return this._branches.mergeBranch(repo, branch, options).match(
      (result) => result,
      (error) => {
        this._logger.error('mergeBranch failed', { rootPath: repo.rootUri.fsPath, branch }, error);
        return { success: false, conflicts: [], failureReason: sanitizeGitError(error.message) };
      }
    );
  }

  /**
   * Rebase the current branch onto another branch.
   *
   * @param repo - The repository
   * @param onto - The branch to rebase onto
   * @returns Rebase result with success status and any conflicts
   */
  rebaseBranch(
    repo: IRepository,
    onto: string,
    options?: IRebaseOptions
  ): Promise<IBasicRebaseResult> {
    // Absorbs the ops Result. Domain conflicts/failures land in
    // Ok(IBasicRebaseResult); a validation reject or spawn/system fault is
    // LOGGED then degraded to a failed result carrying the sanitized reason.
    return this._branches.rebaseBranch(repo, onto, options).match(
      (result) => result,
      (error) => {
        this._logger.error('rebaseBranch failed', { rootPath: repo.rootUri.fsPath, onto }, error);
        return { success: false, conflicts: [], failureReason: sanitizeGitError(error.message) };
      }
    );
  }

  /**
   * Skip the current commit during an in-progress rebase.
   *
   * Issues `git rebase --skip` which drops the problematic commit and
   * continues with the next one in the sequence. If the next commit also
   * conflicts, the returned result reflects those new conflicts exactly
   * like `rebaseBranch`'s conflict-path.
   *
   * This is destructive: the skipped commit's changes are permanently
   * lost from the rewritten history. Callers (ResolveConflictsDialog,
   * palette command) gate with a single confirm modal per safety policy
   * (feedback_data_loss_confirms.md — no double-confirm).
   */
  rebaseSkip(repo: IRepository): Promise<IBasicRebaseResult> {
    // Absorbs the ops Result: a spawn/system fault is LOGGED then degraded to a
    // failed result carrying the sanitized reason.
    return this._branches.rebaseSkip(repo).match(
      (result) => result,
      (error) => {
        this._logger.error('rebaseSkip failed', { rootPath: repo.rootUri.fsPath }, error);
        return { success: false, conflicts: [], failureReason: sanitizeGitError(error.message) };
      }
    );
  }

  /**
   * Abort an in-progress rebase (`git rebase --abort`).
   *
   * Restores the working tree + HEAD to their pre-rebase state and removes
   * the `.git/rebase-merge/` (or `rebase-apply/`) metadata. Mirrors the
   * {@link cherryPickAbort} / {@link revertAbort} pattern: `throwOnError`
   * surfaces any git failure to the caller, which is responsible for
   * routing the message through `sanitizeGitError` before display
   * (auto-abort recovery in `_handleRebaseCurrentOnto`).
   *
   * @param repo - The repository
   */
  rebaseAbort(repo: IRepository): ResultAsync<void, GitError> {
    // FORWARD: the caller `.match`es and surfaces a sanitized toast (auto-abort
    // recovery in `_handleRebaseCurrentOnto`).
    return this._branches.rebaseAbort(repo);
  }

  /**
   * Continue an in-progress rebase after the user resolves conflicts
   * (`git rebase --continue`).
   *
   * Mirrors {@link rebaseSkip}'s result-shape contract: on success returns
   * `{success: true}`; on exit-code ≠ 0 with unmerged files still present
   * returns `{success: false, conflicts}`; on exit-code ≠ 0 with no
   * unmerged files (e.g. continued without staging the resolution, or
   * editor closed without saving the commit message) surfaces the
   * underlying git error via `failureReason` so the caller can show it
   * instead of dropping the failure silently — same boundary contract as
   * {@link rebaseBranch}.
   *
   * @param repo - The repository
   */
  rebaseContinue(repo: IRepository): Promise<IBasicRebaseResult> {
    // Absorbs the ops Result: a spawn/system fault is LOGGED then degraded to a
    // failed result carrying the sanitized reason.
    return this._branches.rebaseContinue(repo).match(
      (result) => result,
      (error) => {
        this._logger.error('rebaseContinue failed', { rootPath: repo.rootUri.fsPath }, error);
        return { success: false, conflicts: [], failureReason: sanitizeGitError(error.message) };
      }
    );
  }

  /**
   * Compare two branches to find differences.
   * Returns commits unique to each branch, files that differ, and ahead/behind counts.
   *
   * @param repo - The repository
   * @param branch1 - The first branch (typically the current branch)
   * @param branch2 - The second branch to compare against
   * @returns Branch comparison result with commits ahead/behind and changed files
   */
  compareBranches(repo: IRepository, branch1: string, branch2: string): Promise<IBranchComparison> {
    // Absorbs the ops Result: a system fault is LOGGED and degraded to an empty
    // comparison (no commits ahead/behind, no changed files).
    return this._branches.compareBranches(repo, branch1, branch2).match(
      (comparison) => comparison,
      (error) => {
        this._logger.error(
          'compareBranches failed',
          { rootPath: repo.rootUri.fsPath, branch1, branch2 },
          error
        );
        return {
          commitsAhead: [],
          commitsBehind: [],
          aheadCount: 0,
          behindCount: 0,
          changedFiles: [],
        };
      }
    );
  }

  // ============================================
  // Remote Operations
  // ============================================

  fetch(
    repo: IRepository,
    optionsOrRemote?: IFetchOptions | string
  ): ResultAsync<IFetchResult, GitError> {
    return this._remoteOps.fetch(repo, optionsOrRemote);
  }

  pull(repo: IRepository, options?: IPullOptions): ResultAsync<void, GitError> {
    return this._remoteOps.pull(repo, options);
  }

  push(repo: IRepository, options?: IPushOptions): ResultAsync<void, GitError> {
    return this._remoteOps.push(repo, options);
  }

  getRemotes(repo: IRepository): ResultAsync<IRemote[], GitError> {
    return this._remoteOps.getRemotes(repo);
  }

  addRemote(repo: IRepository, name: string, url: string): ResultAsync<void, GitError> {
    return this._remoteOps.addRemote(repo, name, url);
  }

  removeRemote(repo: IRepository, name: string): ResultAsync<void, GitError> {
    return this._remoteOps.removeRemote(repo, name);
  }

  setRemoteUrl(repo: IRepository, name: string, url: string): ResultAsync<void, GitError> {
    return this._remoteOps.setRemoteUrl(repo, name, url);
  }

  renameRemote(repo: IRepository, oldName: string, newName: string): ResultAsync<void, GitError> {
    return this._remoteOps.renameRemote(repo, oldName, newName);
  }

  // ============================================
  // Incoming / Outgoing
  // ============================================
  //
  // New capability landed on the GitService class (NOT the frozen IGitService
  // composite — ADR-001). Consumers depend on the concrete `GitService` or the
  // forthcoming `IGitIncomingOutgoing` role interface, mirroring how the
  // `gitCli` escape hatch and other post-freeze additions are exposed.

  /**
   * Incoming (behind) / outgoing (ahead) commit counts for an explicit branch
   * against its tracking upstream. See {@link IncomingOutgoingOps.getForBranch}.
   */
  getIncomingOutgoingForBranch(repo: IRepository, branch: string): Promise<IIncomingOutgoing> {
    // Absorbs the ops Result: this feeds a background badge with no failure
    // toast, so a system fault is LOGGED (not swallowed) and degraded to a
    // "no upstream" reading rather than rejecting the badge update.
    return this._incomingOutgoing.getForBranch(repo, branch).match(
      (io) => io,
      (error) => {
        this._logger.error(
          'getIncomingOutgoingForBranch failed',
          { branch, rootPath: repo.rootUri.fsPath },
          error
        );
        return { branch, incoming: 0, outgoing: 0, noUpstream: true };
      }
    );
  }

  /**
   * Incoming (behind) / outgoing (ahead) commit counts for the current HEAD
   * branch against its upstream. See
   * {@link IncomingOutgoingOps.getForCurrentBranch}.
   */
  getIncomingOutgoing(repo: IRepository): Promise<IIncomingOutgoing> {
    // Absorbs the ops Result (see getIncomingOutgoingForBranch).
    return this._incomingOutgoing.getForCurrentBranch(repo).match(
      (io) => io,
      (error) => {
        this._logger.error('getIncomingOutgoing failed', { rootPath: repo.rootUri.fsPath }, error);
        return { branch: 'HEAD', incoming: 0, outgoing: 0, noUpstream: true };
      }
    );
  }

  // ============================================
  // Worktree Operations
  // ============================================
  //
  // New capability landed on the GitService class (NOT the frozen IGitService
  // composite — ADR-001), mirroring the Incoming/Outgoing additions above.

  /**
   * List the repository's worktrees (`git worktree list --porcelain`).
   * See {@link WorktreeOps.listWorktrees}.
   */
  listWorktrees(repo: IRepository): ResultAsync<IWorktreeEntry[], GitError> {
    return this._worktrees.listWorktrees(repo);
  }

  /**
   * Create a linked worktree (`git worktree add`). See
   * {@link WorktreeOps.addWorktree}.
   */
  addWorktree(repo: IRepository, options: IAddWorktreeOptions): ResultAsync<void, GitError> {
    return this._worktrees.addWorktree(repo, options);
  }

  // ============================================
  // Stash Operations
  // ============================================

  stash(repo: IRepository, message?: string, options?: IStashOptions): ResultAsync<void, GitError> {
    return this._stashTagHistory.stash(repo, message, options);
  }

  stashList(repo: IRepository): Promise<IStash[]> {
    // Absorbs the ops Result: the stash views tolerate an empty list with no
    // failure toast, so a system fault is LOGGED (not swallowed) and degraded
    // to [] rather than rejecting every consumer.
    return this._stashTagHistory.stashList(repo).match(
      (stashes) => stashes,
      (error) => {
        this._logger.error('stashList failed', { rootPath: repo.rootUri.fsPath }, error);
        return [];
      }
    );
  }

  stashApply(repo: IRepository, index: number, reinstateIndex = true): ResultAsync<void, GitError> {
    return this._stashTagHistory.stashApply(repo, index, reinstateIndex);
  }

  stashPop(repo: IRepository, index: number, reinstateIndex = true): ResultAsync<void, GitError> {
    return this._stashTagHistory.stashPop(repo, index, reinstateIndex);
  }

  stashDrop(repo: IRepository, index: number): ResultAsync<void, GitError> {
    return this._stashTagHistory.stashDrop(repo, index);
  }

  /**
   * Create a branch rooted at a stashed state and apply the stash into it.
   * See {@link IGitService.stashBranch}.
   */
  stashBranch(repo: IRepository, index: number, branchName: string): ResultAsync<void, GitError> {
    return this._stashTagHistory.stashBranch(repo, index, branchName);
  }

  /**
   * Rename a stash by re-storing its commit with a new message and dropping
   * the original entry. See {@link IGitService.stashRename}.
   *
   * Implementation is two git calls:
   *   1. `git rev-parse stash@{<index>}`   — get the stash commit hash.
   *   2. `git stash store -m "<newMessage>" <hash>` — re-store at stash@{0}.
   *   3. `git stash drop stash@{<index+1>}` — drop the now-shifted original.
   *
   * No working-tree changes. On step 3 failure we attempt to drop the new
   * top-of-stack entry so we don't leave duplicates.
   */
  stashRename(repo: IRepository, index: number, newMessage: string): ResultAsync<void, GitError> {
    return this._stashTagHistory.stashRename(repo, index, newMessage);
  }

  /**
   * View the contents/diff of a stash.
   *
   * @param repo - The repository
   * @param index - The stash index
   * @returns Array of diffs showing the stash contents
   */
  stashShow(repo: IRepository, index: number): Promise<IDiff[]> {
    // Funnels the ops Result back onto the throwing Promise contract: the
    // single caller (StashView) already try/catches and toasts, so a failure
    // re-throws here. Log on the re-throw arm so the fault is surfaced (not
    // silent) even before the caller's catch decides how to present it.
    return this._stashTagHistory.stashShow(repo, index).match(
      (diffs) => diffs,
      (error) => {
        this._logger.error('stashShow failed', { rootPath: repo.rootUri.fsPath }, error);
        throw error;
      }
    );
  }

  // ============================================
  // Tag Operations
  // ============================================

  getTags(repo: IRepository): Promise<ITag[]> {
    // Absorbs the ops Result: tag-list consumers tolerate an empty list with no
    // failure toast, so a system fault is LOGGED (not swallowed) and degraded
    // to [].
    return this._stashTagHistory.getTags(repo).match(
      (tags) => tags,
      (error) => {
        this._logger.error('getTags failed', { rootPath: repo.rootUri.fsPath }, error);
        return [];
      }
    );
  }

  createTag(
    repo: IRepository,
    name: string,
    message?: string,
    ref?: string,
    force?: boolean
  ): ResultAsync<void, GitError> {
    return this._stashTagHistory.createTag(repo, name, message, ref, force);
  }

  deleteTag(repo: IRepository, name: string): ResultAsync<void, GitError> {
    return this._stashTagHistory.deleteTag(repo, name);
  }

  pushTag(repo: IRepository, name: string, remote?: string): ResultAsync<void, GitError> {
    return this._stashTagHistory.pushTag(repo, name, remote);
  }

  deleteRemoteTag(repo: IRepository, name: string, remote?: string): ResultAsync<void, GitError> {
    return this._stashTagHistory.deleteRemoteTag(repo, name, remote);
  }

  // ============================================
  // History Operations
  // ============================================

  getLog(repo: IRepository, options?: ILogOptions): Promise<ICommit[]> {
    // Track the in-flight log so a concurrent getStatus yields to it (see
    // `_logInFlight`). The slot clears on settle, so only genuinely overlapping
    // status walks ever wait.
    // Absorbs the ops Result: the graph/log views tolerate an empty list with
    // no failure toast, so a system fault is LOGGED (not swallowed) and degraded
    // to []. `.match` yields the Promise the in-flight tracking expects.
    const pending = this._stashTagHistory.getLog(repo, options).match(
      (commits) => commits,
      (error) => {
        this._logger.error('getLog failed', { rootPath: repo.rootUri.fsPath }, error);
        return [];
      }
    );
    this._logInFlight.add(pending);
    // Wake any status calls waiting (within the startup grace) for a log to
    // appear, so they yield to this one instead of racing it.
    if (this._logRegisterWaiters.length > 0) {
      const waiters = this._logRegisterWaiters;
      this._logRegisterWaiters = [];
      for (const wake of waiters) {
        wake();
      }
    }
    void pending.finally(() => this._logInFlight.delete(pending));
    return pending;
  }

  /**
   * Resolve when the next {@link getLog} registers, or after `graceMs` — used by
   * the status gate to close the activation race where status checks for an
   * in-flight log a tick before the graph's getLog has registered.
   */
  private _waitForLogRegistration(graceMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => resolve();
      this._logRegisterWaiters.push(wake);
      setTimeout(() => {
        const i = this._logRegisterWaiters.indexOf(wake);
        if (i >= 0) {
          this._logRegisterWaiters.splice(i, 1);
        }
        resolve();
      }, graceMs);
    });
  }

  getLogCount(repo: IRepository, options?: ILogOptions): Promise<number> {
    // Absorbs the ops Result: the count is a display hint, so a system fault is
    // LOGGED (not swallowed) and degraded to 0.
    return this._stashTagHistory.getLogCount(repo, options).match(
      (count) => count,
      (error) => {
        this._logger.error('getLogCount failed', { rootPath: repo.rootUri.fsPath }, error);
        return 0;
      }
    );
  }

  getCommit(repo: IRepository, hash: string): Promise<ICommit> {
    // Funnels the ops Result back onto the throwing Promise contract: the many
    // callers already `await` (and try/catch) a rejecting getCommit, so a
    // failure re-throws here. Log on the re-throw arm so the fault is surfaced
    // (not silent) even before the caller's catch decides how to present it.
    return this._stashTagHistory.getCommit(repo, hash).match(
      (commit) => commit,
      (error) => {
        this._logger.error('getCommit failed', { rootPath: repo.rootUri.fsPath, hash }, error);
        throw error;
      }
    );
  }

  getFileHistory(
    repo: IRepository,
    path: string,
    options?: IFileHistoryOptions
  ): Promise<ICommit[]> {
    // Absorbs the ops Result: file-history consumers tolerate an empty list with
    // no failure toast, so a system fault is LOGGED (not swallowed) and degraded
    // to [].
    return this._stashTagHistory.getFileHistory(repo, path, options).match(
      (commits) => commits,
      (error) => {
        this._logger.error('getFileHistory failed', { rootPath: repo.rootUri.fsPath }, error);
        return [];
      }
    );
  }

  getLineHistory(
    repo: IRepository,
    path: string,
    startLine: number,
    endLine: number,
    options?: IFileHistoryOptions
  ): Promise<ICommit[]> {
    // Absorbs the ops Result (see getFileHistory).
    return this._stashTagHistory.getLineHistory(repo, path, startLine, endLine, options).match(
      (commits) => commits,
      (error) => {
        this._logger.error('getLineHistory failed', { rootPath: repo.rootUri.fsPath }, error);
        return [];
      }
    );
  }

  /**
   * Compute `git log --cherry-mark --left-right` classifications
   * between `baseRef` and HEAD.
   *
   * Under the hood we invoke:
   *
   *   git log --cherry-mark --left-right --pretty=format:%H %m HEAD...<baseRef>
   *
   * Each output line is `<40-hex> <mark>`. We parse into a Map so the Log tab
   * can O(1)-look-up a given commit's classification. Errors resolve to an
   * empty map (caller gracefully degrades — the feature is non-critical).
   */
  getCherryMarks(
    repo: IRepository,
    baseRef: string
  ): Promise<Map<string, import('./interfaces/IGitService').CherryMark>> {
    return this._diff.getCherryMarks(repo, baseRef);
  }

  // ============================================
  // Diff Operations
  // ============================================

  getDiff(repo: IRepository, path: string, staged?: boolean): Promise<IDiff> {
    // Absorbs the ops Result: a diff view tolerates an empty diff with no
    // failure toast, so a system fault is LOGGED (not swallowed) and degraded
    // to the empty-diff sentinel.
    return this._diff.getDiff(repo, path, staged).match(
      (diff) => diff,
      (error) => {
        this._logger.error('getDiff failed', { rootPath: repo.rootUri.fsPath, path }, error);
        return { path, status: 'modified' as const, hunks: [], binary: false };
      }
    );
  }

  getCommitDiff(repo: IRepository, hash: string): Promise<IDiff[]> {
    // Absorbs the ops Result: a system fault is LOGGED and degraded to [].
    return this._diff.getCommitDiff(repo, hash).match(
      (diffs) => diffs,
      (error) => {
        this._logger.error('getCommitDiff failed', { rootPath: repo.rootUri.fsPath, hash }, error);
        return [];
      }
    );
  }

  getFileAtRevision(repo: IRepository, path: string, rev: string): Promise<string> {
    // Absorbs the ops Result: a system fault is LOGGED and degraded to ''.
    return this._diff.getFileAtRevision(repo, path, rev).match(
      (content) => content,
      (error) => {
        this._logger.error(
          'getFileAtRevision failed',
          { rootPath: repo.rootUri.fsPath, path, rev },
          error
        );
        return '';
      }
    );
  }

  /**
   * Get the combined diff for multiple commits.
   * This calculates the cumulative changes across all selected commits,
   * showing the total changes from the oldest commit's parent to the newest commit.
   *
   * The method sorts commits by their commit date to find the range,
   * then computes the diff between the oldest commit's parent and the newest commit.
   *
   * @param repo - The repository
   * @param commits - Array of commit hashes (can be in any order)
   * @returns Array of diffs representing the combined changes
   */
  getMultiCommitDiff(repo: IRepository, commits: string[]): Promise<IDiff[]> {
    // Absorbs the ops Result: a system fault is LOGGED and degraded to [].
    return this._diff.getMultiCommitDiff(repo, commits).match(
      (diffs) => diffs,
      (error) => {
        this._logger.error('getMultiCommitDiff failed', { rootPath: repo.rootUri.fsPath }, error);
        return [];
      }
    );
  }

  /**
   * List files that differ between the given ref and the working tree.
   * Uses `git diff --name-status -z <ref>` for robust parsing (NUL-delimited,
   * so paths with whitespace or non-ASCII characters are handled correctly).
   */
  getChangedFilesAgainstWorkingTree(repo: IRepository, ref: string): Promise<IRefDiffFile[]> {
    // Absorbs the ops Result: a system fault is LOGGED and degraded to [].
    return this._diff.getChangedFilesAgainstWorkingTree(repo, ref).match(
      (files) => files,
      (error) => {
        this._logger.error(
          'getChangedFilesAgainstWorkingTree failed',
          { rootPath: repo.rootUri.fsPath, ref },
          error
        );
        return [];
      }
    );
  }

  /**
   * Compute the merge-base of two refs.
   *
   * Wraps `git merge-base --end-of-options <refA> <refB>`. Returns the
   * common-ancestor SHA on success, or `undefined` when:
   *   - the refs share no common ancestor (git exits with code 1), or
   *   - the refs are unknown (git exits with code 128 and writes a
   *     "fatal: ..." line to stderr), or
   *   - any other non-zero exit (defensive — caller treats as no path).
   *
   * `--end-of-options` separates options from
   * positional refs, so a hostile ref string like `--upload-pack=evil`
   * can never be interpreted by git as an option flag. The host-side
   * caller in {@link GitToolWindowProvider.setFocusedBranch} also
   * validates branch names against the live branchMap before invoking
   * this method (defense in depth — neither layer alone is sufficient).
   *
   * Used by the Git tool window's branch-focus feature.
   */
  getMergeBase(repo: IRepository, refA: string, refB: string): Promise<string | undefined> {
    // The ops layer returns a Result so a spawn/system fault can't masquerade
    // as "no merge base". The façade preserves the public `string | undefined`
    // contract: Ok → the sha (or undefined for the genuine no-common-ancestor
    // case), Err → LOGGED (never silently dropped) then undefined.
    return this._diff.getMergeBase(repo, refA, refB).match(
      (sha) => sha,
      (error) => {
        this._logger.error(
          'getMergeBase failed',
          { refA, refB, rootPath: repo.rootUri.fsPath },
          error
        );
        return undefined;
      }
    );
  }

  // ============================================
  // Blame Operations
  // ============================================

  getBlame(repo: IRepository, path: string): Promise<IBlameLine[]> {
    // Absorbs the ops Result: a system fault is LOGGED and degraded to [].
    return this._diff.getBlame(repo, path).match(
      (lines) => lines,
      (error) => {
        this._logger.error('getBlame failed', { rootPath: repo.rootUri.fsPath, path }, error);
        return [];
      }
    );
  }

  // ============================================
  // Cherry-pick and Revert
  // ============================================

  /**
   * Cherry-pick one or more commits onto the current branch.
   * Commits are applied in the order provided. Forwards the ops Result so the
   * UI caller surfaces a sanitized toast on a spawn/invalid-argument fault.
   *
   * @param repo - The repository
   * @param commits - Array of commit hashes to cherry-pick
   */
  cherryPick(
    repo: IRepository,
    commits: string[],
    options?: ICherryPickOptions
  ): ResultAsync<ICherryPickResult, GitError> {
    return this._cherryRevert.cherryPick(repo, commits, options);
  }

  /**
   * Abort an in-progress cherry-pick operation.
   * Restores the working directory to its pre-cherry-pick state.
   *
   * @param repo - The repository
   */
  cherryPickAbort(repo: IRepository): ResultAsync<void, GitError> {
    return this._cherryRevert.cherryPickAbort(repo);
  }

  /**
   * Continue a cherry-pick operation after resolving conflicts.
   *
   * @param repo - The repository
   */
  cherryPickContinue(repo: IRepository): ResultAsync<ICherryPickResult, GitError> {
    return this._cherryRevert.cherryPickContinue(repo);
  }

  revert(
    repo: IRepository,
    commits: string[],
    options?: IRevertOptions
  ): ResultAsync<IRevertResult, GitError> {
    return this._cherryRevert.revert(repo, commits, options);
  }

  /**
   * Abort an in-progress revert operation.
   * Restores the working directory to its pre-revert state.
   *
   * @param repo - The repository
   */
  revertAbort(repo: IRepository): ResultAsync<void, GitError> {
    return this._cherryRevert.revertAbort(repo);
  }

  /**
   * Continue a revert operation after resolving conflicts.
   *
   * @param repo - The repository
   * @returns Revert result with success status and any new conflicts
   */
  revertContinue(repo: IRepository): ResultAsync<IRevertResult, GitError> {
    return this._cherryRevert.revertContinue(repo);
  }

  // ============================================
  // Status Operations
  // ============================================

  getStatus(repo: IRepository): Promise<IFileStatus[]> {
    // Coalesce concurrent identical walks (see `_statusInFlight`). A call that
    // arrives while one is already running shares its result; once it settles
    // the slot clears, so a later non-overlapping call walks fresh.
    const key = repo.rootUri.fsPath;
    const existing = this._statusInFlight.get(key);
    if (existing) {
      return existing;
    }
    const pending = this._statusYieldingToLog(repo).finally(() => {
      this._statusInFlight.delete(key);
    });
    this._statusInFlight.set(key, pending);
    return pending;
  }

  /**
   * Run the status walk, but first let any in-flight {@link getLog} finish so
   * the heavy untracked enumeration doesn't starve the graph's first paint.
   * Bounded by `_statusLogGateMs` so a hung/never-resolving log can never block
   * status. A no-op when no log is in flight.
   */
  private async _statusYieldingToLog(repo: IRepository): Promise<IFileStatus[]> {
    // Startup race: if no log is in flight yet but one may be imminent (we're
    // early in the session), wait a short grace for it to register so a status
    // that fired just before the graph's getLog still yields rather than racing.
    if (
      this._logInFlight.size === 0 &&
      Date.now() - this._createdAt < this._statusGateStartupWindowMs
    ) {
      await this._waitForLogRegistration(this._statusGateGraceMs);
    }
    if (this._logInFlight.size > 0) {
      await Promise.race([
        Promise.allSettled([...this._logInFlight]),
        new Promise<void>((resolve) => setTimeout(resolve, this._statusLogGateMs)),
      ]);
    }
    // Absorbs the ops Result: status feeds the SCM / changelist views with no
    // failure toast, so a system fault is LOGGED (not swallowed) and degraded
    // to an empty list rather than rejecting every consumer.
    return this._staging.getStatus(repo).match(
      (entries) => entries,
      (error) => {
        this._logger.error('getStatus failed', { rootPath: repo.rootUri.fsPath }, error);
        return [];
      }
    );
  }

  stage(repo: IRepository, paths: string[]): ResultAsync<void, GitError> {
    return this._staging.stage(repo, paths);
  }

  unstage(repo: IRepository, paths: string[]): ResultAsync<void, GitError> {
    return this._staging.unstage(repo, paths);
  }

  /**
   * Stage a single hunk from a file.
   *
   * @param repo - The repository
   * @param path - The file path
   * @param hunk - The hunk to stage
   */
  stageHunk(repo: IRepository, path: string, hunk: IHunk): ResultAsync<void, GitError> {
    return this._staging.stageHunk(repo, path, hunk);
  }

  /**
   * Stage specific lines within a file.
   * This generates a custom patch that includes only the specified lines.
   *
   * @param repo - The repository
   * @param path - The file path
   * @param selection - Disambiguated line selection: addLines keyed by
   *   newLineNumber, deleteLines keyed by oldLineNumber.
   * @param hunk - The hunk containing the lines to stage
   */
  stageLines(
    repo: IRepository,
    path: string,
    selection: ILineSelection,
    hunk: IHunk
  ): ResultAsync<void, GitError> {
    return this._staging.stageLines(repo, path, selection, hunk);
  }

  /**
   * Unstage a single hunk from a file.
   * This generates a reverse patch and applies it to the index.
   *
   * @param repo - The repository
   * @param path - The file path
   * @param hunk - The hunk to unstage
   */
  unstageHunk(repo: IRepository, path: string, hunk: IHunk): ResultAsync<void, GitError> {
    return this._staging.unstageHunk(repo, path, hunk);
  }

  /**
   * Revert (discard) a single hunk in the working tree (IntelliJ "Revert
   * Chunk"). Delegates to {@link StagingOps.revertHunk}.
   */
  revertHunk(repo: IRepository, path: string, hunk: IHunk): ResultAsync<void, GitError> {
    return this._staging.revertHunk(repo, path, hunk);
  }

  /**
   * Revert (discard) uncommitted changes to a file.
   * This restores the file to its last committed state.
   *
   * @param repo - The repository
   * @param path - The file path to revert
   */
  revertFile(repo: IRepository, path: string): ResultAsync<void, GitError> {
    return this._staging.revertFile(repo, path);
  }

  /**
   * Roll back local changes for a set of selected files (IntelliJ "Rollback").
   * Delegates to {@link StagingOps.rollbackChanges}.
   */
  rollbackChanges(
    repo: IRepository,
    changes: IRollbackChange[],
    options?: IRollbackOptions
  ): ResultAsync<void, GitError> {
    return this._staging.rollbackChanges(repo, changes, options);
  }

  /**
   * Reset the current branch to the given target commit using one of the four
   * IntelliJ reset modes.
   */
  resetToCommit(repo: IRepository, target: string, mode: ResetMode): ResultAsync<void, GitError> {
    return this._staging.resetToCommit(repo, target, mode);
  }

  // ============================================
  // Disposal
  // ============================================

  dispose(): void {
    // Latch the dispose flag first so any in-flight `loadRepository` promise
    // that resolves after this point becomes a no-op when its `.finally(() =>
    // handleChange())` chain re-enters. This is the primary
    // defense against calling `git spawn` + `_onDidChangeRepository.fire()`
    // on a disposed service during a window reload that catches a reload
    // mid-flight.
    this._disposed = true;
    this._onDidChangeRepository.dispose();
    this._onDidRemoveRepository.dispose();
    this._onDidFetch.dispose();
    this._gitCli.dispose();

    // Aggregate watcher counts BEFORE teardown so the emitted record
    // reflects pre-teardown state (watcher teardown
    // during dispose()).
    let watcherCount = 0;
    for (const map of this._watcherMaps) {
      for (const disposables of map.values()) {
        watcherCount += disposables.length;
      }
    }
    this._logger.info('GitService disposing — tearing down watchers', {
      watcherCount,
      repositoryCount: this._repositories.size,
      pendingTimers: this._refreshTimers.size,
      inFlightReloads: this._reloading.size,
    });

    // Dispose every registered watcher family uniformly. Walking the registry
    // (rather than hardcoding `_fileWatchers` then `_newRepoWatchers`) keeps
    // the disposal the single touchpoint, so adding a new family means only
    // `this._watcherMaps.push(...)` in the constructor and its watchers can't
    // leak across window reloads.
    for (const map of this._watcherMaps) {
      for (const disposables of map.values()) {
        for (const d of disposables) {
          d.dispose();
        }
      }
      map.clear();
    }

    for (const timer of this._refreshTimers.values()) {
      clearTimeout(timer);
    }
    this._refreshTimers.clear();
    this._reloading.clear();

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];

    this._repositories.clear();
  }
}

/**
 * Create a new GitService instance.
 *
 * @param gitPath - Optional path to the Git executable
 * @returns A new GitService instance
 */
export function createGitService(gitPath?: string): GitService {
  return new GitService(gitPath);
}

/**
 * Recognise the canonical "empty repo" stderr emitted by `git rev-parse
 * HEAD` when the symbolic ref points at an unborn branch. Any other stderr
 * (corrupt HEAD, missing object, permission error, packed-refs mismatch)
 * must NOT be treated as empty-repo — `loadRepository` leaves `head`
 * undefined in that case so the UI does not promise the user a phantom
 * "first commit will land here" prompt.
 *
 * Two canonical signatures across git versions:
 *   - `fatal: ambiguous argument 'HEAD': unknown revision or path not
 *     in the working tree.` — git ≥ 2.0
 *   - `fatal: bad default revision 'HEAD'` — older git releases
 */
function isEmptyRepoStderr(stderr: string | undefined): boolean {
  if (!stderr) {
    return false;
  }
  return (
    stderr.includes("fatal: ambiguous argument 'HEAD'") ||
    stderr.includes("fatal: bad default revision 'HEAD'")
  );
}
