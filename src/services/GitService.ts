import * as vscode from 'vscode';
import {
  IGitService,
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
  IStashOptions,
  ILogOptions,
  IMergeResult,
  IBasicRebaseResult,
  ICherryPickResult,
  IRevertResult,
  IBranchComparison,
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
 *
 * Requirements: 1.5, 12.4
 */
export class GitService implements IGitService {
  private _gitCli: GitCli;
  private _repositories: Map<string, IRepositoryCache> = new Map();
  private _onDidChangeRepository: vscode.EventEmitter<IRepository>;
  private _disposables: vscode.Disposable[] = [];
  private _fileWatchers: Map<string, vscode.FileSystemWatcher> = new Map();

  /** Cache TTL in milliseconds (5 seconds) */
  private static readonly CACHE_TTL = 5000;

  /**
   * Event fired when a repository changes
   */
  readonly onDidChangeRepository: vscode.Event<IRepository>;

  constructor(gitPath?: string) {
    this._gitCli = createGitCli(gitPath);
    this._onDidChangeRepository = new vscode.EventEmitter<IRepository>();
    this.onDidChangeRepository = this._onDidChangeRepository.event;

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
        // Discover repositories in added folders
        for (const folder of event.added) {
          void this.discoverRepository(folder.uri.fsPath);
        }
      })
    );

    // Initial repository discovery
    void this.discoverRepositories();
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
   * Set up a file watcher for repository changes.
   *
   * @param rootPath - The repository root path
   */
  private setupRepositoryWatcher(rootPath: string): void {
    if (this._fileWatchers.has(rootPath)) {
      return;
    }

    // Watch for changes in .git directory
    const gitDir = vscode.Uri.file(`${rootPath}/.git`);
    const pattern = new vscode.RelativePattern(gitDir, '**/*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleChange = (): void => {
      this.invalidateCache(rootPath);
      void this.loadRepository(rootPath).then((repo) => {
        this._onDidChangeRepository.fire(repo);
      });
    };

    watcher.onDidChange(handleChange);
    watcher.onDidCreate(handleChange);
    watcher.onDidDelete(handleChange);

    this._fileWatchers.set(rootPath, watcher);
    this._disposables.push(watcher);
  }

  /**
   * Remove a repository watcher.
   *
   * @param rootPath - The repository root path
   */
  private removeRepositoryWatcher(rootPath: string): void {
    const watcher = this._fileWatchers.get(rootPath);
    if (watcher) {
      watcher.dispose();
      this._fileWatchers.delete(rootPath);
    }
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
   *
   * Requirements: 3.1, 3.3, 3.4, 3.5
   */
  async commit(repo: IRepository, message: string, options: ICommitOptions = {}): Promise<void> {
    // Validate commit message - prevent empty messages unless amending or allowEmpty
    // Requirement 3.5: Empty message should be prevented with validation error
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !options.amend && !options.allowEmpty) {
      throw new Error('Commit message cannot be empty');
    }

    const args = ['commit', '-m', message];

    // Requirement 3.3: Amend option
    if (options.amend) {
      args.push('--amend');
    }
    // Requirement 3.4: Sign-off option
    if (options.signOff) {
      args.push('--signoff');
    }
    if (options.noVerify) {
      args.push('--no-verify');
    }
    if (options.allowEmpty) {
      args.push('--allow-empty');
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

  async createBranch(repo: IRepository, name: string, startPoint?: string): Promise<void> {
    const args = ['branch', name];
    if (startPoint) {
      args.push(startPoint);
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

  async mergeBranch(repo: IRepository, branch: string): Promise<IMergeResult> {
    const result = await this._gitCli.exec(['merge', branch], { cwd: repo.rootUri.fsPath });
    this.invalidateCache(repo.rootUri.fsPath);

    if (result.exitCode === 0) {
      // Get the merge commit hash
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
   *
   * Requirements: 4.8
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
   * Compare two branches to find differences.
   * Returns commits unique to each branch, files that differ, and ahead/behind counts.
   *
   * @param repo - The repository
   * @param branch1 - The first branch (typically the current branch)
   * @param branch2 - The second branch to compare against
   * @returns Branch comparison result with commits ahead/behind and changed files
   *
   * Requirements: 4.11, 15.1, 15.2, 15.3, 15.5, 15.6
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

  async fetch(repo: IRepository, remote?: string): Promise<void> {
    const args = ['fetch'];
    if (remote) {
      args.push(remote);
    } else {
      args.push('--all');
    }

    await this._gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.invalidateCache(repo.rootUri.fsPath);
  }

  async pull(repo: IRepository, options?: IPullOptions): Promise<void> {
    const args = ['pull'];

    if (options?.rebase) {
      args.push('--rebase');
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
    const args = ['push'];

    if (options?.force) {
      args.push('--force');
    } else if (options?.forceWithLease) {
      args.push('--force-with-lease');
    }
    if (options?.setUpstream) {
      args.push('--set-upstream');
    }
    if (options?.tags) {
      args.push('--tags');
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
   * View the contents/diff of a stash.
   *
   * @param repo - The repository
   * @param index - The stash index
   * @returns Array of diffs showing the stash contents
   *
   * Requirements: 7.7
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
      args.push('--all');
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

  async getFileHistory(repo: IRepository, path: string): Promise<ICommit[]> {
    return this.getLog(repo, { path });
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
   *
   * Requirements: 9.8 (Log)
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

    // Get commit dates to sort them chronologically
    // We need to find the oldest and newest commits to compute the range
    const commitInfos: { hash: string; date: Date }[] = [];

    for (const hash of commits) {
      const result = await this._gitCli.exec(['show', '-s', '--format=%cI', hash], { cwd });
      if (result.exitCode === 0 && result.stdout.trim()) {
        commitInfos.push({
          hash,
          date: new Date(result.stdout.trim()),
        });
      }
    }

    if (commitInfos.length === 0) {
      return [];
    }

    // Sort by date (oldest first)
    commitInfos.sort((a, b) => a.date.getTime() - b.date.getTime());

    const oldestCommit = commitInfos[0].hash;
    const newestCommit = commitInfos[commitInfos.length - 1].hash;

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
   *
   * Requirements: 11.1, 11.2, 11.3
   */
  async cherryPick(repo: IRepository, commits: string[]): Promise<ICherryPickResult> {
    if (commits.length === 0) {
      return { success: true };
    }

    const result = await this._gitCli.exec(['cherry-pick', ...commits], {
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
   * Abort an in-progress cherry-pick operation.
   * Restores the working directory to its pre-cherry-pick state.
   *
   * @param repo - The repository
   *
   * Requirements: 11.4
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
   *
   * Requirements: 11.5
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
   *
   * Requirements: 9.5 (Log context menu - Revert)
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
   *
   * Requirements: 9.5 (Log context menu - Revert)
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
   *
   * Requirements: 3.6, 14.1, 14.2
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
   *
   * Requirements: 3.7, 14.3
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
   *
   * Requirements: 14.5
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
   *
   * Requirements: 2.7 (Local Changes View context menu - Revert)
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
    this._onDidChangeRepository.dispose();
    this._gitCli.dispose();

    for (const watcher of this._fileWatchers.values()) {
      watcher.dispose();
    }
    this._fileWatchers.clear();

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
