/**
 * Push Dialog (T1-01).
 *
 * IntelliJ-style "Push Commits to Remote" dialog. Replaces the old stub with
 * a webview panel (extends {@link BaseWebviewPanel}) that shows:
 *   - A repo table: [✓ selected] [repo basename] [local branch] [target (editable)] [commits-since badge]
 *   - A right-side commit preview pane for the focused row
 *   - A primary-button dropdown: Push / Force Push with Lease / Force Push (Anyway)…
 *   - A gear overflow: --no-verify checkbox, Push tags with all / --follow-tags radio
 *   - Bottom-right "Edit all targets" link
 *
 * Safety policy (see feedback_data_loss_confirms.md):
 *   - `--force-with-lease` is the default force path. When a row's local branch
 *     diverges from its upstream, the primary button's default action switches
 *     to "Force Push with Lease" (matches IntelliJ behaviour).
 *   - Bare `--force` ("Force Push (Anyway)…") is always a secondary, explicit
 *     dropdown entry. It is never the default.
 *   - Targets matching `intellig.protectedBranches` disable the bare-force
 *     entry per-row; force-with-lease remains available.
 *   - No double-confirm modal on force push — the explicit dropdown entry IS
 *     the confirm. Matches IR minimal-UX policy.
 *
 * This file is split into three layers so tests can exercise push logic
 * without activating a webview:
 *   1. Pure helpers (option-builder, protected-branch check, error classifier,
 *      default-action picker, divergence detection).
 *   2. Dependency-injected {@link runPushRow} that executes a single repo's
 *      push and returns a structured {@link IPushRowResult}.
 *   3. The {@link PushDialog} class with webview rendering + message handling.
 */

import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
import { sanitizeGitError } from '../utils/gitError';
import { IGitService, IPushOptions, IRepository } from './interfaces/IGitService';
import type { PullDialog } from './PullDialog';

// ─── Action + state types ────────────────────────────────────────────────────

/** The three actions available in the primary-button dropdown. */
export type PushAction = 'push' | 'forceWithLease' | 'force';

/** Gear overflow state. */
export interface IPushOverflowState {
  /** `--no-verify`. */
  noVerify: boolean;
  /** Include tags in the push. When false, tag scope is ignored. */
  pushTags: boolean;
  /** When pushTags = true: 'all' → --tags, 'follow' → --follow-tags. */
  tagScope: 'all' | 'follow';
}

/** Per-row state in the repo table. */
export interface IPushRow {
  /** Stable row id (repo root fsPath). */
  id: string;
  /** Row visually selected for pushing in this submit. */
  selected: boolean;
  /** The repository behind this row. */
  repo: IRepository;
  /** Display name (usually basename of repo root). */
  repoLabel: string;
  /** Local branch name (e.g. `feature/x`). Read-only. */
  localBranch: string;
  /** The editable target branch name. Starts as upstream.name or local branch. */
  targetBranch: string;
  /** Upstream remote name (e.g. `origin`). May be unset for branches without upstream. */
  upstreamRemote?: string;
  /** Count of commits ahead of upstream (commits-to-be-pushed). */
  ahead: number;
  /** Count of commits behind upstream (divergence signal). */
  behind: number;
  /**
   * Per-row error state, if the last push attempt failed. Used to render the
   * inline row banner and offer "Pull and Retry" / "Force with Lease".
   */
  error?: IPushRowError;
}

/** Classification of a push failure. */
export type PushErrorKind = 'rejected-non-ff' | 'rejected-protected' | 'auth' | 'hook' | 'other';

/** Row-level push error for rendering retry affordances. */
export interface IPushRowError {
  kind: PushErrorKind;
  /** The raw git stderr / error message. */
  message: string;
}

