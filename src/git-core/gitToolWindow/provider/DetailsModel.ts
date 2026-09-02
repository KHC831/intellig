/**
 * The Git tool window's details-panel pending state: the single-commit
 * changed-files payload, the containing-branches list, the multi-selection
 * file cache, and the Group By mode. A passive store — it fires no events and
 * posts nothing; the provider's orchestrators mutate it and own every effect
 * (event fires, webview posts, persistence). Owned by GitToolWindowProvider
 * as `provider.details`.
 */

import type { IChangedFile } from '../../interfaces/IGitToolWindowProvider';
import type { DetailsGroupBy } from './detailsPanelModel.types';

export class DetailsModel {
  private _pendingChangedFiles: IChangedFile[] | undefined;
  private _pendingChangedFilesError: unknown;
  /**
   * The commit {@link _pendingChangedFiles} was loaded for. The payload is only
   * ever read for a matching hash, so a selection that lands on a different
   * commit reads as "not loaded yet" (and gets a load) rather than showing its
   * predecessor's files — mis-attribution is impossible instead of resting on
   * every selection mutator remembering to clear.
   */
  private _pendingChangedFilesHash: string | undefined;
  /**
   * The commit a single-commit changed-files load is already running (or done)
   * for. Keeps the request seam idempotent so it can ask on every repaint
   * without spawning a `git diff` per paint.
   */
  private _singleFilesRequestedHash: string | undefined;
  /**
   * Branches containing the expanded commit, fetched asynchronously after the
   * commit is selected. `undefined` = not yet loaded (the panel shows a loading
   * affordance); resets alongside the pending changed files on a new selection.
   */
  private _pendingContainingBranches: string[] | undefined;
  /**
   * The commit {@link _pendingContainingBranches} was loaded for. Pinned for
   * the same reason as the changed-files payload: a list read under any other
   * commit describes the wrong one.
   */
  private _pendingContainingBranchesHash: string | undefined;
  /**
   * Changed files per commit for the CURRENT multi-commit selection, keyed by
   * hash, plus the selection they belong to. The key guards against a slow
   * load landing after the user moved on: files are only painted while the
   * selection that asked for them is still the live one.
   */
  private _multiChangedFiles = new Map<string, IChangedFile[]>();
  /** Why a commit in the current selection contributed no files, keyed by hash. */
  private _multiChangedFileErrors = new Map<string, string>();
  private _multiSelectionKey: string | undefined;
  /** Commits in the current selection whose files were NOT loaded (the cap). */
  private _multiSelectionLoaded: ReadonlySet<string> | undefined;
  /** Changed-files Group By mode for the details panel (persisted host-side). */
  private _detailsGroupBy: DetailsGroupBy;

  constructor(initialGroupBy: DetailsGroupBy) {
    this._detailsGroupBy = initialGroupBy;
  }

  /** Store a loaded single-commit changed-files payload (with its error). */
  public setPendingFiles(hash: string, files: IChangedFile[], error?: unknown): void {
    this._pendingChangedFiles = files;
    this._pendingChangedFilesError = error;
    this._pendingChangedFilesHash = hash;
  }

  /** Store the loaded containing-branches list for `hash`. */
  public setPendingContainingBranches(hash: string, branches: string[]): void {
    this._pendingContainingBranches = branches;
    this._pendingContainingBranchesHash = hash;
  }

  /**
   * Clear the pending changed-files payload, its error, the single-request
   * latch, and the containing-branches list together: they all describe one
   * commit selection, so a new selection starts from the loading state and
   * never shows the previous commit's data.
   */
  public clearPending(): void {
    this._pendingChangedFiles = undefined;
    this._pendingChangedFilesError = undefined;
    this._pendingChangedFilesHash = undefined;
    this._singleFilesRequestedHash = undefined;
    this._pendingContainingBranches = undefined;
    this._pendingContainingBranchesHash = undefined;
  }

  /**
   * The loaded containing-branches list, but only when it belongs to `hash`.
   * A list loaded for another commit reads as undefined — the "still loading"
   * shape — so the panel never names branches that contain a different commit.
   *
   * The single read path for the field, as {@link pendingFilesFor} is for the
   * changed files: every call site sharing one accessor is what makes the pin
   * hold by construction rather than wherever a guard was remembered.
   */
  public pendingBranchesFor(hash: string): string[] | undefined {
    return this._pendingContainingBranchesHash === hash
      ? this._pendingContainingBranches
      : undefined;
  }

