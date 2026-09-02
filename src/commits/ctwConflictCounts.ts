/**
 * Conflict-region counts for the Commit window's unmerged rows.
 *
 * Reads working-tree files, so it lives outside the pure render-model builder
 * and outside the view class that only needs the answer.
 */

import * as vscode from 'vscode';
import type { IFileChange } from '../changelists/interfaces/IChangelistService';
import type { IRepository } from '../git-core/interfaces/IGitService';
import { countConflictRegions } from './ctwChangesTree';

/**
 * Largest file worth reading for a decorative count. A text file with conflict
 * markers in it is far below this; anything above is a binary or a generated
 * blob, where the count would be meaningless anyway.
 */
const MAX_COUNTED_BYTES = 2 * 1024 * 1024;

/**
 * How many conflict regions each unmerged file holds, keyed by repo-relative
 * path. Only unmerged paths are read, which is a handful even in a bad merge.
 *
 * A Map, not an object literal: these keys are file paths from git, and a file
 * named `constructor` or `__proto__` reads as already present on a literal's
 * prototype.
 *
 * A file that cannot be read — binary, deleted on this side, or racing the
 * index — is simply absent, and its row shows no count rather than a wrong one.
 * So is one too large to be worth reading: this runs on every live update, and
 * a big binary is exactly what a conflicted merge leaves behind. The badge is
 * decorative, so skipping beats holding a copy of the file in memory.
 */
export async function countConflictRegionsPerFile(
  repo: IRepository,
  files: readonly IFileChange[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (file.status !== 'conflicted') {
      continue;
    }
    try {
      const uri = vscode.Uri.joinPath(repo.rootUri, file.path);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_COUNTED_BYTES) {
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      counts.set(file.path, countConflictRegions(Buffer.from(bytes).toString('utf8')));
      // eslint-disable-next-line no-restricted-syntax -- a decorative badge; an unreadable file goes uncounted and the next push retries.
    } catch {
      // Unreadable here just means no count.
    }
  }
  return counts;
}
