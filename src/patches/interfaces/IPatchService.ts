/**
 * Patch Service interface.
 *
 * Wraps `git apply`, `git am`, and `git diff` for the Apply Patch and
 * Create Patch from Local Changes dialogs. Apply-patch conflict handoff
 * must route through `IConflictResolutionService.openResolveConflictsDialog`.
 */

import { IRepository } from '../../git-core/interfaces/IGitService';
import { IConflictedFile } from '../../conflicts/interfaces/IConflictResolutionService';

/**
 * Options controlling how a patch is applied.
 *
 * Either `patchPath` (file on disk) or `patchContent` (inline, e.g. from
 * clipboard) must be provided. Providing both is not permitted.
 */
export interface IApplyPatchOptions {
  /** Absolute path to the patch file on disk. Mutually exclusive with `patchContent`. */
  patchPath?: string;
  /** Raw patch text. Mutually exclusive with `patchPath`. */
  patchContent?: string;
  /**
   * When `true`, apply via `git am` (preserves commit authorship + message).
   * When `false` (default), apply via `git apply --3way --index` which leaves
   * the changes staged and can fall through to `--3way` conflict markers on
   * partial overlap.
   */
  useAm?: boolean;
  /** Pass `--reverse` to apply the patch in reverse (rollback). */
  reverse?: boolean;
  /**
   * Dry-run mode. Adds `--check` to `git apply` so paths are validated without
   * mutating the working tree. `useAm=true` is ignored in check mode (git am
   * does not support --check meaningfully).
   */
  check?: boolean;
  /**
   * Base directory for relative paths inside the patch (the `--directory`
   * flag to `git apply`). Used when the patch was generated in a different
   * repo root than the target.
   */
  baseDir?: string;
  /**
   * Strip-path count (the `-p<N>` flag). Default is `1` (standard `git diff`
   * output). Set to `0` to preserve the full path.
   */
  stripLevel?: number;
}

/**
 * Result of an apply-patch operation.
 */
export interface IApplyPatchResult {
  /** `true` when the patch applied cleanly (no conflicts, no errors). */
  success: boolean;
  /**
   * Files that were modified by the patch. Best-effort — derived from the
   * patch header. Always present on success; may be partial on failure if git
   * emitted file paths before aborting.
   */
  appliedFiles: string[];
  /**
   * Files left with conflict markers after a `--3way` apply. When non-empty,
   * callers MUST route these through
   * `IConflictResolutionService.openResolveConflictsDialog` (REVIEW.md §B4).
   */
  conflicts?: IConflictedFile[];
  /** Raw stderr from git, surfaced for toast/error display on plain failure. */
  stderr?: string;
}

/**
 * Options controlling how a patch is generated from local changes.
 *
 * Behavior defaults:
 * - `files` omitted → whole-tree diff.
 * - `stagedOnly` = `false` (default) → unstaged + staged changes combined.
 * - `stagedOnly` = `true` → `git diff --cached` only.
 *
 * Either `toClipboard` OR `outputPath` MAY be provided; if both are omitted
 * the patch is returned as a string (the default return value of
 * `createPatchFromLocalChanges`).
 */
export interface ICreatePatchOptions {
  /** Restrict the patch to these files (repo-relative paths). */
  files?: string[];
  /** Diff only staged changes (via `git diff --cached`). */
  stagedOnly?: boolean;
  /** Write the patch to the system clipboard via `vscode.env.clipboard`. */
  toClipboard?: boolean;
  /** Absolute path to write the patch file. Parent directory must exist. */
  outputPath?: string;
}

/**
 * Patch Service interface.
 */
export interface IPatchService {
  /**
   * Apply a patch to the repository. Delegates to `git apply` (or `git am`
   * when `options.useAm = true`). Conflicts produced by `--3way` are returned
   * in the result's `conflicts` array; callers route those through
   * `IConflictResolutionService.openResolveConflictsDialog`.
   */
  applyPatch(repo: IRepository, options: IApplyPatchOptions): Promise<IApplyPatchResult>;

  /**
   * Create a patch from the repo's local changes and deliver it via the
   * requested channel. Returns the patch text regardless of delivery channel
   * so callers (e.g. tests) can assert the content.
   */
  createPatchFromLocalChanges(repo: IRepository, options: ICreatePatchOptions): Promise<string>;

  /**
   * Dispose of any service-held resources. No-op for the MVP implementation.
   */
  dispose(): void;
}
