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
  REBASE_ROOT,
} from './interfaces/IRebaseService';
import { IRepository } from './interfaces/IGitService';
import { GitCli, createGitCli, IGitCommandResult, buildGitArgs } from './gitCli';
import { parseStatus, isConflictedStatus } from './gitParser';
import { IGitService } from './interfaces/IGitService';
import { REBASE_PLAN_ENV } from './rebaseTodoEditor';
import { NON_INTERACTIVE_GIT_ENV } from './gitEnv';
import { resolveWorktreeGitDir } from './repo/RepositoryDiscovery';
import { REBASE_APPLY_DIR, REBASE_MERGE_DIR } from './gitDirMarkers';
import {
  IAutostashWatchToken,
  beginAutostashWatch,
  finishAutostashWatch,
  withAutostashParked,
} from './rebaseAutostash';

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
// Typeguard for GitService's @internal cli escape hatch.
interface IGitServiceWithCli {
  gitCli: GitCli;
}

/** POSIX-normalize a path so git's sh accepts it on Windows (no-op on POSIX). */
function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Single-quote a value for a `/bin/sh` command line. */
function shellQuoteSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the GIT_SEQUENCE_EDITOR shim: a `#!/bin/sh` script that runs our Node
 * editor entry on git's todo file. git invokes the sequence editor THROUGH sh on
 * every platform, so both the script path git is handed and the nodeBin /
 * editorJs paths inside it must be forward-slash — an OS-native backslash path
 * is mangled by sh on Windows (C:\a\.git → C:a.git → "command not found").
 * Forward-slashing is a no-op on POSIX, so macOS/Linux output is unchanged.
 */
export function buildSequenceEditorScript(args: {
  gitDir: string;
  nodeBin: string;
  editorJsPath: string;
}): { scriptPath: string; scriptBody: string } {
  const scriptPath = toPosixPath(path.join(args.gitDir, 'rebase-todo-script.sh'));
  const scriptBody = `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 ${shellQuoteSh(toPosixPath(args.nodeBin))} ${shellQuoteSh(toPosixPath(args.editorJsPath))} "$1"
`;
  return { scriptPath, scriptBody };
}

