/**
 * New Branch Dialog.
 *
 * IntelliJ-style "Create New Branch" modal. Replaces the
 * `showInputBox`-based flow with a webview panel (extends
 * {@link BaseWebviewPanel}) that exposes the full option surface:
 *
 *  - Name (text, validated via {@link validateNewBranchName}).
 *  - Start point (read-only, passed in via constructor or HEAD).
 *  - Track remote (checkbox; defaults to true when start point looks
 *    remote, e.g. `origin/main`).
 *  - Overwrite if exists (checkbox, default false; maps to `git branch -f` or
 *    `git checkout -B`).
 *  - Checkout after create (checkbox, default true).
 *  - Create + Cancel buttons.
 *
 * No destructive-op confirm — branch creation is recoverable via
 * `git branch -D` or reflog.
 */

import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { sanitizeGitError } from '../git-core/gitError';
import { isHexObjectId } from '../git-core/gitDirMarkers';
import { getLogger } from '../utils/logger';
import { escapeHtml } from '../utils/escapeHtml';
import {
  IBranchConflictContext,
  validateBranchName as validateBranchNameWithConflicts,
} from './branchNameValidator';

/** Options for constructing a {@link NewBranchDialog}. */
export interface INewBranchDialogOptions {
  repo: IRepository;
  gitService: IGitService;
  /** Start point (commit hash, branch, tag). Defaults to HEAD. */
  startPoint?: string;
  /** Default branch name to pre-fill. */
  defaultName?: string;
  /** Fired after a successful create (and checkout, when enabled). */
  onBranchCreated?: () => void;
}

/**
 * Validate a branch name's format (no conflict checks). Delegates to the pure
 * {@link validateBranchNameWithConflicts} so the git `check-ref-format` rules
 * stay in one place across every entry point.
 *
 * Returns an error string when invalid, or `undefined` when valid.
 */
export function validateNewBranchName(value: string): string | undefined {
  return validateBranchNameWithConflicts(value);
}

/**
 * Pure helper: does this start point look like a remote-tracking ref?
 * Matches `origin/main`, `upstream/feature/x`, etc. Used by the dialog
 * to default `--track` to checked when it would be useful.
 */
export function looksRemoteStartPoint(startPoint: string | undefined): boolean {
  if (!startPoint) {
    return false;
  }
  // Heuristic: one or more non-slash chars, then a slash, then anything.
  // Full refs like `refs/remotes/origin/main` also qualify.
  if (startPoint.startsWith('refs/remotes/')) {
    return true;
  }
  const slash = startPoint.indexOf('/');
  if (slash < 1 || slash === startPoint.length - 1) {
    return false;
  }
  // Exclude commit hashes (hex-only, no slash actually — the early check
  // catches those) and tag-like "v1.2.3" paths where the first segment
  // isn't a remote name. Best we can do without a getRemotes round-trip.
  const first = startPoint.substring(0, slash);
  if (/^[0-9a-f]{7,40}$/.test(first)) {
    return false;
  }
  return true;
}

/**
 * Pure helper: can `--track` work for this start point? Git only sets up
 * tracking when the start point is a BRANCH (local or remote); a commit hash
 * or tag fails with "cannot set up tracking information". With a loaded
 * branch list the answer is exact (context stores remote names STRIPPED of
 * their remote prefix). Without one — the list hasn't loaded yet, or the load
 * failed and left an empty context — be permissive: only a commit hash is
 * knowably untrackable, and git stays the final authority on everything else
 * (a bare name like `main` may well be a local branch, which `--track`
 * accepts). No start point means HEAD, whose `--track` tracks the current
 * branch and always works.
 */
