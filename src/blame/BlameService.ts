import * as vscode from 'vscode';
import { IBlameService, IBlameInfo, IBlameOptions } from './interfaces/IBlameService';
import { IBlameLine, IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { GitCli, buildGitArgs, revParseVerified } from '../git-core/gitCli';
import { parseBlame } from '../git-core/gitParser';
import { getLogger, type Logger } from '../utils/logger';
import { repoRelativePath } from '../utils/repoRelativePath';

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
 *
 * - Display blame annotations for file
 * - Show commit info (hash, author, date) for each line
 * - Show commit message on hover
 * - Navigate to previous revision
 */
export class BlameService implements IBlameService {
  private _gitCli: GitCli;
  private _gitService: IGitService;
  private _onDidChangeBlame: vscode.EventEmitter<{ path: string; blame: IBlameInfo }>;
  private _disposables: vscode.Disposable[] = [];
  private _blameCache: Map<string, IBlameCacheEntry> = new Map();
  /**
   * Per-repo file watcher map. Each watcher is a `RelativePattern` rooted at a
   * repo root, so cache invalidation fires only for files inside a repo (not
   * `.vscode/` / `node_modules/` noise) and the watcher key identifies which
   * repo a changed path belongs to. The map is rebuilt on
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

  constructor(gitService: IGitService) {
    // The git CLI is owned by the gitService; BlameService borrows it so every
    // blame command runs through the same configured process as the rest of the
    // extension. A gitService is required — there is no standalone mode.
    this._gitCli = (gitService as unknown as IGitServiceWithCli).gitCli;
    this._gitService = gitService;
    this._onDidChangeBlame = new vscode.EventEmitter<{ path: string; blame: IBlameInfo }>();
    this.onDidChangeBlame = this._onDidChangeBlame.event;
    this._logger = getLogger().child({ component: 'BlameService' });
    this._logger.info('BlameService constructed');

    this.setupFileWatcher();
  }

  /**
   * Set up file watchers to invalidate the blame cache when files change.
   *
   * Registers one watcher per repo using a `RelativePattern` rooted at the
   * repo's `rootUri.fsPath`. This:
   *   - skips `.vscode/`, `node_modules/`, and other workspace noise that
   *     lives outside any repo root,
   *   - lets us track repo membership cheaply (the watcher key is the repo
   *     root path), and
   *   - re-creates the watcher map whenever a repo is added / removed so
   *     multi-root workspaces work correctly.
   */
  private setupFileWatcher(): void {
    this.refreshRepoWatchers();
    this._disposables.push(
      this._gitService.onDidChangeRepository((repo) => {
        this.refreshRepoWatchers();
        // A commit / checkout / reset / pull moves HEAD WITHOUT changing the
        // working-tree file bytes, so the file watcher never fires and the
        // HEAD-keyed blame entry would stay served (up to the 30s TTL),
        // partially defeating the inline/gutter providers' own repo-change
        // refresh. Invalidate this repo's cache on the same signal.
        this.invalidateRepoCache(repo.rootUri.fsPath);
      }),
      this._gitService.onDidRemoveRepository((repo) => {
        const key = repo.rootUri.fsPath;
        this._watchers.get(key)?.dispose();
        this._watchers.delete(key);
        this.invalidateRepoCache(key);
      })
    );
  }

  /**
   * Sync the per-repo watcher map to the current
   * gitService.getRepositories() snapshot. Adds watchers for new repos
   * and removes watchers for repos that disappeared.
   */
  private refreshRepoWatchers(): void {
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
      // Cache keys use the REPO-RELATIVE path (the form providers pass to getBlame),
      // but VS Code fires the watcher with an absolute fsPath. Convert here at the
      // boundary so the invalidation segment matches the key's path component.
      watcher.onDidChange((uri) => this.invalidateCache(key, repoRelativePath(key, uri.fsPath)));
      watcher.onDidDelete((uri) => this.invalidateCache(key, repoRelativePath(key, uri.fsPath)));
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
   * Invalidate cache entries for a file path within a specific repository.
   *
   * Scoped to `repoRoot` so that a file change in one repo does not evict the
   * same relative-path blame from every other repo in a multi-root workspace.
   * Cache keys are `${repoRoot}:${path}:${revision}:${flags}` (see
   * getCacheKey), so the `${repoRoot}:${filePath}:` prefix uniquely identifies
   * all revisions and flag combinations for this file in this repo.
   *
   * @param repoRoot - The repository root path (the watcher's key)
   * @param filePath - The repo-relative file path to invalidate
   */
  private invalidateCache(repoRoot: string, filePath: string): void {
    const prefix = `${repoRoot}:${filePath}:`;
    for (const key of this._blameCache.keys()) {
      if (key.startsWith(prefix)) {
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
   * @param contents - Optional live editor-buffer text. When given, blame runs
   *   against this content (`git blame --contents -`, piped on stdin) instead of
   *   the on-disk file, so blame line numbers align with an unsaved buffer and
   *   new/edited lines come back uncommitted rather than inheriting the on-disk
   *   line's blame. This path is NOT cached (the result depends on the buffer,
   *   which changes per keystroke) and is incompatible with `revision`, so it is
   *   only applied when no revision is requested.
   * @returns Blame information for the file
   */
  async getBlame(
    repo: IRepository,
    path: string,
    revision?: string,
    options?: IBlameOptions,
    contents?: string
  ): Promise<IBlameInfo> {
    const repoRoot = repo.rootUri.fsPath;
    // `--contents` reads from stdin and cannot be combined with a revision; only
    // honor it for the default (working-tree) blame.
    const useContents = contents !== undefined && !revision;
    const cacheKey = this.getCacheKey(repoRoot, path, revision, options);

    // Live-buffer blame is content-dependent, so it bypasses the cache entirely
    // (neither read from nor written to it).
    if (!useContents) {
      const cached = this.getCachedBlame(cacheKey);
      if (cached) {
        return cached;
      }
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
    if (useContents) {
      // `-` reads the file content from stdin (the live buffer below).
      flags.push('--contents', '-');
    }

    const refs = revision ? [revision] : [];
    const args = buildGitArgs('blame', flags, refs, [path]);

    const result = await this._gitCli.exec(args, {
      cwd: repoRoot,
      ...(useContents ? { input: contents } : {}),
    });

    if (result.exitCode !== 0) {
      // Return empty blame info if command fails
      return { path, lines: [] };
    }

    const lines = parseBlame(result.stdout);

    const blameInfo: IBlameInfo = {
      path,
      lines,
    };

    // Cache only the on-disk result — never the live-buffer one.
    if (!useContents) {
      this.cacheBlame(cacheKey, blameInfo);
    }

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

    // Get the parent commit of the specified commit, via revParseVerified
    // (a flagless rev-parse echoes a literal `--end-of-options` line into
    // stdout, corrupting the rev every downstream blame call is built from).
    const parentCommit = await revParseVerified(this._gitCli, repoRoot, `${commit}^`);
    if (parentCommit === undefined) {
      // No parent commit (initial commit) - return empty blame
      return { path, lines: [] };
    }

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
  /**
   * Invalidate every cached blame entry for one repository (keys are
   * `${repoRoot}:…`). Called on `onDidChangeRepository` / `onDidRemoveRepository`
   * so a HEAD move that doesn't touch file bytes still drops stale blame.
   */
  private invalidateRepoCache(repoRoot: string): void {
    const prefix = `${repoRoot}:`;
    for (const key of this._blameCache.keys()) {
      if (key.startsWith(prefix)) {
        this._blameCache.delete(key);
      }
    }
  }

  clearCache(): void {
    this._blameCache.clear();
  }

  /**
   * Dispose of resources. The git CLI belongs to the gitService and is NOT
   * disposed here. Disposes the change-event emitter, the subscription
   * disposables, and every per-repo watcher.
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
  }
}

/**
 * Create a new BlameService instance.
 *
 * @param gitService - The GitService whose git CLI and repository events the
 *   blame service borrows
 * @returns A new BlameService instance
 */
export function createBlameService(gitService: IGitService): BlameService {
  return new BlameService(gitService);
}
