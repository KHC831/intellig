/**
 * Shared helpers for the commit context-menu command handlers, referenced by
 * both the dispatcher class and the per-domain action modules split out of it.
 */

import * as vscode from 'vscode';
import type { IRepository } from '../git-core/interfaces/IGitService';

/**
 * Base dispatcher deps for every commit action module: commit-targeted repo
 * resolution. Modules extend this (or {@link ICommitSelectionContext}) so
 * the contract lives in one type instead of a re-typed copy per module.
 */
export interface ICommitRepoContext {
  getRepositoryForCommit(hash?: string): Promise<IRepository | undefined>;
}

/** Repo resolution + the multi-selection cross-repo refusal probe. */
export interface ICommitSelectionContext extends ICommitRepoContext {
  isCrossRepoSelection(commitHashes: readonly string[]): boolean;
}

/**
 * Shared entry preamble for multi-selection commit handlers: silently reject
 * an empty, malformed, or cross-repo selection, then resolve the owning
 * repo. Returns undefined when the handler must abort. Handlers whose
 * preamble toasts (e.g. squash's malformed-hash message) keep their own.
 */
export async function resolveCommitSelection(
  ctx: ICommitSelectionContext,
  commitHashes: readonly string[]
): Promise<IRepository | undefined> {
  if (
    commitHashes.length === 0 ||
    !allHashesValid(commitHashes) ||
    ctx.isCrossRepoSelection(commitHashes)
  ) {
    return undefined;
  }
  return ctx.getRepositoryForCommit(commitHashes[0]);
}

/**
 * Defence-in-depth hash format check.
 *
 * `_handleCommitContextMenu` already rejects hashes that
 * aren't in the rendered `commitNodes`, but a future bypass (palette
 * command, scripted entry point) could feed unvalidated input. A
 * lowercase-hex regex catches obvious shell-injection / typoed-string
 * inputs before they reach the gitCli argv. Bounds:
 *   - 4 chars is the shortest `git rev-parse` accepts (abbreviated
 *     refs).
 *   - The upper bound is 64 (not 40) to support
 *     SHA-256 repos created by `git init --object-format=sha256` (Git
 *     ≥ 2.29). A SHA-1 cap would silently reject valid SHA-256
 *     hashes.
 */
const HASH_RE = /^[0-9a-f]{4,64}$/i;
export function allHashesValid(hashes: readonly string[]): boolean {
  return hashes.every((h) => HASH_RE.test(h));
}

/**
 * Single source of truth for the stale-selection toast surfaced when an
 * in-order guard rejects a dispatched action whose commit hash is no longer
 * in the rendered commitNodes. Wire format frozen here.
 *
 * TODO(post-locale): when locale work begins, replace this with a
 * message-id and ship the localised string from a resource bundle.
 */
export const STALE_SELECTION_TOAST =
  'Commit selection changed since the menu opened — please retry.';

/**
 * In-order guard shared by the multi-commit handlers: every dispatched hash
 * must still be present in the rendered display order, otherwise the
 * selection is stale (the log re-rendered between menu-open and dispatch).
 * Toasts {@link STALE_SELECTION_TOAST} and returns false when any hash is
 * missing; callers abort on false.
 */
export function allHashesDisplayed(
  commitHashes: readonly string[],
  displayOrder: readonly string[]
): boolean {
  const inOrder = new Set(displayOrder);
  if (commitHashes.some((h) => !inOrder.has(h))) {
    void vscode.window.showInformationMessage(STALE_SELECTION_TOAST);
    return false;
  }
  return true;
}
