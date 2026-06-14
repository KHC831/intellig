/**
 * Persistent "operation in progress" status-bar item (#28).
 *
 * Surfaces a single status-bar entry whenever ANY open repository has a
 * merge / rebase / cherry-pick / revert paused in progress (typically on
 * conflicts). Clicking it invokes `intellig.showResolveConflictsDialog`,
 * which infers the operation from repository state and opens the unified
 * Resolve-Conflicts surface (continue / abort / skip per op).
 *
 * This is the persistent counterpart to the transient
 * `wireRebasePausedWarning` toast: the toast announces once and vanishes,
 * while this item stays visible until the operation is resolved — matching
 * IntelliJ's always-present in-progress indicator. Unlike the old
 * rebase-only `RebaseProgressView`, it covers all four in-progress kinds
 * through the one unified action.
 *
 * Dependency-injected (repository accessor + change event) so unit tests can
 * drive it with a lightweight stub instead of the full `GitService`.
 */

import * as vscode from 'vscode';
import { IRepository } from '../git-core/interfaces/IGitService';
import { describeInProgressOp } from './inProgressBadge';

/** The unified resolve action the badge click triggers. */
const RESOLVE_COMMAND = 'intellig.showResolveConflictsDialog';

/** Minimal git-service surface the status bar consumes. */
export interface IInProgressStatusBarDeps {
  getRepositories(): IRepository[];
  onDidChangeRepository: vscode.Event<IRepository>;
}

export class InProgressStatusBar implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(deps: IInProgressStatusBarDeps) {
    // Left-aligned, just right of the branch/sync item (priority 100) so the
    // in-progress badge sits adjacent to the Git status it relates to.
    this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this._item.command = RESOLVE_COMMAND;
    this._disposables.push(
      this._item,
      deps.onDidChangeRepository(() => this.refresh(deps.getRepositories()))
    );
    this.refresh(deps.getRepositories());
  }

  /**
   * Re-evaluate visibility + content against the current repo set. The first
   * repository with a non-idle in-progress op wins (multi-root: a single
   * badge points at the unified resolver, which re-resolves the active repo
   * on click).
   */
  refresh(repos: readonly IRepository[]): void {
    // `inProgress` is populated only for non-idle ops (its `kind` excludes
    // 'idle' by type), so its mere presence marks a paused operation.
    const active = repos.find((r) => r.inProgress !== undefined);
    const badge = active?.inProgress
      ? describeInProgressOp(active.inProgress.kind, active.inProgress.target)
      : null;
    if (!badge) {
      this._item.hide();
      return;
    }
    this._item.text = badge.text;
    this._item.tooltip = badge.tooltip;
    this._item.show();
  }

  dispose(): void {
    for (const d of this._disposables) {
      d.dispose();
    }
  }
}

/** Convenience factory. */
export function createInProgressStatusBar(deps: IInProgressStatusBarDeps): InProgressStatusBar {
  return new InProgressStatusBar(deps);
}
