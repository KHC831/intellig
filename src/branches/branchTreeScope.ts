/**
 * What the Branches tree currently SHOWS: the repositories and the branches
 * left visible by the Git tool window's scope (its repository selector and its
 * branch filter). The log-side analog of this state lives in RepoScopeModel;
 * this is the tree's own copy, kept in step by the selection/filter wiring so
 * both windows can never disagree about which refs exist.
 *
 * Pure state + predicates — no vscode, no git. The provider owns the tree
 * effects (refresh on a real change); this owns only the answer to "is this
 * row in scope?".
 */

import type { IBranch, IRepository } from '../git-core/interfaces/IGitService';
import { normalizeRepoPath, normalizeRepoPathString } from '../utils/normalizeRepoPath';

export class BranchTreeScope {
  /**
   * Normalized repo-root paths shown in the grouped multi-root layout: `null`
   * shows every repo, an explicit empty set shows none. Intersected with the
   * live repository list at render, so a stale root is dropped rather than
   * resurrected.
   */
  private _repoRoots: Set<string> | null = null;

  /**
   * Branch names the log's branch filter narrows to, or `null` when the log is
   * unfiltered. The tree lists only these (plus the checked-out branch), so it
   * never offers rows whose commits the filtered log cannot show.
   */
  private _branchNames: Set<string> | null = null;

  /**
   * Narrow to `roots` (repo-root fsPaths); `null` shows every repo, an empty
   * array shows none.
   *
   * @returns true when the visible set actually changed (the caller refreshes).
   */
  public setRepoRoots(roots: readonly string[] | null): boolean {
    const next = roots === null ? null : new Set(roots.map((r) => normalizeRepoPathString(r)));
    if (sameSet(next, this._repoRoots)) {
      return false;
    }
    this._repoRoots = next;
    return true;
  }

  /**
   * Narrow to the branch filter's selection; `null` or an empty selection
   * lists every branch again.
   *
   * @returns true when the visible set actually changed (the caller refreshes).
   */
  public setBranchNames(names: readonly string[] | null): boolean {
    const next = names === null || names.length === 0 ? null : new Set(names);
    if (sameSet(next, this._branchNames)) {
      return false;
    }
    this._branchNames = next;
    return true;
  }

  /** Whether `repo` renders a group row. */
  public repoVisible(repo: IRepository): boolean {
    return this._repoRoots === null || this._repoRoots.has(normalizeRepoPath(repo.rootUri));
  }

  /**
   * Whether `branch` renders a row. The checked-out branch always survives the
   * log's branch filter — the tree must not hide where HEAD is, and that row
   * is the checkout anchor.
   */
  public branchVisible(branch: IBranch): boolean {
    return this._branchNames === null || branch.isHead || this._branchNames.has(branch.name);
  }
}

/** Set equality for the nullable visible-sets (`null` = unfiltered). */
function sameSet(a: Set<string> | null, b: Set<string> | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.size === b.size && [...a].every((v) => b.has(v));
}
