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
 *   - Targets matching `intellig.protectedBranches` prohibit BOTH force
 *     flavors (bare --force and --force-with-lease), matching IntelliJ's
 *     GitPushSupport.isForcePushAllowed, where force-with-lease IS the force
 *     push. Only a plain push can reach a protected target.
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
  type PushErrorKind,
  type IPushOverflowState,
  type IPushDialogInit,
  type PushDialogOutbound,
} from './pushDialog.protocol';
export type { PushAction, PushErrorKind, IPushOverflowState } from './pushDialog.protocol';
import { initIslandHtml } from '../utils/webviewInit';
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

/**
 * Revision push source for a row: push this exact commit instead of the
 * local branch tip — GitPushSource.createRef / createDetached. `detached`
 * means no local branch contains the commit; the row then has no local
 * branch and pushes the raw hash onto whatever target the user confirms.
 */
export interface IPushRowSource {
  /** Hash of the commit to push (full or unique-prefix). */
  hash: string;
  /** True when no local branch contains the commit. */
  detached: boolean;
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
  /** When set, the row pushes this exact commit, not the branch tip. */
  pushSource?: IPushRowSource;
  /**
   * Per-row error state, if the last push attempt failed. Used to render the
   * inline row banner and offer "Pull and Retry" / "Force with Lease".
   */
  error?: IPushRowError;
}

