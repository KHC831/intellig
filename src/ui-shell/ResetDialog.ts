/**
 * Reset Dialog.
 *
 * IntelliJ-style "Reset Current Branch to Here…" modal. Replaces the old
 * QuickPick-based reset flow with a webview panel (extends
 * {@link BaseWebviewPanel}) that exposes all four git reset modes as
 * radio buttons (Soft / Mixed / Hard / Keep).
 *
 * Safety policy (see feedback_data_loss_confirms.md):
 *  - Default selection is **Mixed** (non-destructive).
 *  - Hard/Keep → single modal confirm before execution. No double-confirm.
 *  - If the current branch is listed in `intellig.protectedBranches`,
 *    Hard and Keep radios render as disabled with a tooltip; user must
 *    remove the branch from config to use them.
 */

import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import {
  IGitService,
  IGitServiceCli,
  IRepository,
  ResetMode,
} from '../git-core/interfaces/IGitService';
import { saveLocalChanges, restoreLocalChanges } from '../git-core/ops/preservedChanges';
import { sanitizeGitError } from '../git-core/gitError';
import { getLogger } from '../utils/logger';
import { escapeHtml } from '../utils/escapeHtml';

/**
 * git's error when a `reset` (esp. `--keep`/`--merge`) would clobber
 * uncommitted work — the trigger for IntelliJ's Smart Reset proposal.
 */
export function isLocalChangesOverwriteError(message: string): boolean {
  return /local changes.*would be overwritten|would be overwritten by (?:checkout|merge|reset)/i.test(
    message
  );
}

/** The user's choice when a reset would overwrite local changes. */
export type SmartResetChoice = 'stash' | 'force' | 'cancel';

/**
 * IntelliJ "Smart Reset" (GitResetOperation.proposeSmartReset): when a reset
 * fails because local changes would be overwritten, offer to stash them
 * (stash → reset → unstash), force (`reset --hard`, discarding), or cancel.
 * Pure orchestration over injected ops so it is unit-testable; the dialog wires
 * the real prompt + git calls.
 */
export class SmartResetUnstashConflict extends Error {
  constructor(override readonly cause: unknown) {
    super('Stashed changes conflicted while restoring after reset');
    this.name = 'SmartResetUnstashConflict';
  }
}

/** The working tree has unmerged files — smart reset cannot stash over them. */
export class SmartResetBlockedUnmerged extends Error {
  constructor() {
    super('Cannot stash and reset while unmerged files are present');
    this.name = 'SmartResetBlockedUnmerged';
  }
}

/**
 * The reset was blocked by an overwrite error, yet the working tree has no
 * stashable changes — stashing would be a no-op. Carries the original reset
 * error so the caller surfaces it instead of resetting blind.
 */
export class SmartResetNotStashable extends Error {
  constructor(readonly originalError: unknown) {
    super('Reset blocked but there are no stashable local changes');
    this.name = 'SmartResetNotStashable';
  }
}

export async function runSmartReset(
  mode: ResetMode,
  ops: {
    prompt: () => Promise<SmartResetChoice>;
    stash: () => Promise<void>;
    reset: (mode: ResetMode) => Promise<void>;
    unstash: () => Promise<void>;
  }
): Promise<SmartResetChoice> {
  const choice = await ops.prompt();
  if (choice === 'stash') {
    await ops.stash();
    await ops.reset(mode);
    // The reset has now landed (HEAD moved). A failure restoring the stash is a
    // different outcome from a reset failure — tag it so the caller reports it
    // correctly and never claims the reset itself failed.
    try {
      await ops.unstash();
    } catch (err) {
      throw new SmartResetUnstashConflict(err);
    }
  } else if (choice === 'force') {
    await ops.reset('hard');
  }
  return choice;
}

/**
 * Target commit descriptor passed into the dialog.
 */
export interface IResetTarget {
  /** Full commit hash. Used as the `<commit>` arg to `git reset`. */
  hash: string;
  /** Commit subject line, shown next to the hash in the dialog header. */
  subject: string;
}

/**
 * Options for constructing a {@link ResetDialog}.
 */
