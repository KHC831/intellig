import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IMergeView, IMergeState } from './interfaces/IMergeView';
import { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { sanitizeGitError } from '../git-core/gitError';
import { repoRelativePath } from '../utils/repoRelativePath';

/**
 * Thin adapter that routes 3-way conflict resolution to VS Code's built-in
 * merge editor (`git.openMergeEditor`). The previous custom read-only webview
 * (three `<pre>` columns, no editable result) is replaced by the native
 * editor which provides diff alignment, syntax highlighting, and a full
 * editable result pane.
 *
 * `show(file)` resolves the absolute URI of the conflicted file and hands it
 * to `git.openMergeEditor`. All per-file staging (`markResolved`) is handled
 * by `ConflictResolutionService.markResolved()` or by the native editor's own
 * `git.acceptMerge` command.
 *
 * The `IMergeView` interface methods for per-hunk resolution
 * (`acceptCurrent`, `acceptIncoming`, etc.) are retained for interface
 * compatibility but are no-ops in this implementation: the native editor owns
 * hunk-level resolution internally.
 */
export class MergeView implements IMergeView {
  private _repository: IRepository | undefined;

  private _onDidResolve: vscode.EventEmitter<string>;
  readonly onDidResolve: vscode.Event<string>;

  constructor(
    _extensionUri: vscode.Uri,
    private readonly _gitService: IGitService
  ) {
    this._onDidResolve = new vscode.EventEmitter<string>();
    this.onDidResolve = this._onDidResolve.event;
  }

  /**
   * Open the native VS Code merge editor for a conflicted file.
   *
   * `file` may be an absolute path or a path relative to a repository root
   * (the common case from `git status --porcelain`). Relative paths are
   * resolved against each discovered repository root before the command is
   * dispatched so the native editor receives a valid absolute URI.
   *
   * Delegates to the built-in `git.openMergeEditor` command which accepts a
   * `vscode.Uri` of the conflicted file and internally derives the three
   * versions (:1 base, :2 ours, :3 theirs) from the index. The command is
   * contributed by VS Code's built-in `git` extension (confirmed in
   * `/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/git/package.json`
   * and `dist/main.js`).
   */
  async show(file: string): Promise<void> {
    // Resolve the repository owning this file. Try the verbatim path first
    // (covers absolute-path callers), then fall back to joining against each
    // known repo root (covers repo-relative paths from `git status`).
    this._repository = await this._gitService.getRepository(vscode.Uri.file(file));

    const searchedRoots: string[] = [];
    let absolutePath = file;

    if (!this._repository && !path.isAbsolute(file)) {
      for (const repo of this._gitService.getRepositories()) {
        searchedRoots.push(repo.rootUri.fsPath);
        const candidate = path.join(repo.rootUri.fsPath, file);
        if (fs.existsSync(candidate)) {
          this._repository = await this._gitService.getRepository(vscode.Uri.file(candidate));
          if (this._repository) {
            absolutePath = candidate;
            break;
          }
        }
      }
    } else if (this._repository && !path.isAbsolute(file)) {
      absolutePath = path.join(this._repository.rootUri.fsPath, file);
    }

    if (!this._repository) {
      const rootList =
        searchedRoots.length > 0 ? searchedRoots.join(', ') : '(no repositories discovered)';
      throw new Error(
        `No repository found for file "${file}". Searched repository roots: ${rootList}`
      );
    }

    // Record the repo-relative path so markResolved() can stage it later.
    // `repoRelativePath` canonicalizes both ends so a symlinked working-tree
    // path against a realpath-resolved root (macOS `/var` → `/private/var`)
    // does not yield an escaping `../` pathspec that `git add` would silently
    // ignore, leaving the resolved conflict unstaged.
    this._lastFile = repoRelativePath(this._repository.rootUri.fsPath, absolutePath);

    // Hand off to VS Code's native 3-way merge editor. The command takes the
    // URI of the conflicted working-tree file; it resolves the index versions
    // (:1/:2/:3) itself.
    await vscode.commands.executeCommand('git.openMergeEditor', vscode.Uri.file(absolutePath));
  }

  /**
   * No-op: the native merge editor manages its own lifecycle. Kept for
   * interface compatibility with `ResolveConflictsDialog`.
   */
  hide(): void {
    this._repository = undefined;
  }

  /**
   * No-op: hunk-level acceptance is handled inside the native merge editor.
   */
  acceptCurrent(_conflictId?: number): void {}

  /**
   * No-op: hunk-level acceptance is handled inside the native merge editor.
   */
  acceptIncoming(_conflictId?: number): void {}

  /**
   * No-op: hunk-level acceptance is handled inside the native merge editor.
   */
  acceptBoth(_conflictId?: number): void {}

  /**
   * No-op: bulk acceptance is handled inside the native merge editor.
   */
  acceptAllCurrent(): void {}

  /**
   * No-op: bulk acceptance is handled inside the native merge editor.
   */
  acceptAllIncoming(): void {}

  /**
   * No-op: auto-resolve helpers are not applicable to the native editor path.
   * Returns 0 (no conflicts auto-resolved) to satisfy the interface contract.
   */
  applyAllNonConflictingFromLeft(): number {
    return 0;
  }

  /**
   * No-op: symmetric to {@link applyAllNonConflictingFromLeft}.
   */
  applyAllNonConflictingFromRight(): number {
    return 0;
  }

  /**
   * No-op: conflict navigation is handled inside the native merge editor.
   */
  nextConflict(): void {}

  /**
   * No-op: conflict navigation is handled inside the native merge editor.
   */
  previousConflict(): void {}

  /**
   * Stage the resolved file and fire `onDidResolve`. Called from the
   * `intellig.merge.markResolved` command after the user finishes editing in
   * the native merge editor and signals completion. Returns immediately when
   * no repository is bound (e.g. before `show()` was called).
   *
   * Error handling: atomic-write + git-stage failures are caught, surfaced as
   * a sanitised toast, and do NOT fire `onDidResolve` so downstream
   * consumers (e.g. `ResolveConflictsDialog`) treat the file as still
   * unresolved — matching the behaviour of the previous webview path.
   */
  async markResolved(): Promise<void> {
    if (!this._repository) {
      return;
    }

    // The native editor writes the resolved working-tree content itself; we
    // only need to stage the file.
    const relativeFile = this._currentFile;
    if (!relativeFile) {
      return;
    }

    try {
      await this._gitService.stage(this._repository, [relativeFile]);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to mark resolved: ${sanitizeGitError(raw)}`);
      return;
    }

    this._onDidResolve.fire(relativeFile);
    this.hide();
  }

  /**
   * Always returns `undefined` — the native editor manages its own state;
   * there is no in-process merge state to expose.
   */
  getMergeState(): IMergeState | undefined {
    return undefined;
  }

  /**
   * Always returns `false` — conflict resolution state is owned by the native
   * editor, not by this adapter.
   */
  allConflictsResolved(): boolean {
    return false;
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    this._onDidResolve.dispose();
  }

  /** Repo-relative path of the file last opened via `show()`. */
  private get _currentFile(): string | undefined {
    return this._lastFile;
  }

  private _lastFile: string | undefined;
}

/**
 * Create a new MergeView instance
 */
export function createMergeView(extensionUri: vscode.Uri, gitService: IGitService): MergeView {
  return new MergeView(extensionUri, gitService);
}

/** Side of a conflict marker — left = current (ours), right = incoming (theirs). */
export type NonConflictingSide = 'left' | 'right';

/**
 * Identify conflict-region ids that can be auto-resolved by taking the given
 * side. A region is "non-conflicting from left" when the right-side content
 * didn't meaningfully change:
 *
 *  - diff3 markers (base is known): `incomingContent === baseContent` means
 *    only the left side changed — safe to take left.
 *  - diff2 markers (no base): `incomingContent` is empty while
 *    `currentContent` is non-empty → left-only addition — safe to take left.
 *
 * The `'right'` side is symmetric. True both-sided conflicts are left out.
 *
 * Pure so tests can exercise it without instantiating a webview.
 */
export function identifyNonConflictingConflicts(
  conflicts: ReadonlyArray<{
    id: number;
    resolved: boolean;
    baseContent: string;
    currentContent: string;
    incomingContent: string;
  }>,
  side: NonConflictingSide
): number[] {
  const out: number[] = [];
  for (const c of conflicts) {
    if (c.resolved) {
      continue;
    }
    if (side === 'left') {
      // Prefer diff3 check when base is known (non-empty).
      if (c.baseContent.length > 0 && c.incomingContent === c.baseContent) {
        out.push(c.id);
        continue;
      }
      // Fall-back: diff2 style where the right side is empty but the left
      // has content — only the left added lines.
      if (
        c.baseContent.length === 0 &&
        c.incomingContent.length === 0 &&
        c.currentContent.length > 0
      ) {
        out.push(c.id);
      }
    } else {
      if (c.baseContent.length > 0 && c.currentContent === c.baseContent) {
        out.push(c.id);
        continue;
      }
      if (
        c.baseContent.length === 0 &&
        c.currentContent.length === 0 &&
        c.incomingContent.length > 0
      ) {
        out.push(c.id);
      }
    }
  }
  return out;
}

/**
 * Convenience: parse raw file contents with conflict markers and return the
 * ids of conflicts resolvable from the given side. Used by tests that
 * exercise the whole pipeline in one call.
 *
 * Note: this is a light parser used only for testing. It mirrors the
 * private parser in the old {@link MergeView} implementation for diff2 +
 * diff3 marker shapes.
 */
export function identifyNonConflictingHunks(
  markerText: string,
  side: NonConflictingSide
): number[] {
  const lines = markerText.split('\n');
  interface IHunk {
    id: number;
    baseContent: string;
    currentContent: string;
    incomingContent: string;
    resolved: boolean;
  }
  const hunks: IHunk[] = [];
  let inConflict = false;
  let section: 'current' | 'base' | 'incoming' = 'current';
  let currentBuf: string[] = [];
  let baseBuf: string[] = [];
  let incomingBuf: string[] = [];
  let nextId = 0;
  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      section = 'current';
      currentBuf = [];
      baseBuf = [];
      incomingBuf = [];
    } else if (line.startsWith('|||||||') && inConflict) {
      section = 'base';
    } else if (line.startsWith('=======') && inConflict) {
      section = 'incoming';
    } else if (line.startsWith('>>>>>>>') && inConflict) {
      hunks.push({
        id: nextId++,
        baseContent: baseBuf.join('\n'),
        currentContent: currentBuf.join('\n'),
        incomingContent: incomingBuf.join('\n'),
        resolved: false,
      });
      inConflict = false;
    } else if (inConflict) {
      if (section === 'current') {
        currentBuf.push(line);
      } else if (section === 'base') {
        baseBuf.push(line);
      } else {
        incomingBuf.push(line);
      }
    }
  }
  return identifyNonConflictingConflicts(hunks, side);
}
