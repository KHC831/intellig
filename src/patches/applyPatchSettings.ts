/**
 * Persisted settings and pure decision helpers for the Apply Patch dialog.
 *
 * IntelliJ's ApplyPatchDifferentiatedDialog remembers the last patch location
 * and shows a per-file verdict before the user commits to applying, with OK
 * disabled while the form carries a ValidationInfo. These helpers hold the
 * parts of that behaviour that don't need the webview, so they stay testable.
 */

import { sanitizeGitError } from '../git-core/gitError';
import type { PersistedSlot } from '../utils/persistedState';
import type { IApplyPatchResult } from './interfaces/IPatchService';
import { validateStripLevel } from './applyPatchValidation';
import { validateBaseDir } from './PatchService';

/** Dialog state that survives a reopen. Every field is independently optional. */
export interface IApplyPatchSettings {
  /** Directory the last patch was chosen from, seeding the Browse… dialog. */
  lastPatchDir?: string;
  stripLevel?: number;
  baseDir?: string;
  useAm?: boolean;
}

/**
 * Validate persisted dialog settings field-by-field.
 *
 * A single corrupt field drops only itself: losing every remembered setting
 * because one went bad is a worse outcome than reverting that one to its
 * default. A non-object payload is rejected outright.
 *
 * `repoRoot` re-checks `baseDir` against the repo it will be applied in. A
 * value can sour without ever changing — the same stored subdirectory escapes
 * a different (or moved) root — and only the apply path rejected it, once per
 * attempt, while the dialog kept re-seeding it. Omitted when no root is known.
 */
export function validateApplyPatchSettings(
  raw: unknown,
  repoRoot?: string
): IApplyPatchSettings | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const source = raw as Record<string, unknown>;
  const out: IApplyPatchSettings = {};

  if (typeof source.lastPatchDir === 'string' && source.lastPatchDir.length > 0) {
    out.lastPatchDir = source.lastPatchDir;
  }
  if (
    typeof source.stripLevel === 'number' &&
    validateStripLevel(source.stripLevel) === undefined
  ) {
    out.stripLevel = source.stripLevel;
  }
  if (
    typeof source.baseDir === 'string' &&
    source.baseDir.length > 0 &&
    (repoRoot === undefined || validateBaseDir(source.baseDir, repoRoot) === undefined)
  ) {
    out.baseDir = source.baseDir;
  }
  if (typeof source.useAm === 'boolean') {
    out.useAm = source.useAm;
  }
  return out;
}

/**
 * Persisted Apply Patch dialog settings, scoped to one repository. `baseDir`
 * becomes `git apply --directory`, so a workspace-wide slot would offer repo
 * A's subdirectory while applying into repo B.
 */
export function applyPatchSettingsSlot(repoRoot: string): PersistedSlot<IApplyPatchSettings> {
  return {
    key: `intellig.patch.applySettings:${repoRoot}`,
    version: 1,
    validate: (raw: unknown) => validateApplyPatchSettings(raw, repoRoot),
  };
}

/**
 * `git apply --check` processes in flight for one preview pass. Matches the
 * multi-commit changed-files loader's bound — the same trade between a
 * responsive dialog and process pressure.
 */
export const PREVIEW_CHECK_CONCURRENCY = 4;

/**
 * Files one preview pass will dry-run. A patch can touch thousands; checking
 * every one costs a git process each and tells the user nothing the first
 * screenful did not. The pane says how many of how many it checked rather
 * than presenting the subset as the whole.
 */
export const PREVIEW_FILE_CAP = 100;

/**
 * Per-file verdict of a preview dry-run pass.
 *
 * Three outcomes, not two: a file that applies WITH CONFLICTS still lands,
 * leaving markers to resolve, which is a different next move from one that
 * will not apply at all. Collapsing them onto a single failure flag paints
 * both the same.
 */
export type PatchPreviewStatus = 'ok' | 'conflicts' | 'fails';

export interface IPatchPreviewFile {
  path: string;
  status: PatchPreviewStatus;
  /** Why the file conflicts or will not apply. Absent when `ok`. */
  message?: string;
}

/**
 * Summarise one file's `check` result for the preview list. Conflicts are
 * named as such — a `--3way` check that reports conflicts is a different
 * outcome from a patch that simply doesn't apply, and the user's next move
 * differs.
 */
export function previewFileResult(path: string, result: IApplyPatchResult): IPatchPreviewFile {
  if (result.success) {
    return { path, status: 'ok' };
  }
  if (result.conflicts && result.conflicts.length > 0) {
    return { path, status: 'conflicts', message: 'Applies with conflicts' };
  }
  const reason = result.stderr?.trim();
  return {
    path,
    status: 'fails',
    message: reason ? sanitizeGitError(reason) : 'Does not apply to the current working tree',
  };
}
