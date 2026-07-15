/**
 * Pure git data models — vscode-free AND node-free.
 *
 * These shapes describe git plumbing output (diffs, file status) and
 * carry no dependency on the VS Code API. They live here, apart from
 * {@link import('./IGitService').IGitService} (which imports `vscode` for its
 * service surface), so a webview entry's `*.protocol.ts` can type-import them
 * without pulling the vscode/node runtime into the DOM-only webview program.
 * {@link import('./IGitService')} re-exports every type below, so existing
 * callers keep importing them from there unchanged.
 */

/**
 * File status model
 */
export type FileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored'
  | 'conflicted';

/**
 * Diff line type
 */
export type DiffLineType = 'context' | 'add' | 'delete';

/**
 * Diff line model
 */
export interface IDiffLine {
  type: DiffLineType;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  /**
   * True when git emitted `\ No newline at end of file` immediately after this
   * line — i.e. this line's side (old for delete/context, new for add/context)
   * has no trailing newline. Any patch rebuilt from this hunk must re-emit the
   * marker, or `git apply` rejects the patch / silently re-adds the newline.
   */
  noNewline?: boolean;
}

/**
 * Hunk model - a contiguous block of changed lines
 */
export interface IHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: IDiffLine[];
}

/**
 * Diff model
 */
export interface IDiff {
  path: string;
  oldPath?: string;
  status: FileStatus;
  hunks: IHunk[];
  binary: boolean;
}
