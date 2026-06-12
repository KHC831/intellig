import * as vscode from 'vscode';
import { IBlameService, IBlameInfo, IBlameOptions } from './interfaces/IBlameService';
import { IBlameLine, IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { GitCli, buildGitArgs, createGitCli } from '../git-core/gitCli';
import { parseBlame } from '../git-core/gitParser';
import { getLogger, type Logger } from '../utils/logger';

// Typeguard for GitService's @internal cli escape hatch.
interface IGitServiceWithCli {
  gitCli: GitCli;
}

/**
 * Cache entry for blame information
 */
interface IBlameCacheEntry {
  blame: IBlameInfo;
  timestamp: number;
}

/**
 * Blame Service implementation.
 * Provides blame/annotation functionality for files in Git repositories.
 */
export class BlameService implements IBlameService {
  private _gitCli: GitCli;
  /** See {@link RebaseService._ownsGitCli}. */
  private _ownsGitCli: boolean;
  private _gitService: IGitService | undefined;
  private _onDidChangeBlame: vscode.EventEmitter<{ path: string; blame: IBlameInfo }>;
  private _disposables: vscode.Disposable[] = [];
  private _blameCache: Map<string, IBlameCacheEntry> = new Map();
  /**
   * Per-repo file watcher map. A single `**\/*` glob across the entire
   * workspace (a) triggered cache invalidation on every irrelevant
   * `.vscode/` / `node_modules/` write, and (b) couldn't tell which repo
   * a path belonged to. We now scope each watcher to a `RelativePattern`
   * rooted at the repo root and re-create the map on
   * `gitService.onDidChangeRepository` / `onDidRemoveRepository`.
   */
  private _watchers: Map<string, vscode.FileSystemWatcher> = new Map();

  /**
   * Component-bound Logger emitted on construction and disposal so
   * operational waypoints land in the IntelliG OutputChannel
   * uniformly with the rest of the service graph.
   */
  private readonly _logger: Logger;

  /** Cache TTL in milliseconds (30 seconds) */
  private static readonly CACHE_TTL = 30000;

  /**
   * Event fired when blame information changes
   */
  readonly onDidChangeBlame: vscode.Event<{ path: string; blame: IBlameInfo }>;

  constructor(gitCli?: GitCli, gitService?: IGitService) {
    if (gitService) {
      this._gitCli = (gitService as unknown as IGitServiceWithCli).gitCli;
      this._ownsGitCli = false;
    } else {
      this._gitCli = gitCli || createGitCli();
      this._ownsGitCli = true;
    }
    this._gitService = gitService;
    this._onDidChangeBlame = new vscode.EventEmitter<{ path: string; blame: IBlameInfo }>();
    this.onDidChangeBlame = this._onDidChangeBlame.event;
    this._logger = getLogger().child({ component: 'BlameService' });
    this._logger.info('BlameService constructed', { ownsGitCli: this._ownsGitCli });

    // Set up file watcher (per-repo when gitService is available, else
    // legacy `**/*` global glob).
    this.setupFileWatcher();
  }

  /**
   * Set up file watchers to invalidate blame cache when files change.
   *
   * When a `gitService` was passed at construction time we
   * register one watcher per repo using a `RelativePattern` rooted at
   * the repo's `rootUri.fsPath`. This:
   *   - skips `.vscode/`, `node_modules/`, and other workspace noise
   *     that lives outside any repo root,
   *   - lets us track repo membership cheaply (the watcher key is the
   *     repo root path), and
   *   - re-creates the watcher map whenever a repo is added / removed
   *     so multi-root workspaces work correctly.
   *
   * The legacy `**\/*` global glob is kept as a fallback for callers
   * that still construct `BlameService` standalone (no shared
   * gitService) — they're test-only paths and the over-broad glob is
   * acceptable there.
   */
  private setupFileWatcher(): void {
    if (this._gitService) {
      this.refreshRepoWatchers();
      this._disposables.push(
        this._gitService.onDidChangeRepository(() => this.refreshRepoWatchers()),
        this._gitService.onDidRemoveRepository((repo) => {
          const key = repo.rootUri.fsPath;
          this._watchers.get(key)?.dispose();
          this._watchers.delete(key);
        })
      );
      return;
    }

    // Legacy fallback path used by tests that pass only a GitCli.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidChange((uri) => this.invalidateCache(uri.fsPath));
    watcher.onDidDelete((uri) => this.invalidateCache(uri.fsPath));
    this._disposables.push(watcher);
  }

  /**
   * Sync the per-repo watcher map to the current
   * gitService.getRepositories() snapshot. Adds watchers for new repos
   * and removes watchers for repos that disappeared.
   */
  private refreshRepoWatchers(): void {
    if (!this._gitService) {
      return;
    }
    const repos = this._gitService.getRepositories();
    const live = new Set(repos.map((r) => r.rootUri.fsPath));

    // Remove stale watchers (repos that disappeared).
    for (const [key, watcher] of this._watchers) {
      if (!live.has(key)) {
        watcher.dispose();
        this._watchers.delete(key);
      }
    }

    // Add watchers for new repos.
    for (const repo of repos) {
      const key = repo.rootUri.fsPath;
      if (this._watchers.has(key)) {
        continue;
      }
      const pattern = new vscode.RelativePattern(repo.rootUri, '**/*');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange((uri) => this.invalidateCache(uri.fsPath));
      watcher.onDidDelete((uri) => this.invalidateCache(uri.fsPath));
      this._watchers.set(key, watcher);
    }
  }

  /**
   * Generate a cache key for blame information. Includes blame-option flags so
   * that toggling `-w`/`-M`/`-C` transparently invalidates prior results.
   *
   * @param repoRoot - The repository root path
   * @param path - The file path
   * @param revision - Optional revision
   * @param options - Optional blame flags
   * @returns The cache key
   */
  private getCacheKey(
    repoRoot: string,
    path: string,
    revision?: string,
    options?: IBlameOptions
  ): string {
    const flags = BlameService.serializeOptions(options);
    return `${repoRoot}:${path}:${revision || 'HEAD'}:${flags}`;
  }

  /**
   * Deterministic string representation of the blame-option flags. Used as a
   * cache-key suffix so every flag combination gets its own entry.
   */
  private static serializeOptions(options?: IBlameOptions): string {
    if (!options) {
      return '-';
    }
    return [
      options.ignoreWhitespace ? 'w' : '',
      options.detectMovementsWithinFile ? 'M' : '',
      options.detectMovementsAcrossFiles ? 'C' : '',
    ].join('');
  }

  /**
   * Get cached blame information if still valid.
   *
   * @param cacheKey - The cache key
   * @returns The cached blame info, or undefined if not cached or expired
   */
  private getCachedBlame(cacheKey: string): IBlameInfo | undefined {
    const cached = this._blameCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < BlameService.CACHE_TTL) {
      return cached.blame;
    }
    return undefined;
  }

  /**
   * Cache blame information.
   *
   * @param cacheKey - The cache key
   * @param blame - The blame information to cache
   */
  private cacheBlame(cacheKey: string, blame: IBlameInfo): void {
    this._blameCache.set(cacheKey, {
      blame,
      timestamp: Date.now(),
    });
  }

  /**
   * Invalidate cache entries for a file path.
   *
   * @param filePath - The file path to invalidate
   */
  private invalidateCache(filePath: string): void {
    // Remove all cache entries that contain this file path
    for (const key of this._blameCache.keys()) {
      if (key.includes(filePath)) {
        this._blameCache.delete(key);
      }
    }
  }

  /**
   * Get blame information for a file.
   * Returns blame data for all lines in the file, including commit hash,
   * author, date, and commit message for each line.
   *
   * @param repo - The repository
   * @param path - The file path (relative to repository root)
   * @param revision - Optional revision to get blame for (defaults to HEAD)
   * @param options - Optional blame flags: `-w` / `-M` / `-C`.
   * @returns Blame information for the file
   */
  async getBlame(
    repo: IRepository,
    path: string,
    revision?: string,
    options?: IBlameOptions
  ): Promise<IBlameInfo> {
    const repoRoot = repo.rootUri.fsPath;
    const cacheKey = this.getCacheKey(repoRoot, path, revision, options);

    // Check cache first
    const cached = this.getCachedBlame(cacheKey);
    if (cached) {
      return cached;
    }

    // Build git blame command. Flag order matters for readability only — git
    // accepts them in any order. The order here mirrors IntelliJ's menu.
    // Splice via buildGitArgs so a hostile revision/path can't
    // collapse into a flag.
    const flags: string[] = ['--porcelain'];

    if (options?.ignoreWhitespace) {
      flags.push('-w');
    }
    if (options?.detectMovementsWithinFile) {
      flags.push('-M');
    }
    if (options?.detectMovementsAcrossFiles) {
      // Pass `-C` twice so git also detects copies from files that weren't
      // modified in the same commit. Matches IntelliJ's "across files" mode,
      // which is the more thorough variant of `-C`.
      flags.push('-C');
      flags.push('-C');
    }

    const refs = revision ? [revision] : [];
    const args = buildGitArgs('blame', flags, refs, [path]);

    const result = await this._gitCli.exec(args, { cwd: repoRoot });

    if (result.exitCode !== 0) {
      // Return empty blame info if command fails
      return { path, lines: [] };
    }

    const lines = parseBlame(result.stdout);

    const blameInfo: IBlameInfo = {
      path,
      lines,
    };

    // Cache the result
    this.cacheBlame(cacheKey, blameInfo);

    // Fire change event
    this._onDidChangeBlame.fire({ path, blame: blameInfo });

    return blameInfo;
  }

  /**
   * Get blame information for a specific line in a file.
   * This is useful for showing blame info for the current cursor position.
   *
   * @param repo - The repository
   * @param path - The file path (relative to repository root)
   * @param line - The line number (1-indexed)
   * @param options - Optional blame flags (passed through to getBlame).
   * @returns Blame information for the specific line
   */
  async getBlameForLine(
    repo: IRepository,
    path: string,
    line: number,
    options?: IBlameOptions
  ): Promise<IBlameLine> {
    // Get full blame info (will use cache if available)
    const blameInfo = await this.getBlame(repo, path, undefined, options);

    // Find the blame line for the requested line number
    const blameLine = blameInfo.lines.find((bl) => bl.line === line);

    if (!blameLine) {
      // Return a placeholder if line not found
      // This can happen for newly added lines not yet committed
      return {
        line,
        commit: '0000000000000000000000000000000000000000',
        author: 'Not Committed Yet',
        authorEmail: '',
        date: new Date(),
        message: 'Uncommitted changes',
      };
    }

    return blameLine;
  }

  /**
   * Get blame information for the file at the previous revision.
   * This allows navigating through the history of a file by showing
   * who modified each line before the specified commit.
   *
   * @param repo - The repository
   * @param path - The file path (relative to repository root)
   * @param commit - The commit hash to get the previous revision from
   * @param options - Optional blame flags (passed through to getBlame).
   * @returns Blame information for the file at the previous revision
   */
  async getPreviousRevisionBlame(
    repo: IRepository,
    path: string,
    commit: string,
    options?: IBlameOptions
  ): Promise<IBlameInfo> {
    const repoRoot = repo.rootUri.fsPath;

    // Get the parent commit of the specified commit.
    // `commit` is user-controlled; splice via buildGitArgs.
    const parentResult = await this._gitCli.exec(buildGitArgs('rev-parse', [], [`${commit}^`]), {
      cwd: repoRoot,
    });

    if (parentResult.exitCode !== 0 || !parentResult.stdout.trim()) {
      // No parent commit (initial commit) - return empty blame
      return { path, lines: [] };
    }

    const parentCommit = parentResult.stdout.trim();

    // Check if the file existed at the parent commit.
    // `parentCommit` is computed, but `path` is user-controlled
    // and the combined `<sha>:<path>` token is also gated through buildGitArgs.
    const fileExistsResult = await this._gitCli.exec(
      buildGitArgs('cat-file', ['-e'], [`${parentCommit}:${path}`]),
      { cwd: repoRoot }
    );

    if (fileExistsResult.exitCode !== 0) {
      // File didn't exist at parent commit - return empty blame
      return { path, lines: [] };
    }

    // Get blame for the file at the parent commit
    return this.getBlame(repo, path, parentCommit, options);
  }

  /**
   * Clear the blame cache.
   * This can be called when the repository state changes significantly.
   */
  clearCache(): void {
    this._blameCache.clear();
  }

  /**
   * Dispose of resources.
   *
   * Only dispose `_gitCli` when WE own it.
   * Dispose every per-repo watcher in addition to the
   * legacy `_disposables` array.
   */
  dispose(): void {
    this._logger.info('BlameService disposing', {
      cacheEntries: this._blameCache.size,
      watchers: this._watchers.size,
    });
    this._onDidChangeBlame.dispose();
    this._blameCache.clear();

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];

    for (const watcher of this._watchers.values()) {
      watcher.dispose();
    }
    this._watchers.clear();

    if (this._ownsGitCli) {
      const cli = this._gitCli as unknown as { dispose?: () => void };
      if (typeof cli.dispose === 'function') {
        cli.dispose();
      }
    }
  }
}

/**
 * Create a new BlameService instance.
 *
 * @param gitCli - Optional GitCli instance to use
 * @param gitService - Optional GitService whose gitCli we adopt
 * @returns A new BlameService instance
 */
export function createBlameService(gitCli?: GitCli, gitService?: IGitService): BlameService {
  return new BlameService(gitCli, gitService);
}