export class RebaseService implements IRebaseService {
  private _gitCli: GitCli;
  /**
   * When `true`, this service owns its `_gitCli` and is
   * responsible for disposing it. When `false`, the cli was reached
   * through a shared GitService (see ctor docs) and the GitService owns
   * the lifecycle. Every secondary service spun up its own
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
   * Accept `gitService` so we can route rebase commands
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
   * True when a live in-memory session exists for the repo — the extension is
   * driving this rebase (squash / interactive rebase / a paused extension-run
   * rebase). Reads the RAW map only: unlike {@link getRebaseSession} it never
   * reconstructs a session from disk, so an inherited/CLI rebase reads false.
   *
   * Self-reconciles against git reality: a post-planning session whose
   * on-disk rebase is gone is a phantom — the rebase reached a terminal state
   * through a path that doesn't touch this service (the resolve dialog's
   * Continue/Abort, the terminal). Left in place it would suppress
   * `wireRebasePausedWarning` for a future genuinely-inherited rebase in the
   * repo, so it is cleared here and reported false. A `planning` session has
   * no git backing by design and always survives.
   */
  isManagingRebase(repo: IRepository): boolean {
    const session = this._sessions.get(this.getRepoKey(repo));
    if (!session) {
      return false;
    }
    if (session.status !== 'planning' && !this.isRebaseInProgress(repo)) {
      this.clearSession(repo);
      return false;
    }
    return true;
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
        // `message` mirrors the override for display in the plan, falling back
        // to the commit's own message. `newMessage` is kept SEPARATE so a
        // genuine user override is distinguishable from a commit's own message:
        // only the former may later fire the inline reword/squash override
        // machinery in executeRebase.
        message: action.newMessage || existingCommit.message,
        action: action.action,
        newMessage: action.newMessage,
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
   * Discard any cached rebase session for the repository.
   *
   * An interactive-rebase session is stored in 'planning' state before any
   * `git rebase` runs (the editor revises the plan first). If the user
   * abandons the editor without executing, that session lingers with no git
   * backing and poisons later branch ops. Callers clear it on abandon.
   *
   * @param repo - The repository
   */
  clearSession(repo: IRepository): void {
    const repoKey = this.getRepoKey(repo);
    if (this._sessions.delete(repoKey)) {
      this._onDidChangeRebaseSession.fire(undefined);
    }
  }

  /**
   * Does this git error indicate there is simply no rebase in progress (a
   * phantom/stale session) rather than a genuine failure? git phrases this
   * as "No rebase in progress?".
   *
   * @param message - The combined stderr/stdout from the failed command
   */
  private isNoRebaseInProgressError(message: string): boolean {
    return /no rebase in progress/i.test(message);
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

    // `rebase --continue` commits the replayed pick using its stored message.
    // Pin the editor to a no-op so git commits it verbatim instead of trying to
    // open an editor under the non-TTY spawn — which fails outright when the
    // host has no EDITOR set ("Terminal is dumb, but EDITOR unset"). Mirrors the
    // GIT_EDITOR handling on the interactive-rebase start.
    const { result, autostashParked } = await withAutostashParked(this._gitCli, cwd, () =>
      this._gitCli.exec(['rebase', '--continue'], {
        cwd,
        env: { ...process.env, ...NON_INTERACTIVE_GIT_ENV },
      })
    );

    // Reconcile against git reality: if git reports no rebase in progress, the
    // cached session is a phantom (e.g. an abandoned planning session). Clear
    // it and report the no-op honestly (cleared-stale, not completed) instead
    // of surfacing a raw fatal — no commits were replayed.
    if (result.exitCode !== 0 && this.isNoRebaseInProgressError(result.combined)) {
      this.clearSession(repo);
      return { success: true, status: 'cleared-stale' };
    }

    if (result.exitCode === 0) {
      // Check if rebase is complete
      const isComplete = !this.isRebaseInProgress(repo);

      if (isComplete) {
        this._finishRebase(repo, repoKey);
        return { success: true, status: 'completed', autostashParked };
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
      // Reached from --continue/--skip/amend, so a rebase is necessarily still
      // in progress: the conflict is continuable.
      return {
        success: false,
        status: 'conflict',
        conflictedFiles: conflicts,
        rebaseInProgress: true,
      };
    }

    return { success: false, status: 'paused' };
  }

  /**
   * Abort the rebase and restore original state.
   *
   * @param repo - The repository
   */
  async abortRebase(repo: IRepository): Promise<{ autostashParked: boolean }> {
    const cwd = repo.rootUri.fsPath;
    const repoKey = this.getRepoKey(repo);

    const { result, autostashParked } = await withAutostashParked(this._gitCli, cwd, () =>
      this._gitCli.exec(['rebase', '--abort'], { cwd })
    );

    // A "no rebase in progress" fatal means the cached session was a phantom
    // (e.g. an abandoned planning session). Treat it as a successful clear so
    // it stops poisoning later ops, rather than surfacing the raw fatal.
    if (result.exitCode !== 0 && !this.isNoRebaseInProgressError(result.combined)) {
      throw new Error(`Git command failed: git rebase --abort\n${result.combined}`);
    }

    // Clear the session
    this._finishRebase(repo, repoKey);
    return { autostashParked };
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

    // Reconcile against git reality: no rebase in progress → phantom session.
    // Report the no-op honestly (cleared-stale, not completed).
    if (result.exitCode !== 0 && this.isNoRebaseInProgressError(result.combined)) {
      this.clearSession(repo);
      return { success: true, status: 'cleared-stale' };
    }

    if (result.exitCode === 0) {
      // Check if rebase is complete
      const isComplete = !this.isRebaseInProgress(repo);

      if (isComplete) {
        this._finishRebase(repo, repoKey);
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
      // Reached from --continue/--skip/amend, so a rebase is necessarily still
      // in progress: the conflict is continuable.
      return {
        success: false,
        status: 'conflict',
        conflictedFiles: conflicts,
        rebaseInProgress: true,
      };
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

    // The user's plan: action + (optional) new message, in the planned order.
    // It is applied to git's REAL todo by the sequence editor — NOT rebuilt
    // from scratch — so git's structural lines (update-ref/label/reset/merge/
    // exec) survive (see rebaseTodo.ts / IntelliJ git4idea parity).
    //
    // `newMessage` carries ONLY a genuine user override (an inline reword or
    // squash message). It must never be back-filled from the commit's own
    // message: doing so makes every squash/reword entry satisfy
    // hasSquashOverride/hasRewordOverride, which rewrites the entry to a
    // non-interactive amend with that commit's OWN message and silently drops
    // the user's intended message.
    const plan: IRebaseAction[] = session.commits.map((c) => ({
      hash: c.hash,
      action: c.action,
      newMessage: c.newMessage,
    }));

    // The sequence editor is a `.sh` shim that runs our Node editor entry on
    // git's todo file. Node is reached via the current binary
    // (`process.execPath` — under VS Code that's Electron, so
    // ELECTRON_RUN_AS_NODE=1 makes it behave as plain node). The editor reads
    // the plan from INTELLIG_REBASE_PLAN and rewrites the todo in place.
    //
    // The editor is its OWN esbuild bundle (`npm run build:sequence-editor`)
    // emitted next to dist/extension.js, so the __dirname sibling resolves in
    // the shipped layout; check:vsix-clean pins it in the runtime manifest.
    const { scriptPath: todoScriptPath, scriptBody: todoScript } = buildSequenceEditorScript({
      gitDir: this.gitDir(repo),
      nodeBin: process.execPath,
      editorJsPath: path.join(__dirname, 'rebaseTodoEditor.js'),
    });

    // Write the script file atomically (write-to-temp + rename).
    // Preserves mode 0o755 so git can exec the sequence editor. See
    // {@link atomicWriteFileSync} for the crash-during-write rationale.
    atomicWriteFileSync(todoScriptPath, todoScript, { mode: 0o755 });

    // The autostash is created AND (on a pop conflict) parked inside the one
    // `git rebase` command below, so no marker is observable beforehand —
    // the token's stash-tip snapshot is the detection signal at the
    // completed arm (see rebaseAutostash module doc).
    const autostashToken = await beginAutostashWatch(this._gitCli, cwd);

    try {
      // Start the interactive rebase with our custom sequence editor.
      // The GIT_SEQUENCE_EDITOR transforms git's todo with our plan.
      // `--autostash` stashes a dirty working tree before the todo editor
      // runs and re-applies it after the rebase finishes, so it never
      // interferes with the custom sequence editor while still letting an
      // interactive rebase start from a dirty tree.
      const result = await this._gitCli.exec(
        // REBASE_ROOT swaps the positional base for `--root`: the initial
        // commit has no parent to rebase onto.
        buildGitArgs(
          'rebase',
          session.onto === REBASE_ROOT ? ['-i', '--autostash', '--root'] : ['-i', '--autostash'],
          session.onto === REBASE_ROOT ? [] : [session.onto]
        ),
        {
          cwd,
          env: {
            ...process.env,
            GIT_SEQUENCE_EDITOR: todoScriptPath,
            // git also consults GIT_EDITOR for a `reword`/`squash` message and
            // an `edit` pause. Pin it to a no-op so a blank reword/squash or an
            // edit stop never falls back to the host's ambient editor under a
            // non-TTY spawn (which hangs/fails). The override path supplies
            // reword/squash messages separately via `commit --amend -m`/`-F
            // ... --no-edit`, so 'true' is safe — it only suppresses the
            // interactive editor git would otherwise open.
            GIT_EDITOR: 'true',
            [REBASE_PLAN_ENV]: JSON.stringify(plan),
          },
        }
      );

      // Clean up the script file
      this.cleanupTempFile(todoScriptPath);

      // Update session status based on result
      return await this.handleRebaseResult(repo, session, result, autostashToken);
    } catch (error) {
      // Clean up on error
      this.cleanupTempFile(todoScriptPath);
      throw error;
    }
  }

  /**
   * Single-quote a path for safe interpolation into the POSIX `sh` shim
   * (handles spaces and shell metacharacters in install paths). Embedded
   * single quotes are escaped via the standard `'\''` idiom.
   */
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
    result: IGitCommandResult,
    autostashToken?: IAutostashWatchToken
  ): Promise<IRebaseResult> {
    const repoKey = this.getRepoKey(repo);
    // Resolved only at the terminal (completed) arms — a still-live rebase
    // has not reached the autostash reapply yet.
    const autostashParked = async (): Promise<boolean> =>
      autostashToken
        ? finishAutostashWatch(this._gitCli, repo.rootUri.fsPath, autostashToken)
        : false;

    // Check for conflicts first, even on a zero exit code. With `--autostash`
    // git replays the commits, then re-applies the stashed working tree; if
    // that re-apply collides with the rebased changes git leaves unmerged
    // files behind but STILL exits 0. Inspecting unmerged files before the
    // success path surfaces that pop-conflict instead of reporting a clean
    // completion.
    const conflicts = await this.getConflictedFiles(repo);
    if (conflicts.length > 0) {
      // Both a continuable mid-rebase conflict and a terminal autostash pop
      // conflict list the same unmerged files, so both report status
      // 'conflict' (the resolve dialog opens and lists the files in both
      // cases). They differ only in continuability, surfaced via the
      // orthogonal `rebaseInProgress` flag: a genuine replay conflict leaves a
      // live rebase in progress (.git/rebase-merge or rebase-apply present),
      // continuable via `git rebase --continue`/`--abort`. The autostash pop
      // conflict happens AFTER the rebase completes — git has already removed
      // the rebase metadata, so `--continue` would dead-end on "no rebase in
      // progress". Consumers gate the continue/abort affordance on
      // `rebaseInProgress === true`.
      const rebaseInProgress = this.isRebaseInProgress(repo);
      // A terminal autostash-pop conflict means the rebase itself already
      // finished, so its reword/squash override files are spent — remove them
      // (a still-live rebase keeps them: its remaining exec lines need them).
      if (!rebaseInProgress) {
        this._cleanupRewordFiles(repo);
      }
      session.status = 'conflict';
      this._onDidChangeRebaseSession.fire(session);
      return { success: false, status: 'conflict', conflictedFiles: conflicts, rebaseInProgress };
    }

    // Check if rebase completed successfully
    if (result.exitCode === 0) {
      const isComplete = !this.isRebaseInProgress(repo);
      if (isComplete) {
        this._finishRebase(repo, repoKey);
        return { success: true, status: 'completed', autostashParked: await autostashParked() };
      }
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
    this._finishRebase(repo, repoKey);
    return { success: true, status: 'completed', autostashParked: await autostashParked() };
  }

  /**
   * Check if the rebase is paused for an edit action.
   * When paused for edit, the repository is in a state allowing amendments.
   *
   * @param repo - The repository
   * @returns True if paused for edit
   */
  private async isPausedForEdit(repo: IRepository): Promise<boolean> {
    const rebaseMergePath = path.join(this.gitDir(repo), REBASE_MERGE_DIR);

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
    const gitDir = this.gitDir(repo);
    const rebaseMergePath = path.join(gitDir, REBASE_MERGE_DIR);

    if (!fs.existsSync(rebaseMergePath)) {
      return false;
    }

    // Check for COMMIT_EDITMSG which indicates Git is waiting for a commit message
    const commitEditMsgPath = path.join(gitDir, 'COMMIT_EDITMSG');
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
    const rebaseMergePath = path.join(this.gitDir(repo), REBASE_MERGE_DIR);
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
        // Reached from --continue/--skip/amend, so a rebase is necessarily still
        // in progress: the conflict is continuable.
        return {
          success: false,
          status: 'conflict',
          conflictedFiles: conflicts,
          rebaseInProgress: true,
        };
      }
      return { success: false, status: 'paused' };
    }

    // Continue the rebase after the amend. continueRebase can self-clear a
    // phantom session and return 'cleared-stale', so reword/squash can
    // transitively surface that status — the consumer handles it as a no-op
    // rather than a successful message rewrite.
    return this.continueRebase(repo);
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
        // Reached from --continue/--skip/amend, so a rebase is necessarily still
        // in progress: the conflict is continuable.
        return {
          success: false,
          status: 'conflict',
          conflictedFiles: conflicts,
          rebaseInProgress: true,
        };
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
      // eslint-disable-next-line no-restricted-syntax -- best-effort cleanup of a temp file; a stale temp file is harmless and there is no recovery worth surfacing.
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

    // Get commits between onto and HEAD — these are the commits that will be
    // rebased. `--no-merges` is essential: the interactive rebase runs as a
    // plain `git rebase -i` (no `--rebase-merges`), which FLATTENS the history
    // and omits merge commits from the todo. Without `--no-merges` here, a
    // merge in `onto..HEAD` would appear in the plan but not in git's todo, and
    // transformRebaseTodo would throw ("references commit not in todo"),
    // aborting the rebase over any merge history.
    const result = await this._gitCli.exec(
      buildGitArgs(
        'log',
        ['--reverse', '--no-merges', '--format=%H%x00%s'],
        // A --root rebase replays the ENTIRE history reachable from HEAD.
        [onto === REBASE_ROOT ? 'HEAD' : `${onto}..HEAD`]
      ),
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
   * Finalize a rebase that has reached a terminal state (completed or aborted):
   * drop the cached session, notify listeners, and remove any leftover
   * `.intellig-reword-*.txt` override files. Only called from terminal points
   * so a paused rebase (whose remaining exec lines still reference those files)
   * is never cleaned mid-flight.
   */
  private _finishRebase(repo: IRepository, repoKey: string): void {
    this._sessions.delete(repoKey);
    this._onDidChangeRebaseSession.fire(undefined);
    this._cleanupRewordFiles(repo);
  }

  /**
   * Remove the per-commit reword/squash message-override files the sequence
   * editor wrote into the git dir (`.intellig-reword-<hash>.txt`). They are
   * consumed by the `exec git commit --amend -F` todo lines during the rebase
   * and only litter the git dir afterwards. Best-effort: an unreadable git dir
   * (e.g. a linked-worktree gitlink file) or a concurrently-removed file is
   * ignored.
   */
  private _cleanupRewordFiles(repo: IRepository): void {
    const gitDir = this.gitDir(repo);
    let names: string[];
    try {
      names = fs.readdirSync(gitDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (/^\.intellig-reword-.*\.txt$/.test(name)) {
        try {
          fs.unlinkSync(path.join(gitDir, name));
          // eslint-disable-next-line no-restricted-syntax -- best-effort cleanup of a leftover reword file (see the method doc); a concurrently-removed file or unreadable git dir is harmless.
        } catch {
          // best-effort
        }
      }
    }
  }

  /**
   * Check if a rebase is currently in progress.
   *
   * @param repo - The repository
   * @returns True if a rebase is in progress
   */
  private isRebaseInProgress(repo: IRepository): boolean {
    const gitDir = this.gitDir(repo);
    const rebaseMergePath = path.join(gitDir, REBASE_MERGE_DIR);
    const rebaseApplyPath = path.join(gitDir, REBASE_APPLY_DIR);

    return fs.existsSync(rebaseMergePath) || fs.existsSync(rebaseApplyPath);
  }

  /**
   * Detect an active rebase and return session info.
   *
   * @param repo - The repository
   * @returns Partial session info if rebase is active, undefined otherwise
   */
  private detectActiveRebase(repo: IRepository): Partial<IRebaseSession> | undefined {
    const rebaseMergePath = path.join(this.gitDir(repo), REBASE_MERGE_DIR);

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
   * Get conflicted files in the repository.
   *
   * @param repo - The repository
   * @returns Array of conflicted file paths
   */
  private async getConflictedFiles(repo: IRepository): Promise<string[]> {
    const cwd = repo.rootUri.fsPath;
    // `-z` so unmerged paths with non-ASCII / space / newline names come back
    // verbatim (the default newline format C-quotes them, yielding a path that
    // points at no file). `isConflictedStatus` covers U-in-either-column plus
    // the both-added (AA) / both-deleted (DD) unmerged states.
    const result = await this._gitCli.exec(['status', '--porcelain', '-z'], { cwd });

    if (result.exitCode !== 0) {
      return [];
    }

    return parseStatus(result.stdout)
      .filter(isConflictedStatus)
      .map((file) => file.path)
      .filter((filePath) => filePath.length > 0);
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
    const mergeMsgPath = path.join(this.gitDir(repo), 'MERGE_MSG');
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
   * The repo's real git directory. In a normal checkout this is
   * `<root>/.git`; in a LINKED WORKTREE `<root>/.git` is a pointer FILE, so
   * every marker read/write (rebase-merge, COMMIT_EDITMSG, the sequence-editor
   * script, reword override files) must follow the pointer. All `.git`-relative
   * fs access in this service routes through here so it stays worktree-correct.
   */
  private gitDir(repo: IRepository): string {
    return resolveWorktreeGitDir(repo.rootUri.fsPath);
  }

  /**
   * Dispose of resources.
   *
   * Only dispose `_gitCli` when WE own it. We
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
