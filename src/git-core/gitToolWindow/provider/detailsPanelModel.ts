/**
 * Serializable render-models for the commit Details Panel.
 *
 * Part of the string→DOM webview migration: instead of the host building a
 * Details-Panel HTML string and the webview assigning it via `innerHTML`, the
 * host precomputes a plain JSON model and the inline script builds the DOM via
 * createElement (see `scriptBuilder.buildDetailsPanelDom`). Everything a
 * hostile commit message / path / author could carry crosses as data
 * (postMessage structured clone + textContent / element props), so the panel is
 * injection-proof without a host-side escape pass.
 *
 * The pure transforms (`buildFileTree`, `mergeChangedFiles`, status helpers,
 * issue-reference parsing) are reused verbatim — only the *rendering* moves to
 * the client.
 */

import type { IGtwControllerContext } from './IGtwControllerContext';
import type { IChangedFile, ICommitDetails } from '../../../services/interfaces';
import type { FileStatus } from '../../interfaces/IGitService';
import { buildFileTree, type FileTreeNode } from '../html/fileTree';
import { getFileStatusColor, getFileName, mergeChangedFiles } from './htmlBuilders';
import { findIssueReferences, issueUrl } from '../../../utils/hostingLinks';
import type { IRemoteUrl } from '../../../utils/remoteUrl';

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
    };

/**
 * Collapse threshold for the "Contained in branches" list. Past this many
 * branches the details panel shows the first N plus a "Show all" toggle.
 * IntelliJ's ContainingBranchesPanel collapses by available pixel width; we
 * use a fixed count so the behavior is deterministic across panel sizes.
 */
export const BRANCH_COLLAPSE_THRESHOLD = 3;

/** First line of a message, truncated with an ellipsis past `maxLength`. */
function truncateSummary(message: string, maxLength: number): string {
  const firstLine = message.split('\n')[0];
  return firstLine.length <= maxLength ? firstLine : firstLine.substring(0, maxLength - 3) + '...';
}

/**
 * Split a commit message into inert-text / issue-link tokens, so the client can
 * build text nodes + `<a>` elements from structured runs (no escaping needed —
 * the values cross as data).
 */
export function buildMessageTokens(
  message: string,
  remote: IRemoteUrl | undefined
): MessageToken[] {
  if (!message) {
    return [];
  }
  const refs = findIssueReferences(message);
  if (refs.length === 0 || !remote) {
    return [{ t: 'text', v: message }];
  }
  const tokens: MessageToken[] = [];
  let cursor = 0;
  for (const ref of refs) {
    if (ref.start > cursor) {
      tokens.push({ t: 'text', v: message.substring(cursor, ref.start) });
    }
    // Only linkify refs that map to the hosting provider's issue tracker:
    // `#123` always, and `GH-123` on GitHub. JIRA-style `PROJECT-123` is a
    // ticket key, NOT a provider issue number — linking it to
    // `<provider>/issues/123` points at the wrong resource, so it stays inert.
    const linkable =
      ref.kind === 'hash' || (ref.kind === 'gh-number' && remote.provider === 'github');
    const url = linkable ? issueUrl(remote, ref.id) : undefined;
    const rawText = message.substring(ref.start, ref.end);
    if (url) {
      tokens.push({
        t: 'link',
        text: rawText,
        href: url,
        title: `Open ${rawText} on ${remote.host}`,
      });
    } else {
      tokens.push({ t: 'text', v: rawText });
    }
    cursor = ref.end;
  }
  if (cursor < message.length) {
    tokens.push({ t: 'text', v: message.substring(cursor) });
  }
  return tokens;
}

/** Annotate a pure file-tree forest with per-leaf presentation data. */
function annotateTree(nodes: readonly FileTreeNode[]): DetailsTreeNode[] {
  return nodes.map((node) => {
    if (node.kind === 'directory') {
      return { kind: 'directory', name: node.name, children: annotateTree(node.children) };
    }
    const { file } = node;
    const annotated: DetailsTreeNode = {
      kind: 'file',
      path: file.path,
      status: file.status,
      statusColor: getFileStatusColor(file.status),
      fileName: getFileName(file.path),
    };
    if (file.status === 'renamed' && file.oldPath) {
      annotated.oldPath = file.oldPath;
    }
    // Carry per-file line counts when present (a commit-details file leaf shows
    // a "(+N | -M)" stat); absent for binary / no-line-change files.
    if (typeof file.additions === 'number' || typeof file.deletions === 'number') {
      annotated.additions = file.additions;
      annotated.deletions = file.deletions;
    }
    return annotated;
  });
}

/** Build the annotated file tree for a flat changed-file list. */
function buildAnnotatedTree(files: readonly IChangedFile[]): DetailsTreeNode[] {
  return annotateTree(buildFileTree(files));
}

/** Placeholder model shown when no commit is selected. */
export function buildDetailsPanelPlaceholderModel(): DetailsPanelModel {
  return { kind: 'placeholder' };
}

/** Single-commit Details Panel model. */
export function buildDetailsPanelModel(
  ctx: IGtwControllerContext,
  commitDetails: ICommitDetails
): DetailsPanelModel {
  const issueLinksEnabled = ctx.isIssueLinkingEnabled();
  const remote = issueLinksEnabled ? ctx.getSelectedRepoRemote() : undefined;
  return {
    kind: 'single',
    messageTokens: buildMessageTokens(commitDetails.message, remote),
    bodyTokens: commitDetails.body ? buildMessageTokens(commitDetails.body, remote) : null,
    hash: commitDetails.hash,
    authorName: commitDetails.author.name,
    authorEmail: commitDetails.author.email,
    dateStr: commitDetails.date.toLocaleString(),
    parents: commitDetails.parents.map((p) => ({ full: p, short: p.substring(0, 7) })),
    changedFilesError: commitDetails.changedFilesError,
    changedFilesCount: commitDetails.changedFiles.length,
    fileTree: commitDetails.changedFilesError ? [] : buildAnnotatedTree(commitDetails.changedFiles),
    containingBranches: commitDetails.containingBranches ?? null,
    branchCollapseThreshold: BRANCH_COLLAPSE_THRESHOLD,
  };
}

/** Multi-commit Details Panel model. */
export function buildMultiCommitDetailsPanelModel(
  commitDetailsList: ICommitDetails[],
  combinedChangedFiles?: IChangedFile[]
): DetailsPanelModel {
  const mergedFiles = combinedChangedFiles ?? mergeChangedFiles(commitDetailsList);
  return {
    kind: 'multi',
    count: commitDetailsList.length,
    commits: commitDetailsList.map((d) => ({
      shortHash: d.hash.substring(0, 7),
      summary: truncateSummary(d.message, 60),
    })),
    changedFilesCount: mergedFiles.length,
    fileTree: buildAnnotatedTree(mergedFiles),
  };
}
