/**
 * Pure render-model types for the commit Details Panel — vscode-free AND
 * node-free, split out of `detailsPanelModel.ts` (whose runtime transforms
 * reach vscode-importing helpers). The webview entry's DOM builder + the tool
 * window's `*.protocol.ts` type-import these without pulling the host runtime
 * into the DOM-only webview program. `detailsPanelModel.ts` re-exports every
 * type below, so existing callers keep importing them from there unchanged.
 */

import type { FileStatus } from '../../interfaces/gitModels';

/** One run of a commit message: inert text, or an issue/PR link. */
export type MessageToken =
  | { t: 'text'; v: string }
  | { t: 'link'; text: string; href: string; title: string };

/** A presentation-annotated file-tree node (JSON-serializable). */
export type DetailsTreeNode =
  | { kind: 'directory'; name: string; children: DetailsTreeNode[] }
  | {
      kind: 'file';
      path: string;
      status: FileStatus;
      statusColor: string;
      fileName: string;
      oldPath?: string;
      /** Lines added / deleted (from the diff); omitted for binary or no-line-change files. */
      additions?: number;
      deletions?: number;
    };

/** Details Panel render-model. The `kind` discriminator drives the builder. */
export type DetailsPanelModel =
  | { kind: 'placeholder' }
  | {
      kind: 'single';
      messageTokens: MessageToken[];
      bodyTokens: MessageToken[] | null;
      hash: string;
      authorName: string;
      authorEmail: string;
      dateStr: string;
      parents: Array<{ full: string; short: string }>;
      changedFilesError?: string;
      changedFilesCount: number;
      fileTree: DetailsTreeNode[];
      /** Owning repository display name (root basename) for the files heading. */
      projectName?: string;
      /** Owning repository path (home abbreviated to `~`) for the files heading. */
      projectPath?: string;
      /**
       * Branches containing this commit: `null` while still loading, `[]` when
       * the commit is in no branch, else the alphabetically-sorted names.
       */
      containingBranches: string[] | null;
      /** Collapse the list past this many names behind a "Show all" toggle. */
      branchCollapseThreshold: number;
    }
  | {
      kind: 'multi';
      count: number;
      commits: Array<{ shortHash: string; summary: string }>;
      changedFilesCount: number;
      fileTree: DetailsTreeNode[];
      /** Owning repository display name (root basename) for the files heading. */
      projectName?: string;
      /** Owning repository path (home abbreviated to `~`) for the files heading. */
      projectPath?: string;
    };

/** Repository identity shown in the changed-files heading. */
export interface IDetailsProject {
  name: string;
  path: string;
}
