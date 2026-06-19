import * as vscode from 'vscode';
import { IGitService } from '../git-core/interfaces/IGitService';
import { repoRelativePath } from '../utils/repoRelativePath';

/**
 * Fetch the committed HEAD content for a document URI, or `undefined` when the
 * file is outside any repository (or HEAD-read is unavailable).
 *
 * Shared by the changed-line gutter (LineStatusTracker) and the hover popup so
 * both compare the buffer against the exact same committed revision.
 */
export async function fetchHeadContent(
  gitService: IGitService,
  documentUri: vscode.Uri
): Promise<string | undefined> {
  const repo = await gitService.getRepository(documentUri);
  if (!repo || !gitService.getFileAtRevision) {
    return undefined;
  }
  // getFileAtRevision runs git with `cwd = repo.rootUri.fsPath`, so it needs
  // the REPO-root-relative path. `repoRelativePath` canonicalizes both ends so
  // a symlinked document URI against a realpath-resolved root (macOS `/var` →
  // `/private/var`) does not produce an escaping `../` pathspec.
  const relativePath = repoRelativePath(repo.rootUri.fsPath, documentUri.fsPath);
  return gitService.getFileAtRevision(repo, relativePath, 'HEAD');
}
