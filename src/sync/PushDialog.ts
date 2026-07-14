/**
 * Push Dialog.
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
import { assertNever } from '../utils/assertNever';
import {
  asPushDialogInbound,
  type PushAction,
  type IPushOverflowState,
  type PushDialogOutbound,
} from './pushDialog.protocol';
export type { PushAction, IPushOverflowState } from './pushDialog.protocol';
import { sanitizeGitError } from '../git-core/gitError';
import {
  IGitService,
  IPushOptions,
  IRepository,
  IUpstream,
} from '../git-core/interfaces/IGitService';
import type { PullDialog } from './PullDialog';
import { getLogger } from '../utils/logger';
import { escapeHtml } from '../utils/escapeHtml';

// ─── Action + state types ────────────────────────────────────────────────────
// PushAction + IPushOverflowState are the wire data types; they live in
// pushDialog.protocol (vscode-free) and are re-exported above.

/**
 * Initial gear-overflow state. `tagScope` defaults to 'all' (--tags) to match
 * git4idea, whose tag-mode combo defaults to ALL: --follow-tags silently drops
 * lightweight and unreachable tags, so it's a surprising default for "Push tags".
 */
export const DEFAULT_PUSH_OVERFLOW: IPushOverflowState = {
  noVerify: false,
  pushTags: false,
  tagScope: 'all',
};

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
 * list that destructive reset modes use.
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
 * spec section 4, when the selected branch has local divergence from its upstream
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
 * Human-facing label for the primary button. Extracted as a pure
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
 * same character set git refs normally accept. `:` is excluded — it is the
 * refspec half-separator (`local:remote`), never valid inside a single branch
 * name (git-check-ref-format rejects it), so allowing it here would let `a:b`
 * expand the spec to `local:a:b`.
 */
export function isValidPushRef(name: string): boolean {
  return /^(?![-.])[A-Za-z0-9_./@~^-]+$/.test(name);
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

  // `buildPushOptions` throws on invalid ref names.
  // Catch and surface as a row error so the dialog doesn't unmount.
  let options: IPushOptions;
  try {
    options = buildPushOptions(row, action, overflow);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: { kind: 'other', message } };
  }
  try {
    await deps.gitService.push(row.repo, options).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    return { ok: true };
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'Unknown error';
    // Scrub any `user:token@host` credentials leaked by git stderr before the
    // error lands in a row banner / toast.
    const message = sanitizeGitError(raw);
    return { ok: false, error: { kind: classifyPushError(raw), message } };
  }
}

// ─── Rejected-push update loop (GitPushOperation parity) ─────────────────────

/**
 * Push-attempt ceiling per submit, matching IntelliJ
 * `GitPushOperation.MAX_PUSH_ATTEMPTS`: a busy remote can keep advancing
 * between updates, so the update→push cycle repeats — but never unbounded.
 */
export const MAX_PUSH_ATTEMPTS = 10;

/** Seams for {@link updateAndRetryRejectedRows}. */
export interface IUpdateRetryDeps {
  /** Re-run the push for one row (same action/overflow as the submit). */
  pushRow: (row: IPushRow) => Promise<IPushRowResult>;
  /** Pull the row's repo with the chosen method; `message` on failure. */
  pull: (row: IPushRow, method: 'merge' | 'rebase') => Promise<{ ok: boolean; message?: string }>;
  /**
   * IntelliJ's GitRejectedPushUpdateDialog: Merge / Rebase / Cancel
   * (`undefined`). Asked ONCE per submit; the choice drives every
   * subsequent update in the loop.
   */
  askUpdateMethod: (rejected: ReadonlyArray<IPushRow>) => Promise<'merge' | 'rebase' | undefined>;
}

/**
 * IntelliJ `GitPushOperation`'s update-and-retry cycle for rows whose first
 * push was rejected non-fast-forward: ask Merge/Rebase once, then per row
 * pull → re-push, repeating while the remote keeps rejecting, capped at
 * {@link MAX_PUSH_ATTEMPTS} total pushes. A failed update (e.g. conflicts —
 * which the conflict watcher surfaces separately) parks the row with the
 * update error; any non-non-ff push failure ends that row's loop.
 */