export interface IResetDialogOptions {
  /** The repository to reset. */
  repo: IRepository;
  /** The target commit to reset to. */
  target: IResetTarget;
  /** Current branch name (e.g. "main"). Used for the protected-branch guard. */
  currentBranch: string;
  /**
   * Configured protected-branch names. When `currentBranch` is in this
   * list, the Hard and Keep radios are disabled.
   */
  protectedBranches: string[];
  /** GitService used to execute the reset. */
  gitService: IGitService;
  /**
   * Optional callback fired after a successful reset so the caller can
   * refresh any dependent UI (branch tree, graph panel, etc.).
   */
  onResetComplete?: () => void;
}

/**
 * Internal message shape from webview → extension.
 */
interface IResetDialogMessage {
  type: 'reset' | 'cancel';
  mode?: ResetMode;
}

const VIEW_TYPE = 'intellig.resetDialog';
const TITLE = 'Reset Current Branch';

/** globalState key under which the last-used reset mode is persisted. */
export const RESET_MODE_STATE_KEY = 'intellig.reset.lastMode';

/**
 * Minimal Memento subset (ExtensionContext.globalState shape) used to persist
 * the preferred reset mode. Declared narrowly so the pure helpers below are
 * testable against an in-memory store.
 */
export interface IResetModeStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * Load the user's last-used reset mode (IntelliJ GitVcsSettings.getResetMode
 * parity). Falls back to `'mixed'` (git's + IntelliJ's default) when nothing
 * is stored or the stored value is not a valid {@link ResetMode}.
 */
export function loadPreferredResetMode(store: IResetModeStore): ResetMode {
  const stored = store.get<unknown>(RESET_MODE_STATE_KEY, undefined);
  return isResetMode(stored) ? stored : 'mixed';
}

/** Persist the chosen reset mode so the next dialog pre-selects it. */
export function savePreferredResetMode(store: IResetModeStore, mode: ResetMode): Thenable<void> {
  return store.update(RESET_MODE_STATE_KEY, mode);
}

/**
 * Validation guard for commit-hash-ish strings passed to `git reset`.
 * Matches the guard used in {@link GitService.resetToCommit}.
 *
 * **Security:** rejects refs that start with `-` (git would parse as a flag,
 * e.g. `git reset --mixed -foo` becomes `git reset --mixed -f oo`) or `.`
 * (not a valid git-check-ref-format anyway, and prone to accidental relative-
 * path interpretation in downstream tooling). Same policy as
 * {@link validateTagName} in extension.ts.
 */
export function isValidRef(target: string): boolean {
  return /^(?![-.])[A-Za-z0-9_./@:~^-]+$/.test(target);
}

/**
 * Ordered reset-mode preference list. Used by {@link resolveDefaultMode} to
 * choose the fallback when the designated default is disabled by protected-
 * branch policy. "Mixed" is the safest (IntelliJ default + git default).
 */
const RESET_MODE_PREFERENCE: readonly ResetMode[] = ['mixed', 'soft', 'keep', 'hard'];

/**
 * Pick the effective default reset mode, falling back from the designated
 * default (`preferred`) to the first enabled alternative when the designated
 * one is disabled. Keeps the UI from rendering "no radio checked" if someone
 * later flips the default to Hard on a protected branch.
 *
 * @param preferred - The designated default mode.
 * @param disabled  - Set of modes disabled by the protected-branches policy.
 * @returns         A mode guaranteed not to be in `disabled` (or `preferred`
 *                  itself if every mode is disabled, which cannot happen in
 *                  practice because Soft/Mixed are never disabled).
 */
export function resolveDefaultMode(
  preferred: ResetMode,
  disabled: ReadonlySet<ResetMode>
): ResetMode {
  if (!disabled.has(preferred)) {
    return preferred;
  }
  for (const candidate of RESET_MODE_PREFERENCE) {
    if (!disabled.has(candidate)) {
      return candidate;
    }
  }
  // Degenerate case: all four modes disabled. Return preferred so the caller
  // at least has a valid ResetMode; the disabled attribute will keep it
  // inert in the DOM.
  return preferred;
}

export class ResetDialog extends BaseWebviewPanel {
  private readonly _repo: IRepository;
  private readonly _target: IResetTarget;
  private readonly _currentBranch: string;
  private readonly _protectedBranches: ReadonlySet<string>;
  private readonly _gitService: IGitService;
  private readonly _onResetComplete?: () => void;
  private _busy = false;

