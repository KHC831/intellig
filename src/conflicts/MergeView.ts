import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IMergeView, IMergeState } from './interfaces/IMergeView';
import { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { GitCli } from '../git-core/gitCli';
import { sanitizeGitError } from '../git-core/gitError';
import { canonicalizeFsPath, repoRelativePath } from '../utils/repoRelativePath';
import { ensureSyntheticMergeBase } from './syntheticMergeBase';
import { getLogger } from '../utils/logger';

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
  /**
   * Every conflict file handed to `show()` that has not been staged yet,
   * keyed by the file's CANONICAL absolute path. `markResolved()` resolves
   * its target here from the active editor (falling back to the sole
   * outstanding entry) — a single "last shown file" slot silently staged the
   * WRONG file whenever more than one merge editor was open.
   */
  private readonly _shownFiles = new Map<string, IShownConflictFile>();

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
    let repository = await this._gitService.getRepository(vscode.Uri.file(file));

    const searchedRoots: string[] = [];
    let absolutePath = file;

    if (!repository && !path.isAbsolute(file)) {
      for (const repo of this._gitService.getRepositories()) {
        searchedRoots.push(repo.rootUri.fsPath);
        const candidate = path.join(repo.rootUri.fsPath, file);
        if (fs.existsSync(candidate)) {
          repository = await this._gitService.getRepository(vscode.Uri.file(candidate));
          if (repository) {
            absolutePath = candidate;
            break;
          }
        }
      }
    } else if (repository && !path.isAbsolute(file)) {
      absolutePath = path.join(repository.rootUri.fsPath, file);
    }

    if (!repository) {
      const rootList =
        searchedRoots.length > 0 ? searchedRoots.join(', ') : '(no repositories discovered)';
      throw new Error(
        `No repository found for file "${file}". Searched repository roots: ${rootList}`
      );
    }

    // Track the shown file so markResolved() can stage it later.
    // `repoRelativePath` canonicalizes both ends so a symlinked working-tree
    // path against a realpath-resolved root (macOS `/var` → `/private/var`)
    // does not yield an escaping `../` pathspec that `git add` would silently
    // ignore, leaving the resolved conflict unstaged. The map key is the
    // canonical absolute path so the active-editor lookup in markResolved()
    // compares like with like.
    const relPath = repoRelativePath(repository.rootUri.fsPath, absolutePath);
    this._shownFiles.set(canonicalizeFsPath(absolutePath), { repository, relPath });

    // Add/add conflicts carry no stage-1, so the native editor would show the
    // whole file on both sides over an empty base. Inject a synthetic base from
    // the conflict-marked working file (IntelliJ's loadMergeData fallback) so
    // the editor can collapse the shared lines and show a real diff. Best-effort:
    // a failure must not block opening the editor.
    //
    // The injection READS the stage model and WRITES the index
    // (`update-index --index-info`), so the whole sequence runs under the
    // shared per-repo index lock — otherwise it can interleave with a
    // concurrent bulk accept and re-write unmerged stages for a path the
    // accept just resolved.
    const gitCli = (this._gitService as Partial<{ gitCli: GitCli }>).gitCli;
    if (gitCli) {
      const root = repository.rootUri.fsPath;
      const inject = (): Promise<boolean> => ensureSyntheticMergeBase(gitCli, root, relPath);
      const withIndexLock = (
        this._gitService as Partial<{
          withIndexLock: <T>(rootPath: string, fn: () => Promise<T>) => Promise<T>;
        }>
      ).withIndexLock;
      try {
        await (typeof withIndexLock === 'function'
          ? withIndexLock.call(this._gitService, root, inject)
          : inject());
      } catch (err) {
        getLogger().debug('synthetic merge base injection failed', {
          file: relPath,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Hand off to VS Code's native 3-way merge editor. The command takes the
    // URI of the conflicted working-tree file; it resolves the index versions
    // (:1/:2/:3) itself.
    await vscode.commands.executeCommand('git.openMergeEditor', vscode.Uri.file(absolutePath));
  }

  /**
   * No-op: the native merge editor manages its own lifecycle (per-file
   * bookkeeping is dropped by `markResolved` as files are staged). Kept for
   * interface compatibility with `ResolveConflictsDialog`.
   */
  hide(): void {}

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
   * the native merge editor and signals completion.
   *
   * Target selection: the file the ACTIVE editor is showing (merge-editor
   * result pane or a plain editor on the conflicted file), falling back to
   * the sole outstanding shown file. With several files outstanding and no
   * active-editor match the command is a NO-OP — guessing here staged a file
   * the user had not finished, silently making its conflict markers
   * committable.
   *
   * Error handling: git-stage failures are caught, surfaced as a sanitised
   * toast, and do NOT fire `onDidResolve` (nor drop the tracking entry) so
   * downstream consumers (e.g. `ResolveConflictsDialog`) treat the file as
   * still unresolved.
   */
  async markResolved(): Promise<void> {
    const target = resolveMarkResolvedTarget(this._shownFiles, this._activeEditorFsPath());
    if (!target) {
      if (this._shownFiles.size > 0) {
        getLogger().debug('markResolved: ambiguous target (several merge files outstanding)', {
          outstanding: this._shownFiles.size,
        });
      }
      return;
    }
    const { key, entry } = target;

    try {
      await this._gitService.stage(entry.repository, [entry.relPath]).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Failed to mark resolved: ${sanitizeGitError(raw)}`);
      return;
    }

    this._shownFiles.delete(key);
    this._onDidResolve.fire(entry.relPath);
  }

  /**
   * The absolute fsPath of the file the user is actively looking at: the
   * active tab's merge-editor RESULT document when the tab is a merge
   * editor, else the active text editor's file-scheme document. Every access
   * is optional-chained — test hosts (and older VS Code builds) may lack the
   * tab-input API.
   */
  private _activeEditorFsPath(): string | undefined {
    const activeTab = (
      vscode.window as Partial<{
        tabGroups: { activeTabGroup?: { activeTab?: { input?: unknown } } };
      }>
    ).tabGroups?.activeTabGroup?.activeTab;
    const input = activeTab?.input as Partial<{ result: { fsPath?: unknown } }> | undefined;
    if (input && typeof input.result?.fsPath === 'string') {
      return input.result.fsPath;
    }
    const doc = vscode.window.activeTextEditor?.document;
    if (doc && doc.uri.scheme === 'file') {
      return doc.uri.fsPath;
    }
    return undefined;
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
    this._shownFiles.clear();
  }
}

/** A conflict file opened via `show()` that has not been staged yet. */
export interface IShownConflictFile {
  /** Repository that owns the file. */
  repository: IRepository;
  /** Repo-root-relative pathspec `git add` needs. */
  relPath: string;
}

/**
 * Pick the file `markResolved()` should stage: the shown entry matching the
 * active editor's file (compared canonically, so symlinked paths match), or
 * the sole outstanding entry when exactly one file is left. Ambiguity
 * (several outstanding, no match) resolves to `undefined` — never a guess.
 * Pure; exported for unit tests.
 */
export function resolveMarkResolvedTarget(
  shown: ReadonlyMap<string, IShownConflictFile>,
  activeFsPath: string | undefined
): { key: string; entry: IShownConflictFile } | undefined {
  if (activeFsPath !== undefined) {
    const key = canonicalizeFsPath(activeFsPath);
    const entry = shown.get(key);
    if (entry) {
      return { key, entry };
    }
  }
  if (shown.size === 1) {
    const [key, entry] = shown.entries().next().value as [string, IShownConflictFile];
    return { key, entry };
  }
  return undefined;
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