export function isTrackableStartPoint(
  startPoint: string | undefined,
  ctx?: IBranchConflictContext
): boolean {
  if (!startPoint) {
    return true;
  }
  if (ctx && (ctx.localBranches !== undefined || ctx.remoteBranches !== undefined)) {
    // Normalize full refs to the short names the context stores.
    const short = startPoint.startsWith('refs/remotes/')
      ? startPoint.substring('refs/remotes/'.length)
      : startPoint.startsWith('refs/heads/')
        ? startPoint.substring('refs/heads/'.length)
        : startPoint;
    if (ctx.localBranches?.includes(short)) {
      return true;
    }
    return (
      looksRemoteStartPoint(startPoint) &&
      (ctx.remoteBranches?.includes(stripRemotePrefix(short)) ?? false)
    );
  }
  return !isHexObjectId(startPoint, { allowPrefix: true });
}

/** Webview → extension message shape. */
interface INewBranchDialogMessage {
  type: 'create' | 'cancel';
  name?: string;
  track?: boolean;
  overwrite?: boolean;
  checkout?: boolean;
}

const VIEW_TYPE = 'intellig.newBranchDialog';
const TITLE = 'Create New Branch';

export class NewBranchDialog extends BaseWebviewPanel {
  private readonly _repo: IRepository;
  private readonly _gitService: IGitService;
  private readonly _startPoint: string | undefined;
  private readonly _startPointLabel: string;
  private readonly _defaultTrack: boolean;
  private readonly _defaultName: string;
  private readonly _onBranchCreated?: () => void;
  private _busy = false;
  /** Memoized conflict sources (existing branches + current branch). */
  private _conflictContextPromise: Promise<IBranchConflictContext> | undefined;

  constructor(context: vscode.ExtensionContext, options: INewBranchDialogOptions) {
    super(context, VIEW_TYPE, TITLE, vscode.ViewColumn.One);
    this._repo = options.repo;
    this._gitService = options.gitService;
    this._startPoint = options.startPoint;
    this._startPointLabel = options.startPoint ?? 'HEAD';
    this._defaultTrack = looksRemoteStartPoint(options.startPoint);
    this._defaultName = options.defaultName ?? '';
    this._onBranchCreated = options.onBranchCreated;
    this._render();
    // Load the existing-branch list so the webview can flag conflicts live.
    // Fire-and-forget: the dialog is usable before it resolves, and
    // `_executeCreate` re-awaits it as a server-side safety net.
    void this._ensureConflictContext().then((ctx) => this._postConflictContext(ctx));
  }

  /**
   * Fetch and memoize the conflict sources (local + remote branch names and
   * the current branch). Best-effort: a failure leaves an empty context so the
   * dialog still works — git itself remains the final authority on create.
   */
  private _ensureConflictContext(): Promise<IBranchConflictContext> {
    if (!this._conflictContextPromise) {
      this._conflictContextPromise = (async (): Promise<IBranchConflictContext> => {
        try {
          const branches = await this._gitService.getBranches(this._repo);
          const localBranches = branches.filter((b) => b.type === 'local').map((b) => b.name);
          const remoteBranches = branches
            .filter((b) => b.type === 'remote')
            .map((b) => stripRemotePrefix(b.name));
          const currentBranch =
            branches.find((b) => b.isHead)?.name ?? stripHeadRef(this._repo.head?.name);
          return { localBranches, remoteBranches, currentBranch };
        } catch (err) {
          getLogger()
            .child({ component: 'NewBranchDialog' })
            .warn('failed to load branch list for conflict checks', {
              error: err instanceof Error ? err.message : String(err),
            });
          return {};
        }
      })();
    }
    return this._conflictContextPromise;
  }