  constructor(context: vscode.ExtensionContext, options: IResetDialogOptions) {
    super(context, VIEW_TYPE, TITLE, vscode.ViewColumn.One);
    this._repo = options.repo;
    this._target = options.target;
    this._currentBranch = options.currentBranch;
    this._protectedBranches = new Set(options.protectedBranches);
    this._gitService = options.gitService;
    this._onResetComplete = options.onResetComplete;

    this._render();
  }

  /**
   * Whether the current branch is protected (Hard/Keep disabled).
   */
  get isProtected(): boolean {
    return this._protectedBranches.has(this._currentBranch);
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
      .target {
        margin-bottom: 16px;
        padding: 8px 10px;
        background: var(--vscode-editor-inactiveSelectionBackground);
        border-left: 3px solid var(--vscode-focusBorder);
        font-family: var(--vscode-editor-font-family, monospace);
      }
      .target .hash { font-weight: bold; margin-right: 8px; }
      .modes {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 20px;
      }
      label.mode {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        cursor: pointer;
      }
      label.mode input[disabled] + .label-text {
        opacity: 0.55;
        cursor: not-allowed;
      }
      label.mode .label-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      label.mode .label-text .title-line {
        font-weight: 600;
      }
      label.mode .label-text .desc {
        font-size: 0.9em;
        color: var(--vscode-descriptionForeground);
      }
      .warn { color: var(--vscode-editorWarning-foreground); }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 8px;
      }
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
      button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
    `;
  }

  protected _getBodyHtml(): string {
    return this._getBodyParts().body;
  }

  /**
   * Emit the body HTML and the interactive script separately. Used by
   * `_wrapHtml` so it can splice the script into a nonced `<script>` block
   * without regex-extracting it from the body (nested `</script>`
   * inside a string literal would break the old regex).
   */
  private _getBodyParts(): { body: string; script: string } {
    // Compute the effective default explicitly instead of leaning
    // on the brittle `checked && !disabled` trick. If someone later flips
    // the designated default to Hard, a protected branch will now fall back
    // to the first enabled mode (Soft) rather than render no radio checked.
    const disabledSet = new Set<ResetMode>(this.isProtected ? ['hard', 'keep'] : []);
    // Preselect the user's last-used mode (IntelliJ persists this per project),
    // falling back through resolveDefaultMode if it's disabled on a protected
    // branch.
    const preferred = loadPreferredResetMode(this._context.globalState);
    const effectiveDefault = resolveDefaultMode(preferred, disabledSet);

    // Body ships an empty root; the script builds every control via
    // document.createElement. Host data crosses as a JSON init island and
    // reaches the DOM via .textContent / element props (injection-proof).
    const body = `<div id="root"></div>`;

    const initJson = JSON.stringify({
      shortHash: this._target.hash.substring(0, 8),
      subject: this._target.subject,
      disabledModes: [...disabledSet],
      effectiveDefault,
      protectedTooltip: 'Protected branch — remove from intellig.protectedBranches to enable',
    }).replace(/</g, '\\u003c');

    const script = `
      (function() {
        const vscode = acquireVsCodeApi();
        const INIT = ${initJson};
        const root = document.getElementById('root');
        const el = (tag, props) => Object.assign(document.createElement(tag), props || {});

        // ── Target (hash + subject) ────────────────────────────────────────
        const target = el('div', { className: 'target' });
        target.append(
          el('span', { className: 'hash', textContent: INIT.shortHash }),
          el('span', { className: 'subject', textContent: INIT.subject })
        );

        // ── Reset-mode radios ──────────────────────────────────────────────
        const MODES = [
          { mode: 'soft', label: 'Soft', desc: 'Keep changes staged', warn: false },
          { mode: 'mixed', label: 'Mixed', desc: 'Keep changes unstaged (default)', warn: false },
          { mode: 'hard', label: 'Hard', desc: 'Discard all changes', warn: true },
          { mode: 'keep', label: 'Keep', desc: 'Discard committed, keep local', warn: true },
        ];
        const modesBox = el('div', { className: 'modes' });
        modesBox.setAttribute('role', 'radiogroup');
        modesBox.setAttribute('aria-label', 'Reset mode');
        for (const m of MODES) {
          const disabled = INIT.disabledModes.includes(m.mode);
          const label = el('label', { className: 'mode' });
          label.setAttribute('data-mode', m.mode);
          if (disabled) {
            label.setAttribute('title', INIT.protectedTooltip);
          }
          const input = el('input', { type: 'radio', name: 'reset-mode', value: m.mode });
          input.checked = m.mode === INIT.effectiveDefault;
          input.disabled = disabled;
          const text = el('span', { className: 'label-text' });
          text.append(
            el('span', { className: 'title-line' + (m.warn ? ' warn' : ''), textContent: m.label }),
            el('span', { className: 'desc', textContent: m.desc })
          );
          label.append(input, text);
          modesBox.append(label);
        }

        // ── Actions ────────────────────────────────────────────────────────
        const actions = el('div', { className: 'actions' });
        actions.append(
          el('button', { id: 'cancel-btn', type: 'button', className: 'secondary', textContent: 'Cancel' }),
          el('button', { id: 'reset-btn', type: 'button', textContent: 'Reset' })
        );

        root.append(target, modesBox, actions);

        const submit = () => {
          const checked = document.querySelector('input[name="reset-mode"]:checked');
          const mode = checked ? checked.value : 'mixed';
          vscode.postMessage({ type: 'reset', mode });
        };
        const cancel = () => {
          vscode.postMessage({ type: 'cancel' });
        };
        document.getElementById('reset-btn').addEventListener('click', submit);
        document.getElementById('cancel-btn').addEventListener('click', cancel);

        // Dialog keyboard contract (spec 5.1 — shared across all dialogs):
        //   Cmd+Enter / Ctrl+Enter → primary action (Reset)
        //   Esc                    → cancel
        // Destructive Hard/Keep still routes through the modal confirm in
        // the message handler, so Cmd+Enter never bypasses the safety prompt.
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
   * Override the base renderer entirely so we can emit the interactive
   * script with the CSP nonce. We pass body+script as an explicit
   * tuple from `_getBodyParts()` instead of regex-extracting the script
   * from the serialized body (which would break on nested `</script>`
   * substrings inside string literals).
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
    const msg = raw as IResetDialogMessage | undefined;
    if (!msg || typeof msg !== 'object') {
      return;
    }

    switch (msg.type) {
      case 'cancel':
        this.dispose();
        return;

      case 'reset': {
        const mode = msg.mode;
        if (!mode || !isResetMode(mode)) {
          return;
        }
        // Protected-branch guard at the message boundary: even if a
        // malicious webview somehow bypassed `disabled`, we refuse
        // Hard/Keep on a protected branch.
        if (this.isProtected && (mode === 'hard' || mode === 'keep')) {
          void vscode.window.showWarningMessage(
            `Reset --${mode} blocked: '${this._currentBranch}' is a protected branch. ` +
              `Remove it from intellig.protectedBranches to enable.`
          );
          return;
        }

        if (mode === 'hard' || mode === 'keep') {
          const confirmed = await this._confirmDestructive();
          if (!confirmed) {
            return;
          }
        }

        await this._executeReset(mode);
        return;
      }
    }
  }

  /**
   * Show the single destructive-op confirm modal.
   * Returns true if the user clicked "Reset", false otherwise.
   */
  private async _confirmDestructive(): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      'This will discard local changes. Continue?',
      { modal: true },
      'Reset',
      'Cancel'
    );
    return choice === 'Reset';
  }

  /**
   * Execute the reset and show toast / error. Disposes the dialog on
   * success; leaves it open on failure so the user can retry or cancel.
   */
  private async _executeReset(mode: ResetMode): Promise<void> {
    this._busy = true;
    try {
      if (!isValidRef(this._target.hash)) {
        throw new Error(`Invalid commit reference: ${this._target.hash}`);
      }
      await this._gitService.resetToCommit(this._repo, this._target.hash, mode).match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
      // Remember the chosen mode so the next reset dialog pre-selects it.
      void savePreferredResetMode(this._context.globalState, mode);
      this._finishReset();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Smart Reset: if the reset failed because local changes would be
      // overwritten, propose stashing them rather than just erroring (IntelliJ).
      if (isLocalChangesOverwriteError(errorMessage)) {
        await this._proposeSmartReset(mode, error);
        return;
      }
      void vscode.window.showErrorMessage(`Failed to reset: ${sanitizeGitError(errorMessage)}`);
      this._busy = false;
    }
  }

  /** Success path shared by a plain reset and a smart (stashed/forced) reset. */
  private _finishReset(): void {
    const shortHash = this._target.hash.substring(0, 8);
    void vscode.window.showInformationMessage(`Reset to ${shortHash}`);
    this._completeAndClose();
  }

  /** Fire the completion callback (refresh) and close the dialog. */
  private _completeAndClose(): void {
    if (this._onResetComplete) {
      try {
        this._onResetComplete();
      } catch (err) {
        getLogger()
          .child({ component: 'ResetDialog' })
          .error('onResetComplete callback threw', err instanceof Error ? err : undefined);
      }
    }
    this.dispose();
  }

  /**
   * The reset was blocked by local changes — offer Stash and Reset / Force /
   * Cancel (IntelliJ Smart Reset). Stash → reset → unstash; Force → hard reset.
   */
  private async _proposeSmartReset(mode: ResetMode, originalError: unknown): Promise<void> {
    const STASH = 'Stash and Reset';
    const FORCE = 'Force (discard changes)';
    const gitCli = (this._gitService as unknown as IGitServiceCli).gitCli;
    const cwd = this._repo.rootUri.fsPath;
    // Pins the stash entry created by the `stash` arm so the `unstash` arm pops
    // exactly it — `stash@{0}` is not stable if a concurrent bracket or the
    // user pushes another stash between save and restore.
    let stashSha: string | undefined;
    try {
      const choice = await runSmartReset(mode, {
        prompt: async () => {
          const pick = await vscode.window.showWarningMessage(
            'Local changes would be overwritten by this reset.',
            { modal: true },
            STASH,
            FORCE
          );
          return pick === STASH ? 'stash' : pick === FORCE ? 'force' : 'cancel';
        },
        stash: async () => {
          const saved = await saveLocalChanges(gitCli, cwd, 'Auto-stash before reset');
          if (saved.status === 'blocked-unmerged') {
            throw new SmartResetBlockedUnmerged();
          }
          if (saved.status === 'clean') {
            // The overwrite error was not raised by stashable working-tree
            // changes, so a stash would save nothing and a reset here could
            // destroy the real (non-stashable) obstruction. Surface the
            // original error instead of resetting blind.
            throw new SmartResetNotStashable(originalError);
          }
          stashSha = saved.stashSha;
        },
        reset: (m) =>
          this._gitService.resetToCommit(this._repo, this._target.hash, m).match(
            () => undefined,
            (e) => {
              throw e;
            }
          ),
        unstash: async () => {
          if (stashSha === undefined) {
            return;
          }
          const restore = await restoreLocalChanges(gitCli, cwd, stashSha);
          if (restore.status === 'failed') {
            throw new SmartResetUnstashConflict(restore.detail);
          }
        },
      });
      if (choice === 'cancel') {
        this._busy = false;
        return;
      }
      void savePreferredResetMode(this._context.globalState, mode);
      this._finishReset();
    } catch (error) {
      if (error instanceof SmartResetUnstashConflict) {
        // The reset landed; only restoring the stash conflicted. Report that
        // distinctly — claiming "Failed to reset" here is false (HEAD moved)
        // and dangerous. The stash is retained for the user to resolve. Still
        // persist the mode + refresh + close as a completed reset.
        void savePreferredResetMode(this._context.globalState, mode);
        const shortHash = this._target.hash.substring(0, 8);
        void vscode.window.showWarningMessage(
          `Reset to ${shortHash} succeeded, but your stashed changes conflicted and were ` +
            `left in the stash. Resolve the conflicts, then drop the stash.`
        );
        this._completeAndClose();
        return;
      }
      if (error instanceof SmartResetBlockedUnmerged) {
        void vscode.window.showErrorMessage(
          'Cannot stash and reset: the working tree has unmerged (conflicted) files. ' +
            'Resolve the conflicts first.'
        );
        this._busy = false;
        return;
      }
      const surfaced = error instanceof SmartResetNotStashable ? error.originalError : error;
      const msg = surfaced instanceof Error ? surfaced.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to reset: ${sanitizeGitError(msg)}`);
      this._busy = false;
    }
  }
}

/**
 * Convenience factory: show a Reset dialog for the given target.
 *
 * Kept as a module-level function so callers don't need to import
 * {@link ResetDialog} directly and so tests can stub this single entry
 * point if needed.
 */
export function showResetDialog(
  context: vscode.ExtensionContext,
  options: IResetDialogOptions
): ResetDialog {
  return new ResetDialog(context, options);
}

function isResetMode(x: unknown): x is ResetMode {
  return x === 'soft' || x === 'mixed' || x === 'hard' || x === 'keep';
}