export async function updateAndRetryRejectedRows(
  deps: IUpdateRetryDeps,
  rejectedRows: ReadonlyArray<IPushRow>
): Promise<Map<string, IPushRowResult>> {
  const results = new Map<string, IPushRowResult>(
    rejectedRows.map((r) => [r.id, { ok: false, error: r.error } as IPushRowResult])
  );

  const method = await deps.askUpdateMethod(rejectedRows);
  if (!method) {
    return results;
  }

  let remaining = [...rejectedRows];
  // The submit's own push was attempt 1; the loop owns attempts 2..MAX.
  for (let attempt = 2; attempt <= MAX_PUSH_ATTEMPTS && remaining.length > 0; attempt++) {
    const stillRejected: IPushRow[] = [];
    for (const row of remaining) {
      const update = await deps.pull(row, method);
      if (!update.ok) {
        results.set(row.id, {
          ok: false,
          error: {
            kind: 'other',
            message: `Update before push failed: ${update.message ?? 'unknown error'}`,
          },
        });
        continue;
      }
      const result = await deps.pushRow(row);
      results.set(row.id, result);
      if (!result.ok && result.error?.kind === 'rejected-non-ff') {
        stillRejected.push(row);
      }
    }
    remaining = stillRejected;
  }
  return results;
}

// ─── Dialog options + messages ───────────────────────────────────────────────

/**
 * A single repo/branch to pre-select when the dialog is opened from a specific
 * context (e.g. right-click Push on a branch row). `branch` names the clicked
 * local ref; `upstream` carries that ref's OWN tracking so a non-HEAD branch
 * keeps its remote instead of being forced to --set-upstream (issue #19).
 */
export interface IPushPreselect {
  repo: IRepository;
  branch?: string;
  upstream?: IUpstream;
  /**
   * The clicked branch's OWN ahead/behind vs its upstream. Used so a
   * non-HEAD preselected row shows the branch's divergence (and the
   * force-with-lease auto-flip fires) instead of HEAD's counts (issue #19b).
   */
  ahead?: number;
  behind?: number;
}

/** Options for constructing a {@link PushDialog}. */
export interface IPushDialogOptions {
  /** The repositories to offer in the row table. */
  repos: ReadonlyArray<IRepository>;
  /** Optional single repo / branch to preselect; all other rows unselected. */
  preselect?: IPushPreselect;
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

// Wire shapes (inbound union + incremental-patch outbound) live in
// pushDialog.protocol.ts. The outbound patches are targeted DOM updates rather
// than a full `_render()`, which would wipe input focus + mid-word keystrokes;
// they deliberately do NOT echo the user's edited targetBranch / selected /
// overflow values back (the touched input already reflects them).

const VIEW_TYPE = 'intellig.pushDialog';
const TITLE = 'Push Commits to Remote';

// ─── PushDialog class ────────────────────────────────────────────────────────

export class PushDialog extends BaseWebviewPanel<PushDialogOutbound> {
  private readonly _gitService: IGitService;
  private readonly _protectedBranches: ReadonlyArray<string>;
  private readonly _pullDialogAccessor?: () => PullDialog | undefined;
  private readonly _onPushComplete?: () => void;
  private _rows: IPushRow[] = [];
  private _overflow: IPushOverflowState = { ...DEFAULT_PUSH_OVERFLOW };
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

