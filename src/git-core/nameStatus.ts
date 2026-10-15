import { IRefDiffFile } from './interfaces/IGitService';

/**
 * Parse `git diff --name-status -z` output:
 *   <status>\0<path>\0                for M/A/D/T/U entries
 *   <status>\0<oldPath>\0<newPath>\0  for R/C entries (status can be `R100`, …)
 */
export function parseNameStatus(stdout: string): IRefDiffFile[] {
  const tokens = stdout.split('\0').filter((t) => t.length > 0);
  const files: IRefDiffFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const statusChar = tokens[i].charAt(0).toUpperCase();
    i += 1;

    if (statusChar === 'R' || statusChar === 'C') {
      const oldPath = tokens[i];
      const newPath = tokens[i + 1];
      i += 2;
      if (newPath) {
        files.push({ path: newPath, status: statusChar, oldPath });
      }
    } else if (
      statusChar === 'M' ||
      statusChar === 'A' ||
      statusChar === 'D' ||
      statusChar === 'T' ||
      // `git diff --name-status` emits one status letter per file; bare `U`
      // is the complete unmerged marker (no AA/DD composite in this output),
      // so this is not the two-column porcelain conflict predicate.
      statusChar === 'U' // conflict-predicate-exempt: single-letter name-status marker
    ) {
      const filePath = tokens[i];
      i += 1;
      if (filePath) {
        files.push({ path: filePath, status: statusChar });
      }
    } else {
      // Unknown status; skip the following path token to stay aligned.
      i += 1;
    }
  }
  return files;
}
