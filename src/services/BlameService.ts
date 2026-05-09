import * as vscode from 'vscode';
import { IBlameService, IBlameInfo, IBlameOptions } from './interfaces/IBlameService';
import { IBlameLine, IRepository } from './interfaces/IGitService';
import { GitCli, createGitCli } from '../utils/gitCli';
import { parseBlame } from '../utils/gitParser';

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
 * - 9.1: Display blame annotations for file
 * - 9.2: Show commit info (hash, author, date) for each line
 * - 9.3: Show commit message on hover
 * - 9.6: Navigate to previous revision
 */
export class BlameService implements IBlameService {
  private _gitCli: GitCli;
  private _onDidChangeBlame: vscode.EventEmitter<{ path: string; blame: IBlameInfo }>;
  private _disposables: vscode.Disposable[] = [];
  private _blameCache: Map<string, IBlameCacheEntry> = new Map();

  /** Cache TTL in milliseconds (30 seconds) */
  private static readonly CACHE_TTL = 30000;

  /**
   * Event fired when blame information changes
   */
  readonly onDidChangeBlame: vscode.Event<{ path: string; blame: IBlameInfo }>;

  constructor(gitCli?: GitCli) {
    this._gitCli = gitCli || createGitCli();
    this._onDidChangeBlame = new vscode.EventEmitter<{ path: string; blame: IBlameInfo }>();
    this.onDidChangeBlame = this._onDidChangeBlame.event;

    // Set up file watcher to invalidate cache when files change
    this.setupFileWatcher();
  }

  /**
   * Set up a file watcher to invalidate blame cache when files change.
   */
  private setupFileWatcher(): void {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');

    watcher.onDidChange((uri) => {
      this.invalidateCache(uri.fsPath);
    });

    watcher.onDidDelete((uri) => {
      this.invalidateCache(uri.fsPath);
    });

    this._disposables.push(watcher);
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
   * @param options - Optional blame flags (T2-08): `-w` / `-M` / `-C`.
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
    const args = ['blame', '--porcelain'];

    if (options?.ignoreWhitespace) {
      args.push('-w');
    }
    if (options?.detectMovementsWithinFile) {
      args.push('-M');
    }
    if (options?.detectMovementsAcrossFiles) {
      // Pass `-C` twice so git also detects copies from files that weren't
      // modified in the same commit. Matches IntelliJ's "across files" mode,
      // which is the more thorough variant of `-C`.
      args.push('-C');
      args.push('-C');
    }

    // Add revision if specified
    if (revision) {
      args.push(revision);
    }

    args.push('--', path);

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

    // Get the parent commit of the specified commit
    const parentResult = await this._gitCli.exec(['rev-parse', `${commit}^`], { cwd: repoRoot });

    if (parentResult.exitCode !== 0 || !parentResult.stdout.trim()) {
      // No parent commit (initial commit) - return empty blame
      return { path, lines: [] };
    }

    const parentCommit = parentResult.stdout.trim();

    // Check if the file existed at the parent commit
    const fileExistsResult = await this._gitCli.exec(
      ['cat-file', '-e', `${parentCommit}:${path}`],
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
   */
  dispose(): void {
    this._onDidChangeBlame.dispose();
    this._blameCache.clear();

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];
  }
}

/**
 * Create a new BlameService instance.
 *
 * @param gitCli - Optional GitCli instance to use
 * @returns A new BlameService instance
 */
export function createBlameService(gitCli?: GitCli): BlameService {
  return new BlameService(gitCli);
}
