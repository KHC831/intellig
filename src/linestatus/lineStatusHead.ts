import * as vscode from 'vscode';
import * as path from 'path';
import { IGitService } from '../git-core/interfaces/IGitService';

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
  const relativePath = path.relative(repo.rootUri.fsPath, documentUri.fsPath);
  return gitService.getFileAtRevision(repo, relativePath, 'HEAD');
}