/** Result of a single-row push attempt. */
export interface IPushRowResult {
  ok: boolean;
  error?: IPushRowError;
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Is the target branch name protected? Uses the same `intellig.protectedBranches`
 * list that T1-11 introduced for destructive reset modes.
 */
export function isProtectedTarget(
  targetBranch: string,
  protectedBranches: ReadonlyArray<string>
): boolean {
  return protectedBranches.includes(targetBranch);
}

/**
 * Classify a git push error by matching common stderr patterns. Returns a
 * `PushErrorKind` tag that determines which row-banner affordances to show.
 *
 * The ordering matters — we match specific patterns before falling back to
 * `other`.
 */
export function classifyPushError(stderr: string): PushErrorKind {
  const msg = stderr.toLowerCase();
  if (/protected branch/.test(msg) || /refusing to (allow|overwrite)/.test(msg)) {
    return 'rejected-protected';
  }
  if (/\(non-fast-forward\)/.test(msg) || /updates were rejected because/.test(msg)) {
    return 'rejected-non-ff';
  }
  if (
    /authentication failed/.test(msg) ||
    /permission denied/.test(msg) ||
    /could not read username/.test(msg) ||
    /support for password authentication was removed/.test(msg)
  ) {
    return 'auth';
  }
  if (/pre-push hook/.test(msg) || /hook declined/.test(msg) || /hook failed/.test(msg)) {
    return 'hook';
  }
  return 'other';
}

/**
 * Pick the default primary action based on divergence state. Per design
 * spec §4, when the selected branch has local divergence from its upstream
 * (ahead > 0 AND behind > 0), flip the default from `push` to
 * `forceWithLease` so the user's muscle-memory "Enter" stays safe.
 */
export function defaultPrimaryAction(rows: ReadonlyArray<IPushRow>): PushAction {
  const selected = rows.filter((r) => r.selected);
  if (selected.length === 0) {
    return 'push';
  }
  const anyDiverged = selected.some((r) => r.ahead > 0 && r.behind > 0);
  return anyDiverged ? 'forceWithLease' : 'push';
}

/**
 * SR-5: human-facing label for the primary button. Extracted as a pure
 * helper so the host + webview-patch pipeline stay in sync.
 */
export function primaryButtonLabel(action: PushAction): string {
  switch (action) {
    case 'force':
      return 'Force Push (Anyway)…';
    case 'forceWithLease':
      return 'Force Push with Lease';
    case 'push':
    default:
      return 'Push';
  }
}

/**
 * Build an {@link IPushOptions} from a row + chosen action + overflow state.
 *
 * - Sets `--set-upstream` when the row has no upstreamRemote (new branch).
 * - Computes a `refspec` only when the target differs from the local branch
 *   (so the common case stays `git push <remote> <branch>`).
 * - Maps action: `push` → nothing / `forceWithLease` → --force-with-lease
 *   / `force` → --force (and only `force` sets bare --force).
 * - Maps overflow: `noVerify` → --no-verify; `pushTags` + scope → --tags or
 *   --follow-tags.
 */
export function buildPushOptions(
  row: IPushRow,
  action: PushAction,
  overflow: IPushOverflowState,
  fallbackRemote: string = 'origin'
): IPushOptions {
  // Security: refuse up-front if either branch name could be parsed by git as
  // a CLI flag. `git push <remote> -foo` treats `-foo` as `-f oo`; same for
  // refspec halves. Matches validateTagName / isValidRef policy.
  if (!isValidPushRef(row.localBranch)) {
    throw new Error(`Invalid local branch '${row.localBranch}': cannot start with '-' or '.'`);
  }
  if (row.targetBranch && !isValidPushRef(row.targetBranch)) {
    throw new Error(`Invalid target branch '${row.targetBranch}': cannot start with '-' or '.'`);
  }

  const remote = row.upstreamRemote ?? fallbackRemote;
  const opts: IPushOptions = {
    remote,
    branch: row.localBranch,
  };

  if (!row.upstreamRemote) {
    opts.setUpstream = true;
  }

  switch (action) {
    case 'forceWithLease':
      opts.forceWithLease = true;
      break;
    case 'force':
      opts.force = true;
      break;
    case 'push':
    default:
      break;
  }

  if (overflow.noVerify) {
    opts.noVerify = true;
  }
  if (overflow.pushTags) {
    if (overflow.tagScope === 'follow') {
      opts.followTags = true;
    } else {
      opts.tags = true;
    }
  }

  if (row.targetBranch && row.targetBranch !== row.localBranch) {
    opts.refspec = `${row.localBranch}:${row.targetBranch}`;
    // When pushing a refspec, drop the positional branch so the CLI doesn't
    // see two push specs.
    delete opts.branch;
  }

  return opts;
}

/**
 * Security guard: a ref/branch name must not start with `-` (git would parse
 * it as a CLI flag) or `.` (invalid per git-check-ref-format). Allows the
 * same character set git refs normally accept.
 */
export function isValidPushRef(name: string): boolean {
  return /^(?![-.])[A-Za-z0-9_./@:~^-]+$/.test(name);
}

/**
 * Guard: is this primary action permitted for the row given the protected list?
 * The bare-force action is the only one blocked on protected targets; forceWithLease
 * and push always pass.
 */
export function isActionAllowedForRow(
  row: IPushRow,
  action: PushAction,
  protectedBranches: ReadonlyArray<string>
): boolean {
  if (action === 'force' && isProtectedTarget(row.targetBranch, protectedBranches)) {
    return false;
  }
  return true;
}

// ─── Dependency-injected push-row runner ─────────────────────────────────────

/** Dependencies for {@link runPushRow}. Thin seams over {@link IGitService}. */
export interface IRunPushRowDeps {
  gitService: IGitService;
  protectedBranches: ReadonlyArray<string>;
}

/**
 * Execute a single row's push. Returns a structured result instead of
 * throwing so the caller can keep driving other rows in parallel.
 */
export async function runPushRow(
  deps: IRunPushRowDeps,
  row: IPushRow,
  action: PushAction,
  overflow: IPushOverflowState
): Promise<IPushRowResult> {
  if (!isActionAllowedForRow(row, action, deps.protectedBranches)) {
    return {
      ok: false,
      error: {
        kind: 'rejected-protected',
        message: `'${row.targetBranch}' is a protected branch — Force Push (Anyway) is blocked locally. Remove it from intellig.protectedBranches to enable.`,
      },
    };
  }

  // `buildPushOptions` throws on invalid ref names (SR-3 security guard).
  // Catch and surface as a row error so the dialog doesn't unmount.
  let options: IPushOptions;
  try {
    options = buildPushOptions(row, action, overflow);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: { kind: 'other', message } };
  }
  try {
    await deps.gitService.push(row.repo, options);
    return { ok: true };
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'Unknown error';
    // Scrub any `user:token@host` credentials leaked by git stderr before the
    // error lands in a row banner / toast (senior-review LOW finding).
    const message = sanitizeGitError(raw);
    return { ok: false, error: { kind: classifyPushError(raw), message } };
  }
}

