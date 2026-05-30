import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { atomicWriteFileSync } from '../utils/atomicWrite';
import {
  IRebaseService,
  IRebaseSession,
  IRebaseCommit,
  IRebaseAction,
  IRebaseResult,
  RebaseAction,
  RebaseStatus,
} from './interfaces/IRebaseService';
import { IRepository } from './interfaces/IGitService';
import { GitCli, createGitCli, IGitCommandResult } from './gitCli';
import { IGitService } from './interfaces/IGitService';

/**
 * Rebase Service implementation.
 * Manages interactive rebase operations including starting, modifying, and controlling rebases.
 *
 * Persistent-state audit (parallel to the forward-compat round-trip work
 * on ChangelistService + ShelfService): RebaseService holds zero
 * IntelliG-owned persistent state. All rebase session state lives in
 * git's own `.git/rebase-merge/*` metadata (`onto`, `head-name`,
 * `git-rebase-todo`, `done`, …) — git both writes and consumes those
 * files. The only thing this service writes is an ephemeral
 * `.git/rebase-todo-script.sh` sequence editor that's deleted after
 * `git rebase -i` returns. There is no JSON / YAML / plist payload we
 * could lose forward-compat fields in, and therefore no round-trip
 * pattern is needed here. In-memory `_sessions` is the only IntelliG
 * representation and it's ephemeral per extension activation. If a
 * future change introduces persistent rebase-session metadata (e.g. a
 * `.git/intellig-rebase-plan.json` alongside the upstream files), the
 * same `_unknownTopLevel` / `_unknownItem` round-trip discipline should
 * be applied.
 */
// Wave I WI-D — typeguard for GitService's @internal cli escape hatch.
interface IGitServiceWithCli {
  gitCli: GitCli;
}

export class RebaseService implements IRebaseService {
  private _gitCli: GitCli;
  /**
   * Wave I WI-D — when `true`, this service owns its `_gitCli` and is
   * responsible for disposing it. When `false`, the cli was reached
   * through a shared GitService (see ctor docs) and the GitService owns
   * the lifecycle. Pre-Wave-I every secondary service spun up its own
   * GitCli, so `gitService.onCommandExecuted` listeners (e.g. the
   * Console View) never saw `git rebase`/`git stash`/`git blame` calls.
   */
  private _ownsGitCli: boolean;
  private _sessions: Map<string, IRebaseSession> = new Map();
  private _onDidChangeRebaseSession: vscode.EventEmitter<IRebaseSession | undefined>;
  private _disposables: vscode.Disposable[] = [];

  /**
   * Event fired when rebase session changes
   */
  readonly onDidChangeRebaseSession: vscode.Event<IRebaseSession | undefined>;

  /**
   * Wave I WI-D — accept `gitService` so we can route rebase commands
   * through the SAME GitCli the GitService owns. When the host wires us
   * with `new RebaseService(undefined, gitService)`, our `_gitCli`
   * points at `gitService.gitCli`, the ConsoleService's
   * `connectToGitCli(gitService.gitCli)` subscription captures every
   * `git rebase` call, and the back-channel diagnostics surface
   * end-to-end.
   *
   * Legacy callers that pass only `gitCli` (or nothing) still get a
   * standalone instance with its own ownership flag set so dispose()
   * tears it down.
   *
   * @param gitCli - Optional explicit cli. Ignored when `gitService` is set.
   * @param gitService - Optional shared GitService whose `gitCli` field we adopt.
   */
  constructor(gitCli?: GitCli, gitService?: IGitService) {
    if (gitService) {
      this._gitCli = (gitService as unknown as IGitServiceWithCli).gitCli;
      this._ownsGitCli = false;
    } else {
      this._gitCli = gitCli || createGitCli();
      this._ownsGitCli = true;
    }
    this._onDidChangeRebaseSession = new vscode.EventEmitter<IRebaseSession | undefined>();
    this.onDidChangeRebaseSession = this._onDidChangeRebaseSession.event;
  }

