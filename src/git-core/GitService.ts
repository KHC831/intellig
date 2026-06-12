import * as path from 'path';
import * as vscode from 'vscode';
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
  IDiffLine,
  IBlameLine,
  ICommitOptions,
  ICheckoutOptions,
  IPullOptions,
  IPushOptions,
  IFetchOptions,
  IFetchResult,
  IFetchRefUpdate,
  IStashOptions,
  ILogOptions,
  IFileHistoryOptions,
  ICreateBranchOptions,
  IMergeOptions,
  IMergeResult,
  IBasicRebaseResult,
  ICherryPickOptions,
  ICherryPickResult,
  IRevertResult,
  IBranchComparison,
  IRefDiffFile,
  ResetMode,
  RepositoryState,
} from './interfaces/IGitService';
import { GitCli, IGitCommandOptions, createGitCli, buildGitArgs } from './gitCli';
import {
  scanFolderForGitRepos,
  defaultRepoScanFs,
  IRepoScanFs,
  INTERNAL_IGNORED_FOLDERS,
} from './repoScan';
import {
  parseStatus,
  parseLog,
  parseCommit,
  parseBranches,
  parseTags,
  parseStashList,
  parseRemotes,
  parseHead,
  parseRepositoryState,
  parseDiff,
  parseBlame,
  getLogFormat,
  getBranchFormat,
  getTagFormat,
} from './gitParser';
import { sortCommitsStable } from './commitSort';
import { sanitizeGitError } from './gitError';
import { readInProgressOperation } from './gitInProgress';
import { getOutputChannel } from '../utils/outputChannel';
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
   * graph (task 9.1, Requirements 6.1, 6.2, 6.7).
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

    // (#219): register the two known watcher families with the
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
            `GitService.onDidChangeWorkspaceFolders: discover added folder ${folder.uri.fsPath}`,
            { outputChannel: getOutputChannel() }
          );
        }
      })
    );

    // Issue #211: re-run discovery on all workspace folders when the
    // repository-scan-related settings change. Previously the two settings
    // (`intellig.repositoryScanMaxDepth` + `intellig.repositoryScanIgnoredFolders`)
    // were read once at workspace-folder-add time; mid-session edits had no
    // effect until window reload, with no signal to the user.
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
            `GitService.onDidChangeConfiguration: rediscover ${folder.uri.fsPath}`,
            { outputChannel: getOutputChannel() }
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
      'GitService.constructor: initial repository discovery',
      { outputChannel: getOutputChannel() }
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
    const path = uri.fsPath;

    // Check cache first
    const cached = this.getCachedRepository(path);
    if (cached) {
      return cached;
    }

    // Try to find repository root
    const rootPath = await this._gitCli.getRepositoryRoot(path);
    if (!rootPath) {
      return undefined;
    }

    // Check if we have this root cached
    const cachedRoot = this.getCachedRepository(rootPath);
    if (cachedRoot) {
      return cachedRoot;
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
   * Get all discovered repositories.
   *
   * @returns Array of repositories
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
   * (task #204) — previously this only checked `path` itself for
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
      resolveRepoRoot: (p): Promise<string | undefined> => this._gitCli.getRepositoryRoot(p),
    });

    for (const root of repoRoots) {
      if (!this._repositories.has(root)) {
        // Enroll into `_reloading` so drain paths see this in-flight load.
        const repo = await this._enrollReload(root, this.loadRepository(root));
        this.setupRepositoryWatcher(root);
        this._logger.info('repository discovered', { rootPath: root });
        // Fire `onDidChangeRepository` so the 6
        // event-driven subscribers (BranchTreeProvider, StatusBarService,
        // BranchPopup, ChangelistService, ConflictResolutionService,
        // GitToolWindowProvider) see the freshly-discovered repo. Without
        // this fire, an empty `git init` repo (no internal `.git/` writes
        // to trigger the debounced refresh path) leaves every subscriber
        // stale until the user manually performs a state-changing git
        // operation. The dispose latch matches `_performDebouncedRefresh`'s
        // post-await pattern at line ~653.
        if (!this._disposed) {
          this._onDidChangeRepository.fire(repo);
        }
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
      const fsPath = uri.fsPath;
      const lastSep = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'));
      if (lastSep <= 0) {
        return;
      }
      const repoParentDir = fsPath.slice(0, lastSep);

      // Filter against ignored folders. Re-read config in case it changed
      // since `discoverRepository` ran.
      const config = vscode.workspace.getConfiguration('intellig');
      const userIgnored = config.get<string[]>('repositoryScanIgnoredFolders', []);
      // Apply the same filter the scanner uses: basename of any ancestor
      // between the workspace folder and the parent dir matching an
      // ignored name disqualifies this `.git/`.
      //
      // (path-prefix string match): use
      // `path.relative` rather than `repoParentDir.startsWith(folderPath)`.
      // The string-prefix check incorrectly matched `/workspace/foo` as
      // inside `/work` because `'/workspace/foo'.startsWith('/work')` is
      // true. `path.relative` returns `'../workspace/foo'` for that case,
      // which we detect via the `..` prefix and bail.
      const rel = path.relative(folderPath, repoParentDir);
      if (rel.length > 0 && (rel === '..' || rel.startsWith('..' + path.sep))) {
        // The created `.git/` is OUTSIDE the watched folder. This shouldn't
        // happen given the RelativePattern glob, but defend against it.
        return;
      }
      if (path.isAbsolute(rel)) {
        // Different drive on Windows — also outside the watched folder.
        return;
      }
      const segments = rel.split(/[/\\]/).filter((s) => s.length > 0);
      const allIgnored = new Set<string>([...INTERNAL_IGNORED_FOLDERS, ...userIgnored]);
      if (segments.some((seg) => allIgnored.has(seg))) {
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
        `GitService.setupNewRepoWatcher: discover new repo at ${repoParentDir}`,
        { outputChannel: getOutputChannel() }
      );
    });

    // (#219): single-element-array shape so the map fits the shared
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
      } catch {
        // No upstream configured
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

    // Get repository state
    let state: RepositoryState = 'idle';
    try {
      const statusResult = await this._gitCli.exec(['status'], options);
      state = parseRepositoryState(statusResult.stdout);
    } catch {
      // Ignore errors
    }

    // When state is non-idle, read on-disk in-progress markers
    // (`MERGE_HEAD` / `rebase-merge/head-name` / `CHERRY_PICK_HEAD` /
    // `REVERT_HEAD`) so the StatusBar can render verb-form labels with
    // the operation's target ("Rebasing onto main", "Cherry-picking
    // abc1234"). Cherry-pick + revert markers carry a 40-char SHA;
    // abbreviate via `git rev-parse --short` (single git invocation per
    // non-idle reload, skipped entirely for idle repos).
    let inProgress;
    if (state !== 'idle') {
      const gitDir = path.join(rootPath, '.git');
      try {
        inProgress = await readInProgressOperation(gitDir, async (sha) => {
          const result = await this._gitCli.exec(
            buildGitArgs('rev-parse', ['--short'], [sha]),
            options
          );
          return result.exitCode === 0 ? result.stdout.trim() : sha.substring(0, 7);
        });
      } catch {
        // Read failures fall through; the verb-only fallback in
        // StatusBarService still renders a useful label without the target.
      }
    }

    // Invariant: when both `state` and `inProgress` are populated, their
    // classifications must agree. `state` is parsed from `git status` text;
    // `inProgress.kind` is derived from on-disk marker files. They can
    // drift if the parsers diverge or if a future repo-state gets added
    // to one source but not the other. Surface the drift in dev/test
    // without crashing production. The duplication of the kind enum is
    // intentional and locked: see `IInProgressOperation.kind` JSDoc.
    if (
      inProgress !== undefined &&
      inProgress.kind !== state &&
      process.env.NODE_ENV !== 'production'
    ) {
      this._logger.warn('inProgress.kind out of sync with repository state', {
        rootPath,
        state,
        inProgressKind: inProgress.kind,
      });
    }

    // Get remotes
    let remotes: IRemote[] = [];
    try {
      const remotesResult = await this._gitCli.exec(['remote', '-v'], options);
      if (remotesResult.exitCode === 0) {
        remotes = parseRemotes(remotesResult.stdout);
      }
    } catch {
      // Ignore errors
    }

    const repository: IRepository = {
      rootUri: vscode.Uri.file(rootPath),
      state,
      head,
      remotes,
      submodules: [], // TODO: Parse submodules if needed
      ...(inProgress ? { inProgress } : {}),
    };

    // Cache the repository
    this._repositories.set(rootPath, {
      repository,
      lastUpdated: Date.now(),
    });

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

    const gitDir = vscode.Uri.file(`${rootPath}/.git`);

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
          `GitService.setupRepositoryWatcher: debounced refresh for ${rootPath}`,
          { outputChannel: getOutputChannel() }
        );
      }, GitService.WATCHER_DEBOUNCE_MS);
      this._refreshTimers.set(rootPath, timer);
    };

    // (#213): a deletion of `.git/HEAD` is the strongest signal that
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
      // `removeRepositoryWatcher` now fires
      // `onDidRemoveRepository` for every removed repo internally (the
      // shared cleanup path used by both `.git/HEAD` deletion AND
      // workspace-folder removal). We just delegate. Idempotency:
      // `_repositories.has(rootPath)` short-circuits the second-fire so a
      // duplicated delete event is a no-op.
      if (!this._repositories.has(rootPath)) {
        return;
      }
      this.removeRepositoryWatcher(rootPath);
    };

    // Per-root watchers live in `_fileWatchers` which is the sole lifecycle
    // owner — `removeRepositoryWatcher` disposes and removes from that map,
    // and `dispose()` walks the same map. Previously each watcher was ALSO
    // pushed into `_disposables`, leaving a dangling entry behind after a
    // workspace-folder removal. Disposable.dispose() is idempotent so it
    // wasn't user-visible, but the entry slowly accumulated across the
    // session. Only the _onDidChangeRepository emitter and other process-
    // lifetime disposables belong in `_disposables`.
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
      // Watcher-driven refresh failure (Requirement 6.2): warn rather
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
    const isInsideOrEqual = (candidate: string): boolean => {
      if (candidate === rootPath) {
        return true;
      }
      const rel = path.relative(rootPath, candidate);
      // path.relative returns '..' or starts with '..' + sep when candidate
      // is OUTSIDE rootPath; absolute path means different drive on Windows.
      if (rel.length === 0 || rel === '..' || rel.startsWith('..' + path.sep)) {
        return false;
      }
      // Defense against Windows absolute-path pivot (different drive).
      if (path.isAbsolute(rel)) {
        return false;
      }
      return true;
    };

    // Issue #219: walk EVERY registered watcher-family map uniformly.
    // This method previously hardcoded `_fileWatchers` and a separate
    // `_newRepoWatchers.get(rootPath)` exact-match cleanup; new families
    // would silently leak unless contributors remembered to extend the
    // function. The `_watcherMaps` registry makes "register the new map"
    // the single touchpoint for correct lifecycle.
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
    }

    // Fire `onDidRemoveRepository` for EVERY
    // matched repo BEFORE deleting from `_repositories`. Previously only the
    // `.git/HEAD`-deletion path (`handleHeadDelete`) fired the emitter,
    // which violated the JSDoc contract that promises both removal causes
    // (workspace-folder removal AND `.git/HEAD` deletion) trigger the
    // event. Six future subscribers (BranchTreeProvider, StatusBarService,
    // BranchPopup, ChangelistService, ConflictResolutionService,
    // GitToolWindowProvider) need this on the COMMON folder-removal path,
    // not just the EXOTIC `rm -rf .git` path.
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
  async commit(repo: IRepository, message: string, options: ICommitOptions = {}): Promise<void> {
    // Validate commit message - prevent empty messages unless amending or allowEmpty
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !options.amend && !options.allowEmpty) {
      throw new Error('Commit message cannot be empty');
    }

    const args = ['commit', '-m', message];

    if (options.amend) {
      args.push('--amend');
    }
    if (options.signOff) {
      args.push('--signoff');
    }
    if (options.noVerify) {
      args.push('--no-verify');
    }
    if (options.allowEmpty) {
      args.push('--allow-empty');
    }
    // `--author="Name <email>"` override.
    if (options.author && options.author.trim().length > 0) {
      args.push(`--author=${options.author.trim()}`);
    }

    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async amend(repo: IRepository, message: string): Promise<void> {
    await this.commit(repo, message, { amend: true });
  }

  // ============================================
  // Branch Operations
  // ============================================

  async getBranches(repo: IRepository): Promise<IBranch[]> {
    const format = getBranchFormat();
    const result = await this._gitCli.exec(['branch', '-a', '--format', format], {
      cwd: repo.rootUri.fsPath,
    });

    if (result.exitCode !== 0) {
      return [];
    }

    return parseBranches(result.stdout);
  }

  async createBranch(
    repo: IRepository,
    name: string,
    startPointOrOptions?: string | ICreateBranchOptions
  ): Promise<void> {
    // Normalize the legacy string form into an options object so the rest
    // of the function is a single code path.
    const options: ICreateBranchOptions =
      typeof startPointOrOptions === 'string'
        ? { startPoint: startPointOrOptions }
        : (startPointOrOptions ?? {});

    // Security: service-boundary reject branch names starting with `-`
    // (git would parse `-foo` as a CLI flag) or `.` (invalid per
    // git-check-ref-format). Mirrors the `resetToCommit` isValidRef guard
    // and defends against upstream callers that skipped validateBranchName.
    if (!name || name.startsWith('-') || name.startsWith('.')) {
      throw new Error(`Invalid branch name: ${name}`);
    }

    // When `checkout: true`, use `git checkout -[B] <name> <startPoint>`
    // so the branch is created AND switched to in a single atomic command.
    // Using `-B` when force is also set gives us "reset-and-checkout" in one
    // shot — matches IntelliJ's "Overwrite if exists" + "Checkout" combo.
    // branch-name validation above rejects `-`-leading names,
    // so `name` is safe to land positionally. We splice `--end-of-options`
    // before the unvalidated `startPoint` ref (the user-controlled
    // injection point).
    //
    // For `git checkout -[B|b] <name> --track <startPoint>` the name
    // must immediately follow `-b` (see GitServiceCheckout.test.ts).
    // The startPoint ref ALSO must follow git's positional contract:
    // either bare `<name> <startPoint>` or `<name> --track <startPoint>`.
    // We build the argv with the structural separator between flag args
    // and the user-controlled startPoint while preserving git's
    // positional constraints.
    if (options.checkout) {
      const args = ['checkout', options.force ? '-B' : '-b', name];
      if (options.track) {
        args.push('--track');
      }
      if (options.startPoint) {
        args.push('--end-of-options', options.startPoint);
      }
      await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
      this.invalidateCache(repo.rootUri.fsPath);
      return;
    }

    const args = ['branch'];
    if (options.force) {
      args.push('-f');
    }
    if (options.track) {
      args.push('--track');
    }
    args.push(name);
    if (options.startPoint) {
      args.push('--end-of-options', options.startPoint);
    }

    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async checkout(repo: IRepository, ref: string, options?: ICheckoutOptions): Promise<void> {
    // Splice `--end-of-options` between flag args and the ref
    // to reject argv injection via a hostile branch name (e.g.
    // `--upload-pack=evil`).
    //
    // For `createBranch: true` the layout is
    //   `git checkout -b <name> [-f] [--track <upstream>]`
    // where `<name>` MUST immediately follow `-b` (a long-standing
    // regression class — see GitServiceCheckout.test.ts:103). The
    // `--end-of-options` separator cannot land between `-b` and the
    // name without breaking git's parser. We keep the createBranch
    // path's argv unchanged and rely on `validateBranchName` (called
    // by createBranch upstream) to reject hostile names.

    // forceCreate path: `git checkout -B <ref> [-f] [--track
    // <startPoint>]` — "create-or-reset to startpoint". Mirrors the `-b`
    // precedent: `-B` and `<ref>` MUST be adjacent (git parses the token
    // right after `-B` as the branch name). forceCreate WINS over
    // createBranch when both are set — `-B` is strictly more permissive
    // (succeeds whether or not the branch exists).
    //
    // Startpoint design: the `track` value doubles as the single startpoint
    // positional. git treats `--track <startPoint>` here as both "set this
    // upstream" and "reset to this commit". `--end-of-options` is NOT used
    // for the startpoint: with `--track`, git reinterprets a token after
    // `--end-of-options` as a pathspec and fails ("'--track' cannot be used
    // with updating paths"). Verified against git 2.50.1. We instead reject
    // a startpoint that starts with `-`/`.` (mirrors deleteBranch /
    // setBranchUpstream's leading-token guard). The `<ref>` is safe by
    // adjacency.
    if (options?.forceCreate) {
      if (options.track && (options.track.startsWith('-') || options.track.startsWith('.'))) {
        throw new Error(`Invalid start point: ${options.track}`);
      }
      const args = ['checkout', '-B', ref];
      if (options.force) {
        args.push('-f');
      }
      if (options.track) {
        args.push('--track', options.track);
      }
      await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
      this.invalidateCache(repo.rootUri.fsPath);
      return;
    }

    if (options?.createBranch) {
      const args = ['checkout', '-b', ref];
      if (options?.force) {
        args.push('-f');
      }
      if (options?.track) {
        args.push('--track', options.track);
      }
      await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
      this.invalidateCache(repo.rootUri.fsPath);
      return;
    }

    // Plain checkout path: the ref is user-controlled, so we splice
    // `--end-of-options` before it.
    const flags: string[] = [];
    if (options?.force) {
      flags.push('-f');
    }
    const trailing: string[] = [];
    if (options?.track) {
      trailing.push('--track', options.track);
    }

    const args = [...buildGitArgs('checkout', flags, [ref]), ...trailing];
    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async deleteBranch(repo: IRepository, name: string, force?: boolean): Promise<void> {
    // service-boundary reject branch names starting with `-`
    // (git would parse `-foo` as a CLI flag) or `.` (invalid per
    // git-check-ref-format). Mirrors the `createBranch` guard. Also splice
    // `--end-of-options` between the `-d`/`-D` flag and the user-controlled
    // name as structural defense in depth.
    if (!name || name.startsWith('-') || name.startsWith('.')) {
      throw new Error(`Invalid branch name: ${name}`);
    }
    const args = buildGitArgs('branch', [force ? '-D' : '-d'], [name]);
    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
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
  async setBranchUpstream(
    repo: IRepository,
    localName: string,
    upstreamRef: string
  ): Promise<void> {
    if (!localName || localName.startsWith('-') || localName.startsWith('.')) {
      throw new Error(`Invalid branch name: ${localName}`);
    }
    if (!upstreamRef || upstreamRef.startsWith('-') || upstreamRef.startsWith('.')) {
      throw new Error(`Invalid upstream ref: ${upstreamRef}`);
    }
    const args = buildGitArgs('branch', [`--set-upstream-to=${upstreamRef}`], [localName]);
    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async renameBranch(repo: IRepository, oldName: string, newName: string): Promise<void> {
    // service-boundary reject either name starting with `-`
    // (git would parse `-foo` as a CLI flag) or `.` (invalid per
    // git-check-ref-format). Mirrors the `createBranch` guard. Also splice
    // `--end-of-options` between the `-m` flag and the user-controlled
    // names as structural defense in depth.
    if (!oldName || oldName.startsWith('-') || oldName.startsWith('.')) {
      throw new Error(`Invalid branch name: ${oldName}`);
    }
    if (!newName || newName.startsWith('-') || newName.startsWith('.')) {
      throw new Error(`Invalid branch name: ${newName}`);
    }
    await this._gitCli.exec(buildGitArgs('branch', ['-m'], [oldName, newName]), {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async mergeBranch(
    repo: IRepository,
    branch: string,
    options?: IMergeOptions
  ): Promise<IMergeResult> {
    // Order: git merge [--ff-only|--no-ff] [--squash] [--no-commit] [-m <msg>] <branch>
    // Strategy flags are CLI-mutex. Precedence when the caller sets several:
    // ffOnly > noFf > squash. UI enforces the mutex before we get here.
    const flags: string[] = [];
    if (options?.ffOnly) {
      flags.push('--ff-only');
    } else if (options?.noFf) {
      flags.push('--no-ff');
    }
    if (options?.squash) {
      flags.push('--squash');
    }
    if (options?.noCommit) {
      flags.push('--no-commit');
    }
    if (options?.message && options.message.length > 0) {
      flags.push('-m', options.message);
    }
    // `branch` is user-controlled; splice via buildGitArgs.
    const args = buildGitArgs('merge', flags, [branch]);

    const result = await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath });
    this.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      // Get the merge commit hash (note: with --squash or --no-commit, HEAD
      // hasn't advanced, so we still return the current HEAD — callers
      // interpret this as "the resulting tip" regardless of whether a new
      // commit was created).
      const headResult = await this._gitCli.exec(['rev-parse', 'HEAD'], {
        cwd: repo.rootUri.fsPath,
      });
      return {
        success: true,
        mergeCommit: headResult.stdout.trim(),
      };
    }

    // Check for conflicts
    const statusResult = await this._gitCli.exec(['status', '--porcelain'], {
      cwd: repo.rootUri.fsPath,
    });
    const conflicts = parseStatus(statusResult.stdout)
      .filter((f) => f.indexStatus === 'U' || f.workTreeStatus === 'U')
      .map((f) => f.path);

    if (conflicts.length > 0) {
      return {
        success: false,
        conflicts,
      };
    }

    // Non-conflict failure (refused merge, unrelated histories, dirty
    // tree, etc.). Preserve git's stderr so the caller can surface the
    // underlying reason instead of a silent no-op.
    return {
      success: false,
      conflicts: [],
      failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
    };
  }

  /**
   * Rebase the current branch onto another branch.
   *
   * @param repo - The repository
   * @param onto - The branch to rebase onto
   * @returns Rebase result with success status and any conflicts
   */
  async rebaseBranch(repo: IRepository, onto: string): Promise<IBasicRebaseResult> {
    // `onto` is user-controlled; splice via buildGitArgs.
    const args = buildGitArgs('rebase', [], [onto]);
    const result = await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath });
    this.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      return {
        success: true,
      };
    }

    // Check for conflicts
    const statusResult = await this._gitCli.exec(['status', '--porcelain'], {
      cwd: repo.rootUri.fsPath,
    });
    const conflicts = parseStatus(statusResult.stdout)
      .filter((f) => f.indexStatus === 'U' || f.workTreeStatus === 'U')
      .map((f) => f.path);

    if (conflicts.length > 0) {
      return {
        success: false,
        conflicts,
      };
    }

    // Non-conflict failure (dirty working tree, in-progress rebase, refs
    // out of sync, etc.). Preserve git's stderr so the caller can surface
    // the underlying reason instead of a silent no-op.
    return {
      success: false,
      conflicts: [],
      failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
    };
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
  async rebaseSkip(repo: IRepository): Promise<IBasicRebaseResult> {
    const result = await this._gitCli.exec(['rebase', '--skip'], {
      cwd: repo.rootUri.fsPath,
    });
    this.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      return { success: true };
    }

    // Rebase is still running but the next commit hit conflicts. Surface
    // them the same way rebaseBranch does so callers can re-render the
    // Resolve Conflicts dialog with the new file set.
    const statusResult = await this._gitCli.exec(['status', '--porcelain'], {
      cwd: repo.rootUri.fsPath,
    });
    const conflicts = parseStatus(statusResult.stdout)
      .filter((f) => f.indexStatus === 'U' || f.workTreeStatus === 'U')
      .map((f) => f.path);

    return {
      success: false,
      conflicts,
    };
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
  async rebaseAbort(repo: IRepository): Promise<void> {
    await this._gitCli.exec(['rebase', '--abort'], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
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
  async rebaseContinue(repo: IRepository): Promise<IBasicRebaseResult> {
    const result = await this._gitCli.exec(['rebase', '--continue'], {
      cwd: repo.rootUri.fsPath,
    });
    this.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      return { success: true };
    }

    const statusResult = await this._gitCli.exec(['status', '--porcelain'], {
      cwd: repo.rootUri.fsPath,
    });
    const conflicts = parseStatus(statusResult.stdout)
      .filter((f) => f.indexStatus === 'U' || f.workTreeStatus === 'U')
      .map((f) => f.path);

    if (conflicts.length > 0) {
      return {
        success: false,
        conflicts,
      };
    }

    return {
      success: false,
      conflicts: [],
      failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
    };
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
  async compareBranches(
    repo: IRepository,
    branch1: string,
    branch2: string
  ): Promise<IBranchComparison> {
    const cwd = repo.rootUri.fsPath;
    const format = getLogFormat();

    // Get ahead/behind counts using git rev-list --left-right --count
    // This returns: "ahead\tbehind"
    // branch1/branch2 are user-controlled; splice via buildGitArgs.
    const countResult = await this._gitCli.exec(
      buildGitArgs('rev-list', ['--left-right', '--count'], [`${branch1}...${branch2}`]),
      { cwd }
    );

    let aheadCount = 0;
    let behindCount = 0;

    if (countResult.exitCode === 0 && countResult.stdout.trim()) {
      const parts = countResult.stdout.trim().split(/\s+/);
      if (parts.length >= 2) {
        aheadCount = parseInt(parts[0], 10) || 0;
        behindCount = parseInt(parts[1], 10) || 0;
      }
    }

    // Get commits unique to branch1 (ahead commits)
    // git rev-list branch2..branch1 gives commits in branch1 not in branch2
    // Both branches splice via buildGitArgs.
    const commitsAhead: ICommit[] = [];
    if (aheadCount > 0) {
      const aheadResult = await this._gitCli.exec(
        buildGitArgs('log', [`--format=${format}`, '-z'], [`${branch2}..${branch1}`]),
        { cwd }
      );
      if (aheadResult.exitCode === 0 && aheadResult.stdout.trim()) {
        commitsAhead.push(...parseLog(aheadResult.stdout));
      }
    }

    // Get commits unique to branch2 (behind commits)
    // git rev-list branch1..branch2 gives commits in branch2 not in branch1
    const commitsBehind: ICommit[] = [];
    if (behindCount > 0) {
      const behindResult = await this._gitCli.exec(
        buildGitArgs('log', [`--format=${format}`, '-z'], [`${branch1}..${branch2}`]),
        { cwd }
      );
      if (behindResult.exitCode === 0 && behindResult.stdout.trim()) {
        commitsBehind.push(...parseLog(behindResult.stdout));
      }
    }

    // Get files that differ between branches.
    // Use `--name-only -z` so paths with whitespace
    // / non-ASCII characters split unambiguously on `\0` rather than the
    // old `\n` parse, which lost names containing literal newlines.
    const diffResult = await this._gitCli.exec(
      buildGitArgs('diff', ['--name-only', '-z'], [`${branch1}...${branch2}`]),
      {
        cwd,
      }
    );

    // `-z` separates entries with `\0`, not `\n`, so paths
    // containing newlines or whitespace round-trip safely.
    let changedFiles: string[] = [];
    if (diffResult.exitCode === 0 && diffResult.stdout.length > 0) {
      changedFiles = diffResult.stdout.split('\0').filter((f) => f.length > 0);
    }

    return {
      commitsAhead,
      commitsBehind,
      aheadCount,
      behindCount,
      changedFiles,
    };
  }

  // ============================================
  // Remote Operations
  // ============================================

  async fetch(repo: IRepository, optionsOrRemote?: IFetchOptions | string): Promise<IFetchResult> {
    // Back-compat: a plain string argument is treated as the remote name.
    const options: IFetchOptions =
      typeof optionsOrRemote === 'string' ? { remote: optionsOrRemote } : (optionsOrRemote ?? {});

    const args = ['fetch', '--porcelain'];
    if (options.prune) {
      args.push('--prune');
    }
    // Resolve tag-fetching policy. User-passed `tags` / `noTags` in
    // `options` always win over the `intellig.fetchTags` config so
    // programmatic callers (PushDialog retry, Pull dialog, etc.) can opt
    // out of the global policy. When neither the option nor the config
    // dictates a flag ("auto"), we emit no tag-related flag and let git's
    // own default (follow `remote.<remote>.tagOpt`) apply.
    if (options.tags) {
      args.push('--tags');
    } else if (options.noTags) {
      args.push('--no-tags');
    } else {
      const fetchTagsPolicy = vscode.workspace
        .getConfiguration('intellig')
        .get<string>('fetchTags', 'auto');
      if (fetchTagsPolicy === 'all') {
        args.push('--tags');
      } else if (fetchTagsPolicy === 'never') {
        args.push('--no-tags');
      }
      // 'auto' (and any unexpected value) → no flag.
    }
    if (options.all) {
      args.push('--all');
    } else if (options.remote) {
      args.push(options.remote);
    } else {
      args.push('--all');
    }

    const cliResult = await this._gitCli.exec(args, {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });

    const result = this._parseFetchPorcelain(cliResult.stdout, cliResult.stderr);
    this.invalidateCache(repo.rootUri.fsPath);
    this._onDidFetch.fire({ repo, result });
    return result;
  }

  /**
   * Parse `git fetch --porcelain` output.
   *
   * Each porcelain line has the shape `<flag> <old-sha> <new-sha> <ref>`
   * (whitespace-separated). We skip lines that do not conform and surface
   * stderr diagnostics as non-fatal errors.
   */
  private _parseFetchPorcelain(stdout: string, stderr: string): IFetchResult {
    const updatedRefs: IFetchRefUpdate[] = [];
    const errors: string[] = [];

    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const parts = line.split(/\s+/);
      if (parts.length < 4) {
        continue;
      }
      const oldSha = parts[1];
      const newSha = parts[2];
      const ref = parts.slice(3).join(' ');
      if (!/^[0-9a-f]{40}$/.test(newSha)) {
        continue;
      }
      if (oldSha === newSha) {
        continue;
      }
      updatedRefs.push({ ref, oldSha, newSha });
    }

    if (stderr) {
      for (const rawLine of stderr.split('\n')) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        // Skip informational lines git emits on stderr.
        if (/^From\s|^\s*->\s|^\s*\*\s|^\s*\+/.test(line)) {
          continue;
        }
        errors.push(line);
      }
    }

    return {
      updatedRefs,
      ahead: 0,
      behind: updatedRefs.length,
      errors,
    };
  }

  async pull(repo: IRepository, options?: IPullOptions): Promise<void> {
    // Order: git pull [--rebase|--ff-only|--no-ff] [--squash] [--no-commit] [--no-verify] <remote> <branch>
    // Split flags vs. refs (remote/branch) so buildGitArgs can
    // splice `--end-of-options` between them; defends against argv
    // injection through hostile remote/branch names.
    const flags: string[] = [];

    // Strategy flags are mutually exclusive; first non-empty wins to stay safe
    // even if the caller hasn't resolved the UI mutex.
    if (options?.rebase) {
      flags.push('--rebase');
    } else if (options?.ffOnly) {
      flags.push('--ff-only');
    } else if (options?.noFf) {
      flags.push('--no-ff');
    }

    if (options?.squash) {
      flags.push('--squash');
    }
    if (options?.noCommit) {
      flags.push('--no-commit');
    }
    if (options?.noVerify) {
      flags.push('--no-verify');
    }
    if (options?.prune) {
      flags.push('--prune');
    }

    const refs: string[] = [];
    if (options?.remote) {
      refs.push(options.remote);
    }
    if (options?.branch) {
      refs.push(options.branch);
    }

    const args = buildGitArgs('pull', flags, refs);
    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async push(repo: IRepository, options?: IPushOptions): Promise<void> {
    // Order: git push [--force|--force-with-lease] [--set-upstream] [--no-verify]
    //                 [--tags|--follow-tags] <remote> [<refspec>|<branch>]
    // Split flags vs. refs so buildGitArgs splices
    // `--end-of-options`; defends against argv injection through hostile
    // remote / refspec / branch names.
    const flags: string[] = [];

    // Force flags are mutually exclusive; `force` (bare --force) wins if a
    // caller sets both so the command can't silently downgrade the user's
    // explicit request. Safety policy still puts the onus on the UI to
    // prefer `forceWithLease`.
    if (options?.force) {
      flags.push('--force');
    } else if (options?.forceWithLease) {
      flags.push('--force-with-lease');
    }
    if (options?.setUpstream) {
      flags.push('--set-upstream');
    }
    if (options?.noVerify) {
      flags.push('--no-verify');
    }
    // Tag flags are mutually exclusive; prefer --follow-tags when both set
    // so we don't accidentally push unrelated tags.
    if (options?.followTags) {
      flags.push('--follow-tags');
    } else if (options?.tags) {
      flags.push('--tags');
    }

    const refs: string[] = [];
    if (options?.remote) {
      refs.push(options.remote);
    }
    // Explicit refspec (`local:target`) takes precedence over positional branch.
    if (options?.refspec) {
      refs.push(options.refspec);
    } else if (options?.branch) {
      refs.push(options.branch);
    }

    const args = buildGitArgs('push', flags, refs);
    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async getRemotes(repo: IRepository): Promise<IRemote[]> {
    const result = await this._gitCli.exec(['remote', '-v'], { cwd: repo.rootUri.fsPath });
    if (result.exitCode !== 0) {
      return [];
    }
    return parseRemotes(result.stdout);
  }

  async addRemote(repo: IRepository, name: string, url: string): Promise<void> {
    await this._gitCli.exec(['remote', 'add', name, url], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async removeRemote(repo: IRepository, name: string): Promise<void> {
    await this._gitCli.exec(['remote', 'remove', name], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  // ============================================
  // Stash Operations
  // ============================================

  async stash(repo: IRepository, message?: string, options?: IStashOptions): Promise<void> {
    const args = ['stash', 'push'];

    if (message) {
      args.push('-m', message);
    }
    if (options?.includeUntracked) {
      args.push('--include-untracked');
    }
    if (options?.keepIndex) {
      args.push('--keep-index');
    }

    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async stashList(repo: IRepository): Promise<IStash[]> {
    const result = await this._gitCli.exec(['stash', 'list'], { cwd: repo.rootUri.fsPath });
    if (result.exitCode !== 0) {
      return [];
    }
    return parseStashList(result.stdout);
  }

  /**
   * Validate a stash index before interpolating it into the
   * `stash@{<index>}` ref., `stashApply` / `stashPop` /
   * `stashDrop` / `stashShow` interpolated the raw `index` directly,
   * trusting upstream callers (CommitToolWindow / palette commands) to
   * pass a valid integer. A non-integer or negative value would
   * silently produce a malformed git ref like `stash@{NaN}` or
   * `stash@{undefined}`. The other stash methods (`stashBranch`,
   * `stashRename`) already validated; this helper reuses the same
   * predicate so the pattern is uniform across all 6 sites.
   *
   * Throws (rather than returns) so the caller can trust `index` is a
   * non-negative integer for the rest of the call.
   */
  private _validateStashIndex(index: number): asserts index is number {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid stash index: ${index}`);
    }
  }

  async stashApply(repo: IRepository, index: number): Promise<void> {
    this._validateStashIndex(index);
    await this._gitCli.exec(['stash', 'apply', `stash@{${index}}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async stashPop(repo: IRepository, index: number): Promise<void> {
    this._validateStashIndex(index);
    await this._gitCli.exec(['stash', 'pop', `stash@{${index}}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async stashDrop(repo: IRepository, index: number): Promise<void> {
    this._validateStashIndex(index);
    await this._gitCli.exec(['stash', 'drop', `stash@{${index}}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Create a branch rooted at a stashed state and apply the stash into it.
   * See {@link IGitService.stashBranch}.
   */
  async stashBranch(repo: IRepository, index: number, branchName: string): Promise<void> {
    if (!branchName || !branchName.trim()) {
      throw new Error('Branch name cannot be empty');
    }
    this._validateStashIndex(index);
    await this._gitCli.exec(['stash', 'branch', branchName.trim(), `stash@{${index}}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
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
  async stashRename(repo: IRepository, index: number, newMessage: string): Promise<void> {
    this._validateStashIndex(index);
    if (typeof newMessage !== 'string') {
      throw new Error('New stash message must be a string');
    }

    const cwd = repo.rootUri.fsPath;

    // Resolve the stash ref to a commit hash. Fails if the index
    // doesn't exist.
    const revParse = await this._gitCli.exec(['rev-parse', `stash@{${index}}`], {
      cwd,
      throwOnError: true,
    });
    const commitHash = revParse.stdout.trim();
    if (!commitHash || !/^[a-f0-9]{7,40}$/i.test(commitHash)) {
      throw new Error(`Could not resolve stash@{${index}} to a commit`);
    }

    // Store the commit back onto the stash stack with the new
    // message. This creates a duplicate entry at stash@{0}; the original
    // shifts to stash@{index+1}.
    await this._gitCli.exec(['stash', 'store', '-m', newMessage, commitHash], {
      cwd,
      throwOnError: true,
    });

    // Drop the original (now at index+1). If this fails we try to
    // undo step 2 so the user doesn't end up with a duplicate.
    try {
      await this._gitCli.exec(['stash', 'drop', `stash@{${index + 1}}`], {
        cwd,
        throwOnError: true,
      });
    } catch (error) {
      // Best-effort rollback of the duplicate.
      try {
        await this._gitCli.exec(['stash', 'drop', 'stash@{0}'], { cwd });
      } catch {
        // If rollback also fails, leave the state as-is; the error below
        // still surfaces to the caller.
      }
      throw error;
    }

    this.invalidateCache(cwd);
  }

  /**
   * View the contents/diff of a stash.
   *
   * @param repo - The repository
   * @param index - The stash index
   * @returns Array of diffs showing the stash contents
   */
  async stashShow(repo: IRepository, index: number): Promise<IDiff[]> {
    this._validateStashIndex(index);
    const result = await this._gitCli.exec(['stash', 'show', '-p', `stash@{${index}}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });

    return parseDiff(result.stdout);
  }

  // ============================================
  // Tag Operations
  // ============================================

  async getTags(repo: IRepository): Promise<ITag[]> {
    const format = getTagFormat();
    const result = await this._gitCli.exec(['tag', '-l', '--format', format], {
      cwd: repo.rootUri.fsPath,
    });

    if (result.exitCode !== 0) {
      return [];
    }

    return parseTags(result.stdout);
  }

  async createTag(repo: IRepository, name: string, message?: string, ref?: string): Promise<void> {
    // service-boundary reject tag names starting with `-`
    // (git would parse `-foo` as a CLI flag) or `.` (invalid per
    // git-check-ref-format). Mirrors the `createBranch` guard.
    if (!name || name.startsWith('-') || name.startsWith('.')) {
      throw new Error(`Invalid tag name: ${name}`);
    }
    // Splice `--end-of-options` between flags and the
    // user-controlled `name` (and optional `ref`). Layouts:
    //   lightweight: `tag --end-of-options <name> [<ref>]`
    //   annotated  : `tag -a -m <msg> --end-of-options <name> [<ref>]`
    // Verified: `tag -a --end-of-options <name> -m <msg>` FAILS because
    // `-m` becomes a non-option arg after `--end-of-options`. We therefore
    // place `-m <msg>` BEFORE the separator.
    const flags: string[] = [];
    if (message) {
      flags.push('-a', '-m', message);
    }
    const refs: string[] = [name];
    if (ref) {
      refs.push(ref);
    }
    const args = buildGitArgs('tag', flags, refs);

    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async deleteTag(repo: IRepository, name: string): Promise<void> {
    // service-boundary reject tag names starting with `-`
    // (git would parse `-foo` as a CLI flag) or `.` (invalid per
    // git-check-ref-format). Also splice `--end-of-options` between the
    // `-d` flag and the user-controlled name as structural defense in
    // depth.
    if (!name || name.startsWith('-') || name.startsWith('.')) {
      throw new Error(`Invalid tag name: ${name}`);
    }
    await this._gitCli.exec(buildGitArgs('tag', ['-d'], [name]), {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async pushTag(repo: IRepository, name: string, remote?: string): Promise<void> {
    // `name` (and `remote`) are user-controlled; splice via buildGitArgs.
    const args = buildGitArgs('push', [], [remote || 'origin', `refs/tags/${name}`]);
    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
  }

  // ============================================
  // History Operations
  // ============================================

  async getLog(repo: IRepository, options?: ILogOptions): Promise<ICommit[]> {
    const format = getLogFormat();
    const args = ['log', `--format=${format}`, '-z'];

    if (options?.maxCount) {
      args.push(`-n${options.maxCount}`);
    }
    if (options?.skip) {
      args.push(`--skip=${options.skip}`);
    }
    if (options?.author) {
      args.push(`--author=${options.author}`);
    }
    if (options?.since) {
      args.push(`--since=${options.since.toISOString()}`);
    }
    if (options?.until) {
      args.push(`--until=${options.until.toISOString()}`);
    }
    if (options?.grep) {
      args.push(`--grep=${options.grep}`);
    }
    if (options?.all) {
      args.push('--exclude=refs/stash', '--all');
    }
    if (options?.topoOrder) {
      // git's default is date-driven ("show commit, then show its
      // parents in date order"), which interleaves divergent branches
      // and breaks graph rendering after history rewrites (rebase /
      // squash / cherry-pick give commits a "now" committerDate even
      // when their topology hasn't changed). `--topo-order` walks
      // ancestry in topological order so consumers can rely on a
      // commit's parent appearing later in the output. The graph
      // pipeline sets this; non-graph callers (search, file history)
      // can leave it off if they want git's default.
      args.push('--topo-order');
    }
    if (options?.path) {
      args.push('--', options.path);
    }

    const result = await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath });
    if (result.exitCode !== 0) {
      return [];
    }

    return parseLog(result.stdout);
  }

  async getCommit(repo: IRepository, hash: string): Promise<ICommit> {
    const format = getLogFormat();
    // `hash` is user-controlled; splice via buildGitArgs.
    const result = await this._gitCli.exec(
      buildGitArgs('show', ['-s', `--format=${format}`, '-z'], [hash]),
      {
        cwd: repo.rootUri.fsPath,
        throwOnError: true,
      }
    );

    const commit = parseCommit(result.stdout);
    if (!commit) {
      throw new Error(`Failed to parse commit: ${hash}`);
    }

    return commit;
  }

  async getFileHistory(
    repo: IRepository,
    path: string,
    options?: IFileHistoryOptions
  ): Promise<ICommit[]> {
    // Standalone implementation so we can pass `--follow` and a
    // branch ref that the generic `getLog()` doesn't understand.
    // `branch` is user-controlled; splice via buildGitArgs so
    // `--end-of-options` separates flag args from the ref.
    const format = getLogFormat();
    const flags: string[] = [`--format=${format}`, '-z'];

    if (options?.follow) {
      flags.push('--follow');
    }
    if (options?.maxCount !== undefined && options.maxCount > 0) {
      flags.push('-n', String(options.maxCount));
    }

    const refs: string[] = [];
    if (options?.branch) {
      // A branch/ref name — git log understands both local and remote refs.
      refs.push(options.branch);
    }

    // buildGitArgs writes the trailing `-- <path>` for us when `paths` is
    // non-undefined.
    const args = buildGitArgs('log', flags, refs, [path]);

    const result = await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath });
    if (result.exitCode !== 0) {
      return [];
    }
    return parseLog(result.stdout);
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
  async getCherryMarks(
    repo: IRepository,
    baseRef: string
  ): Promise<Map<string, import('./interfaces/IGitService').CherryMark>> {
    const out = new Map<string, import('./interfaces/IGitService').CherryMark>();
    if (!baseRef) {
      return out;
    }

    try {
      // %m emits one of `<`, `>`, `=`, `+`, `-` per commit per --cherry-mark docs.
      // `baseRef` is user-controlled; splice via buildGitArgs.
      const result = await this._gitCli.exec(
        buildGitArgs(
          'log',
          ['--cherry-mark', '--left-right', '--pretty=format:%H %m'],
          [`HEAD...${baseRef}`]
        ),
        {
          cwd: repo.rootUri.fsPath,
          throwOnError: false,
        }
      );
      if (result.exitCode !== 0 || !result.stdout) {
        return out;
      }
      const lines = result.stdout.split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) {
          continue;
        }
        // Format: "<hash> <mark>" — hash is 40 hex, mark is one char.
        const space = line.indexOf(' ');
        if (space !== 40) {
          continue;
        }
        const hash = line.substring(0, 40);
        const mark = line.substring(space + 1).trim();
        if (isCherryMark(mark)) {
          out.set(hash, mark);
        }
      }
    } catch {
      // Swallow — the UI degrades to "no highlights" rather than surfacing
      // an error toast for a non-essential visual cue.
    }
    return out;
  }

  // ============================================
  // Diff Operations
  // ============================================

  async getDiff(repo: IRepository, path: string, staged?: boolean): Promise<IDiff> {
    const args = ['diff'];
    if (staged) {
      args.push('--cached');
    }
    args.push('--', path);

    const result = await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath });
    const diffs = parseDiff(result.stdout);

    // Return the first diff or an empty diff
    return (
      diffs[0] || {
        path,
        status: 'modified',
        hunks: [],
        binary: false,
      }
    );
  }

  async getCommitDiff(repo: IRepository, hash: string): Promise<IDiff[]> {
    // `hash` is user-controlled; splice via buildGitArgs so a
    // hostile ref like `--upload-pack=evil` cannot land as a flag.
    const result = await this._gitCli.exec(buildGitArgs('show', ['--format='], [hash]), {
      cwd: repo.rootUri.fsPath,
    });

    return parseDiff(result.stdout);
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
  async getMultiCommitDiff(repo: IRepository, commits: string[]): Promise<IDiff[]> {
    if (commits.length === 0) {
      return [];
    }

    // For a single commit, just return its diff
    if (commits.length === 1) {
      return this.getCommitDiff(repo, commits[0]);
    }

    const cwd = repo.rootUri.fsPath;

    // Get commit dates + parents to sort them chronologically.
    // We need the oldest and newest commits to compute the range, and we
    // need parent hashes so `sortCommitsStable` can resolve date ties
    // topologically (parent-before-child) rather than by hash-alphabetical
    // alone. Same-second timestamps are common in imported histories and
    // squash-and-rebase flows; ordering a child before its parent would
    // push the diff "base" past the child and silently drop edits.
    const commitInfos: { hash: string; commitDate: Date; parents: string[] }[] = [];

    for (const hash of commits) {
      // `%cI` (commit-date ISO-8601) + `%P` (space-separated parent hashes),
      // separated by a tab so we can split unambiguously.
      // `hash` is user-controlled; splice via buildGitArgs.
      const result = await this._gitCli.exec(
        buildGitArgs('show', ['-s', '--format=%cI%x09%P'], [hash]),
        { cwd }
      );
      if (result.exitCode === 0 && result.stdout.trim()) {
        const [iso, parentsLine = ''] = result.stdout.trim().split('\t');
        const parents = parentsLine.split(/\s+/).filter((p) => p.length > 0);
        commitInfos.push({
          hash,
          commitDate: new Date(iso),
          parents,
        });
      }
    }

    if (commitInfos.length === 0) {
      return [];
    }

    // Deterministic sort: primary by commit date, secondary by
    // parent-before-child (topological) inside date-tied groups, and only
    // falling back to hash-alphabetical when no parent edge disambiguates.
    // See `src/utils/commitSort.ts` for the full rationale.
    const sortedInfos = sortCommitsStable(commitInfos);

    const oldestCommit = sortedInfos[0].hash;
    const newestCommit = sortedInfos[sortedInfos.length - 1].hash;

    // Get the parent of the oldest commit to use as the base
    // If the oldest commit has no parent (initial commit), use the empty tree
    // `oldestCommit` is user-controlled; splice via buildGitArgs.
    const parentResult = await this._gitCli.exec(
      buildGitArgs('rev-parse', [], [`${oldestCommit}^`]),
      { cwd }
    );

    let baseRef: string;
    if (parentResult.exitCode === 0 && parentResult.stdout.trim()) {
      baseRef = parentResult.stdout.trim();
    } else {
      // No parent - use empty tree SHA (Git's magic empty tree)
      baseRef = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    }

    // Get the diff between the base and the newest commit.
    // Both refs are user-controlled (well, baseRef may be a
    // computed parent SHA; newestCommit is direct user input). Splice
    // via buildGitArgs.
    const diffResult = await this._gitCli.exec(buildGitArgs('diff', [], [baseRef, newestCommit]), {
      cwd,
    });

    return parseDiff(diffResult.stdout);
  }

  /**
   * List files that differ between the given ref and the working tree.
   * Uses `git diff --name-status -z <ref>` for robust parsing (NUL-delimited,
   * so paths with whitespace or non-ASCII characters are handled correctly).
   */
  async getChangedFilesAgainstWorkingTree(repo: IRepository, ref: string): Promise<IRefDiffFile[]> {
    // `ref` is user-controlled; splice via buildGitArgs.
    const result = await this._gitCli.exec(buildGitArgs('diff', ['--name-status', '-z'], [ref]), {
      cwd: repo.rootUri.fsPath,
    });

    if (result.exitCode !== 0) {
      return [];
    }

    // `git diff --name-status -z` output format:
    //   <status>\0<path>\0                  for M/A/D/T/U entries
    // <status>\0<oldPath>\0<newPath>\0 for R/C entries (status can be `R100`, ``, …)
    const tokens = result.stdout.split('\0').filter((t) => t.length > 0);
    const files: IRefDiffFile[] = [];
    let i = 0;
    while (i < tokens.length) {
      const rawStatus = tokens[i];
      const statusChar = rawStatus.charAt(0).toUpperCase();
      i += 1;

      if (statusChar === 'R' || statusChar === 'C') {
        const oldPath = tokens[i];
        const newPath = tokens[i + 1];
        i += 2;
        if (newPath) {
          files.push({
            path: newPath,
            status: statusChar,
            oldPath,
          });
        }
      } else if (
        statusChar === 'M' ||
        statusChar === 'A' ||
        statusChar === 'D' ||
        statusChar === 'T' ||
        statusChar === 'U'
      ) {
        const filePath = tokens[i];
        i += 1;
        if (filePath) {
          files.push({
            path: filePath,
            status: statusChar,
          });
        }
      } else {
        // Unknown status; skip the following path token to stay aligned.
        i += 1;
      }
    }

    return files;
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
  async getMergeBase(repo: IRepository, refA: string, refB: string): Promise<string | undefined> {
    try {
      const result = await this._gitCli.exec(['merge-base', '--end-of-options', refA, refB], {
        cwd: repo.rootUri.fsPath,
      });
      if (result.exitCode !== 0) {
        return undefined;
      }
      const sha = result.stdout.trim();
      return sha.length > 0 ? sha : undefined;
    } catch {
      // Defensive: GitCli throws on spawn errors / disposed repos.
      // Trap T-8 — caller treats undefined as "no path-to-merge-base".
      return undefined;
    }
  }

  // ============================================
  // Blame Operations
  // ============================================

  async getBlame(repo: IRepository, path: string): Promise<IBlameLine[]> {
    // `path` is user-controlled; splice with `--` separator
    // via buildGitArgs so a path that starts with `-` cannot collapse
    // into a flag (e.g., `--git-dir=evil`).
    const result = await this._gitCli.exec(buildGitArgs('blame', ['--porcelain'], [], [path]), {
      cwd: repo.rootUri.fsPath,
    });

    if (result.exitCode !== 0) {
      return [];
    }

    return parseBlame(result.stdout);
  }

  // ============================================
  // Cherry-pick and Revert
  // ============================================

  /**
   * Cherry-pick one or more commits onto the current branch.
   * Commits are applied in the order provided.
   *
   * @param repo - The repository
   * @param commits - Array of commit hashes to cherry-pick
   * @returns Cherry-pick result with success status and any conflicts
   */
  async cherryPick(
    repo: IRepository,
    commits: string[],
    options?: ICherryPickOptions
  ): Promise<ICherryPickResult> {
    if (commits.length === 0) {
      return { success: true };
    }

    // File-subset mode ("Apply Selected Changes"): an empty array
    // means "no files picked" — short-circuit rather than erasing the
    // index. Caller should never invoke with an empty list; return success
    // defensively.
    if (options?.files && options.files.length === 0) {
      return { success: true };
    }

    // When `files` is set we force --no-commit because we need to mutate
    // the index afterwards to narrow to the selected file set.
    const noCommit = options?.noCommit === true || options?.files !== undefined;

    // `commits` are user-controlled; splice via buildGitArgs.
    const cherryFlags: string[] = [];
    if (noCommit) {
      cherryFlags.push('--no-commit');
    }
    const args = buildGitArgs('cherry-pick', cherryFlags, commits);

    const result = await this._gitCli.exec(args, {
      cwd: repo.rootUri.fsPath,
    });

    this.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode !== 0) {
      // Check for conflicts (plain cherry-pick path).
      const conflicts = await this.getConflictedFiles(repo);
      if (conflicts.length > 0) {
        return {
          success: false,
          conflicts,
        };
      }
      // Non-conflict failure (bad object, refused operation, dirty tree
      // for a non-conflicting reason, etc.). Surface git's stderr so the
      // caller can show it instead of dropping the failure silently.
      return {
        success: false,
        conflicts: [],
        failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
      };
    }

    // Success path: if a file subset was requested, narrow the index +
    // worktree down to those files. Every file touched by the commits that
    // is NOT in the subset is unstaged and restored to its HEAD content.
    if (options?.files && options.files.length > 0) {
      const touched = await this._collectTouchedFiles(repo, commits);
      const keep = new Set(options.files);
      const drop = touched.filter((f) => !keep.has(f));
      if (drop.length > 0) {
        await this._restoreFilesToHead(repo, drop);
      }
      this.invalidateCache(repo.rootUri.fsPath);
    }

    return { success: true };
  }

  /**
   * Return the union of files touched by each commit (via
   * `git show --name-only --format=`). Used by the `files` subset path to
   * determine which files to revert after a `cherry-pick -n`.
   */
  private async _collectTouchedFiles(repo: IRepository, commits: string[]): Promise<string[]> {
    const touched = new Set<string>();
    for (const commit of commits) {
      // `commit` is user-controlled; splice via buildGitArgs.
      const res = await this._gitCli.exec(
        buildGitArgs('show', ['--name-only', '--format='], [commit]),
        {
          cwd: repo.rootUri.fsPath,
        }
      );
      if (res.exitCode !== 0) {
        continue;
      }
      for (const rawLine of res.stdout.split('\n')) {
        const line = rawLine.trim();
        if (line.length > 0) {
          touched.add(line);
        }
      }
    }
    return [...touched];
  }

  /**
   * Unstage + restore a set of files to their HEAD content. Used by the
   * cherry-pick file-subset path to drop files outside the user's
   * selection. Batches the `reset` and `checkout` calls (one call each
   * for the whole set) to avoid N round-trips.
   */
  private async _restoreFilesToHead(repo: IRepository, files: string[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    // Unstage (may fail if already unstaged; we tolerate that).
    await this._gitCli.exec(['reset', 'HEAD', '--', ...files], {
      cwd: repo.rootUri.fsPath,
    });
    // Restore working-tree copy.
    await this._gitCli.exec(['checkout', '--', ...files], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
  }

  /**
   * Abort an in-progress cherry-pick operation.
   * Restores the working directory to its pre-cherry-pick state.
   *
   * @param repo - The repository
   */
  async cherryPickAbort(repo: IRepository): Promise<void> {
    await this._gitCli.exec(['cherry-pick', '--abort'], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Continue a cherry-pick operation after resolving conflicts.
   *
   * @param repo - The repository
   * @returns Cherry-pick result with success status and any new conflicts
   */
  async cherryPickContinue(repo: IRepository): Promise<ICherryPickResult> {
    const result = await this._gitCli.exec(['cherry-pick', '--continue'], {
      cwd: repo.rootUri.fsPath,
    });

    this.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      return { success: true };
    }

    // Check for conflicts (there might be more commits to cherry-pick)
    const conflicts = await this.getConflictedFiles(repo);

    if (conflicts.length > 0) {
      return {
        success: false,
        conflicts,
      };
    }

    // Non-conflict failure: surface git's stderr so the caller can show
    // it instead of dropping the failure silently.
    return {
      success: false,
      conflicts: [],
      failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
    };
  }

  /**
   * Get the list of conflicted files in the repository.
   *
   * @param repo - The repository
   * @returns Array of conflicted file paths
   */
  private async getConflictedFiles(repo: IRepository): Promise<string[]> {
    const statusResult = await this._gitCli.exec(['status', '--porcelain'], {
      cwd: repo.rootUri.fsPath,
    });
    return parseStatus(statusResult.stdout)
      .filter((f) => f.indexStatus === 'U' || f.workTreeStatus === 'U')
      .map((f) => f.path);
  }

  async revert(repo: IRepository, commits: string[]): Promise<IRevertResult> {
    if (commits.length === 0) {
      return { success: true };
    }

    // `commits` are user-controlled; splice via buildGitArgs.
    const result = await this._gitCli.exec(buildGitArgs('revert', ['--no-edit'], commits), {
      cwd: repo.rootUri.fsPath,
    });

    this.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      return { success: true };
    }

    // Check for conflicts
    const conflicts = await this.getConflictedFiles(repo);

    if (conflicts.length > 0) {
      return {
        success: false,
        conflicts,
      };
    }

    // Non-conflict failure: surface git's stderr so the caller can show
    // it instead of dropping the failure silently.
    return {
      success: false,
      conflicts: [],
      failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
    };
  }

  /**
   * Abort an in-progress revert operation.
   * Restores the working directory to its pre-revert state.
   *
   * @param repo - The repository
   */
  async revertAbort(repo: IRepository): Promise<void> {
    await this._gitCli.exec(['revert', '--abort'], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Continue a revert operation after resolving conflicts.
   *
   * @param repo - The repository
   * @returns Revert result with success status and any new conflicts
   */
  async revertContinue(repo: IRepository): Promise<IRevertResult> {
    const result = await this._gitCli.exec(['revert', '--continue'], {
      cwd: repo.rootUri.fsPath,
    });

    this.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      return { success: true };
    }

    // Check for conflicts (there might be more commits to revert)
    const conflicts = await this.getConflictedFiles(repo);

    if (conflicts.length > 0) {
      return {
        success: false,
        conflicts,
      };
    }

    // Non-conflict failure: surface git's stderr so the caller can show
    // it instead of dropping the failure silently.
    return {
      success: false,
      conflicts: [],
      failureReason: sanitizeGitError(result.stderr.trim() || result.stdout.trim()) || undefined,
    };
  }

  // ============================================
  // Status Operations
  // ============================================

  async getStatus(repo: IRepository): Promise<IFileStatus[]> {
    const result = await this._gitCli.exec(['status', '--porcelain'], {
      cwd: repo.rootUri.fsPath,
    });

    if (result.exitCode !== 0) {
      return [];
    }

    return parseStatus(result.stdout);
  }

  async stage(repo: IRepository, paths: string[]): Promise<void> {
    await this._gitCli.exec(['add', '--', ...paths], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async unstage(repo: IRepository, paths: string[]): Promise<void> {
    await this._gitCli.exec(['reset', 'HEAD', '--', ...paths], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Stage a single hunk from a file.
   *
   * @param repo - The repository
   * @param path - The file path
   * @param hunk - The hunk to stage
   */
  async stageHunk(repo: IRepository, path: string, hunk: IHunk): Promise<void> {
    // Generate a patch for the hunk
    const patch = this.generateHunkPatch(path, hunk);

    await this._gitCli.exec(['apply', '--cached', '-'], {
      cwd: repo.rootUri.fsPath,
      input: patch,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Stage specific lines within a file.
   * This generates a custom patch that includes only the specified lines.
   *
   * @param repo - The repository
   * @param path - The file path
   * @param lines - Array of line numbers (1-indexed) in the new file to stage
   * @param hunk - The hunk containing the lines to stage
   */
  async stageLines(repo: IRepository, path: string, lines: number[], hunk: IHunk): Promise<void> {
    if (lines.length === 0) {
      return;
    }

    // Generate a patch that includes only the specified lines
    const patch = this.generateLinesPatch(path, lines, hunk);

    await this._gitCli.exec(['apply', '--cached', '-'], {
      cwd: repo.rootUri.fsPath,
      input: patch,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Unstage a single hunk from a file.
   * This generates a reverse patch and applies it to the index.
   *
   * @param repo - The repository
   * @param path - The file path
   * @param hunk - The hunk to unstage
   */
  async unstageHunk(repo: IRepository, path: string, hunk: IHunk): Promise<void> {
    // Generate a patch for the hunk
    const patch = this.generateHunkPatch(path, hunk);

    // Apply the patch in reverse to unstage
    await this._gitCli.exec(['apply', '--cached', '-R', '-'], {
      cwd: repo.rootUri.fsPath,
      input: patch,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Revert (discard) uncommitted changes to a file.
   * This restores the file to its last committed state.
   *
   * @param repo - The repository
   * @param path - The file path to revert
   */
  async revertFile(repo: IRepository, path: string): Promise<void> {
    // Use git checkout -- <path> to discard changes
    // This works for both modified and deleted files
    await this._gitCli.exec(['checkout', '--', path], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Reset the current branch to the given target commit using one of the four
   * IntelliJ reset modes.
   */
  async resetToCommit(repo: IRepository, target: string, mode: ResetMode): Promise<void> {
    // Security: reject refs starting with `-` (git would treat them as CLI
    // flags, bypassing the argv-spawn defense) or `.` (invalid per
    // git-check-ref-format). Mirrors the ResetDialog.isValidRef guard.
    if (!target || !/^(?![-.])[A-Za-z0-9_./@:~^-]+$/.test(target)) {
      throw new Error(`Invalid reset target: ${target}`);
    }
    const modeFlag = `--${mode}`;
    await this._gitCli.exec(['reset', modeFlag, target], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Generate a patch string for a single hunk.
   *
   * @param path - The file path
   * @param hunk - The hunk to generate a patch for
   * @returns The patch string
   */
  private generateHunkPatch(path: string, hunk: IHunk): string {
    const lines: string[] = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      hunk.header,
    ];

    for (const line of hunk.lines) {
      switch (line.type) {
        case 'add':
          lines.push(`+${line.content}`);
          break;
        case 'delete':
          lines.push(`-${line.content}`);
          break;
        case 'context':
          lines.push(` ${line.content}`);
          break;
      }
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Generate a patch string for specific lines within a hunk.
   * This creates a patch that only includes the selected lines while
   * converting unselected additions to context and keeping unselected deletions.
   *
   * @param path - The file path
   * @param selectedLines - Array of line numbers (1-indexed) in the new file to include
   * @param hunk - The hunk containing the lines
   * @returns The patch string
   */
  private generateLinesPatch(path: string, selectedLines: number[], hunk: IHunk): string {
    const selectedSet = new Set(selectedLines);

    // Build the new hunk with only selected lines
    const newLines: IDiffLine[] = [];
    let currentNewLine = hunk.newStart;
    let oldLines = 0;
    let newLinesCount = 0;

    for (const line of hunk.lines) {
      if (line.type === 'context') {
        // Context lines are always included
        newLines.push(line);
        oldLines++;
        newLinesCount++;
        currentNewLine++;
      } else if (line.type === 'add') {
        if (selectedSet.has(currentNewLine)) {
          // Include selected additions
          newLines.push(line);
          newLinesCount++;
        } else {
          // Convert unselected additions to context (they exist in working copy)
          // Skip them - they won't be staged
        }
        currentNewLine++;
      } else if (line.type === 'delete') {
        // For deletions, we need to check if the corresponding line is selected
        // Deletions don't have a new line number, so we include them if any
        // adjacent additions are selected, or always include them for simplicity
        // In practice, line-level staging of deletions is complex
        // For now, include deletions that are explicitly selected or adjacent to selected lines
        const lineNumber = line.oldLineNumber;
        if (lineNumber !== undefined && selectedSet.has(lineNumber)) {
          newLines.push(line);
          oldLines++;
        } else {
          // Convert unselected deletions to context
          newLines.push({
            type: 'context',
            content: line.content,
            oldLineNumber: line.oldLineNumber,
            newLineNumber: currentNewLine,
          });
          oldLines++;
          newLinesCount++;
        }
      }
    }

    // If no lines were actually selected for staging, return empty
    const hasChanges = newLines.some((l) => l.type === 'add' || l.type === 'delete');
    if (!hasChanges) {
      return '';
    }

    // Generate the new hunk header
    const newHeader = `@@ -${hunk.oldStart},${oldLines} +${hunk.newStart},${newLinesCount} @@`;

    const patchLines: string[] = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      newHeader,
    ];

    for (const line of newLines) {
      switch (line.type) {
        case 'add':
          patchLines.push(`+${line.content}`);
          break;
        case 'delete':
          patchLines.push(`-${line.content}`);
          break;
        case 'context':
          patchLines.push(` ${line.content}`);
          break;
      }
    }

    return patchLines.join('\n') + '\n';
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
    // reflects pre-teardown state (Requirement 6.1: watcher teardown
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

    // Issue #219: dispose every registered watcher family uniformly.
    // This loop previously hardcoded `_fileWatchers` then `_newRepoWatchers`;
    // a future family added without remembering this site would leak its
    // watchers across window reloads. The registry walker is the single
    // touchpoint so adding a new family means only `this._watcherMaps.push(...)`
    // in the constructor.
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

/** Type guard for a single-char `git log --cherry-mark` output. */
function isCherryMark(value: string): value is import('./interfaces/IGitService').CherryMark {
  return value === '=' || value === '+' || value === '-' || value === '<' || value === '>';
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