  /** Push the loaded conflict sources to the webview for live validation. */
  private _postConflictContext(ctx: IBranchConflictContext): void {
    if (this._disposed) {
      return;
    }
    void this.postMessage({
      type: 'conflicts',
      localBranches: ctx.localBranches ?? [],
      remoteBranches: ctx.remoteBranches ?? [],
      currentBranch: ctx.currentBranch ?? '',
      // Refine the render-time heuristic with the loaded branch list: the
      // webview hides the Track checkbox when the start point turns out not
      // to be a branch (commit hash, tag) — `--track` can never work there.
      startPointTrackable: isTrackableStartPoint(this._startPoint, ctx),
    });
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
        margin-bottom: 12px;
        padding: 6px 10px;
        background: var(--vscode-editor-inactiveSelectionBackground);
        border-left: 3px solid var(--vscode-focusBorder);
        font-family: var(--vscode-editor-font-family, monospace);
      }
      .summary .label {
        color: var(--vscode-descriptionForeground);
        margin-right: 6px;
      }
      .field { margin-bottom: 12px; }
      .field label.top {
        display: block;
        margin-bottom: 4px;
        color: var(--vscode-descriptionForeground);
      }
      input[type=text] {
        width: 100%;
        box-sizing: border-box;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 4px 6px;
        font-family: inherit;
        font-size: inherit;
      }
      .error {
        color: var(--vscode-errorForeground);
        font-size: 0.9em;
        margin-top: 4px;
        min-height: 1.1em;
      }
      .flags { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
      label.flag {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
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
      button:disabled { opacity: 0.55; cursor: not-allowed; }
    `;
  }

  protected _getBodyHtml(): string {
    return this._getBodyParts().body;
  }

  /**
   * Emit the body HTML and the interactive script separately. Used by
   * `_render` so it can splice the script into a nonced `<script>` block
   * without regex-extracting it from the body (nested `</script>`
   * inside a string literal would break the old regex).
   */
  private _getBodyParts(): { body: string; script: string } {
    // Body ships an empty root; the script builds every control via
    // document.createElement. Host data crosses as a JSON init island and
    // reaches the DOM via .value / .textContent (injection-proof).
    const body = `<div id="root"></div>`;

    const initJson = JSON.stringify({
      startPointLabel: this._startPointLabel,
      defaultName: this._defaultName,
      defaultTrack: this._defaultTrack,
      // Render-time answer (no branch list yet): hides Track immediately for
      // a commit-hash start point; the conflicts message refines it once the
      // branch list loads.
      trackVisible: isTrackableStartPoint(this._startPoint),
    }).replace(/</g, '\\u003c');

    const script = `
      (function() {
        const vscode = acquireVsCodeApi();
        const INIT = ${initJson};
        const root = document.getElementById('root');
        const el = (tag, props) => Object.assign(document.createElement(tag), props || {});

        // ── Summary (start point) ──────────────────────────────────────────
        const summary = el('div', { className: 'summary' });
        summary.append(
          el('span', { className: 'label', textContent: 'Start point:' }),
          INIT.startPointLabel
        );

        // ── Name field ─────────────────────────────────────────────────────
        const field = el('div', { className: 'field' });
        const nameLabel = el('label', { className: 'top', htmlFor: 'branch-name', textContent: 'New branch name:' });
        const nameInput = el('input', {
          type: 'text',
          id: 'branch-name',
          placeholder: 'feature/my-new-branch',
          value: INIT.defaultName,
        });
        const nameErr = el('div', { id: 'name-error', className: 'error' });
        field.append(nameLabel, nameInput, nameErr);

        // ── Option checkboxes ──────────────────────────────────────────────
        const flagsBox = el('div', { className: 'flags' });
        const flagRow = (id, checked, parts) => {
          const label = el('label', { className: 'flag' });
          const input = el('input', { type: 'checkbox', id: id });
          input.checked = checked;
          label.append(input, ...parts);
          return label;
        };
        const trackRow = flagRow('flag-track', INIT.defaultTrack, ['Track remote (', el('code', { textContent: '--track' }), ')']);
        trackRow.id = 'track-row';
        // Tracking only works when the start point is a branch; a commit hash
        // never qualifies, so the row starts hidden and the conflicts message
        // (loaded branch list) gives the final answer below.
        trackRow.hidden = !INIT.trackVisible;
        flagsBox.append(
          trackRow,
          flagRow('flag-overwrite', false, [
            'Overwrite if exists (',
            el('code', { textContent: '-f' }),
            ' / ',
            el('code', { textContent: '-B' }),
            ')',
          ]),
          flagRow('flag-checkout', true, ['Checkout after create'])
        );

        // ── Actions ────────────────────────────────────────────────────────
        const actions = el('div', { className: 'actions' });
        actions.append(
          el('button', { id: 'cancel-btn', type: 'button', className: 'secondary', textContent: 'Cancel' }),
          el('button', { id: 'create-btn', type: 'button', textContent: 'Create' })
        );

        root.append(summary, field, flagsBox, actions);
        nameInput.focus();

        const nameEl = document.getElementById('branch-name');
        const errorEl = document.getElementById('name-error');
        const createBtn = document.getElementById('create-btn');
        const overwriteEl = document.getElementById('flag-overwrite');

        // Existing-branch conflict sources, pushed from the extension once the
        // branch list loads (see NewBranchDialog._postConflictContext).
        let conflicts = { localBranches: [], remoteBranches: [], currentBranch: '' };

        // Mirror of branchNameValidator.isValidRefNameFormat (git check-ref-format).
        const validFormat = (name) => {
          if (!name || name.trim().length === 0) return false;
          if (/[\\u0000-\\u001F\\u007F]/.test(name) || /\\s/.test(name)) return false;
          if (/[~^:?*[\\\\"]/.test(name) || name.indexOf('@{') !== -1) return false;
          if (name.indexOf('..') !== -1 || name.indexOf('//') !== -1) return false;
          if (/^[.\\-/]/.test(name)) return false;
          if (/[./]$/.test(name) || name.slice(-5) === '.lock') return false;
          if (name.indexOf('./') !== -1 || name.indexOf('/.') !== -1) return false;
          return true;
        };

        const dirClash = (name) => conflicts.localBranches.some(
          (b) => b !== name && (b.indexOf(name + '/') === 0 || name.indexOf(b + '/') === 0)
        );

        // Mirror of branchNameValidator.validateBranchName.
        const validate = () => {
          const raw = nameEl.value;
          const v = raw.trim();
          if (v.length === 0) return 'Branch name cannot be empty';
          if (v.toUpperCase() === 'HEAD') return "Branch name cannot be 'HEAD'";
          if (!validFormat(raw)) return "Branch name '" + raw + "' is invalid";
          if (conflicts.remoteBranches.indexOf(v) !== -1)
            return "Branch name '" + v + "' clashes with an existing remote branch";
          if (dirClash(v))
            return "Branch name '" + v + "' clashes with an existing branch directory";
          if (!overwriteEl.checked) {
            if (conflicts.currentBranch && v === conflicts.currentBranch)
              return "Branch '" + v + "' is the current branch";
            if (conflicts.localBranches.indexOf(v) !== -1)
              return "Branch '" + v + "' already exists";
          }
          return '';
        };

        const refresh = () => {
          const err = validate();
          errorEl.textContent = err;
          createBtn.disabled = !!err;
        };

        nameEl.addEventListener('input', refresh);
        overwriteEl.addEventListener('change', refresh);

        window.addEventListener('message', (e) => {
          const m = e.data;
          if (m && m.type === 'conflicts') {
            conflicts = {
              localBranches: m.localBranches || [],
              remoteBranches: m.remoteBranches || [],
              currentBranch: m.currentBranch || '',
            };
            if (m.startPointTrackable === false) {
              const row = document.getElementById('track-row');
              const box = document.getElementById('flag-track');
              row.hidden = true;
              box.checked = false;
            } else if (m.startPointTrackable === true) {
              document.getElementById('track-row').hidden = false;
            }
            refresh();
          }
        });

        createBtn.addEventListener('click', () => {
          const err = validate();
          if (err) {
            errorEl.textContent = err;
            createBtn.disabled = true;
            nameEl.focus();
            return;
          }
          vscode.postMessage({
            type: 'create',
            name: nameEl.value.trim(),
            track: document.getElementById('flag-track').checked,
            overwrite: overwriteEl.checked,
            checkout: document.getElementById('flag-checkout').checked,
          });
        });
        document.getElementById('cancel-btn').addEventListener('click', () => {
          vscode.postMessage({ type: 'cancel' });
        });
        nameEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            createBtn.click();
          }
        });

        // Dialog keyboard contract (spec 5.1 — shared across all dialogs):
        //   Cmd+Enter / Ctrl+Enter → primary action (Create)
        //   Esc                    → cancel
        // Plain Enter on the single-line name field already submits (above);
        // this adds the modified-Enter alias and the page-wide Esc handler.
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            document.getElementById('create-btn').click();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            document.getElementById('cancel-btn').click();
          }
        });

        // Reflect the initial name's validity (disables Create on empty/default).
        refresh();
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
    const msg = raw as INewBranchDialogMessage | undefined;
    if (!msg || typeof msg !== 'object') {
      return;
    }
    switch (msg.type) {
      case 'cancel':
        this.dispose();
        return;
      case 'create':
        await this._executeCreate({
          name: msg.name ?? '',
          track: msg.track === true,
          overwrite: msg.overwrite === true,
          checkout: msg.checkout === true,
        });
        return;
    }
  }

