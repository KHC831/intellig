/**
 * Patch Service interface.
 *
 * Wraps `git apply`, `git am`, and `git diff` for the Apply Patch and
 * Create Patch from Local Changes dialogs. Apply-patch conflict handoff
 * must route through `IConflictResolutionService.openResolveConflictsDialog`.
 */

import { IRepository } from '../../git-core/interfaces/IGitService';
import type { IPreApplyState } from '../../git-core/ops/preservedChanges';
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
   * Dry-run mode: `git apply --3way --check`, the apply strategy without
   * `--index`, so the verdict predicts the real apply and nothing is written.
   * `useAm=true` falls back to `git apply` here (git am has no dry run); the
   * diff either lands or does not regardless of who commits it.
   *
   * Outcomes mirror a real apply: success for a clean merge, `conflicts` for
   * one that needs markers, `stderr` when the patch cannot apply at all.
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
   * `IConflictResolutionService.openResolveConflictsDialog` (REVIEW.md section B4).
   */
  conflicts?: IConflictedFile[];
  /** Raw stderr from git, surfaced for toast/error display on plain failure. */
  stderr?: string;
  /**
   * `true` when a `useAm` apply failed AND left a paused `git am` session on
   * disk (`.git/rebase-apply/applying`). Callers must offer the am recovery
   * ops ({@link IPatchService.amContinue} / `amSkip` / `amAbort`) — a plain
   * error toast strands the user in a session only `git am` commands can end.
   * Never set for plain `git apply` runs (they create no repo state).
   */
  amSessionActive?: boolean;
  /**
   * Pre-apply restore token, present ONLY on a plain 3-way CONFLICT result
   * (the arm that leaves partial state: conflicted files carry markers,
   * clean siblings land fully). Callers thread it into the Resolve Conflicts
   * handoff so Abort can restore the FULL pre-apply state. Success and hard
   * failure carry no token — a hard failure is atomic (git apply's
   * all-or-nothing contract), and the snapshot itself is an unreferenced
   * `git stash create` commit, so dropping it leaves no stash-stack litter.
   */
  preApplyState?: IPreApplyState;
}

/**
 * Result of an am session recovery op (`git am --continue|--skip|--abort`).
 */
export interface IAmSessionOpResult {
  /** `true` when git finished the operation cleanly. */
  success: boolean;
  /**
   * Unmerged files present after a failed continue/skip (the next mailbox
   * patch collided). Callers route these through the Resolve Conflicts dialog
   * with `operation: 'applyPatch'`.
   */
  conflicts?: IConflictedFile[];
  /** Sanitized git error for non-conflict failures. */
  failureReason?: string;
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
  /**
   * Generate the patch in reverse (`git diff -R`): applying it undoes the
   * local changes. Mirrors IntelliJ's Create Patch "Reverse" checkbox
   * (CreatePatchConfigurationPanel).
   */
  reverse?: boolean;
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
   * Continue a paused `git am` session after the user resolves conflicts
   * (`git am --continue`). Further conflicts (the next mailbox patch collided)
   * come back in `conflicts`.
   */
  amContinue(repo: IRepository): Promise<IAmSessionOpResult>;

  /**
   * Skip the failing patch of a paused `git am` session and apply the rest
   * (`git am --skip`). Destructive of the skipped patch's changes — callers
   * gate with a single confirm modal.
   */
  amSkip(repo: IRepository): Promise<IAmSessionOpResult>;

  /**
   * Abort a paused `git am` session, restoring the pre-apply state
   * (`git am --abort`). Destructive of the in-flight apply — callers gate
   * with a single confirm modal.
   */
  amAbort(repo: IRepository): Promise<IAmSessionOpResult>;

  /**
   * Dispose of any service-held resources. No-op for the MVP implementation.
   */
  dispose(): void;
}