  /**
   * Start an interactive rebase.
   * This initiates a rebase session and parses the commits to be rebased.
   *
   * @param repo - The repository to rebase in
   * @param onto - The commit/branch to rebase onto
   * @returns The rebase session with commits and their actions
   */
  async startInteractiveRebase(repo: IRepository, onto: string): Promise<IRebaseSession> {
    const cwd = repo.rootUri.fsPath;
    const repoKey = this.getRepoKey(repo);

    // Get the current branch name before starting rebase
    const branchResult = await this._gitCli.exec(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    const originalBranch = branchResult.stdout.trim();

    // Get the commits that will be rebased
    // These are commits between 'onto' and HEAD
    const commits = await this.getCommitsToRebase(repo, onto);

    // Create the initial session in 'planning' state
    // This allows the user to modify the plan before executing
    const session: IRebaseSession = {
      onto,
      originalBranch,
      commits,
      currentStep: 0,
      status: 'planning',
    };

    // Store the session
    this._sessions.set(repoKey, session);
    this._onDidChangeRebaseSession.fire(session);

    return session;
  }

  /**
   * Get the current rebase session for a repository.
   *
   * @param repo - The repository to check
   * @returns The current rebase session, or undefined if no rebase is in progress
   */
  getRebaseSession(repo: IRepository): IRebaseSession | undefined {
    const repoKey = this.getRepoKey(repo);

    // First check our cached session
    let session = this._sessions.get(repoKey);

    // Also check if there's an active rebase in the repository
    const activeSession = this.detectActiveRebase(repo);
    if (activeSession) {
      // Update our cached session with the active state
      if (session) {
        session = {
          ...session,
          ...activeSession,
        };
        this._sessions.set(repoKey, session);
      } else if (this.isCompleteSession(activeSession)) {
        // Only set if we have a complete session
        session = activeSession;
        this._sessions.set(repoKey, session);
      }
    }

    return session;
  }

  /**
   * Check if a partial session has all required fields.
   *
   * @param session - The partial session to check
   * @returns True if the session has all required fields
   */
  private isCompleteSession(session: Partial<IRebaseSession>): session is IRebaseSession {
    return (
      session.onto !== undefined &&
      session.originalBranch !== undefined &&
      session.commits !== undefined &&
      session.currentStep !== undefined &&
      session.status !== undefined
    );
  }

  /**
   * Update the rebase plan with new actions.
   * This allows reordering commits and changing their actions (pick, reword, edit, squash, fixup, drop).
   *
   * @param repo - The repository
   * @param plan - The new plan with updated actions and order
   */
  updateRebasePlan(repo: IRepository, plan: IRebaseAction[]): void {
    const repoKey = this.getRepoKey(repo);
    const session = this._sessions.get(repoKey);

    if (!session) {
      throw new Error('No rebase session found for this repository');
    }

    if (session.status !== 'planning' && session.status !== 'paused') {
      throw new Error('Cannot update rebase plan when rebase is in progress');
    }

    // Update the commits based on the new plan
    // The plan array defines both the new order and the new actions
    const updatedCommits: IRebaseCommit[] = plan.map((action) => {
      const existingCommit = session.commits.find((c) => c.hash === action.hash);
      if (!existingCommit) {
        throw new Error(`Commit ${action.hash} not found in rebase session`);
      }
      return {
        hash: action.hash,
        message: action.newMessage || existingCommit.message,
        action: action.action,
      };
    });

    // Update the session
    const updatedSession: IRebaseSession = {
      ...session,
      commits: updatedCommits,
    };

    this._sessions.set(repoKey, updatedSession);
    this._onDidChangeRebaseSession.fire(updatedSession);
  }

  /**
   * Continue the rebase after resolving conflicts.
   *
   * @param repo - The repository
   * @returns The result of continuing the rebase
   */
  async continueRebase(repo: IRepository): Promise<IRebaseResult> {
    const cwd = repo.rootUri.fsPath;
    const repoKey = this.getRepoKey(repo);

    const result = await this._gitCli.exec(['rebase', '--continue'], { cwd });

    if (result.exitCode === 0) {
      // Check if rebase is complete
      const isComplete = !this.isRebaseInProgress(repo);

      if (isComplete) {
        this._sessions.delete(repoKey);
        this._onDidChangeRebaseSession.fire(undefined);
        return { success: true, status: 'completed' };
      }

      // Update session status
      const session = this._sessions.get(repoKey);
      if (session) {
        session.status = 'in-progress';
        session.currentStep++;
        this._onDidChangeRebaseSession.fire(session);
      }

      return { success: true, status: 'in-progress' };
    }

    // Check for conflicts
    const conflicts = await this.getConflictedFiles(repo);
    if (conflicts.length > 0) {
      const session = this._sessions.get(repoKey);
      if (session) {
        session.status = 'conflict';
        this._onDidChangeRebaseSession.fire(session);
      }
      return { success: false, status: 'conflict', conflictedFiles: conflicts };
    }

    return { success: false, status: 'paused' };
  }

  /**
   * Abort the rebase and restore original state.
   *
   * @param repo - The repository
   */
  async abortRebase(repo: IRepository): Promise<void> {
    const cwd = repo.rootUri.fsPath;
    const repoKey = this.getRepoKey(repo);

    await this._gitCli.exec(['rebase', '--abort'], { cwd, throwOnError: true });

    // Clear the session
    this._sessions.delete(repoKey);
    this._onDidChangeRebaseSession.fire(undefined);
  }

  /**
   * Skip the current commit during rebase.
   *
   * @param repo - The repository
   * @returns The result of skipping the commit
   */
  async skipCommit(repo: IRepository): Promise<IRebaseResult> {
    const cwd = repo.rootUri.fsPath;
    const repoKey = this.getRepoKey(repo);

    const result = await this._gitCli.exec(['rebase', '--skip'], { cwd });

    if (result.exitCode === 0) {
      // Check if rebase is complete
      const isComplete = !this.isRebaseInProgress(repo);

      if (isComplete) {
        this._sessions.delete(repoKey);
        this._onDidChangeRebaseSession.fire(undefined);
        return { success: true, status: 'completed' };
      }

      // Update session status
      const session = this._sessions.get(repoKey);
      if (session) {
        session.status = 'in-progress';
        session.currentStep++;
        this._onDidChangeRebaseSession.fire(session);
      }

      return { success: true, status: 'in-progress' };
    }

    // Check for conflicts
    const conflicts = await this.getConflictedFiles(repo);
    if (conflicts.length > 0) {
      const session = this._sessions.get(repoKey);
      if (session) {
        session.status = 'conflict';
        this._onDidChangeRebaseSession.fire(session);
      }
      return { success: false, status: 'conflict', conflictedFiles: conflicts };
    }

    return { success: false, status: 'paused' };
  }

  /**
   * Execute the rebase with the current plan.
   * This writes the todo file and starts the actual rebase.
   * Handles all rebase actions: pick, reword, edit, squash, fixup, drop.
   *
   * @param repo - The repository
   * @returns The result of starting the rebase
   */
  async executeRebase(repo: IRepository): Promise<IRebaseResult> {
    const cwd = repo.rootUri.fsPath;
    const repoKey = this.getRepoKey(repo);
    const session = this._sessions.get(repoKey);

    if (!session) {
      throw new Error('No rebase session found for this repository');
    }

    if (session.status !== 'planning') {
      throw new Error('Rebase is not in planning state');
    }

    // Generate the todo content with all actions
    const todoContent = this.generateTodoContent(session.commits);

    // Create a temporary script that will write our todo content
    const todoScriptPath = path.join(cwd, '.git', 'rebase-todo-script.sh');
    const todoScript = `#!/bin/sh
cat << 'EOF' > "$1"
${todoContent}EOF
`;

    // Write the script file atomically (write-to-temp + rename).
    // Preserves mode 0o755 so git can exec the sequence editor. See
    // {@link atomicWriteFileSync} for the crash-during-write rationale.
    atomicWriteFileSync(todoScriptPath, todoScript, { mode: 0o755 });

    try {
      // Start the interactive rebase with our custom sequence editor
      // The GIT_SEQUENCE_EDITOR will replace the todo file with our plan
      const result = await this._gitCli.exec(['rebase', '-i', session.onto], {
        cwd,
        env: {
          ...process.env,
          GIT_SEQUENCE_EDITOR: todoScriptPath,
        },
      });

      // Clean up the script file
      this.cleanupTempFile(todoScriptPath);

      // Update session status based on result
      return await this.handleRebaseResult(repo, session, result);
    } catch (error) {
      // Clean up on error
      this.cleanupTempFile(todoScriptPath);
      throw error;
    }
  }

  /**
   * Handle the result of a rebase operation.
   * Detects paused states for edit/reword actions and conflict states.
   *
   * @param repo - The repository
   * @param session - The current rebase session
   * @param result - The Git command result
   * @returns The rebase result
   */
  private async handleRebaseResult(
    repo: IRepository,
    session: IRebaseSession,
    result: IGitCommandResult
  ): Promise<IRebaseResult> {
    const repoKey = this.getRepoKey(repo);

    // Check if rebase completed successfully
    if (result.exitCode === 0) {
      const isComplete = !this.isRebaseInProgress(repo);
      if (isComplete) {
        this._sessions.delete(repoKey);
        this._onDidChangeRebaseSession.fire(undefined);
        return { success: true, status: 'completed' };
      }
    }

    // Check for conflicts
    const conflicts = await this.getConflictedFiles(repo);
    if (conflicts.length > 0) {
      session.status = 'conflict';
      this._onDidChangeRebaseSession.fire(session);
      return { success: false, status: 'conflict', conflictedFiles: conflicts };
    }

    // Check if paused for edit action
    // When paused for edit, the rebase is in progress but waiting for user amendments
    const isPausedForEdit = await this.isPausedForEdit(repo);
    if (isPausedForEdit) {
      session.status = 'paused';
      session.currentStep = this.getCurrentRebaseStep(repo);
      this._onDidChangeRebaseSession.fire(session);
      return { success: true, status: 'paused' };
    }

    // Check if paused for reword action
    // When paused for reword, Git is waiting for a new commit message
    const isPausedForReword = this.isPausedForReword(repo);
    if (isPausedForReword) {
      session.status = 'paused';
      session.currentStep = this.getCurrentRebaseStep(repo);
      this._onDidChangeRebaseSession.fire(session);
      return { success: true, status: 'paused' };
    }

    // Check if rebase is still in progress
    if (this.isRebaseInProgress(repo)) {
      session.status = 'in-progress';
      session.currentStep = this.getCurrentRebaseStep(repo);
      this._onDidChangeRebaseSession.fire(session);
      return { success: true, status: 'in-progress' };
    }

    // Rebase completed
    this._sessions.delete(repoKey);
    this._onDidChangeRebaseSession.fire(undefined);
    return { success: true, status: 'completed' };
  }

  /**
   * Check if the rebase is paused for an edit action.
   * When paused for edit, the repository is in a state allowing amendments.
   *
   * @param repo - The repository
   * @returns True if paused for edit
   */
  private async isPausedForEdit(repo: IRepository): Promise<boolean> {
    const rebaseMergePath = path.join(repo.rootUri.fsPath, '.git', 'rebase-merge');

    if (!fs.existsSync(rebaseMergePath)) {
      return false;
    }

    // Check for the 'amend' file which indicates an edit pause
    const amendPath = path.join(rebaseMergePath, 'amend');
    if (fs.existsSync(amendPath)) {
      return true;
    }

    // Also check the message file - if it exists and we're in rebase, we might be paused for edit
    const messagePath = path.join(rebaseMergePath, 'message');
    const stoppedShaPath = path.join(rebaseMergePath, 'stopped-sha');

    // If stopped-sha exists, we're paused at a commit (could be edit or conflict)
    if (fs.existsSync(stoppedShaPath) && fs.existsSync(messagePath)) {
      // Check if there are no conflicts - if no conflicts and stopped, it's likely an edit pause
      const conflicts = await this.getConflictedFiles(repo);
      if (conflicts.length === 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if the rebase is paused for a reword action.
   * When paused for reword, Git is waiting for a new commit message.
   *
   * @param repo - The repository
   * @returns True if paused for reword
   */
  private isPausedForReword(repo: IRepository): boolean {
    const rebaseMergePath = path.join(repo.rootUri.fsPath, '.git', 'rebase-merge');

    if (!fs.existsSync(rebaseMergePath)) {
      return false;
    }

    // Check for COMMIT_EDITMSG which indicates Git is waiting for a commit message
    const commitEditMsgPath = path.join(repo.rootUri.fsPath, '.git', 'COMMIT_EDITMSG');
    if (fs.existsSync(commitEditMsgPath)) {
      // Verify we're in a rebase and not just a regular commit
      const todoPath = path.join(rebaseMergePath, 'git-rebase-todo');
      if (fs.existsSync(todoPath)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the current step in the rebase process.
   *
   * @param repo - The repository
   * @returns The current step number (0-indexed)
   */
  private getCurrentRebaseStep(repo: IRepository): number {
    const rebaseMergePath = path.join(repo.rootUri.fsPath, '.git', 'rebase-merge');
    const donePath = path.join(rebaseMergePath, 'done');

    if (!fs.existsSync(donePath)) {
      return 0;
    }

    try {
      const doneContent = fs.readFileSync(donePath, 'utf8');
      const doneCommits = this.parseTodoFile(doneContent);
      return doneCommits.length;
    } catch {
      return 0;
    }
  }

  /**
   * Provide a new message for a reword action.
   * This should be called when the rebase is paused for reword.
   *
   * @param repo - The repository
   * @param message - The new commit message
   * @returns The result of continuing the rebase with the new message
   */
  async provideRewordMessage(repo: IRepository, message: string): Promise<IRebaseResult> {
    const cwd = repo.rootUri.fsPath;
    const repoKey = this.getRepoKey(repo);
    const session = this._sessions.get(repoKey);

    if (!session) {
      throw new Error('No rebase session found for this repository');
    }

    // Use git commit --amend to change the message during reword
    // This is the standard way to provide a new message during interactive rebase
    const result = await this._gitCli.exec(['commit', '--amend', '-m', message], { cwd });

    if (result.exitCode !== 0) {
      // Check for conflicts
      const conflicts = await this.getConflictedFiles(repo);
      if (conflicts.length > 0) {
        session.status = 'conflict';
        this._onDidChangeRebaseSession.fire(session);
        return { success: false, status: 'conflict', conflictedFiles: conflicts };
      }
      return { success: false, status: 'paused' };
    }

    // Continue the rebase after the amend
    return this.continueRebase(repo);
  }

  /**
   * Provide a combined message for a squash action.
   *
   * Wave C — symmetric companion to {@link provideRewordMessage}. The git
   * mechanics are identical: when the rebase pauses after a `squash`
   * step, git wants a single combined commit message; we feed it through
   * `git commit --amend -m <message>` and resume on `--continue`. The
   * separate method name (vs. reusing `provideRewordMessage`) carries
   * intent at the call site of the new Wave C squash N-commit flow.
   *
   * @param repo - The repository
   * @param message - The combined commit message
   * @returns The result of continuing the rebase with the combined message
   */
  async provideSquashMessage(repo: IRepository, message: string): Promise<IRebaseResult> {
    return this.provideRewordMessage(repo, message);
  }

  /**
   * Amend the current commit during an edit pause.
   * This should be called when the rebase is paused for edit.
   *
   * @param repo - The repository
   * @param message - Optional new commit message
   * @returns The result of the amend operation
   */
  async amendEditCommit(repo: IRepository, message?: string): Promise<IRebaseResult> {
    const cwd = repo.rootUri.fsPath;
    const repoKey = this.getRepoKey(repo);
    const session = this._sessions.get(repoKey);

    if (!session) {
      throw new Error('No rebase session found for this repository');
    }

    // Perform the amend
    const amendArgs = ['commit', '--amend'];
    if (message) {
      amendArgs.push('-m', message);
    } else {
      amendArgs.push('--no-edit');
    }

    const result = await this._gitCli.exec(amendArgs, { cwd });

    if (result.exitCode !== 0) {
      // Check for conflicts
      const conflicts = await this.getConflictedFiles(repo);
      if (conflicts.length > 0) {
        session.status = 'conflict';
        this._onDidChangeRebaseSession.fire(session);
        return { success: false, status: 'conflict', conflictedFiles: conflicts };
      }
      return { success: false, status: 'paused' };
    }

    // Amend succeeded, still paused for further edits
    return { success: true, status: 'paused' };
  }

  /**
   * Clean up a temporary file.
   *
   * @param filePath - The file path to clean up
   */
  private cleanupTempFile(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Get commits that will be rebased.
   *
   * @param repo - The repository
   * @param onto - The commit/branch to rebase onto
   * @returns Array of commits to be rebased
   */
  private async getCommitsToRebase(repo: IRepository, onto: string): Promise<IRebaseCommit[]> {
    const cwd = repo.rootUri.fsPath;

    // Get commits between onto and HEAD
    // These are the commits that will be rebased
    const result = await this._gitCli.exec(
      ['log', '--reverse', '--format=%H%x00%s', `${onto}..HEAD`],
      { cwd }
    );

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return [];
    }

    const commits: IRebaseCommit[] = [];
    const lines = result.stdout.trim().split('\n');

    for (const line of lines) {
      const [hash, message] = line.split('\0');
      if (hash && message) {
        commits.push({
          hash: hash.trim(),
          message: message.trim(),
          action: 'pick', // Default action
        });
      }
    }

    return commits;
  }

  /**
   * Check if a rebase is currently in progress.
   *
   * @param repo - The repository
   * @returns True if a rebase is in progress
   */
  private isRebaseInProgress(repo: IRepository): boolean {
    const rebaseMergePath = path.join(repo.rootUri.fsPath, '.git', 'rebase-merge');
    const rebaseApplyPath = path.join(repo.rootUri.fsPath, '.git', 'rebase-apply');

    return fs.existsSync(rebaseMergePath) || fs.existsSync(rebaseApplyPath);
  }

  /**
   * Detect an active rebase and return session info.
   *
   * @param repo - The repository
   * @returns Partial session info if rebase is active, undefined otherwise
   */
  private detectActiveRebase(repo: IRepository): Partial<IRebaseSession> | undefined {
    const rebaseMergePath = path.join(repo.rootUri.fsPath, '.git', 'rebase-merge');

    if (!fs.existsSync(rebaseMergePath)) {
      return undefined;
    }

    try {
      // Read the todo file to get remaining commits
      const todoPath = path.join(rebaseMergePath, 'git-rebase-todo');
      const donePath = path.join(rebaseMergePath, 'done');
      const ontoPath = path.join(rebaseMergePath, 'onto');
      const headNamePath = path.join(rebaseMergePath, 'head-name');

      let status: RebaseStatus = 'in-progress';
      let onto = '';
      let originalBranch = '';
      const commits: IRebaseCommit[] = [];

      // Read onto
      if (fs.existsSync(ontoPath)) {
        onto = fs.readFileSync(ontoPath, 'utf8').trim();
      }

      // Read original branch
      if (fs.existsSync(headNamePath)) {
        originalBranch = fs.readFileSync(headNamePath, 'utf8').trim();
        // Remove refs/heads/ prefix if present
        if (originalBranch.startsWith('refs/heads/')) {
          originalBranch = originalBranch.substring('refs/heads/'.length);
        }
      }

      // Read todo file for remaining commits
      if (fs.existsSync(todoPath)) {
        const todoContent = fs.readFileSync(todoPath, 'utf8');
        commits.push(...this.parseTodoFile(todoContent));
      }

      // Check for conflicts
      const conflictedFiles = this.getConflictedFilesSync(repo);
      if (conflictedFiles.length > 0) {
        status = 'conflict';
      }

      // Calculate current step from done file
      let currentStep = 0;
      if (fs.existsSync(donePath)) {
        const doneContent = fs.readFileSync(donePath, 'utf8');
        const doneCommits = this.parseTodoFile(doneContent);
        currentStep = doneCommits.length;
      }

      return {
        onto,
        originalBranch,
        commits,
        currentStep,
        status,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Parse a git-rebase-todo file content.
   *
   * @param content - The todo file content
   * @returns Array of rebase commits
   */
  private parseTodoFile(content: string): IRebaseCommit[] {
    const commits: IRebaseCommit[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Parse action, hash, and message
      // Format: action hash message
      const match = trimmed.match(
        /^(pick|p|reword|r|edit|e|squash|s|fixup|f|drop|d)\s+([a-f0-9]+)\s+(.*)$/i
      );
      if (match) {
        const [, actionStr, hash, message] = match;
        const action = this.normalizeAction(actionStr);
        commits.push({ hash, message, action });
      }
    }

    return commits;
  }

  /**
   * Normalize a rebase action string to the full action name.
   *
   * @param action - The action string (may be abbreviated)
   * @returns The normalized action
   */
  private normalizeAction(action: string): RebaseAction {
    const actionLower = action.toLowerCase();
    switch (actionLower) {
      case 'p':
      case 'pick':
        return 'pick';
      case 'r':
      case 'reword':
        return 'reword';
      case 'e':
      case 'edit':
        return 'edit';
      case 's':
      case 'squash':
        return 'squash';
      case 'f':
      case 'fixup':
        return 'fixup';
      case 'd':
      case 'drop':
        return 'drop';
      default:
        return 'pick';
    }
  }

  /**
   * Generate todo file content from commits.
   *
   * @param commits - The commits with their actions
   * @returns The todo file content
   */
  private generateTodoContent(commits: IRebaseCommit[]): string {
    const lines: string[] = [];

    for (const commit of commits) {
      lines.push(`${commit.action} ${commit.hash} ${commit.message}`);
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Get conflicted files in the repository.
   *
   * @param repo - The repository
   * @returns Array of conflicted file paths
   */
  private async getConflictedFiles(repo: IRepository): Promise<string[]> {
    const cwd = repo.rootUri.fsPath;
    const result = await this._gitCli.exec(['status', '--porcelain'], { cwd });

    if (result.exitCode !== 0) {
      return [];
    }

    const conflicts: string[] = [];
    const lines = result.stdout.split('\n');

    for (const line of lines) {
      // Conflicted files have 'U' in either column or 'AA', 'DD', etc.
      if (line.length >= 2) {
        const indexStatus = line[0];
        const workTreeStatus = line[1];
        if (
          indexStatus === 'U' ||
          workTreeStatus === 'U' ||
          (indexStatus === 'A' && workTreeStatus === 'A') ||
          (indexStatus === 'D' && workTreeStatus === 'D')
        ) {
          const filePath = line.substring(3).trim();
          if (filePath) {
            conflicts.push(filePath);
          }
        }
      }
    }

    return conflicts;
  }

  /**
   * Get conflicted files synchronously.
   *
   * @param repo - The repository
   * @returns Array of conflicted file paths
   */
  private getConflictedFilesSync(repo: IRepository): string[] {
    // This is a simplified sync version - in practice, we'd use the async version
    // For detection purposes, we check for MERGE_HEAD or conflict markers
    const mergeMsgPath = path.join(repo.rootUri.fsPath, '.git', 'MERGE_MSG');
    return fs.existsSync(mergeMsgPath) ? ['conflict-detected'] : [];
  }

  /**
   * Get a unique key for a repository.
   *
   * @param repo - The repository
   * @returns A unique key string
   */
  private getRepoKey(repo: IRepository): string {
    return repo.rootUri.fsPath;
  }

  /**
   * Dispose of resources.
   *
   * Wave I WI-D — only dispose `_gitCli` when WE own it. Pre-Wave-I we
   * unconditionally disposed; the new shared-cli path delegates
   * lifecycle to the GitService.
   */
  dispose(): void {
    this._onDidChangeRebaseSession.dispose();
    this._sessions.clear();

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];

    if (this._ownsGitCli) {
      const cli = this._gitCli as unknown as { dispose?: () => void };
      if (typeof cli.dispose === 'function') {
        cli.dispose();
      }
    }
  }
}

/**
 * Create a new RebaseService instance.
 *
 * @param gitCli - Optional GitCli instance to use
 * @param gitService - Optional GitService whose gitCli we adopt
 * @returns A new RebaseService instance
 */
export function createRebaseService(gitCli?: GitCli, gitService?: IGitService): RebaseService {
  return new RebaseService(gitCli, gitService);
}
