/**
 * Rebase Dialog.
 *
 * IntelliJ-style "Rebase" modal that unifies the two former rebase entry
 * points — the branch-tree "Rebase Current onto X" one-click action and
 * the QuickPick-based interactive flow — into a single webview panel
 * (extends {@link BaseWebviewPanel}).
 *
 * Fields:
 *  - Branch (read-only, the current branch from `repo.head`).
 *  - Onto target — a dropdown of branch names; the preselected target
 *    (the clicked branch, or a commit hash) is ensured present + selected.
 *  - Interactive checkbox — when checked, the confirm opens the interactive
 *    rebase todo editor ({@link RebaseEditor}); when unchecked, it runs a
 *    plain `gitService.rebaseBranch(repo, onto)` with the full conflict +
 *    orphan-recovery handling ported from the old branch-menu handler.
 *
 * Conflict / recovery (non-interactive path): mirrors the old
 * `_handleRebaseCurrentOnto` exactly — snapshot the in-progress kind BEFORE
 * the call so an orphaned rebasing state left by OUR non-conflict failure is
 * auto-aborted (and never one the user already had paused). Conflicts hand
 * off to {@link IConflictResolutionService} with `operation: 'rebase'`; the
 * continue/abort affordance is gated on `rebaseInProgress === true` (an
 * `--autostash` pop conflict has no live rebase to continue).
 *
 * No destructive-op confirm — rebase is recoverable via `git rebase --abort`,
 * and `rebaseBranch` passes `--autostash` so a dirty tree is preserved.
 */

