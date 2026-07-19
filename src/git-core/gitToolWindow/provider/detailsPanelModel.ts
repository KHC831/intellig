/**
 * Serializable render-models for the commit Details Panel.
 *
 * Part of the string→DOM webview migration: instead of the host building a
 * Details-Panel HTML string and the webview assigning it via `innerHTML`, the
 * host precomputes a plain JSON model and the webview entry builds the DOM via
 * createElement (see `webview/detailsPanelDom.buildDetailsPanelDom`). Everything a
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
import type { ICommitNode } from '../../commitGraph';
import type { ICommit } from '../../interfaces/IGitService';
import { buildFileTree, type FileTreeNode } from '../html/fileTree';
import { getFileStatusColor, getFileName, mergeChangedFiles } from './htmlBuilders';
import { findIssueReferences, issueUrl } from '../../../utils/hostingLinks';
import type { IRemoteUrl } from '../../../utils/remoteUrl';
import type {
  DetailsGroupBy,
  MessageToken,
  DetailsTreeNode,
  DetailsPanelModel,
  IDetailsProject,
} from './detailsPanelModel.types';

export type { MessageToken, DetailsTreeNode, DetailsPanelModel, IDetailsProject };

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
  remote: IRemoteUrl | undefined,
  isKnownCommitHash?: (hash: string) => boolean
): MessageToken[] {
  if (!message) {
    return [];
  }
  // Commit hashes are found in the runs left inert by issue linking, so a ref
  // and a hash in one message each keep their own treatment.
  const withHashes = (runs: MessageToken[]): MessageToken[] =>
    isKnownCommitHash
      ? runs.flatMap((tok) =>
          tok.t === 'text' ? splitCommitHashes(tok.v, isKnownCommitHash) : [tok]
        )
      : runs;
  const refs = findIssueReferences(message);
  if (refs.length === 0 || !remote) {
    return withHashes([{ t: 'text', v: message }]);
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
  return withHashes(tokens);
}

/**
 * Identity comparison for the committer line, mirroring
 * VcsUserUtil.isSamePerson: NAME decides (email may legitimately differ
 * between machines), compared case-insensitively, falling back to the email's
 * local part when a name is absent.
 */
function isSamePerson(
  author: { name: string; email: string },
  committer: { name: string; email: string }
): boolean {
  const standardName = (user: { name: string; email: string }): string => {
    const name = user.name || user.email.split('@')[0] || user.email;
    return name.trim().toLowerCase();
  };
  return standardName(author) === standardName(committer);
}

/**
 * The dimmed committer line, or undefined when the commit was authored and
 * committed by one person at one instant (CommitPresentationUtil
 * .getAuthorAndCommitterText): a differing committer is named, and a differing
 * commit time is dated — an amend by the author shows the date alone.
 */
function buildCommittedLine(
  details: ICommitDetails
): { name?: string; email?: string; dateStr?: string } | undefined {
  const { committer, commitDate } = details;
  const timesDiffer = commitDate !== undefined && commitDate.getTime() !== details.date.getTime();
  const personDiffers = committer !== undefined && !isSamePerson(details.author, committer);
  if (!personDiffers && !timesDiffer) {
    return undefined;
  }
  const line: { name?: string; email?: string; dateStr?: string } = {};
  if (personDiffers && committer) {
    line.name = committer.name;
    line.email = committer.email;
  }
  if (timesDiffer && commitDate) {
    line.dateStr = commitDate.toLocaleString();
  }
  return line;
}

/**
 * Split an inert run into text + commit-hash tokens (IntelliJ HASH_PATTERN /
 * replaceHashes): a 7-to-40 character hex run that names a commit becomes a
 * clickable ref, anything else stays text. The run must be delimited by
 * non-hex characters, so a longer digest never contributes its first 40
 * characters as a bogus hash.
 */
