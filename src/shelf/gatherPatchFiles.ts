/**
 * Recursive patch-file collection for Import Patches — the
 * `ShelveChangesManager.gatherPatchFiles` counterpart (platform/vcs-impl/
 * src/com/intellij/openapi/vcs/changes/shelf/ShelveChangesManager.kt:668):
 * directories are expanded breadth-first and only patch-type files are kept,
 * whether picked directly or found inside a directory.
 *
 * vscode-free (plain fs) so the collection is unit-testable over a tmp tree.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/** Extensions the Import Patches picker treats as patch files. */
const PATCH_FILE_EXTENSIONS = new Set(['.patch', '.diff']);

/** Whether `filePath` names a patch-type file (by extension, case-insensitive). */
export function isPatchFilePath(filePath: string): boolean {
  return PATCH_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Expand the picker selection into the flat list of patch files to import:
 * directories are walked recursively (entries visited in sorted order for a
 * deterministic result), files are kept iff patch-typed, and duplicates
 * (a file picked directly AND reached through a picked directory) collapse
 * to one entry. A path that cannot be stat'ed is kept when patch-typed —
 * the per-file import surfaces the real fs error, which beats silently
 * dropping the user's explicit pick.
 */
export async function gatherPatchFiles(selection: readonly string[]): Promise<string[]> {
  const gathered: string[] = [];
  const seen = new Set<string>();

  const keep = (filePath: string): void => {
    if (isPatchFilePath(filePath) && !seen.has(filePath)) {
      seen.add(filePath);
      gathered.push(filePath);
    }
  };

  const visit = async (target: string): Promise<void> => {
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      keep(target);
      return;
    }
    if (stat.isDirectory()) {
      let entries: string[];
      try {
        entries = await fs.readdir(target);
      } catch {
        return;
      }
      // ref-sort-exempt: filesystem entry names, for deterministic traversal order
      for (const entry of entries.sort()) {
        await visit(path.join(target, entry));
      }
      return;
    }
    if (stat.isFile()) {
      keep(target);
    }
  };

  for (const target of selection) {
    await visit(target);
  }
  return gathered;
}
