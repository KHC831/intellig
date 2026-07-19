/**
 * Pure render-model types for the commit Details Panel — vscode-free AND
 * node-free, split out of `detailsPanelModel.ts` (whose runtime transforms
 * reach vscode-importing helpers). The webview entry's DOM builder + the tool
 * window's `*.protocol.ts` type-import these without pulling the host runtime
 * into the DOM-only webview program. `detailsPanelModel.ts` re-exports every
 * type below, so existing callers keep importing them from there unchanged.
 */

import type { FileStatus } from '../../interfaces/gitModels';

/**
 * How the changed-file list is grouped: `tree` compacts directories like
 * IntelliJ's directory grouping, `flat` lists full paths. Declared here (the
 * DOM-safe model module) so the webview program never reaches the host-only
 * persistence helper that stores it.
 */
export type DetailsGroupBy = 'tree' | 'flat';

/** One run of a commit message: inert text, an issue/PR link, or a commit ref. */
export type MessageToken =
  | { t: 'text'; v: string }
  | { t: 'link'; text: string; href: string; title: string }
  /** A hash naming a commit that exists; clicking it selects that commit. */
  | { t: 'commit'; text: string; hash: string };

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
      /**
       * Dimmed committer line, present only when the commit was not simply
       * authored and committed by one person at one instant: `name`/`email`
       * appear when the committer differs from the author, `dateStr` when the
       * commit time differs from the author time.
       */
      committed?: { name?: string; email?: string; dateStr?: string };
      /** Branch refs pointing AT this commit, rendered as chips. */
      refBranches: string[];
      /** Tag refs pointing AT this commit, rendered as chips. */
      refTags: string[];
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
      /** How the changed-file list is grouped; drives the Group By toggle. */
      groupBy: DetailsGroupBy;
    }
  | {
      kind: 'multi';
      count: number;
      commits: Array<{ shortHash: string; summary: string }>;
      /** Why the combined file list is incomplete, when some commit failed to load. */
      changedFilesError?: string;
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