function splitCommitHashes(
  text: string,
  isKnownCommitHash: (hash: string) => boolean
): MessageToken[] {
  const tokens: MessageToken[] = [];
  const pattern = /[0-9a-f]+/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const run = match[0];
    if (run.length < 7 || run.length > 40 || !isKnownCommitHash(run)) {
      continue;
    }
    if (match.index > cursor) {
      tokens.push({ t: 'text', v: text.substring(cursor, match.index) });
    }
    tokens.push({ t: 'commit', text: run, hash: run });
    cursor = match.index + run.length;
  }
  if (tokens.length === 0) {
    return [{ t: 'text', v: text }];
  }
  if (cursor < text.length) {
    tokens.push({ t: 'text', v: text.substring(cursor) });
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

/**
 * Build the annotated file forest for a changed-file list. `flat` skips the
 * directory grouping entirely and labels each leaf with its full path, so the
 * list reads as plain paths (IntelliJ's GroupBy: None).
 */
function buildAnnotatedTree(
  files: readonly IChangedFile[],
  groupBy: DetailsGroupBy = 'tree'
): DetailsTreeNode[] {
  if (groupBy === 'flat') {
    return annotateTree(
      files.map((file) => ({ kind: 'file' as const, name: getFileName(file.path), file }))
    ).map((node) => (node.kind === 'file' ? { ...node, fileName: node.path } : node));
  }
  return annotateTree(buildFileTree(files));
}

/**
 * Build the ICommitDetails fields shared by all graph-node→details
 * conversions: hash, message, body, author, date, parents, branches, tags.
 *
 * Excludes changedFiles, changedFilesError, and containingBranches — callers
 * overlay those from their own pending state so the result type is spread-able
 * into a full ICommitDetails literal.
 */
export function commitNodeToBaseDetails(
  node: ICommitNode
): Omit<ICommitDetails, 'changedFiles' | 'changedFilesError' | 'containingBranches'> {
  return commitToBaseDetails(
    node.commit,
    (node.branches || []).map((ref) => ref.name),
    node.tags || []
  );
}

/**
 * The same conversion for a bare commit — the History tab has no graph node,
 * so its refs come in separately. One builder keeps every details surface on
 * an identical field set.
 */
export function commitToBaseDetails(
  commit: ICommit,
  branches: string[] = [],
  tags: string[] = []
): Omit<ICommitDetails, 'changedFiles' | 'changedFilesError' | 'containingBranches'> {
  return {
    hash: commit.hash,
    message: commit.message,
    body: commit.body,
    author: { name: commit.author.name, email: commit.author.email },
    committer: commit.committer
      ? { name: commit.committer.name, email: commit.committer.email }
      : undefined,
    date: commit.authorDate,
    commitDate: commit.commitDate,
    parents: commit.parents || [],
    branches,
    tags,
  };
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
  const project = ctx.getSelectedRepoProject();
  const isKnownCommitHash = (hash: string): boolean => ctx.isKnownCommitHash(hash);
  return {
    kind: 'single',
    messageTokens: buildMessageTokens(commitDetails.message, remote, isKnownCommitHash),
    bodyTokens: commitDetails.body
      ? buildMessageTokens(commitDetails.body, remote, isKnownCommitHash)
      : null,
    hash: commitDetails.hash,
    authorName: commitDetails.author.name,
    authorEmail: commitDetails.author.email,
    dateStr: commitDetails.date.toLocaleString(),
    committed: buildCommittedLine(commitDetails),
    refBranches: commitDetails.branches ?? [],
    refTags: commitDetails.tags ?? [],
    parents: commitDetails.parents.map((p) => ({ full: p, short: p.substring(0, 7) })),
    changedFilesError: commitDetails.changedFilesError,
    changedFilesCount: commitDetails.changedFiles.length,
    fileTree: commitDetails.changedFilesError
      ? []
      : buildAnnotatedTree(commitDetails.changedFiles, ctx.getDetailsGroupBy()),
    groupBy: ctx.getDetailsGroupBy(),
    projectName: project?.name,
    projectPath: project?.path,
    containingBranches: commitDetails.containingBranches ?? null,
    branchCollapseThreshold: BRANCH_COLLAPSE_THRESHOLD,
  };
}

/**
 * How many selected commits get their changed files loaded for the combined
 * tree. A range-select can cover hundreds of commits and each one costs a
 * `git diff`; past this many the tree is built from the first
 * {@link MULTI_DETAILS_COMMIT_CAP} in selection order and the panel says so,
 * rather than freezing the UI or silently showing a partial list as complete.
 */
export const MULTI_DETAILS_COMMIT_CAP = 20;

/** Multi-commit Details Panel model. */
export function buildMultiCommitDetailsPanelModel(
  commitDetailsList: ICommitDetails[],
  project?: IDetailsProject,
  skippedCommits = 0
): DetailsPanelModel {
  const mergedFiles = mergeChangedFiles(commitDetailsList);
  // Any commit whose diff failed makes the combined list partial; report the
  // first reason rather than presenting the remainder as complete. A capped
  // selection is partial for a different reason, and says which.
  const changedFilesError =
    commitDetailsList.find((d) => d.changedFilesError)?.changedFilesError ??
    (skippedCommits > 0
      ? `Showing files from the first ${commitDetailsList.length - skippedCommits} of ${commitDetailsList.length} selected commits.`
      : undefined);
  return {
    kind: 'multi',
    changedFilesError,
    count: commitDetailsList.length,
    commits: commitDetailsList.map((d) => ({
      shortHash: d.hash.substring(0, 7),
      summary: truncateSummary(d.message, 60),
    })),
    changedFilesCount: mergedFiles.length,
    fileTree: buildAnnotatedTree(mergedFiles),
    projectName: project?.name,
    projectPath: project?.path,
  };
}
