import * as vscode from 'vscode';
import { readConfig } from '../config/configKeys';
import * as path from 'path';
import * as fs from 'fs';
import { IMergeView, IMergeState } from './interfaces/IMergeView';
import { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { GitCli } from '../git-core/gitCli';
import { sanitizeGitError } from '../git-core/gitError';
import { isConflictedStatus } from '../git-core/gitParser';
import { canonicalizeFsPath, repoRelativePath } from '../utils/repoRelativePath';
import { ensureSyntheticMergeBase } from './syntheticMergeBase';
import { MergeWindowPanel, IMergeWindowConflictContext } from './merge-window/MergeWindowPanel';
import { getLogger } from '../utils/logger';

/**
 * What the experimental merge window needs beyond MergeView's own
 * dependencies. Absent (older wiring) means the native-editor path is used
 * regardless of the setting.
 */
export interface IMergeWindowDeps {
  context: vscode.ExtensionContext;
  /** Raw stage names + operation; the panel maps them to panes via the reversal predicate. */
  getConflictContext: (repository: IRepository) => Promise<IMergeWindowConflictContext>;
}

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
 * `git.acceptMerge` command. Hunk-level resolution and conflict navigation are
 * owned by the native editor internally.
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

  /**
   * Open merge windows keyed by the file's canonical absolute path. One
   * window per file: a second `show()` reveals the existing window instead
   * of stacking a duplicate whose stale stage data would, on Apply, silently
   * overwrite a resolution completed in the first. (The native-editor path
   * gets this dedup from VS Code itself.) Entries are dropped on panel
   * dispose.
   */
  private readonly _openMergeWindows = new Map<string, MergeWindowPanel>();

  private _onDidResolve: vscode.EventEmitter<string>;
  readonly onDidResolve: vscode.Event<string>;

  constructor(
    _extensionUri: vscode.Uri,
    private readonly _gitService: IGitService,
    private readonly _mergeWindowDeps?: IMergeWindowDeps
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

    const gitCli = (this._gitService as Partial<{ gitCli: GitCli }>).gitCli;

    // Experimental IntelliG merge window (Monaco three-pane, ported IntelliJ
    // engine) behind a setting; the native editor stays the default path.
    // The window handles a missing add/add base in memory (the same
    // conflict-marked-file fallback IntelliJ's loadMergeData uses), so only
    // the native editor — which reads stages from the index itself — needs
    // the synthetic stage-1 written into the index.
    if (this._isMergeWindowEnabled() && this._mergeWindowDeps && gitCli) {
      await this._openMergeWindow(repository, absolutePath, relPath, gitCli);
      return;
    }

    if (gitCli) {
      await this._injectSyntheticBase(repository, relPath, gitCli);
    }
    await this._openNativeMergeEditor(absolutePath);
  }

  /**
   * Add/add conflicts carry no stage-1, so the native editor would show the
   * whole file on both sides over an empty base. Inject a synthetic base from
   * the conflict-marked working file (IntelliJ's loadMergeData fallback) so
   * the editor can collapse the shared lines and show a real diff.
   * Best-effort: a failure must not block opening the editor.
   *
   * The injection READS the stage model and WRITES the index
   * (`update-index --index-info`), so the whole sequence runs under the
   * shared per-repo index lock — otherwise it can interleave with a
   * concurrent bulk accept and re-write unmerged stages for a path the
   * accept just resolved.
   */
  protected async _injectSyntheticBase(
    repository: IRepository,
    relPath: string,
    gitCli: GitCli
  ): Promise<void> {
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

  private _isMergeWindowEnabled(): boolean {
    return readConfig('mergeWindow.enabled') === true;
  }

  /**
   * Hand off to VS Code's native 3-way merge editor. The command takes the
   * URI of the conflicted working-tree file; it resolves the index versions
   * (:1/:2/:3) itself.
   */
  protected async _openNativeMergeEditor(absolutePath: string): Promise<void> {
    await vscode.commands.executeCommand('git.openMergeEditor', vscode.Uri.file(absolutePath));
  }

  /**
   * Open the IntelliG merge window for the conflicted file. The conflict
   * context (operation + stage names) decides the panel's pane assignment:
   * git4idea derives the same thing from the repository state
   * (`GitMergeUtil.isReverseRoot` returns true while REBASING —
   * plugins/git4idea/backend/src/merge/GitMergeUtil.java:468), and it is never
   * a guess there. Neither is it here: an unresolved probe is retried once and
   * then reported, because defaulting to the forward mapping would label the
   * other side's content "Yours" for the whole rebase.
   */
  protected async _openMergeWindow(
    repository: IRepository,
    absolutePath: string,
    relPath: string,
    gitCli: GitCli
  ): Promise<void> {
    const deps = this._mergeWindowDeps;
    if (!deps) {
      return;
    }
    const windowKey = canonicalizeFsPath(absolutePath);
    const existing = this._openMergeWindows.get(windowKey);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active);
      return;
    }
    let conflictContext: IMergeWindowConflictContext;
    try {
      conflictContext = await this._resolveConflictContext(deps, repository);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      getLogger().warn('merge window: conflict-context resolution failed', { err: raw });
      void vscode.window.showErrorMessage(
        `Failed to determine the conflict sides: ${sanitizeGitError(raw)}`
      );
      return;
    }
    const panel = this._createMergeWindowPanel(deps.context, {
      repository,
      relPath,
      absolutePath,
      conflictContext,
      gitCli,
      gitService: this._gitService,
      onApplied: (applied): void => {
        this._shownFiles.delete(windowKey);
        this._onDidResolve.fire(applied);
      },
    });
    this._openMergeWindows.set(windowKey, panel);
    panel.onDidDispose(() => {
      if (this._openMergeWindows.get(windowKey) === panel) {
        this._openMergeWindows.delete(windowKey);
      }
    });
  }

  /**
   * Resolve the conflict context, retrying once so a transient probe failure
   * (a busy index, a momentary lock) does not cost the user the window.
   */
  private async _resolveConflictContext(
    deps: IMergeWindowDeps,
    repository: IRepository
  ): Promise<IMergeWindowConflictContext> {
    try {
      return await deps.getConflictContext(repository);
    } catch {
      return await deps.getConflictContext(repository);
    }
  }

  /** Panel construction seam, so tests can observe opening without a webview. */
  protected _createMergeWindowPanel(
    context: vscode.ExtensionContext,
    opts: ConstructorParameters<typeof MergeWindowPanel>[1]
  ): MergeWindowPanel {
    return new MergeWindowPanel(context, opts);
  }

  /**
   * No-op: the native merge editor manages its own lifecycle (per-file
   * bookkeeping is dropped by `markResolved` as files are staged). Kept for
   * interface compatibility with `ResolveConflictsDialog`.
   */
  hide(): void {}

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
    // Drop entries resolved elsewhere (bulk accept, palette, terminal, a tab
    // closed after an external resolve) FIRST: a stale entry could otherwise
    // win the sole-entry fallback and stage whatever content the file has
    // now — or keep the command needlessly ambiguous.
    await this._pruneEntriesNoLongerConflicted();

    const target = resolveMarkResolvedTarget(this._shownFiles, this._activeEditorFsPath());
    if (!target) {
      if (this._shownFiles.size > 0) {
        getLogger().debug('markResolved: ambiguous target (several merge files outstanding)', {
          outstanding: this._shownFiles.size,
        });
        // The user pressed a button — a silent no-op reads as breakage.
        void vscode.window.showInformationMessage(
          'Several conflicted files are open — focus the merge editor of the file to mark ' +
            'resolved, then run the command again.'
        );
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
   * Remove tracked files that no longer have unmerged index entries. A
   * conflict can be resolved outside this view's flow; the tracking entry
   * then goes stale, and staging it would silently commit whatever the
   * worktree holds. Best-effort: a missing/failed status read prunes nothing
   * (the sole-entry fallback then behaves as before).
   */
  private async _pruneEntriesNoLongerConflicted(): Promise<void> {
    if (this._shownFiles.size === 0 || typeof this._gitService.getStatus !== 'function') {
      return;
    }
    const byRoot = new Map<string, { repository: IRepository; keys: string[] }>();
    for (const [key, entry] of this._shownFiles) {
      const root = entry.repository.rootUri.fsPath;
      const group = byRoot.get(root) ?? { repository: entry.repository, keys: [] };
      group.keys.push(key);
      byRoot.set(root, group);
    }
    for (const group of byRoot.values()) {
      let conflicted: Set<string>;
      try {
        const status = await this._gitService.getStatus(group.repository);
        conflicted = new Set(status.filter(isConflictedStatus).map((f) => f.path));
      } catch {
        continue;
      }
      for (const key of group.keys) {
        const entry = this._shownFiles.get(key);
        if (entry && !conflicted.has(entry.relPath)) {
          this._shownFiles.delete(key);
        }
      }
    }
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
    for (const panel of this._openMergeWindows.values()) {
      panel.dispose();
    }
    this._openMergeWindows.clear();
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
 * Create a new MergeView instance. `mergeWindowDeps` enables the experimental
 * IntelliG merge window path (still gated by `intellig.mergeWindow.enabled`).
 */
export function createMergeView(
  extensionUri: vscode.Uri,
  gitService: IGitService,
  mergeWindowDeps?: IMergeWindowDeps
): MergeView {
  return new MergeView(extensionUri, gitService, mergeWindowDeps);
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