import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { IGitService, IRepository, IRebaseOptions } from '../git-core/interfaces/IGitService';
import { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import { RebaseEditor } from './RebaseEditor';
import { sanitizeGitError } from '../git-core/gitError';
import { getLogger } from '../utils/logger';

/** Options for constructing a {@link RebaseDialog}. */
export interface IRebaseDialogOptions {
  repo: IRepository;
  /** Preselected onto-target — a branch name or a commit hash. */
  onto: string;
  /** Branch names offered in the Onto dropdown. `onto` is ensured present. */
  branchChoices: string[];
  /** Whether the Interactive checkbox starts checked. */
  interactiveDefault?: boolean;
  gitService: IGitService;
  /** Factory for the interactive-rebase editor (lazily created on confirm). */
  createRebaseEditor: () => RebaseEditor;
  /** Optional — used for the non-interactive conflict handoff. */
  conflictResolutionService?: IConflictResolutionService;
  /** Optional callback fired after a rebase completes (reload + refresh). */
  onComplete?: () => void;
}

/**
 * Cross-module preselect passed to the `openRebaseDialog` opener. The
 * opener resolves `branchChoices` (via `getBranches`) and the editor
 * factory; callers supply only the repo + intent.
 */
export interface IRebaseDialogPreselect {
  repo: IRepository;
  /** Preselected onto-target (branch name or commit hash). Defaults to the
   *  first non-current branch when omitted (the bare-palette flow). */
  onto?: string;
  /** Whether the Interactive checkbox starts checked. */
  interactiveDefault?: boolean;
}

/** Webview → extension message shape. */
interface IRebaseDialogMessage {
  type: 'rebase' | 'cancel';
  onto?: string;
  interactive?: boolean;
  rebaseMerges?: boolean;
  keepEmpty?: boolean;
  updateRefs?: boolean;
  autosquash?: boolean;
}

/**
 * The non-interactive rebase options surfaced as checkboxes, in git4idea's
 * `GitRebaseOption` declaration order. `--root` is intentionally omitted from
 * the dialog: it discards the chosen onto target (rebase-from-root), which the
 * "Rebase onto X" framing here would make confusing — it stays reachable
 * through the {@link IRebaseOptions} API for callers that need it.
 */
const REBASE_OPTION_CHECKBOXES: ReadonlyArray<{
  id: keyof Pick<IRebaseOptions, 'rebaseMerges' | 'keepEmpty' | 'updateRefs' | 'autosquash'>;
  flag: string;
  title: string;
  desc: string;
}> = [
  {
    id: 'rebaseMerges',
    flag: '--rebase-merges',
    title: 'Rebase merges',
    desc: 'Recreate merge commits instead of flattening them.',
  },
  {
    id: 'updateRefs',
    flag: '--update-refs',
    title: 'Update refs',
    desc: 'Advance any branch that points at a rebased commit (stacked branches).',
  },
  {
    id: 'keepEmpty',
    flag: '--keep-empty',
    title: 'Keep empty commits',
    desc: 'Keep commits that begin empty rather than dropping them.',
  },
  {
    id: 'autosquash',
    flag: '--autosquash',
    title: 'Auto-squash',
    desc: 'Reorder fixup!/squash! commits under the commits they target.',
  },
];

const VIEW_TYPE = 'intellig.rebaseDialog';
const TITLE = 'Rebase';

/** globalState key under which the last-used rebase options are persisted. */
export const REBASE_OPTIONS_STATE_KEY = 'intellig.rebase.lastOptions';

/** The four persisted rebase-option flags (the dialog checkboxes; no `root`). */
export interface IPersistedRebaseOptions {
  rebaseMerges: boolean;
  keepEmpty: boolean;
  updateRefs: boolean;
  autosquash: boolean;
}

/** Memento subset (ExtensionContext.globalState shape) for option persistence. */
export interface IRebaseOptionsStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

const REBASE_OPTIONS_DEFAULT: IPersistedRebaseOptions = {
  rebaseMerges: false,
  keepEmpty: false,
  updateRefs: false,
  autosquash: false,
};

/**
 * Load the user's last-used rebase options (IntelliJ GitRebaseSettings
 * parity). Coerces each field to a boolean and defaults any missing/invalid
 * key to false; returns all-false when nothing valid is stored.
 */
export function loadRebaseOptions(store: IRebaseOptionsStore): IPersistedRebaseOptions {
  const raw = store.get<unknown>(REBASE_OPTIONS_STATE_KEY, undefined);
  if (!raw || typeof raw !== 'object') {
    return { ...REBASE_OPTIONS_DEFAULT };
  }
  const obj = raw as Record<string, unknown>;
  return {
    rebaseMerges: Boolean(obj.rebaseMerges),
    keepEmpty: Boolean(obj.keepEmpty),
    updateRefs: Boolean(obj.updateRefs),
    autosquash: Boolean(obj.autosquash),
  };
}

/** Persist the chosen rebase options so the next dialog pre-checks them. */
export function saveRebaseOptions(
  store: IRebaseOptionsStore,
  options: IPersistedRebaseOptions
): Thenable<void> {
  return store.update(REBASE_OPTIONS_STATE_KEY, options);
}

export class RebaseDialog extends BaseWebviewPanel {
  private readonly _repo: IRepository;
  private readonly _onto: string;
  private readonly _branchChoices: string[];
  private readonly _interactiveDefault: boolean;
  private readonly _gitService: IGitService;
  private readonly _createRebaseEditor: () => RebaseEditor;
  private readonly _conflictResolutionService?: IConflictResolutionService;
  private readonly _onComplete?: () => void;
  private readonly _currentBranch: string;
  private _busy = false;

  constructor(context: vscode.ExtensionContext, options: IRebaseDialogOptions) {
    super(context, VIEW_TYPE, TITLE, vscode.ViewColumn.One);
    this._repo = options.repo;
    this._onto = options.onto;
    // Ensure the preselected target is offered even if it is not a branch
    // (e.g. a commit hash from the "Interactive Rebase from Here" entry).
    this._branchChoices = options.branchChoices.includes(options.onto)
      ? [...options.branchChoices]
      : [options.onto, ...options.branchChoices];
    this._interactiveDefault = options.interactiveDefault === true;
    this._gitService = options.gitService;
    this._createRebaseEditor = options.createRebaseEditor;
    this._conflictResolutionService = options.conflictResolutionService;
    this._onComplete = options.onComplete;
    this._currentBranch = options.repo.head?.name?.replace(/^refs\/heads\//, '') ?? 'HEAD';
    this._render();
  }

  protected override _getStyles(): string {
    return `
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 16px 20px;
        font-size: var(--vscode-font-size);
      }
      .summary {
        margin-bottom: 16px;
        padding: 8px 10px;
        background: var(--vscode-editor-inactiveSelectionBackground);
        border-left: 3px solid var(--vscode-focusBorder);
        font-family: var(--vscode-editor-font-family, monospace);
      }
      .summary .label { color: var(--vscode-descriptionForeground); margin-right: 6px; }
      .field { margin-bottom: 14px; display: flex; flex-direction: column; gap: 4px; }
      .field label.field-label { color: var(--vscode-descriptionForeground); }
      select {
        width: 100%;
        box-sizing: border-box;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 4px 6px;
        font-family: inherit;
        font-size: var(--vscode-font-size);
      }
      label.flag { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; margin-bottom: 14px; }
      label.flag .label-text { display: flex; flex-direction: column; gap: 2px; }
      label.flag .label-text .title-line { font-weight: 600; }
      label.flag .label-text .desc {
        font-size: 0.9em;
        color: var(--vscode-descriptionForeground);
      }
      label.flag .label-text .title-line code {
        font-weight: 400;
        font-size: 0.85em;
        color: var(--vscode-descriptionForeground);
      }
      fieldset.rebase-options {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        padding: 10px 12px 0;
        margin: 0 0 14px;
      }
      fieldset.rebase-options.disabled { opacity: 0.5; }
      fieldset.rebase-options .rebase-options-legend {
        padding: 0 4px;
        font-size: 0.9em;
        color: var(--vscode-descriptionForeground);
      }
      .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
      button {
        font-family: inherit;
        font-size: inherit;
        padding: 4px 14px;
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
      }
      button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }
      button:disabled { opacity: 0.55; cursor: not-allowed; }
    `;
  }

  protected _getBodyHtml(): string {
    return this._getBodyParts().body;
  }

  /**
   * Emit the body HTML and the interactive script separately so `_render`
   * can splice the script into a nonced `<script>` block without
   * regex-extracting it (nested `</script>` inside a string literal would
   * break that). Mirrors {@link MergeDialog}.
   */
  private _getBodyParts(): { body: string; script: string } {
    // Pre-check the option boxes from the user's last-used rebase options
    // (IntelliJ GitRebaseSettings persists these per project).
    const persistedOptions = loadRebaseOptions(this._context.globalState);
    const options = this._branchChoices
      .map((name) => {
        const selected = name === this._onto ? ' selected' : '';
        return `<option value="${escapeHtml(name)}"${selected}>${escapeHtml(name)}</option>`;
      })
      .join('');

    const body = `
      <div class="summary">
        <div><span class="label">Branch:</span>${escapeHtml(this._currentBranch)} (current)</div>
      </div>

      <div class="field">
        <label class="field-label" for="onto-select">Rebase onto:</label>
        <select id="onto-select">${options}</select>
      </div>

      <label class="flag" data-flag="interactive">
        <input type="checkbox" id="flag-interactive"${this._interactiveDefault ? ' checked' : ''} />
        <span class="label-text">
          <span class="title-line">Interactive</span>
          <span class="desc">Open the rebase todo editor to reorder, squash, edit, or drop commits.</span>
        </span>
      </label>

      <fieldset id="rebase-options" class="rebase-options">
        <legend class="rebase-options-legend">Options</legend>
        ${REBASE_OPTION_CHECKBOXES.map(
          (o) => `
        <label class="flag" data-flag="${o.id}">
          <input type="checkbox" id="flag-${o.id}"${persistedOptions[o.id] ? ' checked' : ''} />
          <span class="label-text">
            <span class="title-line">${escapeHtml(o.title)} <code>${escapeHtml(o.flag)}</code></span>
            <span class="desc">${escapeHtml(o.desc)}</span>
          </span>
        </label>`
        ).join('')}
      </fieldset>

      <div class="actions">
        <button id="cancel-btn" class="secondary" type="button">Cancel</button>
        <button id="rebase-btn" type="button">Rebase</button>
      </div>
    `;

    const script = `
      (function() {
        const vscode = acquireVsCodeApi();
        const optionIds = ${JSON.stringify(REBASE_OPTION_CHECKBOXES.map((o) => o.id))};
        const interactiveBox = document.getElementById('flag-interactive');
        const optionsFieldset = document.getElementById('rebase-options');
        // The flag options apply to the non-interactive rebase only; the
        // interactive path hands off to the todo editor. Disable them while
        // Interactive is checked so the UI never implies they'd take effect.
        const syncOptionsEnabled = () => {
          const disabled = interactiveBox.checked;
          optionsFieldset.classList.toggle('disabled', disabled);
          for (const id of optionIds) {
            document.getElementById('flag-' + id).disabled = disabled;
          }
        };
        interactiveBox.addEventListener('change', syncOptionsEnabled);
        syncOptionsEnabled();
        const submit = () => {
          const msg = {
            type: 'rebase',
            onto: document.getElementById('onto-select').value,
            interactive: interactiveBox.checked,
          };
          for (const id of optionIds) {
            msg[id] = document.getElementById('flag-' + id).checked;
          }
          vscode.postMessage(msg);
        };
        const cancel = () => {
          vscode.postMessage({ type: 'cancel' });
        };
        document.getElementById('rebase-btn').addEventListener('click', submit);
        document.getElementById('cancel-btn').addEventListener('click', cancel);

        // Dialog keyboard contract (spec 5.1 — shared across all dialogs):
        //   Cmd+Enter / Ctrl+Enter → primary action (Rebase)
        //   Esc                    → cancel
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        });
      })();
    `;

    return { body, script };
  }

  /**
   * Override the base renderer so the interactive script carries the CSP
   * nonce. Mirrors {@link MergeDialog._render}.
   */
  protected override _render(): void {
    if (this._disposed) {
      return;
    }

    const nonce = this._getNonce();
    const csp = this._buildCsp(nonce);
    const styles = this._getStyles();
    const styleBlock = styles.length > 0 ? `<style>${styles}</style>` : '';
    const { body, script } = this._getBodyParts();

    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${escapeHtml(this._title)}</title>
  ${styleBlock}
</head>
<body>
${body}
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
  }

  protected async _onMessage(raw: unknown): Promise<void> {
    if (this._busy || this._disposed) {
      return;
    }
    const msg = raw as IRebaseDialogMessage | undefined;
    if (!msg || typeof msg !== 'object') {
      return;
    }

    switch (msg.type) {
      case 'cancel':
        this.dispose();
        return;

      case 'rebase': {
        // Defensive: only accept a target we offered, falling back to the
        // preselected onto. The webview <select> can only emit our options,
        // but a compromised webview must not steer the rebase onto an
        // arbitrary ref.
        const onto =
          typeof msg.onto === 'string' && this._branchChoices.includes(msg.onto)
            ? msg.onto
            : this._onto;
        if (msg.interactive === true) {
          await this._executeInteractive(onto);
        } else {
          const persisted: IPersistedRebaseOptions = {
            rebaseMerges: msg.rebaseMerges === true,
            keepEmpty: msg.keepEmpty === true,
            updateRefs: msg.updateRefs === true,
            autosquash: msg.autosquash === true,
          };
          // Remember the chosen options so the next dialog pre-checks them.
          void saveRebaseOptions(this._context.globalState, persisted);
          await this._executeNonInteractive(onto, persisted);
        }
        return;
      }
    }
  }

  /** Interactive path — hand off to the rebase todo editor. */
  private async _executeInteractive(onto: string): Promise<void> {
    this._busy = true;
    try {
      const editor = this._createRebaseEditor();
      await editor.show(this._repo, { onto });
      if (this._onComplete) {
        this._safeOnComplete();
      }
      this.dispose();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(
        `Failed to start interactive rebase: ${sanitizeGitError(msg)}`
      );
      this._busy = false;
    }
  }

  /**
   * Non-interactive path — plain `rebaseBranch` with the conflict +
   * orphan-recovery handling ported verbatim from the old branch-menu
   * `_handleRebaseCurrentOnto` so routing through the dialog keeps every
   * safety net.
   */
  private async _executeNonInteractive(onto: string, options?: IRebaseOptions): Promise<void> {
    this._busy = true;
    try {
      // Snapshot the in-progress kind BEFORE the call so we can tell a
      // rebasing state OUR invocation created (eligible for auto-abort)
      // from one the user already had paused.
      const beforeKind = this._repo.inProgress?.kind;

      const result = await this._gitService.rebaseBranch(this._repo, onto, options);

      let conflictDialogOpened = false;
      let nonConflictFailure = false;

      if (result.success) {
        void vscode.window.showInformationMessage(`Rebased onto '${onto}' successfully`);
      } else if (result.conflicts && result.conflicts.length > 0) {
        // A conflict can only continue/abort when a live rebase remains
        // (`rebaseInProgress === true`); an autostash-pop conflict has none.
        const continuable = result.rebaseInProgress === true;
        if (this._conflictResolutionService) {
          conflictDialogOpened = true;
          await this._conflictResolutionService.openResolveConflictsDialog(
            this._repo,
            result.conflicts.map((p) => ({ path: p, resolved: false })),
            { operation: 'rebase', target: onto, canAbort: continuable, canContinue: continuable }
          );
        } else {
          void vscode.window.showWarningMessage(
            `Rebase onto '${onto}' paused with conflicts. Resolve and continue, or abort.`
          );
        }
      } else {
        nonConflictFailure = true;
        const reason = result.failureReason ?? 'unknown error (no output from git)';
        void vscode.window.showErrorMessage(
          `Failed to rebase onto '${onto}': ${sanitizeGitError(reason)}`
        );
      }

      // Rebase moved HEAD (or left a marker); reload before deciding on
      // recovery so the fresh `inProgress` state is read off disk.
      const reloaded = await this._gitService.reloadRepository(this._repo);
      const afterKind = (reloaded ?? this._repo).inProgress?.kind;

      if (nonConflictFailure && beforeKind !== 'rebasing' && afterKind === 'rebasing') {
        // Our non-conflict failure left an orphaned rebasing state. The
        // user's model is "it didn't work, leave it as if I never clicked" —
        // auto-abort, but ONLY when the state did not exist before our call.
        try {
          await this._gitService.rebaseAbort(this._repo);
        } catch (abortError) {
          const abortMsg = abortError instanceof Error ? abortError.message : 'Unknown error';
          void vscode.window.showErrorMessage(
            `Failed to abort orphaned rebase: ${sanitizeGitError(abortMsg)}`
          );
        }
      } else if (afterKind === 'rebasing' && !conflictDialogOpened) {
        void vscode.window.showWarningMessage(
          'Rebase paused with conflicts (or interruption). Resolve and continue, or abort.'
        );
      }

      if (this._onComplete) {
        this._safeOnComplete();
      }
      this.dispose();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to rebase: ${sanitizeGitError(msg)}`);
      this._busy = false;
    }
  }

  private _safeOnComplete(): void {
    try {
      this._onComplete?.();
    } catch (err) {
      getLogger()
        .child({ component: 'RebaseDialog' })
        .error('onComplete threw', err instanceof Error ? err : undefined);
    }
  }
}

/**
 * git4idea blocks opening the rebase dialog while a rebase is already live
 * (`GitRebaseDialog` shows a "Rebase already in progress" validation error).
 * Returns the message to surface when `repo` is mid-rebase, or `undefined`
 * when it is safe to open. A non-rebase in-progress op (merge, cherry-pick)
 * does NOT block — only an existing rebase would collide.
 */
export function rebaseInProgressMessage(repo: IRepository): string | undefined {
  return repo.inProgress?.kind === 'rebasing'
    ? 'A rebase is already in progress. Continue, skip, or abort it before starting a new one.'
    : undefined;
}

/**
 * Convenience factory. Returns `undefined` (after surfacing an error) when a
 * rebase is already in progress, so the caller never opens a second rebase on
 * top of a live one.
 */
export function showRebaseDialog(
  context: vscode.ExtensionContext,
  options: IRebaseDialogOptions
): RebaseDialog | undefined {
  const blocked = rebaseInProgressMessage(options.repo);
  if (blocked) {
    void vscode.window.showErrorMessage(blocked);
    return undefined;
  }
  return new RebaseDialog(context, options);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