/** Row-level push error for rendering retry affordances. */
export interface IPushRowError {
  kind: PushErrorKind;
  /**
   * A classified, user-facing one-liner (`pushErrorBannerMessage`), not raw
   * git output — the row banner is a UI surface, and the full stderr goes to
   * the log instead.
   */
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
  if (/\(stale info\)/.test(msg)) {
    // A force-with-lease refused because the remote moved after the last
    // fetch (reference result type REJECTED_STALE_INFO).
    return 'rejected-stale-lease';
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
 * Row-banner text for a failed push. A classified failure gets a one-liner
 * naming the target — matching IntelliJ's push notifications
 * (`push.notification.description.rejected.by.remote`,
 * `push.rejected.merge.needed`, `push.failed.error.message` in
 * git4idea GitBundle.properties) — because the banner also carries the retry
 * affordances the user must still see. The raw git output goes to the log, never
 * the UI; only an unclassified failure falls back to it (sanitized).
 */
export function pushErrorBannerMessage(
  kind: PushErrorKind,
  sanitized: string,
  targetBranch: string
): string {
  switch (kind) {
    case 'rejected-non-ff':
      return (
        `Push to '${targetBranch}' was rejected: the remote has commits you don't have. ` +
        'Remote changes need to be merged before pushing.'
      );
    case 'rejected-stale-lease':
      return `Force push with lease to '${targetBranch}' was rejected: the remote was updated after your last fetch.`;
    case 'rejected-protected':
      return `Push to '${targetBranch}' was rejected: the remote protects that branch.`;
    case 'auth':
      return 'Push failed: the remote rejected your credentials.';
    case 'hook':
      return 'Push failed: the pre-push hook rejected the push.';
    case 'other':
    default:
      return sanitized;
  }
}

/**
 * Pick the default primary action based on divergence state. Per design
 * spec section 4, when the selected branch has local divergence from its upstream
 * (ahead > 0 AND behind > 0), flip the default from `push` to
 * `forceWithLease` so the user's muscle-memory "Enter" stays safe.
 *
 * A diverged row whose target is protected never triggers the flip: force
 * pushes (both flavors) are prohibited on protected targets, so arming one
 * behind the Enter key would either rewrite the protected branch or dead-end
 * on the guard.
 */
export function defaultPrimaryAction(
  rows: ReadonlyArray<IPushRow>,
  protectedBranches: ReadonlyArray<string> = []
): PushAction {
  const selected = rows.filter((r) => r.selected);
  if (selected.length === 0) {
    return 'push';
  }
  const anyDiverged = selected.some(
    (r) => r.ahead > 0 && r.behind > 0 && !isProtectedTarget(r.targetBranch, protectedBranches)
  );
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
 *   Never for a revision source — a pushed hash is not a branch ref, so
 *   there is nothing to track (GitPushTarget.shouldSetUpstream).
 * - Computes a `refspec` only when the target differs from the local branch
 *   (so the common case stays `git push <remote> <branch>`). A revision
 *   source always pushes `<hash>:refs/heads/<target>` — the full ref name,
 *   since git cannot infer a ref kind from a raw hash
 *   (GitPushOperation.createPushSpec).
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
  // Security: refuse up-front if a ref/hash could be parsed by git as a CLI
  // flag. `git push <remote> -foo` treats `-foo` as `-f oo`; same for
  // refspec halves. Matches validateTagName / isValidRef policy.
  const source = row.pushSource;
  if (source) {
    if (!isValidPushHash(source.hash)) {
      throw new Error(`Invalid commit hash '${source.hash}'`);
    }
    if (!row.targetBranch) {
      throw new Error('A commit push needs a target branch name');
    }
  } else if (!isValidPushRef(row.localBranch)) {
    throw new Error(`Invalid local branch '${row.localBranch}': cannot start with '-' or '.'`);
  }
  if (row.targetBranch && !isValidPushRef(row.targetBranch)) {
    throw new Error(`Invalid target branch '${row.targetBranch}': cannot start with '-' or '.'`);
  }

  const remote = row.upstreamRemote ?? fallbackRemote;
  const opts: IPushOptions = {
    remote,
  };

  if (!source) {
    opts.branch = row.localBranch;
    if (!row.upstreamRemote) {
      opts.setUpstream = true;
    }
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

  if (source) {
    const targetRef = row.targetBranch.startsWith('refs/')
      ? row.targetBranch
      : `refs/heads/${row.targetBranch}`;
    opts.refspec = `${source.hash}:${targetRef}`;
  } else if (row.targetBranch && row.targetBranch !== row.localBranch) {
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
 * Security guard for a revision push source: hex only (full hash or unique
 * prefix), so it can never be parsed as a CLI flag or expand the refspec.
 */
export function isValidPushHash(hash: string): boolean {
  return /^[0-9a-f]{4,64}$/i.test(hash);
}

/**
 * Guard: is this primary action permitted for the row given the protected list?
 * Both force flavors are blocked on protected targets (IntelliJ
 * GitPushSupport.isForcePushAllowed disables the force-push action entirely,
 * and force-with-lease is just its lease-checked variant); plain push passes.
 */
export function isActionAllowedForRow(
  row: IPushRow,
  action: PushAction,
  protectedBranches: ReadonlyArray<string>
): boolean {
  if (
    (action === 'force' || action === 'forceWithLease') &&
    isProtectedTarget(row.targetBranch, protectedBranches)
  ) {
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
        message: `'${row.targetBranch}' is a protected branch — force pushes (with or without lease) are blocked locally. Remove it from intellig.protectedBranches to enable.`,
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
    // error lands in the log, a row banner, or a toast.
    const sanitized = sanitizeGitError(raw);
    const kind = classifyPushError(raw);
    getLogger()
      .child({ component: 'PushDialog' })
      .warn('push failed', { kind, target: row.targetBranch, detail: sanitized });
    return {
      ok: false,
      error: { kind, message: pushErrorBannerMessage(kind, sanitized, row.targetBranch) },
    };
  }
}

// ─── Rejected-push update loop (GitPushOperation parity) ─────────────────────

/**
 * Push-attempt ceiling per submit, matching IntelliJ
 * `GitPushOperation.MAX_PUSH_ATTEMPTS`: a busy remote can keep advancing
 * between updates, so the update→push cycle repeats — but never unbounded.
 */
export const MAX_PUSH_ATTEMPTS = 10;

/**
 * Gate for the rejected-push update proposal, mirroring IntelliJ
 * `GitPushOperation`'s break conditions: the update leg integrates the
 * CURRENT branch from its tracked upstream, so proposing Merge/Rebase is only
 * meaningful when every rejected push was the current branch onto that
 * branch's own tracked target. A rejected push of a non-checked-out branch
 * (`pushingNotCurrentBranch`), to an edited/non-tracked target
 * (`pushingToNotTrackedBranch`), or of a branch with no upstream surfaces
 * as-is instead — updating would pull into a branch the user never asked to
 * touch. (Force pushes never reach this check; the caller only loops plain
 * pushes.)
 *
 * Revision rows (push-up-to-here) never enter the loop: an update moves the
 * branch tip but the row's hash is FIXED, so a re-push would still be
 * rejected — or worse, ff-move the remote to a commit the user never chose.
 * The reference gates its re-pushable HEAD^n variant behind a registry flag
 * for the same reason.
 */
export function shouldProposeUpdateForRejected(rejected: ReadonlyArray<IPushRow>): boolean {
  return (
    rejected.length > 0 &&
    rejected.every((row) => {
      if (row.pushSource) {
        return false;
      }
      const head = row.repo.head;
      const currentBranch = head?.name?.replace(/^refs\/heads\//, '');
      if (!currentBranch || row.localBranch !== currentBranch) {
        return false;
      }
      const upstream = head?.upstream;
      if (!upstream) {
        return false;
      }
      return row.targetBranch === upstream.name && row.upstreamRemote === upstream.remote;
    })
  );
}

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
  /**
   * Revision push source (push-up-to-here): the selected row pushes this
   * exact commit. With `detached: false`, `branch` names the containing
   * local branch; with `detached: true` no local branch contains it and the
   * row has no local branch at all.
   */
  pushSource?: IPushRowSource;
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
      this._primaryAction = defaultPrimaryAction(this._rows, this._protectedBranches);
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
      let localBranch = isPreselectedBranchRow ? preselect!.branch! : headBranch;
      const clickedIsHead = isPreselectedBranchRow && localBranch === headBranch;
      let rowUpstream = !isPreselectedBranchRow || clickedIsHead ? upstream : preselect?.upstream;
      let targetBranch = rowUpstream?.name ?? localBranch;

      // A revision source (push-up-to-here) pushes an exact commit, not a
      // branch tip. A detached source has no local branch at all; its target
      // defaults to the current branch name, else a fresh "detached" ref
      // (GitPushSupport.getDefaultTarget for a branchless source).
      const pushSource = selected ? preselect?.pushSource : undefined;
      if (pushSource?.detached) {
        localBranch = '';
        rowUpstream = preselect?.upstream;
        targetBranch = rowUpstream?.name ?? (headBranch || 'detached');
      }

      // A clicked non-HEAD branch reports its OWN divergence (threaded via
      // preselect), not the resolved HEAD's — otherwise a diverged non-HEAD
      // branch shows 0/0 and the force-with-lease auto-flip never fires. A
      // revision row's counts are ALWAYS the hash's own (even on HEAD, an
      // older commit pushes fewer commits than the tip).
      const fromClickedBranch = (isPreselectedBranchRow && !clickedIsHead) || Boolean(pushSource);
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
        ...(pushSource ? { pushSource } : {}),
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
    const anyProtected = this._rows.some(
      (r) => r.selected && isProtectedTarget(r.targetBranch, this._protectedBranches)
    );
    const init: IPushDialogInit = {
      empty: this._rows.length === 0,
      rows: this._rows.map((r) => ({
        id: r.id,
        repoLabel: r.repoLabel,
        localBranch: r.localBranch,
        targetBranch: r.targetBranch,
        ahead: r.ahead,
        selected: r.selected,
        protected: isProtectedTarget(r.targetBranch, this._protectedBranches),
        sourceHash: r.pushSource?.hash ?? null,
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
    };
    return `<div id="root"></div>${initIslandHtml(init)}`;
  }

  /**
   * Override the base renderer so the body ships with an EXTERNAL bundle tag
   * (media/webview/pushDialog.js) instead of the base's empty sentinel. The
   * interactive logic lives in the bundled entry (src/sync/webview/pushDialog.ts),
   * which reads its init from the body island and applies host patchRow/
   * patchOverflow patches.
   */
  protected override _render(): void {
    if (this._disposed) {
      return;
    }

    const nonce = this._getNonce();
    const csp = this._buildCsp(nonce);
    const styles = this._getStyles();
    const styleBlock = styles.length > 0 ? `<style>${styles}</style>` : '';
    const bundleUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'webview', 'pushDialog.js')
    );

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
${this._getBodyHtml()}
<script nonce="${nonce}" src="${bundleUri.toString()}"></script>
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
        this._primaryAction = defaultPrimaryAction(this._rows, this._protectedBranches);
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
        // A revision row never updates-and-retries: its hash is fixed, so a
        // pull cannot make it pushable (the webview hides the affordance;
        // this guards a stale DOM).
        if (!row || row.pushSource) {
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

      case 'forceAnyway-row': {
        // Follow-up to a stale-lease rejection: re-run with plain force for
        // exactly this row (GitPushOperation.deriveForceWithoutLease). The
        // protected guard in runPushRow still applies.
        const row = this._rows.find((r) => r.id === msg.rowId);
        if (!row) {
          return;
        }
        await this._submitRows([row], 'force');
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
      // Force pushes never loop — the user already chose to overwrite — and
      // the proposal is further gated on every rejected row being the current
      // branch pushed to its tracked target (see shouldProposeUpdateForRejected).
      if (action === 'push') {
        const rejected = rows.filter(
          (_row, i) => !results[i].ok && results[i].error?.kind === 'rejected-non-ff'
        );
        if (rejected.length > 0 && shouldProposeUpdateForRejected(rejected)) {
          const rejectedWithError = rejected.map((row) => ({
            ...row,
            error: results[rows.indexOf(row)].error,
          }));
          const finalById = await updateAndRetryRejectedRows(
            {
              pushRow: (row) => runPushRow(deps, row, action, this._overflow),
              pull: async (row, method) =>
                this._gitService
                  .pull(row.repo, { rebase: method === 'rebase', autostash: true, prune: true })
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
        // All rows settled successfully — toast, fire callback, dispose. A
        // revision row names the pushed commit (a detached one has no branch
        // name at all).
        void vscode.window.showInformationMessage(
          rows.length === 1
            ? rows[0].pushSource
              ? `Pushed up to ${rows[0].pushSource.hash.slice(0, 7)}`
              : `Pushed '${rows[0].localBranch}'`
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