// ─── Dialog options + messages ───────────────────────────────────────────────

/** Options for constructing a {@link PushDialog}. */
export interface IPushDialogOptions {
  /** The repositories to offer in the row table. */
  repos: ReadonlyArray<IRepository>;
  /** Optional single repo / branch to preselect; all other rows unselected. */
  preselect?: { repo: IRepository; branch?: string };
  /** Initial primary-button action. Defaults to `push` (computed from divergence). */
  preselectForce?: 'force-with-lease' | 'force';
  /** GitService — used for `.push` and for per-repo upstream/branch discovery. */
  gitService: IGitService;
  /** Protected-branches list from `intellig.protectedBranches` config. */
  protectedBranches: ReadonlyArray<string>;
  /**
   * Optional PullDialog accessor — when a row is rejected (non-ff), clicking
   * "Pull and Retry" invokes this. When absent, the rejection banner still
   * renders but the button is disabled.
   */
  pullDialogAccessor?: () => PullDialog | undefined;
  /** Callback fired after all rows settle successfully so callers can refresh. */
  onPushComplete?: () => void;
}

/** Webview → extension message shape. */
interface IPushDialogMessage {
  type:
    | 'submit'
    | 'cancel'
    | 'updateRow'
    | 'updateOverflow'
    | 'pullAndRetry'
    | 'forceWithLease-row';
  action?: PushAction;
  rowId?: string;
  rowPatch?: Partial<Pick<IPushRow, 'selected' | 'targetBranch'>>;
  overflow?: IPushOverflowState;
}