  /**
   * The loaded changed-files payload, but only when it belongs to `hash`. A
   * payload loaded for another commit reads as an empty, error-free list — the
   * "not loaded yet" shape the seam answers with a load.
   */
  public pendingFilesFor(hash: string): {
    changedFiles: IChangedFile[];
    changedFilesError: string | undefined;
  } {
    if (this._pendingChangedFilesHash !== hash) {
      return { changedFiles: [], changedFilesError: undefined };
    }
    return {
      changedFiles: this._pendingChangedFiles ?? [],
      changedFilesError: this._pendingChangedFilesError
        ? String(this._pendingChangedFilesError)
        : undefined,
    };
  }

  /**
   * Identity of a multi-commit selection, order-independent — the cache key
   * that decides whether a completed file load still describes what is
   * selected.
   */
  public selectionKeyOf(hashes: readonly string[]): string {
    return [...hashes].sort().join(','); // ref-sort-exempt: commit hashes, a cache key
  }

  /**
   * Record `hashes` as the current multi-commit selection.
   *
   * `alreadyCurrent` means the selection is unchanged (the caller skips the
   * reload); `warm` means files for it are already cached. On a NEW selection
   * the previous selection's cache is dropped — recording the key even for a
   * selection too small to need a load is what makes a still-running load for
   * the old selection land as stale instead of painting over the new one.
   */
  public noteMultiSelection(hashes: readonly string[]): {
    alreadyCurrent: boolean;
    warm: boolean;
  } {
    const key = this.selectionKeyOf(hashes);
    if (this._multiSelectionKey === key) {
      return { alreadyCurrent: true, warm: this._multiChangedFiles.size > 0 };
    }
    this._multiSelectionKey = key;
    this._multiChangedFiles.clear();
    this._multiChangedFileErrors.clear();
    this._multiSelectionLoaded = undefined;
    return { alreadyCurrent: false, warm: false };
  }

  /**
   * Accept a completed multi-selection file load. Returns `false` (and stores
   * nothing) when `hashes` no longer describe the live selection — a payload
   * for a selection the user has already left is dropped.
   */
  public acceptMultiFiles(
    hashes: readonly string[],
    filesByHash: ReadonlyMap<string, IChangedFile[]>,
    loadedHashes: readonly string[],
    errorsByHash: ReadonlyMap<string, string>
  ): boolean {
    if (this.selectionKeyOf(hashes) !== this._multiSelectionKey) {
      return false;
    }
    this._multiChangedFiles = new Map(filesByHash);
    this._multiChangedFileErrors = new Map(errorsByHash);
    this._multiSelectionLoaded = new Set(loadedHashes);
    return true;
  }

  /** Changed files already loaded for `hash` in the current selection. */
  public getMultiChangedFiles(hash: string): IChangedFile[] | undefined {
    return this._multiChangedFiles.get(hash);
  }

  /** Why `hash` contributed no files to the current selection, if it failed. */
  public getMultiChangedFilesError(hash: string): string | undefined {
    return this._multiChangedFileErrors.get(hash);
  }

  /** The subset of the current selection whose files were actually loaded. */
  public getMultiSelectionLoaded(): ReadonlySet<string> | undefined {
    return this._multiSelectionLoaded;
  }

  /**
   * Record `hash` as the single-commit selection a file load was requested
   * for. Returns `false` when a load is already running (or done) for it, so
   * the caller only fires the load event once per commit.
   */
  public noteSingleRequest(hash: string): boolean {
    if (this._singleFilesRequestedHash === hash) {
      return false;
    }
    this._singleFilesRequestedHash = hash;
    return true;
  }

  /** How the details panel currently groups changed files. */
  public getGroupBy(): DetailsGroupBy {
    return this._detailsGroupBy;
  }

  /**
   * Switch the Group By mode. Returns `false` on a no-op (same mode), so the
   * caller skips persistence and the repaint.
   */
  public setGroupBy(mode: DetailsGroupBy): boolean {
    if (this._detailsGroupBy === mode) {
      return false;
    }
    this._detailsGroupBy = mode;
    return true;
  }
}
