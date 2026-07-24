/**
 * Shared helpers for the commit context-menu command handlers, referenced by
 * both the dispatcher class and the per-domain action modules split out of it.
 */

import * as vscode from 'vscode';
import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';

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
  if (commitHashes.length === 0) {
    return undefined;
  }
  // Cross-repo before validity: the probe owns a user-facing warning toast,
  // which must fire even when the selection also carries a malformed hash.
  if (ctx.isCrossRepoSelection(commitHashes) || !allHashesValid(commitHashes)) {
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
 * Abbreviation-tolerant commit-hash equality: a log-surface selection can
 * carry an abbreviated hash while git output (sessions, merge-base, HEAD)
 * carries the full SHA. A colliding prefix cannot slip through — git rejects
 * an ambiguous abbreviation before any flow reaches a comparison.
 */
export function hashesReferToSameCommit(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** Set-membership form of {@link hashesReferToSameCommit}. */
export function selectionContainsCommit(selected: readonly string[], hash: string): boolean {
  return selected.some((s) => hashesReferToSameCommit(s, hash));
}

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

/**
 * Project a selection onto the rendered newest-first display order.
 * Newest-first means smallest index = newest, largest = oldest — the
 * invariant every multi-commit flow (patch range, drop, squash) derives
 * its rewrite base from, single-sourced here. Hashes missing from the
 * order are ignored (callers run {@link allHashesDisplayed} first);
 * returns undefined when none remain.
 */
export function selectionDisplayBounds(
  commitHashes: readonly string[],
  displayOrder: readonly string[]
): { newestHash: string; newestIdx: number; oldestHash: string; oldestIdx: number } | undefined {
  const indexByHash = new Map<string, number>();
  for (let i = 0; i < displayOrder.length; i++) {
    indexByHash.set(displayOrder[i], i);
  }
  const indices = commitHashes
    .map((h) => indexByHash.get(h))
    .filter((i): i is number => i !== undefined)
    .sort((a, b) => a - b);
  if (indices.length === 0) {
    return undefined;
  }
  const newestIdx = indices[0];
  const oldestIdx = indices[indices.length - 1];
  return {
    newestHash: displayOrder[newestIdx],
    newestIdx,
    oldestHash: displayOrder[oldestIdx],
    oldestIdx,
  };
}

/**
 * Reload-before-refresh after a HEAD-moving operation, so the panel
 * renders against fresh `repo.head.commit`. The ordering is load-bearing;
 * every happy path routes through here instead of re-typing the pair.
 */
export async function reloadAndRefresh(
  ctx: {
    readonly gitService: Pick<IGitService, 'reloadRepository'>;
    readonly gitToolWindowProvider: { refresh(): void };
  },
  repo: IRepository
): Promise<void> {
  await ctx.gitService.reloadRepository(repo);
  ctx.gitToolWindowProvider.refresh();
}

/**
 * First subject line of a commit for a confirm modal / dialog header,
 * truncated to 60 chars. Races `getCommit` against a 500ms timeout so a
 * slow / hung git process can't stall the UI; timeout and lookup failure
 * both degrade to '' (callers fall back to the bare short-sha or blank).
 */
export async function previewCommitSubject(
  ctx: { readonly gitService: Pick<IGitService, 'getCommit'> },
  repo: IRepository,
  hash: string
): Promise<string> {
  try {
    const commit = await Promise.race([
      ctx.gitService.getCommit(repo, hash),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
    ]);
    return (commit?.message ?? '').split('\n')[0].slice(0, 60);
  } catch {
    return '';
  }
}