/**
 * SR-5: host → webview incremental-patch messages. When a user edits a row's
 * target field or toggles an overflow checkbox, the host would previously
 * call `_render()` to regenerate the entire body — which wiped input focus,
 * selection, and mid-word keystrokes. We now send a targeted DOM patch so
 * only the derived display state updates (primary-button label, row
 * `data-protected` attribute, Force-Push-Anyway disabled state). Structural
 * changes (rows added / removed / errored, etc.) still fall back to
 * `_render()`.
 *
 * Note: we deliberately do NOT echo the user's `targetBranch` / `selected` /
 * overflow-checkbox values back into the webview — the input element the
 * user just touched already reflects the new value. Writing it back would
 * either be a no-op (value unchanged) or would fight the user's cursor in
 * rare race conditions.
 */
interface IPushDialogPatchRow {
  type: 'patchRow';
  rowId: string;
  /** `true` if the row's edited target is in the protected-branches list. */
  protected: boolean;
  /** Derived primary-button + select state (may flip on selected/target edits). */
  primary: { action: PushAction; label: string; anyProtected: boolean };
}

interface IPushDialogPatchOverflow {
  type: 'patchOverflow';
  /** Derived primary-button + select state (flips when action-select changes). */
  primary: { action: PushAction; label: string; anyProtected: boolean };
}

const VIEW_TYPE = 'intellig.pushDialog';
const TITLE = 'Push Commits to Remote';

// ─── PushDialog class ────────────────────────────────────────────────────────

export class PushDialog extends BaseWebviewPanel {
  private readonly _gitService: IGitService;
  private readonly _protectedBranches: ReadonlyArray<string>;
  private readonly _pullDialogAccessor?: () => PullDialog | undefined;
  private readonly _onPushComplete?: () => void;
  private _rows: IPushRow[] = [];
  private _overflow: IPushOverflowState = {
    noVerify: false,
    pushTags: false,
    tagScope: 'follow',
  };
  private _primaryAction: PushAction = 'push';
  private _busy = false;

  constructor(context: vscode.ExtensionContext, options: IPushDialogOptions) {
    super(context, VIEW_TYPE, TITLE, vscode.ViewColumn.One);
    this._gitService = options.gitService;
    this._protectedBranches = options.protectedBranches;
    this._pullDialogAccessor = options.pullDialogAccessor;
    this._onPushComplete = options.onPushComplete;

    // Populate rows synchronously — data comes entirely from in-memory repo state.
    this._populateRows(options.repos, options.preselect);
    if (options.preselectForce === 'force-with-lease') {
      this._primaryAction = 'forceWithLease';
    } else if (options.preselectForce === 'force') {
      this._primaryAction = 'force';
    } else {
      this._primaryAction = defaultPrimaryAction(this._rows);
    }
    this._render();
  }

  // ─── Row bootstrap ─────────────────────────────────────────────────────────