  private async _executeCreate(params: {
    name: string;
    track: boolean;
    overwrite: boolean;
    checkout: boolean;
  }): Promise<void> {
    const context = await this._ensureConflictContext();
    const error = validateBranchNameWithConflicts(params.name, context, {
      allowExistingLocal: params.overwrite,
    });
    if (error) {
      void vscode.window.showErrorMessage(error);
      return;
    }
    // Server-side twin of the webview's Track gating (the checkbox may have
    // been checked before the branch list loaded): git can only set up
    // tracking from a branch, so fail fast with a clear message instead of
    // letting `git checkout --track` 128 on a commit-hash start point.
    if (params.track && !isTrackableStartPoint(this._startPoint, context)) {
      void vscode.window.showErrorMessage(
        `Cannot set up tracking: start point '${this._startPointLabel}' is not a branch.`
      );
      return;
    }
    this._busy = true;
    try {
      await this._gitService
        .createBranch(this._repo, params.name, {
          startPoint: this._startPoint,
          force: params.overwrite,
          track: params.track,
          checkout: params.checkout,
        })
        .match(
          () => undefined,
          (e) => {
            throw e;
          }
        );
      // Reload BEFORE announcing: the branch views and the graph's per-repo
      // log cache invalidate on onDidChangeRepository, which only the reload
      // fires deterministically — the `.git` watcher's debounced reload can
      // land after the refresh below, leaving a stale snapshot that hides the
      // new branch from the log until the next unrelated change. Best-effort:
      // the branch already exists, so a reload failure must not surface as a
      // failed create (the watcher reload eventually covers it).
      try {
        await this._gitService.reloadRepository(this._repo);
      } catch (err) {
        getLogger()
          .child({ component: 'NewBranchDialog' })
          .warn('post-create reload failed', {
            error: err instanceof Error ? err.message : String(err),
          });
      }
      const verb = params.checkout ? 'Created and switched to' : 'Created';
      void vscode.window.showInformationMessage(`${verb} branch '${params.name}'`);
      if (this._onBranchCreated) {
        try {
          this._onBranchCreated();
        } catch (err) {
          getLogger()
            .child({ component: 'NewBranchDialog' })
            .error('onBranchCreated threw', err instanceof Error ? err : undefined);
        }
      }
      this.dispose();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Failed to create branch: ${sanitizeGitError(msg)}`);
      this._busy = false;
    }
  }
}

/**
 * Convenience factory.
 */
export function showNewBranchDialog(
  context: vscode.ExtensionContext,
  options: INewBranchDialogOptions
): NewBranchDialog {
  return new NewBranchDialog(context, options);
}

/** `origin/feature/x` → `feature/x`; leaves a bare name untouched. */
function stripRemotePrefix(name: string): string {
  const slash = name.indexOf('/');
  return slash > 0 ? name.substring(slash + 1) : name;
}

/** `refs/heads/main` → `main`; passes through a bare name or undefined. */
function stripHeadRef(name: string | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  return name.startsWith('refs/heads/') ? name.substring('refs/heads/'.length) : name;
}
