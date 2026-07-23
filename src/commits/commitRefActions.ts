/**
 * Create-ref-from-commit actions (new branch / new tag) for the commit
 * context menu. Extracted from CommitContextMenuCommands; the class delegates
 * through a thin context so behaviour is unchanged.
 */

import * as vscode from 'vscode';
import type { IRepository } from '../git-core/interfaces/IGitService';

/** Deps the ref actions reach back into the dispatcher for. */
export interface ICommitRefActionsContext {
  getRepositoryForCommit(hash?: string): Promise<IRepository | undefined>;
}

export async function newBranch(
  ctx: ICommitRefActionsContext,
  commitHashes: string[]
): Promise<void> {
  if (commitHashes.length === 0) {
    return;
  }
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  await vscode.commands.executeCommand(
    'intellig.commit.newBranch',
    commitHashes[0],
    repo?.rootUri.fsPath
  );
}

export async function newTag(ctx: ICommitRefActionsContext, commitHashes: string[]): Promise<void> {
  if (commitHashes.length === 0) {
    return;
  }
  const repo = await ctx.getRepositoryForCommit(commitHashes[0]);
  await vscode.commands.executeCommand(
    'intellig.commit.newTag',
    commitHashes[0],
    repo?.rootUri.fsPath
  );
}
