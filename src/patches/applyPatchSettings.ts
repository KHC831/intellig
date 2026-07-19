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
 */
export function validateApplyPatchSettings(raw: unknown): IApplyPatchSettings | undefined {
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
  if (typeof source.baseDir === 'string' && source.baseDir.length > 0) {
    out.baseDir = source.baseDir;
  }
  if (typeof source.useAm === 'boolean') {
    out.useAm = source.useAm;
  }
  return out;
}

/** Persisted Apply Patch dialog settings. */
export const APPLY_PATCH_SETTINGS_SLOT: PersistedSlot<IApplyPatchSettings> = {
  key: 'intellig.patch.applySettings',
  version: 1,
  validate: validateApplyPatchSettings,
};

/** Per-file verdict of a preview `--check` pass. */
export interface IPatchPreviewFile {
  path: string;
  ok: boolean;
  /** Why the file will not apply. Absent when `ok`. */
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
    return { path, ok: true };
  }
  if (result.conflicts && result.conflicts.length > 0) {
    return { path, ok: false, message: 'Applies with conflicts' };
  }
  const reason = result.stderr?.trim();
  return {
    path,
    ok: false,
    message: reason ? sanitizeGitError(reason) : 'Does not apply to the current working tree',
  };
}
