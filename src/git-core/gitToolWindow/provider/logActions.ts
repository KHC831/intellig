/**
 * Context-menu action vocabularies for the Git tool window, plus the runtime
 * allow-list the untrusted webview `action` string is validated against.
 */

/**
 * Context menu action types for Local Changes View
 */
export type LocalChangesContextAction =
  | 'stage'
  | 'unstage'
  | 'revert'
  | 'showDiff'
  | 'moveToChangelist'
  | 'shelve'
  | 'delete';

/**
 * Context menu action types for Log View.
 *
 * MUST be a superset of `MultiSelectMenuAction` from
 * `../multiSelect.ts`. Every menu `data-action` rendered in the webview
 * resolves to a `LogContextAction` arm, and the multi-select gating
 * (visibility / enable / reason) is computed from the
 * `MultiSelectMenuAction` projection. If a new action ONLY participates
 * in multi-select gating, add it to BOTH unions; if it ONLY ships
 * outside the menu (e.g., a keyboard-only action), add it here only.
 *
 * Drift between the two unions is caught at runtime by
 * `multiSelect.test.ts` "every rendered data-action has a matching
 * case in CommitContextMenuCommands._handleAction".
 */
export type LogContextAction =
  | 'copyHash'
  | 'createPatch'
  // IntelliJ CreatePatchFromChangesAction.Clipboard: silent variant that
  // copies the combined format-patch mailbox straight to the clipboard.
  | 'createPatchToClipboard'
  | 'cherryPick'
  | 'checkoutRevision'
  | 'showRepoAtRevision'
  | 'compareWithLocal'
  | 'resetToHere'
  | 'revert'
  | 'undoCommit'
  | 'dropCommit'
  | 'editCommitMessage'
  | 'interactiveRebase'
  // multi-select-only actions.
  | 'squashCommits'
  | 'compareVersions'
  // compareWithBranch opens a QuickPick listing local + remote branches + tags
  // and routes through BranchComparisonView.
  // IntelliJ Git.Fixup.To.Commit / Git.Squash.Into.Commit: commit the
  // currently-staged changes as a `fixup!`/`squash!` of the selected commit
  // (git commit --fixup=<hash> / --squash=<hash>). Single-only.
  | 'fixup'
  | 'squashInto'
  | 'compareWithBranch'
  // IntelliJ Git.PushUpToHere: push all local commits up to and including
  // the selected commit to the current branch's remote. Single-only.
  | 'pushUpToCommit'
  // IntelliJ Git.CreateNewBranch.FromCommit / Git.CreateNewTag: create a
  // branch or tag starting from the selected commit. Single-only; each
  // delegates to the registered intellig.commit.newBranch / newTag command.
  | 'newBranch'
  | 'newTag'
  // G9: go-to-parent/child navigation — handled entirely in the webview JS;
  // listed here so the cast in _handleCommitContextMenu remains type-safe.
  | 'goToParent'
  | 'goToChild';

/**
 * Runtime allow-list of every {@link LogContextAction}. Kept exhaustive by
 * `satisfies Record<LogContextAction, true>` — adding a union arm without a
 * matching entry is a COMPILE error, so the message-boundary validator
 * ({@link isLogContextAction}) can never silently miss a new action.
 */
const LOG_CONTEXT_ACTIONS = {
  copyHash: true,
  createPatch: true,
  createPatchToClipboard: true,
  cherryPick: true,
  checkoutRevision: true,
  showRepoAtRevision: true,
  compareWithLocal: true,
  resetToHere: true,
  revert: true,
  undoCommit: true,
  dropCommit: true,
  editCommitMessage: true,
  interactiveRebase: true,
  squashCommits: true,
  compareVersions: true,
  fixup: true,
  squashInto: true,
  compareWithBranch: true,
  pushUpToCommit: true,
  newBranch: true,
  newTag: true,
  goToParent: true,
  goToChild: true,
} satisfies Record<LogContextAction, true>;

/**
 * Boundary validator: is `value` a known {@link LogContextAction}? Used to
 * allow-list the untrusted webview `action` before emitting it (some arms —
 * drop/reset/rebase — are destructive), so the guarantee doesn't rest on the
 * downstream consumer's switch staying exhaustive + default-safe.
 */
export function isLogContextAction(value: unknown): value is LogContextAction {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOG_CONTEXT_ACTIONS, value)
  );
}
