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
import { GitCli, IGitCommandOptions, createGitCli } from '../utils/gitCli';
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
} from '../utils/gitParser';
import { sortCommitsStable } from '../utils/commitSort';
import { safeFireAndForget } from '../utils/safeFireAndForget';

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
   * Event fired when a fetch completes (successful or not)
   */
  readonly onDidFetch: vscode.Event<{ repo: IRepository; result: IFetchResult }>;

  constructor(gitPath?: string) {
    this._gitCli = createGitCli(gitPath);
    this._onDidChangeRepository = new vscode.EventEmitter<IRepository>();
    this.onDidChangeRepository = this._onDidChangeRepository.event;
    this._onDidFetch = new vscode.EventEmitter<{ repo: IRepository; result: IFetchResult }>();
    this.onDidFetch = this._onDidFetch.event;

    // Forward Git command events for console logging
    this._disposables.push(
      this._gitCli.onCommandExecuted((event) => {
        // This can be used by the Console View to display command output
        console.log(`Git: ${event.args.join(' ')}`);
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

    // Load repository information
    return this.loadRepository(rootPath);
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
   * Discover a repository at the given path.
   *
   * @param path - The path to check
   */
  private async discoverRepository(path: string): Promise<void> {
    const rootPath = await this._gitCli.getRepositoryRoot(path);
    if (rootPath) {
      await this.loadRepository(rootPath);
      this.setupRepositoryWatcher(rootPath);
    }
  }

  /**
   * Load repository information from Git.
   *
   * @param rootPath - The repository root path
   * @returns The repository
   */
  private async loadRepository(rootPath: string): Promise<IRepository> {
    const options: IGitCommandOptions = { cwd: rootPath };

    // Get HEAD information
    let head;
    try {
      const branchResult = await this._gitCli.exec(['symbolic-ref', 'HEAD'], options);
      const commitResult = await this._gitCli.exec(['rev-parse', 'HEAD'], options);

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
        branchResult.stdout,
        commitResult.stdout,
        upstreamResult?.exitCode === 0 ? upstreamResult.stdout : undefined,
        aheadBehindResult?.exitCode === 0 ? aheadBehindResult.stdout : undefined
      );
    } catch {
      // Repository might be empty or in detached HEAD state
    }

    // Get repository state
    let state: RepositoryState = 'idle';
    try {
      const statusResult = await this._gitCli.exec(['status'], options);
      state = parseRepositoryState(statusResult.stdout);
    } catch {
      // Ignore errors
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
        // own errors internally (see the try/catch that logs to
        // console.error around `loadRepository`), but we still route the
        // outer call through safeFireAndForget so a future unhandled-
        // rejection path doesn't regress silently.
        safeFireAndForget(
          this._performDebouncedRefresh(rootPath),
          `GitService.setupRepositoryWatcher: debounced refresh for ${rootPath}`
        );
      }, GitService.WATCHER_DEBOUNCE_MS);
      this._refreshTimers.set(rootPath, timer);
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
      watcher.onDidDelete(handleChange);
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
    const reload = this.loadRepository(rootPath);
    this._reloading.set(rootPath, reload);
    // Resolve the reload inside try/finally so the _reloading entry is
    // always cleared, but fire the emitter *outside* the catch block:
    // otherwise a subscriber throwing synchronously gets re-wrapped as a
    // "repository reload failed" error, which is both misleading and hides
    // the real bug location.
    let repo: IRepository | undefined;
    try {
      repo = await reload;
    } catch (err) {
      console.error(`GitService: repository reload for ${rootPath} failed:`, err);
    } finally {
      this._reloading.delete(rootPath);
    }
    if (repo && !this._disposed) {
      this._onDidChangeRepository.fire(repo);
    }
  }

  /**
   * Remove a repository watcher.
   *
   * @param rootPath - The repository root path
   */
  private removeRepositoryWatcher(rootPath: string): void {
    const watchers = this._fileWatchers.get(rootPath);
    if (watchers) {
      for (const watcher of watchers) {
        watcher.dispose();
      }
      this._fileWatchers.delete(rootPath);
    }
    const timer = this._refreshTimers.get(rootPath);
    if (timer) {
      clearTimeout(timer);
      this._refreshTimers.delete(rootPath);
    }
    this._reloading.delete(rootPath);
    this._repositories.delete(rootPath);
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
    // T2-06: `--author="Name <email>"` override.
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

    // T3-03: when `checkout: true`, use `git checkout -[B] <name> <startPoint>`
    // so the branch is created AND switched to in a single atomic command.
    // Using `-B` when force is also set gives us "reset-and-checkout" in one
    // shot — matches IntelliJ's "Overwrite if exists" + "Checkout" combo.
    if (options.checkout) {
      const args = ['checkout'];
      args.push(options.force ? '-B' : '-b');
      args.push(name);
      if (options.track) {
        args.push('--track');
      }
      if (options.startPoint) {
        args.push(options.startPoint);
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
      args.push(options.startPoint);
    }

    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async checkout(repo: IRepository, ref: string, options?: ICheckoutOptions): Promise<void> {
    const args = ['checkout'];

    if (options?.createBranch) {
      args.push('-b', ref);
    } else {
      if (options?.force) {
        args.push('-f');
      }
      args.push(ref);
    }

    if (options?.createBranch && options?.force) {
      args.push('-f');
    }

    if (options?.track) {
      args.push('--track', options.track);
    }

    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async deleteBranch(repo: IRepository, name: string, force?: boolean): Promise<void> {
    const args = ['branch', force ? '-D' : '-d', name];
    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async renameBranch(repo: IRepository, oldName: string, newName: string): Promise<void> {
    await this._gitCli.exec(['branch', '-m', oldName, newName], {
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
    const args = ['merge'];
    if (options?.ffOnly) {
      args.push('--ff-only');
    } else if (options?.noFf) {
      args.push('--no-ff');
    }
    if (options?.squash) {
      args.push('--squash');
    }
    if (options?.noCommit) {
      args.push('--no-commit');
    }
    if (options?.message && options.message.length > 0) {
      args.push('-m', options.message);
    }
    args.push(branch);

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

    return {
      success: false,
      conflicts,
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
    const result = await this._gitCli.exec(['rebase', onto], { cwd: repo.rootUri.fsPath });
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

    return {
      success: false,
      conflicts,
    };
  }

  /**
   * Skip the current commit during an in-progress rebase (T3-05).
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
    const countResult = await this._gitCli.exec(
      ['rev-list', '--left-right', '--count', `${branch1}...${branch2}`],
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
    const commitsAhead: ICommit[] = [];
    if (aheadCount > 0) {
      const aheadResult = await this._gitCli.exec(
        ['log', `--format=${format}`, '-z', `${branch2}..${branch1}`],
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
        ['log', `--format=${format}`, '-z', `${branch1}..${branch2}`],
        { cwd }
      );
      if (behindResult.exitCode === 0 && behindResult.stdout.trim()) {
        commitsBehind.push(...parseLog(behindResult.stdout));
      }
    }

    // Get files that differ between branches
    // git diff --name-only branch1...branch2 shows files changed between the merge base and branch2
    // We use branch1..branch2 to get all files that differ
    const diffResult = await this._gitCli.exec(['diff', '--name-only', `${branch1}...${branch2}`], {
      cwd,
    });

    let changedFiles: string[] = [];
    if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
      changedFiles = diffResult.stdout
        .trim()
        .split('\n')
        .filter((f) => f.length > 0);
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
    // T3-12: resolve tag-fetching policy. User-passed `tags` / `noTags` in
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
    const args = ['pull'];

    // Strategy flags are mutually exclusive; first non-empty wins to stay safe
    // even if the caller hasn't resolved the UI mutex.
    if (options?.rebase) {
      args.push('--rebase');
    } else if (options?.ffOnly) {
      args.push('--ff-only');
    } else if (options?.noFf) {
      args.push('--no-ff');
    }

    if (options?.squash) {
      args.push('--squash');
    }
    if (options?.noCommit) {
      args.push('--no-commit');
    }
    if (options?.noVerify) {
      args.push('--no-verify');
    }

    if (options?.remote) {
      args.push(options.remote);
    }
    if (options?.branch) {
      args.push(options.branch);
    }

    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async push(repo: IRepository, options?: IPushOptions): Promise<void> {
    // Order: git push [--force|--force-with-lease] [--set-upstream] [--no-verify]
    //                 [--tags|--follow-tags] <remote> [<refspec>|<branch>]
    const args = ['push'];

    // Force flags are mutually exclusive; `force` (bare --force) wins if a
    // caller sets both so the command can't silently downgrade the user's
    // explicit request. Safety policy still puts the onus on the UI to
    // prefer `forceWithLease`.
    if (options?.force) {
      args.push('--force');
    } else if (options?.forceWithLease) {
      args.push('--force-with-lease');
    }
    if (options?.setUpstream) {
      args.push('--set-upstream');
    }
    if (options?.noVerify) {
      args.push('--no-verify');
    }
    // Tag flags are mutually exclusive; prefer --follow-tags when both set
    // so we don't accidentally push unrelated tags.
    if (options?.followTags) {
      args.push('--follow-tags');
    } else if (options?.tags) {
      args.push('--tags');
    }
    if (options?.remote) {
      args.push(options.remote);
    }
    // Explicit refspec (`local:target`) takes precedence over positional branch.
    if (options?.refspec) {
      args.push(options.refspec);
    } else if (options?.branch) {
      args.push(options.branch);
    }

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

  async stashApply(repo: IRepository, index: number): Promise<void> {
    await this._gitCli.exec(['stash', 'apply', `stash@{${index}}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async stashPop(repo: IRepository, index: number): Promise<void> {
    await this._gitCli.exec(['stash', 'pop', `stash@{${index}}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async stashDrop(repo: IRepository, index: number): Promise<void> {
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
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid stash index: ${index}`);
    }
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
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid stash index: ${index}`);
    }
    if (typeof newMessage !== 'string') {
      throw new Error('New stash message must be a string');
    }

    const cwd = repo.rootUri.fsPath;

    // Step 1: resolve the stash ref to a commit hash. Fails if the index
    // doesn't exist.
    const revParse = await this._gitCli.exec(['rev-parse', `stash@{${index}}`], {
      cwd,
      throwOnError: true,
    });
    const commitHash = revParse.stdout.trim();
    if (!commitHash || !/^[a-f0-9]{7,40}$/i.test(commitHash)) {
      throw new Error(`Could not resolve stash@{${index}} to a commit`);
    }

    // Step 2: store the commit back onto the stash stack with the new
    // message. This creates a duplicate entry at stash@{0}; the original
    // shifts to stash@{index+1}.
    await this._gitCli.exec(['stash', 'store', '-m', newMessage, commitHash], {
      cwd,
      throwOnError: true,
    });

    // Step 3: drop the original (now at index+1). If this fails we try to
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
    const args = ['tag'];

    if (message) {
      args.push('-a', name, '-m', message);
    } else {
      args.push(name);
    }

    if (ref) {
      args.push(ref);
    }

    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async deleteTag(repo: IRepository, name: string): Promise<void> {
    await this._gitCli.exec(['tag', '-d', name], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async pushTag(repo: IRepository, name: string, remote?: string): Promise<void> {
    const args = ['push', remote || 'origin', `refs/tags/${name}`];
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
    const result = await this._gitCli.exec(['show', '-s', `--format=${format}`, '-z', hash], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });

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
    // T2-07 — standalone implementation so we can pass `--follow` and a
    // branch ref that the generic `getLog()` doesn't understand. Falls back
    // to the pre-T2-07 behaviour when both flags are absent.
    const format = getLogFormat();
    const args = ['log', `--format=${format}`, '-z'];

    if (options?.follow) {
      args.push('--follow');
    }
    if (options?.maxCount !== undefined && options.maxCount > 0) {
      args.push('-n', String(options.maxCount));
    }
    if (options?.branch) {
      // A branch/ref name — git log understands both local and remote refs.
      args.push(options.branch);
    }

    // `--` separator, then the path.
    args.push('--', path);

    const result = await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath });
    if (result.exitCode !== 0) {
      return [];
    }
    return parseLog(result.stdout);
  }

  /**
   * T3-07 — Compute `git log --cherry-mark --left-right` classifications
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
      const result = await this._gitCli.exec(
        ['log', '--cherry-mark', '--left-right', '--pretty=format:%H %m', `HEAD...${baseRef}`],
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
    const result = await this._gitCli.exec(['show', '--format=', hash], {
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
      const result = await this._gitCli.exec(['show', '-s', '--format=%cI%x09%P', hash], { cwd });
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
    const parentResult = await this._gitCli.exec(['rev-parse', `${oldestCommit}^`], { cwd });

    let baseRef: string;
    if (parentResult.exitCode === 0 && parentResult.stdout.trim()) {
      baseRef = parentResult.stdout.trim();
    } else {
      // No parent - use empty tree SHA (Git's magic empty tree)
      baseRef = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    }

    // Get the diff between the base and the newest commit
    const diffResult = await this._gitCli.exec(['diff', baseRef, newestCommit], { cwd });

    return parseDiff(diffResult.stdout);
  }

  /**
   * List files that differ between the given ref and the working tree.
   * Uses `git diff --name-status -z <ref>` for robust parsing (NUL-delimited,
   * so paths with whitespace or non-ASCII characters are handled correctly).
   */
  async getChangedFilesAgainstWorkingTree(repo: IRepository, ref: string): Promise<IRefDiffFile[]> {
    const result = await this._gitCli.exec(['diff', '--name-status', '-z', ref], {
      cwd: repo.rootUri.fsPath,
    });

    if (result.exitCode !== 0) {
      return [];
    }

    // `git diff --name-status -z` output format:
    //   <status>\0<path>\0                  for M/A/D/T/U entries
    //   <status>\0<oldPath>\0<newPath>\0    for R/C entries (status can be `R100`, `C75`, …)
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

  // ============================================
  // Blame Operations
  // ============================================

  async getBlame(repo: IRepository, path: string): Promise<IBlameLine[]> {
    const result = await this._gitCli.exec(['blame', '--porcelain', path], {
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

    // File-subset mode (T2-05 "Apply Selected Changes"): an empty array
    // means "no files picked" — short-circuit rather than erasing the
    // index. Caller should never invoke with an empty list; return success
    // defensively.
    if (options?.files && options.files.length === 0) {
      return { success: true };
    }

    // When `files` is set we force --no-commit because we need to mutate
    // the index afterwards to narrow to the selected file set.
    const noCommit = options?.noCommit === true || options?.files !== undefined;

    const args = ['cherry-pick'];
    if (noCommit) {
      args.push('--no-commit');
    }
    args.push(...commits);

    const result = await this._gitCli.exec(args, {
      cwd: repo.rootUri.fsPath,
    });

    this.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode !== 0) {
      // Check for conflicts (keeps pre-T2-05 behavior for plain cherry-pick).
      const conflicts = await this.getConflictedFiles(repo);
      return {
        success: false,
        conflicts,
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
      const res = await this._gitCli.exec(['show', '--name-only', '--format=', commit], {
        cwd: repo.rootUri.fsPath,
      });
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

    return {
      success: false,
      conflicts,
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

    const result = await this._gitCli.exec(['revert', '--no-edit', ...commits], {
      cwd: repo.rootUri.fsPath,
    });

    this.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      return { success: true };
    }

    // Check for conflicts
    const conflicts = await this.getConflictedFiles(repo);

    return {
      success: false,
      conflicts,
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

    return {
      success: false,
      conflicts,
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
    this._onDidFetch.dispose();
    this._gitCli.dispose();

    for (const watchers of this._fileWatchers.values()) {
      for (const watcher of watchers) {
        watcher.dispose();
      }
    }
    this._fileWatchers.clear();

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

/** T3-07 — Type guard for a single-char `git log --cherry-mark` output. */
function isCherryMark(value: string): value is import('./interfaces/IGitService').CherryMark {
  return value === '=' || value === '+' || value === '-' || value === '<' || value === '>';
}