  private _populateRows(repos: ReadonlyArray<IRepository>, preselect?: IPushPreselect): void {
    const rows: IPushRow[] = [];
    for (const repo of repos) {
      const headBranch = repo.head?.name?.replace(/^refs\/heads\//, '') ?? '';
      const upstream = repo.head?.upstream;
      const selected = !preselect || preselect.repo.rootUri.fsPath === repo.rootUri.fsPath;

      // When the user right-clicks a specific branch (preselect.branch on the
      // selected row), that clicked branch is the SOLE source of the pushed
      // local ref — never the resolved repo's current HEAD. Seeding from
      // `repo.head` here would ship HEAD's commits to the clicked branch's
      // remote ref (a destructive cross-ref push when HEAD ≠ the clicked
      // branch). When the clicked branch IS the current HEAD we use HEAD's
      // upstream; otherwise we use the clicked branch's OWN upstream threaded
      // in via `preselect.upstream` so an already-tracking branch
      // keeps its remote instead of being forced to --set-upstream against the
      // fallback. A clicked branch with no upstream still falls through to a
      // new-upstream push (target = branch itself).
      const isPreselectedBranchRow = Boolean(preselect?.branch) && selected;
      const localBranch = isPreselectedBranchRow ? preselect!.branch! : headBranch;
      const clickedIsHead = isPreselectedBranchRow && localBranch === headBranch;
      const rowUpstream = !isPreselectedBranchRow || clickedIsHead ? upstream : preselect?.upstream;
      const targetBranch = rowUpstream?.name ?? localBranch;

      // A clicked non-HEAD branch reports its OWN divergence (threaded via
      // preselect), not the resolved HEAD's — otherwise a diverged non-HEAD
      // branch shows 0/0 and the force-with-lease auto-flip never fires.
      const fromClickedBranch = isPreselectedBranchRow && !clickedIsHead;
      const ahead = fromClickedBranch ? (preselect?.ahead ?? 0) : (repo.head?.ahead ?? 0);
      const behind = fromClickedBranch ? (preselect?.behind ?? 0) : (repo.head?.behind ?? 0);

      rows.push({
        id: repo.rootUri.fsPath,
        selected,
        repo,
        repoLabel: basename(repo.rootUri.fsPath),
        localBranch,
        targetBranch,
        upstreamRemote: rowUpstream?.remote,
        ahead,
        behind,
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
      .overflow label {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .overflow input[type=checkbox] {
        margin: 0;
      }
      .tags-group {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .hint {
        color: var(--vscode-descriptionForeground);
        font-size: 0.85em;
        margin: -4px 0 12px;
        min-height: 1.1em;
      }
      select {
        font-family: inherit;
        font-size: inherit;
        padding: 3px 6px;
        background: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
        border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
      }
      select:disabled { opacity: 0.55; cursor: not-allowed; }
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
   * regex extraction (nested `</script>` inside any future string
   * literal would break the old regex).
   */
  private _getBodyParts(): { body: string; script: string } {
    // Body ships an empty root; the script builds the table, overflow options,
    // and action bar via document.createElement. Host data crosses as a JSON
    // init island and reaches the DOM via .value / .textContent / element props
    // (injection-proof) — never markup.
    const body = `<div id="root"></div>`;

    const anyProtected = this._rows.some(
      (r) => r.selected && isProtectedTarget(r.targetBranch, this._protectedBranches)
    );
    const initJson = JSON.stringify({
      empty: this._rows.length === 0,
      rows: this._rows.map((r) => ({
        id: r.id,
        repoLabel: r.repoLabel,
        localBranch: r.localBranch,
        targetBranch: r.targetBranch,
        ahead: r.ahead,
        selected: r.selected,
        protected: isProtectedTarget(r.targetBranch, this._protectedBranches),
        error: r.error ? { message: r.error.message, kind: r.error.kind } : null,
      })),
      primaryAction: this._primaryAction,
      primaryLabel: primaryButtonLabel(this._primaryAction),
      anyProtected,
      overflow: {
        noVerify: this._overflow.noVerify,
        pushTags: this._overflow.pushTags,
        tagScope: this._overflow.tagScope,
      },
    }).replace(/</g, '\\u003c');

    // Script is returned separately so `_render()` can splice it into
    // a nonced `<script>` without fragile regex extraction. Builds the body
    // via createElement, then wires events + the incremental patch handlers
    // (patchRow / patchOverflow) that replace the old full-rerender path.
    const script = `
      (function() {
        const vscode = acquireVsCodeApi();
        const INIT = ${initJson};
        const el = (tag, props) => Object.assign(document.createElement(tag), props || {});
        const root = document.getElementById('root');

        if (INIT.empty) {
          root.append(el('div', { textContent: 'Loading repositories…' }));
          return;
        }

        // ── Repository table ───────────────────────────────────────────────
        const table = el('table');
        const thead = el('thead');
        const headRow = el('tr');
        const th0 = el('th');
        th0.setAttribute('style', 'width:30px');
        headRow.append(
          th0,
          el('th', { textContent: 'Repository' }),
          el('th', { textContent: 'Branch' }),
          el('th', { textContent: 'Target' }),
          el('th', { textContent: 'Commits' })
        );
        thead.append(headRow);
        const tbody = el('tbody', { id: 'rows' });
        for (const r of INIT.rows) {
          const tr = el('tr');
          tr.setAttribute('data-row-id', r.id);
          if (r.protected) tr.setAttribute('data-protected', '1');
          const c0 = el('td');
          const cb = el('input', { type: 'checkbox', className: 'row-select' });
          cb.checked = r.selected;
          cb.setAttribute('data-row-id', r.id);
          c0.append(cb);
          const c3 = el('td');
          const ti = el('input', { type: 'text', className: 'row-target', value: r.targetBranch });
          ti.setAttribute('data-row-id', r.id);
          c3.append(ti);
          const c4 = el('td');
          c4.append(el('span', { className: 'badge', textContent: r.ahead === 0 ? 'up to date' : String(r.ahead) }));
          tr.append(c0, el('td', { textContent: r.repoLabel }), el('td', { textContent: r.localBranch }), c3, c4);
          tbody.append(tr);
          if (r.error) {
            const er = el('tr', { className: 'row-error' });
            er.setAttribute('data-row-id', r.id);
            const td = el('td');
            td.setAttribute('colspan', '5');
            td.append('⚠ ' + r.error.message + ' ');
            if (r.error.kind === 'rejected-non-ff') {
              const b1 = el('button', { textContent: 'Pull and Retry…' });
              b1.setAttribute('data-action', 'pullAndRetry');
              b1.setAttribute('data-row-id', r.id);
              const b2 = el('button', { textContent: 'Force with Lease' });
              b2.setAttribute('data-action', 'forceWithLease-row');
              b2.setAttribute('data-row-id', r.id);
              td.append(b1, ' ', b2);
            }
            er.append(td);
            tbody.append(er);
          }
        }
        table.append(thead, tbody);
        root.append(table);

        root.append(el('a', { className: 'edit-all', id: 'edit-all', textContent: 'Edit all targets' }));

        // ── Overflow options ───────────────────────────────────────────────
        const overflow = el('div', { className: 'overflow' });
        const labelled = (input, text) => {
          const l = el('label');
          l.append(input, text);
          return l;
        };
        const HINTS = {
          noVerify: 'Skip the pre-push git hook (--no-verify).',
          all: 'All tags: pushes every local tag to the remote — both lightweight tags (plain "git tag") and annotated ones — no matter which branch they sit on.',
          follow: 'Follow tags: pushes only annotated tags (made with a message, like release tags) that sit on the commits you are pushing. Plain lightweight tags are left behind — use "All tags" to include them.',
        };
        const noVerify = el('input', { type: 'checkbox', id: 'no-verify' });
        noVerify.checked = INIT.overflow.noVerify;
        const pushTags = el('input', { type: 'checkbox', id: 'push-tags' });
        pushTags.checked = INIT.overflow.pushTags;
        // The scope is a sub-choice of "Push tags": a dropdown enabled only when
        // the box is checked (git4idea's checkbox + combo layout).
        const tagScope = el('select', { id: 'tag-scope' });
        tagScope.setAttribute('aria-label', 'Tag scope');
        const tagAll = el('option', { value: 'all', textContent: 'All tags' });
        tagAll.selected = INIT.overflow.tagScope === 'all';
        const tagFollow = el('option', { value: 'follow', textContent: 'Follow tags' });
        tagFollow.selected = INIT.overflow.tagScope === 'follow';
        tagScope.append(tagAll, tagFollow);
        tagScope.disabled = !INIT.overflow.pushTags;
        const tagsGroup = el('span', { className: 'tags-group' });
        tagsGroup.append(labelled(pushTags, 'Push tags'), tagScope);
        overflow.append(labelled(noVerify, '--no-verify'), tagsGroup);
        root.append(overflow);
        // Always-visible explanation of the enabled options: the --no-verify line
        // when it is checked, and the current tag-scope line while Push tags is on.
        const tagHint = el('div', { id: 'tag-hint', className: 'hint' });
        root.append(tagHint);
        const updateHint = () => {
          const parts = [];
          if (noVerify.checked) parts.push(HINTS.noVerify);
          if (pushTags.checked) parts.push(tagScope.value === 'follow' ? HINTS.follow : HINTS.all);
          tagHint.textContent = parts.join(' ');
        };
        updateHint();

        // ── Action bar ─────────────────────────────────────────────────────
        const actionsBar = el('div', { className: 'actions' });
        const cancelBtn = el('button', { id: 'cancel-btn', className: 'secondary', type: 'button', textContent: 'Cancel' });
        const actionSelect = el('select', { id: 'action-select' });
        actionSelect.setAttribute('aria-label', 'Push action');
        const optPush = el('option', { value: 'push', textContent: 'Push' });
        optPush.selected = INIT.primaryAction === 'push';
        const optLease = el('option', { value: 'forceWithLease', textContent: 'Force Push with Lease' });
        optLease.selected = INIT.primaryAction === 'forceWithLease';
        const optForce = el('option', { value: 'force', textContent: 'Force Push (Anyway)…' });
        optForce.selected = INIT.primaryAction === 'force';
        optForce.disabled = INIT.anyProtected;
        actionSelect.append(optPush, optLease, optForce);
        const pushBtn = el('button', { id: 'push-btn', type: 'button', textContent: INIT.primaryLabel });
        actionsBar.append(cancelBtn, actionSelect, pushBtn);
        root.append(actionsBar);

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
          // e.target on a click inside #rows is always an HTMLElement,
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
          tagScope: document.getElementById('tag-scope').value === 'all' ? 'all' : 'follow',
        });
        const syncTagScopeEnabled = () => {
          document.getElementById('tag-scope').disabled = !document.getElementById('push-tags').checked;
        };
        document.querySelectorAll('.overflow input, .overflow select').forEach((inp) => {
          inp.addEventListener('change', () => {
            syncTagScopeEnabled();
            updateHint();
            vscode.postMessage({ type: 'updateOverflow', overflow: readOverflow() });
          });
        });
        document.getElementById('action-select').addEventListener('change', (e) => {
          vscode.postMessage({ type: 'updateOverflow', action: e.target.value });
        });
        const submit = () => {
          const action = document.getElementById('action-select').value;
          vscode.postMessage({ type: 'submit', action });
        };
        const cancel = () => {
          vscode.postMessage({ type: 'cancel' });
        };
        document.getElementById('push-btn').addEventListener('click', submit);
        document.getElementById('cancel-btn').addEventListener('click', cancel);

        // Dialog keyboard contract (spec 5.1 — shared across all dialogs):
        //   Cmd+Enter / Ctrl+Enter → primary action (Push)
        //   Esc                    → cancel
        // Plain Enter inside a row's target-branch text input is left to the
        // browser default so it doesn't submit mid-edit.
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        });

        // Apply incremental host→webview patches. Only derived
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
   * with the CSP nonce. Receives body + script as an explicit tuple
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
    const msg = asPushDialogInbound(raw);
    if (!msg) {
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
        // Send an incremental DOM patch rather than a full
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
        // Incremental patch; same rationale as updateRow above. The
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
      default:
        assertNever(msg);
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
   * Compute the derived primary-button payload the webview needs to
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
   * Send an incremental patch for a single row. Only derived display
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
    const payload: PushDialogOutbound = {
      type: 'patchRow',
      rowId,
      protected: isProtectedTarget(row.targetBranch, this._protectedBranches),
      primary: this._computePrimaryPayload(),
    };
    void this.postMessage(payload);
  }

  /**
   * Send an incremental patch after an overflow-checkbox / force-
   * action-select change. Updates just the primary-button label + select
   * availability.
   */
  private _patchOverflow(): void {
    const payload: PushDialogOutbound = {
      type: 'patchOverflow',
      primary: this._computePrimaryPayload(),
    };
    void this.postMessage(payload);
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

      // GitPushOperation parity: a plain push rejected non-fast-forward gets
      // the Merge/Rebase update-and-retry loop instead of a dead-end banner.
      // Force pushes never loop — the user already chose to overwrite.
      if (action === 'push') {
        const rejected = rows.filter(
          (_row, i) => !results[i].ok && results[i].error?.kind === 'rejected-non-ff'
        );
        if (rejected.length > 0) {
          const rejectedWithError = rejected.map((row) => ({
            ...row,
            error: results[rows.indexOf(row)].error,
          }));
          const finalById = await updateAndRetryRejectedRows(
            {
              pushRow: (row) => runPushRow(deps, row, action, this._overflow),
              pull: async (row, method) =>
                this._gitService
                  .pull(row.repo, { rebase: method === 'rebase', autostash: true })
                  .match(
                    () => ({ ok: true }),
                    (e) => ({ ok: false, message: sanitizeGitError(e.message) })
                  ),
              askUpdateMethod: async (stillRejected) => {
                const branches = [...new Set(stillRejected.map((r) => `'${r.localBranch}'`))].join(
                  ', '
                );
                const choice = await vscode.window.showWarningMessage(
                  `Push of ${branches} was rejected: the remote has changes you do not have yet. Update the branch and push again?`,
                  { modal: true },
                  'Merge',
                  'Rebase'
                );
                return choice === 'Merge' ? 'merge' : choice === 'Rebase' ? 'rebase' : undefined;
              },
            },
            rejectedWithError
          );
          for (let i = 0; i < rows.length; i++) {
            const final = finalById.get(rows[i].id);
            if (final) {
              results[i] = final;
            }
          }
        }
      }

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
            getLogger()
              .child({ component: 'PushDialog' })
              .error('onPushComplete callback threw', err instanceof Error ? err : undefined);
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