  private _populateRows(
    repos: ReadonlyArray<IRepository>,
    preselect?: { repo: IRepository; branch?: string }
  ): void {
    const rows: IPushRow[] = [];
    for (const repo of repos) {
      const localBranch = repo.head?.name?.replace(/^refs\/heads\//, '') ?? '';
      const upstream = repo.head?.upstream;
      const targetBranch = upstream?.name ?? localBranch;
      const selected = !preselect || preselect.repo.rootUri.fsPath === repo.rootUri.fsPath;
      rows.push({
        id: repo.rootUri.fsPath,
        selected,
        repo,
        repoLabel: basename(repo.rootUri.fsPath),
        localBranch,
        targetBranch: preselect?.branch && selected ? preselect.branch : targetBranch,
        upstreamRemote: upstream?.remote,
        ahead: repo.head?.ahead ?? 0,
        behind: repo.head?.behind ?? 0,
      });
    }
    this._rows = rows;
  }

  // ─── Testing hooks (protected so subclasses/tests can observe state) ───────

  /** Public getter for tests and programmatic callers. */
  get rows(): ReadonlyArray<IPushRow> {
    return this._rows;
  }

  /** Public getter for tests. */
  get primaryAction(): PushAction {
    return this._primaryAction;
  }

  /** Public getter for tests. */
  get overflow(): IPushOverflowState {
    return { ...this._overflow };
  }

  // ─── Webview rendering ─────────────────────────────────────────────────────

  protected override _getStyles(): string {
    return `
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 16px 20px;
        font-size: var(--vscode-font-size);
      }
      table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
      th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--vscode-editorWidget-border, #555); }
      th { font-weight: 600; color: var(--vscode-descriptionForeground); }
      td input[type=text] {
        width: 100%;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 2px 4px;
      }
      .badge {
        display: inline-block;
        padding: 0 6px;
        border-radius: 8px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        font-size: 0.85em;
      }
      .row-error {
        font-size: 0.9em;
        color: var(--vscode-errorForeground);
        padding: 4px 8px;
      }
      .row-error button {
        margin-left: 8px;
      }
      .overflow {
        display: flex;
        gap: 16px;
        align-items: center;
        margin: 12px 0;
        font-size: 0.95em;
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
      .edit-all {
        float: right;
        font-size: 0.9em;
        color: var(--vscode-textLink-foreground);
        cursor: pointer;
      }
    `;
  }

  protected _getBodyHtml(): string {
    return this._getBodyParts().body;
  }

  /**
   * Emit the body HTML and the interactive script separately so `_wrapHtml`
   * can splice the script into a nonced `<script>` block without fragile
   * regex extraction (LOW-1 — nested `</script>` inside any future string
   * literal would break the old regex).
   */
  private _getBodyParts(): { body: string; script: string } {
    if (this._rows.length === 0) {
      return { body: '<div>Loading repositories…</div>', script: '' };
    }

    const rowsHtml = this._rows
      .map((r) => {
        const protectedRow = isProtectedTarget(r.targetBranch, this._protectedBranches);
        const protectedAttr = protectedRow ? ' data-protected="1"' : '';
        const errorHtml = r.error
          ? `<tr class="row-error" data-row-id="${escapeHtml(r.id)}">
              <td colspan="5">
                ⚠ ${escapeHtml(r.error.message)}
                ${
                  r.error.kind === 'rejected-non-ff'
                    ? `<button data-action="pullAndRetry" data-row-id="${escapeHtml(r.id)}">Pull and Retry…</button>
                       <button data-action="forceWithLease-row" data-row-id="${escapeHtml(r.id)}">Force with Lease</button>`
                    : ''
                }
              </td>
             </tr>`
          : '';
        return `
          <tr data-row-id="${escapeHtml(r.id)}"${protectedAttr}>
            <td><input type="checkbox" class="row-select" ${r.selected ? 'checked' : ''} data-row-id="${escapeHtml(r.id)}" /></td>
            <td>${escapeHtml(r.repoLabel)}</td>
            <td>${escapeHtml(r.localBranch)}</td>
            <td><input type="text" class="row-target" value="${escapeHtml(r.targetBranch)}" data-row-id="${escapeHtml(r.id)}" /></td>
            <td>${r.ahead === 0 ? '<span class="badge">up to date</span>' : `<span class="badge">${r.ahead}</span>`}</td>
          </tr>
          ${errorHtml}`;
      })
      .join('\n');

    // Primary button label reflects default action.
    const primaryLabel = primaryButtonLabel(this._primaryAction);

    // Build the dropdown options.
    const anyProtected = this._rows.some(
      (r) => r.selected && isProtectedTarget(r.targetBranch, this._protectedBranches)
    );

    const body = `
      <table>
        <thead>
          <tr>
            <th style="width:30px"></th>
            <th>Repository</th>
            <th>Branch</th>
            <th>Target</th>
            <th>Commits</th>
          </tr>
        </thead>
        <tbody id="rows">${rowsHtml}</tbody>
      </table>
      <a class="edit-all" id="edit-all">Edit all targets</a>

      <div class="overflow">
        <label><input type="checkbox" id="no-verify" ${this._overflow.noVerify ? 'checked' : ''}/> --no-verify</label>
        <label><input type="checkbox" id="push-tags" ${this._overflow.pushTags ? 'checked' : ''}/> Push tags</label>
        <label><input type="radio" name="tag-scope" value="all" ${this._overflow.tagScope === 'all' ? 'checked' : ''}/> all tags</label>
        <label><input type="radio" name="tag-scope" value="follow" ${this._overflow.tagScope === 'follow' ? 'checked' : ''}/> --follow-tags</label>
      </div>

      <div class="actions">
        <button id="cancel-btn" class="secondary" type="button">Cancel</button>
        <select id="action-select" aria-label="Push action">
          <option value="push" ${this._primaryAction === 'push' ? 'selected' : ''}>Push</option>
          <option value="forceWithLease" ${this._primaryAction === 'forceWithLease' ? 'selected' : ''}>Force Push with Lease</option>
          <option value="force" ${this._primaryAction === 'force' ? 'selected' : ''} ${anyProtected ? 'disabled' : ''}>Force Push (Anyway)…</option>
        </select>
        <button id="push-btn" type="button">${escapeHtml(primaryLabel)}</button>
      </div>
    `;

    // Script is returned separately (LOW-1) so `_render()` can splice it into
    // a nonced `<script>` without fragile regex extraction. Contains the
    // SR-5 incremental patch handlers (patchRow / patchOverflow) that replace
    // the old full-rerender path.
    const script = `
      (function() {
        const vscode = acquireVsCodeApi();
        const postRowPatch = (rowId, patch) => {
          vscode.postMessage({ type: 'updateRow', rowId, rowPatch: patch });
        };
        document.getElementById('rows').addEventListener('change', (e) => {
          const el = e.target;
          const rowId = el.getAttribute('data-row-id');
          if (!rowId) return;
          if (el.classList.contains('row-select')) {
            postRowPatch(rowId, { selected: el.checked });
          } else if (el.classList.contains('row-target')) {
            postRowPatch(rowId, { targetBranch: el.value });
          }
        });
        document.getElementById('rows').addEventListener('click', (e) => {
          const el = e.target;
          // LOW-5: e.target on a click inside #rows is always an HTMLElement,
          // which always has getAttribute. Drop the defensive guard.
          const action = el.getAttribute('data-action');
          const rowId = el.getAttribute('data-row-id');
          if (action && rowId) {
            vscode.postMessage({ type: action, rowId });
          }
        });
        document.getElementById('edit-all').addEventListener('click', () => {
          document.querySelectorAll('input.row-target').forEach((inp) => {
            inp.focus();
            inp.select();
          });
        });
        const readOverflow = () => ({
          noVerify: document.getElementById('no-verify').checked,
          pushTags: document.getElementById('push-tags').checked,
          tagScope: document.querySelector('input[name=tag-scope]:checked')?.value === 'all' ? 'all' : 'follow',
        });
        document.querySelectorAll('.overflow input').forEach((inp) => {
          inp.addEventListener('change', () => {
            vscode.postMessage({ type: 'updateOverflow', overflow: readOverflow() });
          });
        });
        document.getElementById('action-select').addEventListener('change', (e) => {
          vscode.postMessage({ type: 'updateOverflow', action: e.target.value });
        });
        document.getElementById('push-btn').addEventListener('click', () => {
          const action = document.getElementById('action-select').value;
          vscode.postMessage({ type: 'submit', action });
        });
        document.getElementById('cancel-btn').addEventListener('click', () => {
          vscode.postMessage({ type: 'cancel' });
        });

        // SR-5: apply incremental host→webview patches. Only derived
        // display state is touched; the user's checkbox / text-input
        // value is left alone so the caret doesn't bounce.
        function applyPrimary(primary) {
          if (!primary) return;
          var btn = document.getElementById('push-btn');
          if (btn) btn.textContent = primary.label;
          var sel = document.getElementById('action-select');
          if (sel) {
            if (sel.value !== primary.action) {
              sel.value = primary.action;
            }
            for (var i = 0; i < sel.options.length; i++) {
              var opt = sel.options[i];
              if (opt.value === 'force') {
                opt.disabled = !!primary.anyProtected;
              }
            }
          }
        }
        window.addEventListener('message', (event) => {
          const msg = event.data;
          if (!msg || typeof msg.type !== 'string') return;
          if (msg.type === 'patchRow' && typeof msg.rowId === 'string') {
            var row = document.querySelector('tr[data-row-id="' + CSS.escape(msg.rowId) + '"]');
            if (row) {
              if (msg.protected) row.setAttribute('data-protected', '1');
              else row.removeAttribute('data-protected');
            }
            applyPrimary(msg.primary);
            return;
          }
          if (msg.type === 'patchOverflow') {
            applyPrimary(msg.primary);
            return;
          }
        });
      })();
    `;

    return { body, script };
  }

  /**
   * Override the base renderer entirely so we emit the interactive script
   * with the CSP nonce. LOW-1: receives body + script as an explicit tuple
   * from `_getBodyParts()` instead of regex-splicing the body.
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

  // ─── Message handling ──────────────────────────────────────────────────────

  protected async _onMessage(raw: unknown): Promise<void> {
    if (this._disposed) {
      return;
    }
    const msg = raw as IPushDialogMessage | undefined;
    if (!msg || typeof msg !== 'object') {
      return;
    }

    // Cancel must flow through even while a push is in flight — it closes the
    // panel (the git push itself isn't cancellable at the CLI layer, so we
    // don't try to abort, just get out of the user's way).
    if (msg.type === 'cancel') {
      this.dispose();
      return;
    }

    // All other actions respect the busy gate to avoid double-fire races.
    if (this._busy) {
      return;
    }

    switch (msg.type) {
      case 'updateRow': {
        if (!msg.rowId || !msg.rowPatch) {
          return;
        }
        this._updateRow(msg.rowId, msg.rowPatch);
        // A target-edit might flip the default primary action (divergence
        // vs. protected state), so recompute.
        this._primaryAction = defaultPrimaryAction(this._rows);
        // SR-5: send an incremental DOM patch rather than a full
        // _render(). Full re-render steals focus mid-edit and drops
        // keystrokes.
        this._patchRow(msg.rowId);
        return;
      }

      case 'updateOverflow': {
        if (msg.overflow) {
          this._overflow = msg.overflow;
        }
        if (msg.action && isPushAction(msg.action)) {
          this._primaryAction = msg.action;
        }
        // SR-5: incremental patch; same rationale as updateRow above. The
        // user's checkbox / radio is already visually toggled by the time
        // this fires — we only need to refresh derived controls (primary
        // button label + force-action option availability).
        this._patchOverflow();
        return;
      }

      case 'pullAndRetry': {
        const row = this._rows.find((r) => r.id === msg.rowId);
        if (!row) {
          return;
        }
        const dialog = this._pullDialogAccessor?.();
        if (!dialog) {
          return;
        }
        // Open Pull dialog pre-filled with this row's remote + branch, then
        // re-queue the push for this row.
        const preset = row.upstreamRemote ? 'merge' : undefined;
        const prefilledSource = row.upstreamRemote
          ? { remote: row.upstreamRemote, branch: row.targetBranch }
          : undefined;
        // Fire-and-forget: Pull dialog drives its own UI. After it closes,
        // the user can click Push again in this dialog.
        void dialog.show(row.repo, preset, prefilledSource).then(() => {
          // Clear the per-row error so the banner goes away; user can retry.
          this._updateRow(row.id, undefined);
          this._render();
        });
        return;
      }

      case 'forceWithLease-row': {
        // User clicked the per-row "Force with Lease" escape hatch. Kick
        // that single row with forceWithLease, leaving other rows alone.
        const row = this._rows.find((r) => r.id === msg.rowId);
        if (!row) {
          return;
        }
        await this._submitRows([row], 'forceWithLease');
        return;
      }

      case 'submit': {
        const action = msg.action && isPushAction(msg.action) ? msg.action : this._primaryAction;
        const selected = this._rows.filter((r) => r.selected);
        if (selected.length === 0) {
          return;
        }
        await this._submitRows(selected, action);
        return;
      }
    }
  }

  private _updateRow(
    rowId: string,
    patch: Partial<Pick<IPushRow, 'selected' | 'targetBranch'>> | undefined
  ): void {
    const i = this._rows.findIndex((r) => r.id === rowId);
    if (i < 0) {
      return;
    }
    if (patch === undefined) {
      // Clear the row's error state but keep selection + target.
      this._rows[i] = { ...this._rows[i], error: undefined };
      return;
    }
    this._rows[i] = { ...this._rows[i], ...patch, error: undefined };
  }

  /**
   * SR-5: compute the derived primary-button payload the webview needs to
   * keep its label + disabled state in sync after an incremental update.
   */
  private _computePrimaryPayload(): {
    action: PushAction;
    label: string;
    anyProtected: boolean;
  } {
    const anyProtected = this._rows.some(
      (r) => r.selected && isProtectedTarget(r.targetBranch, this._protectedBranches)
    );
    return {
      action: this._primaryAction,
      label: primaryButtonLabel(this._primaryAction),
      anyProtected,
    };
  }

  /**
   * SR-5: send an incremental patch for a single row. Only derived display
   * state — data-protected attribute on the row, primary-button label, and
   * Force-Push-Anyway option availability — is included. The user's raw
   * inputs (checkbox, target-branch value) are NOT echoed back so we don't
   * fight the caret mid-edit.
   */
  private _patchRow(rowId: string): void {
    const row = this._rows.find((r) => r.id === rowId);
    if (!row) {
      return;
    }
    const payload: IPushDialogPatchRow = {
      type: 'patchRow',
      rowId,
      protected: isProtectedTarget(row.targetBranch, this._protectedBranches),
      primary: this._computePrimaryPayload(),
    };
    void this._panel.webview.postMessage(payload);
  }

  /**
   * SR-5: send an incremental patch after an overflow-checkbox / force-
   * action-select change. Updates just the primary-button label + select
   * availability.
   */
  private _patchOverflow(): void {
    const payload: IPushDialogPatchOverflow = {
      type: 'patchOverflow',
      primary: this._computePrimaryPayload(),
    };
    void this._panel.webview.postMessage(payload);
  }

  private async _submitRows(rows: ReadonlyArray<IPushRow>, action: PushAction): Promise<void> {
    this._busy = true;
    try {
      const deps: IRunPushRowDeps = {
        gitService: this._gitService,
        protectedBranches: this._protectedBranches,
      };
      const results = await Promise.all(
        rows.map((r) => runPushRow(deps, r, action, this._overflow))
      );
      let anySuccess = false;
      let anyFailure = false;
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const row = rows[i];
        const idx = this._rows.findIndex((r) => r.id === row.id);
        if (idx < 0) {
          continue;
        }
        if (result.ok) {
          anySuccess = true;
          // Clear any previous error state.
          this._rows[idx] = { ...this._rows[idx], error: undefined };
        } else {
          anyFailure = true;
          this._rows[idx] = { ...this._rows[idx], error: result.error };
        }
      }
      this._render();

      if (anySuccess && !anyFailure) {
        // All rows settled successfully — toast, fire callback, dispose.
        void vscode.window.showInformationMessage(
          rows.length === 1
            ? `Pushed '${rows[0].localBranch}'`
            : `Pushed ${rows.length} repositories`
        );
        if (this._onPushComplete) {
          try {
            this._onPushComplete();
          } catch (err) {
            console.error('PushDialog: onPushComplete callback threw:', err);
          }
        }
        this.dispose();
      }
      // On any failure: leave dialog open, per-row banners render, user can retry.
    } finally {
      this._busy = false;
    }
  }
}

// ─── Factory + entry-point sugar ─────────────────────────────────────────────

/**
 * Entry point used by `intellig.push` and branch.push. Gathers context
 * (repos, protected branches, pull dialog accessor) and constructs the
 * dialog. Returns the instance so callers can `dispose()` it early if
 * needed.
 */
export function showPushDialog(
  context: vscode.ExtensionContext,
  options: IPushDialogOptions
): PushDialog {
  return new PushDialog(context, options);
}

/**
 * Returns true if `x` is a valid {@link PushAction}.
 */
function isPushAction(x: unknown): x is PushAction {
  return x === 'push' || x === 'forceWithLease' || x === 'force';
}

function basename(fsPath: string): string {
  const parts = fsPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? fsPath;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
