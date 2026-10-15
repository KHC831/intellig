/**
 * PullDialog.
 *
 * Two-step native QuickPick flow for `git pull`:
 *   1. Pick the remote + branch to pull from (sectioned by remote).
 *   2. Pick the flag toggles (multi-select) then confirm via a terminal
 *      `▶ Pull` item.
 *
 * The pure behaviour is exposed via {@link runPullDialog} so unit tests can
 * drive the dialog without activating the extension. The {@link PullDialog}
 * class wires real `vscode.window` helpers and service-locator bindings.
 */

import * as vscode from 'vscode';
import { readConfig } from '../config/configKeys';
import {
  IBranch,
  IGitService,
  IPullOptions,
  IRepository,
} from '../git-core/interfaces/IGitService';
import { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import { sanitizeGitError, combinedGitErrorText } from '../git-core/gitError';
import { looksLikeConflictText } from '../git-core/gitProse';

// ─── Flag-key helpers ────────────────────────────────────────────────────────

/** Keys of {@link IPullOptions} that represent CLI flags (not remote/branch). */
export type PullFlagKey =
  'rebase' | 'ffOnly' | 'noFf' | 'squash' | 'noCommit' | 'noVerify' | 'autostash';

/** CLI representation of each flag, for UI labelling. */
const FLAG_LABELS: Record<PullFlagKey, string> = {
  rebase: '--rebase',
  ffOnly: '--ff-only',
  noFf: '--no-ff',
  squash: '--squash',
  noCommit: '--no-commit',
  noVerify: '--no-verify',
  autostash: '--autostash',
};

/**
 * Strategy flags that are mutually exclusive — turning one on clears the
 * others. Ordered as presented in the picker.
 */
const STRATEGY_FLAGS: ReadonlyArray<PullFlagKey> = ['rebase', 'ffOnly', 'noFf'];

/** The remaining flags, in picker order. */
const MODIFIER_FLAGS: ReadonlyArray<PullFlagKey> = ['squash', 'noCommit', 'noVerify', 'autostash'];

/** All flag keys in picker order. */
export const ALL_PULL_FLAGS: ReadonlyArray<PullFlagKey> = [...STRATEGY_FLAGS, ...MODIFIER_FLAGS];

/**
 * Pairwise incompatibilities, mirroring GitPullOption.isOptionSuitable:
 * `--rebase` refuses every merge-shaping flag; `--ff-only` / `--no-ff` /
 * `--squash` are mutually incompatible; `--no-commit` only clashes with
 * `--rebase`. `--no-verify` and `--autostash` combine with anything. git
 * itself errors on these combinations, so the picker must resolve them
 * rather than pass them through.
 */
const FLAG_INCOMPATIBILITIES: Record<PullFlagKey, ReadonlyArray<PullFlagKey>> = {
  rebase: ['ffOnly', 'noFf', 'squash', 'noCommit'],
  ffOnly: ['rebase', 'noFf', 'squash'],
  noFf: ['rebase', 'ffOnly', 'squash'],
  squash: ['rebase', 'ffOnly', 'noFf'],
  noCommit: ['rebase'],
  noVerify: [],
  autostash: [],
};

// ─── Pure mutex resolver ─────────────────────────────────────────────────────

/**
 * Resolve the incompatibility matrix over a flag state.
 *
 * @param flags - Current flag state.
 * @param lastToggled - The flag the user most recently toggled on, if any.
 *   When present and enabled, its incompatible partners are cleared first so
 *   the fresh choice wins. Independently of that, a final sweep in picker
 *   order keeps each enabled flag only when it is compatible with every flag
 *   kept before it, so no incompatible pair ever survives.
 */
export function resolveFlagMutex(
  flags: Record<PullFlagKey, boolean>,
  lastToggled?: PullFlagKey
): Record<PullFlagKey, boolean> {
  const resolved: Record<PullFlagKey, boolean> = { ...flags };

  if (lastToggled && resolved[lastToggled]) {
    for (const other of FLAG_INCOMPATIBILITIES[lastToggled]) {
      resolved[other] = false;
    }
  }

  const kept: PullFlagKey[] = [];
  for (const key of ALL_PULL_FLAGS) {
    if (!resolved[key]) {
      continue;
    }
    if (kept.some((k) => FLAG_INCOMPATIBILITIES[k].includes(key))) {
      resolved[key] = false;
    } else {
      kept.push(key);
    }
  }
  return resolved;
}

/**
 * Materialize a set of default flag values. `intellig.pullRebase` seeds
 * `rebase` when no preset is supplied; a preset explicitly overrides.
 */
export function defaultPullFlags(
  defaultRebase: boolean,
  preset?: 'rebase' | 'merge'
): Record<PullFlagKey, boolean> {
  const flags: Record<PullFlagKey, boolean> = {
    rebase: false,
    ffOnly: false,
    noFf: false,
    squash: false,
    noCommit: false,
    noVerify: false,
    autostash: false,
  };
  if (preset === 'rebase') {
    flags.rebase = true;
  } else if (preset === 'merge') {
    // Explicit merge preset — caller wants classic merge behaviour. We do
    // NOT auto-set `--no-ff`; that's a separate user choice. We simply keep
    // `rebase` off.
    flags.rebase = false;
  } else {
    flags.rebase = defaultRebase;
  }
  return flags;
}

// ─── Source (remote + branch) picking ────────────────────────────────────────

/** One remote-branch row in the source picker. */
export interface IPullSourceChoice {
  remote: string;
  branch: string;
}

/** Sectioned QuickPick item for the step-1 picker. */
interface ISourceQuickPickItem extends vscode.QuickPickItem {
  remote?: string;
  branch?: string;
}

/**
 * Build the step-1 (source) QuickPick item list. Remote branches are
 * grouped by remote, with the tracked upstream (if any) highlighted.
 *
 * Exported for focused unit testing.
 */
export function buildSourceItems(
  branches: ReadonlyArray<IBranch>,
  trackedUpstream?: { remote: string; name: string }
): ISourceQuickPickItem[] {
  const grouped = new Map<string, IBranch[]>();
  for (const b of branches) {
    if (b.type !== 'remote') {
      continue;
    }
    const slash = b.name.indexOf('/');
    if (slash < 0) {
      continue;
    }
    const remote = b.name.substring(0, slash);
    const list = grouped.get(remote) ?? [];
    list.push(b);
    grouped.set(remote, list);
  }

  const items: ISourceQuickPickItem[] = [];
  // Put the upstream's remote first (if present), then the rest in insertion order.
  const orderedRemotes: string[] = [];
  if (trackedUpstream && grouped.has(trackedUpstream.remote)) {
    orderedRemotes.push(trackedUpstream.remote);
  }
  for (const remote of grouped.keys()) {
    if (!orderedRemotes.includes(remote)) {
      orderedRemotes.push(remote);
    }
  }

  for (const remote of orderedRemotes) {
    items.push({
      label: `Remote: ${remote}`,
      kind: vscode.QuickPickItemKind.Separator,
    });
    const remoteBranches = grouped.get(remote) ?? [];
    for (const b of remoteBranches) {
      const slash = b.name.indexOf('/');
      const branch = slash >= 0 ? b.name.substring(slash + 1) : b.name;
      const isUpstream = trackedUpstream?.remote === remote && trackedUpstream?.name === branch;
      items.push({
        label: `$(git-branch) ${branch}`,
        description: isUpstream ? 'upstream' : undefined,
        remote,
        branch,
      });
    }
  }
  return items;
}

// ─── Flag picker items ───────────────────────────────────────────────────────

/** Flag-toggle item for the step-2 picker. */
export interface IPullFlagItem extends vscode.QuickPickItem {
  /** Flag key when this item toggles a flag. */
  flagKey?: PullFlagKey;
  /** True for the terminal `▶ Pull` item. */
  confirm?: boolean;
}

/**
 * Build the full flag-toggle item list, marking currently-on flags picked.
 * The terminal `▶ Pull` confirmer item is placed last and is never
 * `picked: true` so it doesn't auto-submit.
 */
export function buildFlagItems(flags: Record<PullFlagKey, boolean>): IPullFlagItem[] {
  const items: IPullFlagItem[] = [];
  for (const key of STRATEGY_FLAGS) {
    items.push({
      label: FLAG_LABELS[key],
      flagKey: key,
      picked: flags[key],
    });
  }
  for (const key of MODIFIER_FLAGS) {
    items.push({
      label: FLAG_LABELS[key],
      flagKey: key,
      picked: flags[key],
    });
  }
  items.push({
    label: '$(play) Pull',
    description: 'Run with the selected flags',
    confirm: true,
  });
  return items;
}

/**
 * Collapse a selection list (from canPickMany=true) plus the existing flag
 * state into a finalized flag record, applying mutex rules.
 */
export function applyFlagSelection(
  previous: Record<PullFlagKey, boolean>,
  selection: ReadonlyArray<IPullFlagItem>
): Record<PullFlagKey, boolean> {
  const selectedKeys = new Set<PullFlagKey>();
  for (const it of selection) {
    if (it.flagKey) {
      selectedKeys.add(it.flagKey);
    }
  }
  const next: Record<PullFlagKey, boolean> = {
    rebase: selectedKeys.has('rebase'),
    ffOnly: selectedKeys.has('ffOnly'),
    noFf: selectedKeys.has('noFf'),
    squash: selectedKeys.has('squash'),
    noCommit: selectedKeys.has('noCommit'),
    noVerify: selectedKeys.has('noVerify'),
    autostash: selectedKeys.has('autostash'),
  };

  // Detect which flag was freshly enabled relative to `previous` — the
  // fresh choice wins over whatever it is incompatible with.
  let newlyEnabled: PullFlagKey | undefined;
  for (const key of ALL_PULL_FLAGS) {
    if (next[key] && !previous[key]) {
      newlyEnabled = key;
      break;
    }
  }

  return resolveFlagMutex(next, newlyEnabled);
}

// ─── Conflict detection helper ───────────────────────────────────────────────

/**
 * Heuristic: git writes "CONFLICT" markers when a merge/rebase leaves a
 * conflict. The marker lands on STDOUT, but `GitCommandError.message` is
 * `stderr || stdout` (one stream) — so inspect the COMBINED output, not just
 * the message, or a conflicting pull whose stderr carries hint text
 * misclassifies as a generic error. Accepts the raw thrown value (or a plain
 * string) and scans the fullest available output.
 */
export function isConflictError(error: unknown): boolean {
  return looksLikeConflictText(combinedGitErrorText(error));
}

// ─── Dependency-injected flow ────────────────────────────────────────────────

/** Dependencies for the pull flow, kept discrete so tests can drive them. */
export interface IRunPullDialogDeps {
  repo: IRepository;
  gitService: IGitService;
  conflictResolutionService: IConflictResolutionService;
  defaultRebase: boolean;
  /** Optional prefilled source — skips the step-1 picker. */
  prefilledSource?: IPullSourceChoice;
  /** Optional preset that pre-selects rebase or merge in step 2. */
  preset?: 'rebase' | 'merge';
  /** Prompt helpers — thin seams over `vscode.window.*`. */
  showQuickPickSingle: <T extends vscode.QuickPickItem>(
    items: ReadonlyArray<T>,
    options: vscode.QuickPickOptions
  ) => Thenable<T | undefined>;
  showQuickPickMulti: <T extends vscode.QuickPickItem>(
    items: ReadonlyArray<T>,
    options: vscode.QuickPickOptions & { canPickMany: true }
  ) => Thenable<ReadonlyArray<T> | undefined>;
  showInformationMessage: (message: string) => Thenable<string | undefined>;
  showWarningMessage: (message: string) => Thenable<string | undefined>;
  showErrorMessage: (message: string) => Thenable<string | undefined>;
}

/**
 * Outcome of a `runPullDialog` invocation. Useful mostly for tests; the
 * production caller doesn't need to branch on the result.
 */
export type PullDialogOutcome =
  | { status: 'cancelled'; step: 'source' | 'options' }
  | { status: 'pulled'; options: IPullOptions }
  | { status: 'conflict'; options: IPullOptions; message: string }
  | { status: 'error'; options: IPullOptions; message: string };

/**
 * Run the two-step Pull dialog flow. Returns the outcome so tests can assert
 * on what happened; the production caller typically discards the result.
 */
export async function runPullDialog(deps: IRunPullDialogDeps): Promise<PullDialogOutcome> {
  let source = deps.prefilledSource;
  if (!source) {
    const branches = await deps.gitService.getBranches(deps.repo);
    const trackedUpstream = deps.repo.head?.upstream;
    const items = buildSourceItems(branches, trackedUpstream);

    if (items.length === 0) {
      void deps.showErrorMessage('No remote branches found. Fetch from a remote first.');
      return { status: 'cancelled', step: 'source' };
    }

    const picked = await deps.showQuickPickSingle(items, {
      title: 'Pull: Choose source',
      placeHolder: 'Select a remote branch to pull from',
      matchOnDescription: true,
    });
    if (!picked || !('remote' in picked) || !picked.remote || !picked.branch) {
      return { status: 'cancelled', step: 'source' };
    }
    source = { remote: picked.remote, branch: picked.branch };
  }

  // Flags step. canPickMany loop-free: we let VS Code show all toggles at
  // once; the user's selection set is the final flag state after mutex.
  const flags = defaultPullFlags(deps.defaultRebase, deps.preset);
  const flagItems = buildFlagItems(flags);

  const selected = await deps.showQuickPickMulti(flagItems, {
    title: `Pull: Options — ${source.remote}/${source.branch}`,
    placeHolder: 'Toggle flags and pick ▶ Pull to run (Esc to cancel)',
    canPickMany: true,
  });

  if (!selected) {
    return { status: 'cancelled', step: 'options' };
  }

  // Users migrating from IntelliJ expect Enter alone to submit the flag
  // selection. VS Code's `showQuickPick` with `canPickMany` returns the
  // current selection set on OK, and there's no per-item "Accept" button on
  // the classic API — so we require the explicit ▶ Pull terminal item to be
  // picked, otherwise treat the submission as cancel. This keeps accidental
  // Enter from silently pulling with a surprise flag set.
  //
  // TODO: migrate to `vscode.window.createQuickPick()` + a dedicated accept
  // button (`buttons: [{iconPath, tooltip:'Pull'}]`) so Enter binds to accept
  // naturally. That API is more involved (manual show/hide, event plumbing)
  // so we keep the cheaper pattern here for now.
  const confirmed = selected.some((it) => it.confirm === true);
  if (!confirmed) {
    return { status: 'cancelled', step: 'options' };
  }

  const resolvedFlags = applyFlagSelection(flags, selected);

  const options: IPullOptions = {
    remote: source.remote,
    branch: source.branch,
    rebase: resolvedFlags.rebase || undefined,
    ffOnly: resolvedFlags.ffOnly || undefined,
    noFf: resolvedFlags.noFf || undefined,
    squash: resolvedFlags.squash || undefined,
    noCommit: resolvedFlags.noCommit || undefined,
    noVerify: resolvedFlags.noVerify || undefined,
    autostash: resolvedFlags.autostash || undefined,
    prune: true,
  };

  try {
    await deps.gitService.pull(deps.repo, options).match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    void deps.showInformationMessage(
      `Pulled ${source.remote}/${source.branch} into current branch`
    );
    return { status: 'pulled', options };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (isConflictError(error)) {
      // Hand conflicts off to the Resolve Conflicts dialog. The
      // operation union on IConflictResolutionService does not include
      // `'pull'` — a pull produces the same repo state that merge/rebase
      // produce directly, so we map pull-with-rebase → `'rebase'` and any
      // other pull → `'merge'`. `canContinue` is true for merge/rebase
      // because the user can complete the op after resolving.
      try {
        const conflicts = await deps.conflictResolutionService.getConflictedFiles(deps.repo);
        await deps.conflictResolutionService.openResolveConflictsDialog(deps.repo, conflicts, {
          operation: resolvedFlags.rebase ? 'rebase' : 'merge',
          target: `${source.remote}/${source.branch}`,
          canAbort: true,
          canContinue: true,
        });
      } catch (handoffError) {
        // If the dialog itself fails to open, fall back to the original
        // warning toast so the user at least knows about the conflicts.
        const reason = handoffError instanceof Error ? handoffError.message : 'Unknown error';
        void deps.showWarningMessage(
          `Pull produced conflicts — resolve manually (${sanitizeGitError(reason)}).`
        );
      }
      return { status: 'conflict', options, message };
    }
    void deps.showErrorMessage(`Failed to pull: ${sanitizeGitError(message)}`);
    return { status: 'error', options, message };
  }
}

// ─── Class wrapper with real VS Code bindings ────────────────────────────────

/**
 * PullDialog — the shipping entry point. Constructor takes the service
 * locator pieces it needs; the static {@link PullDialog.show} helper is the
 * one callers use.
 */
export class PullDialog {
  private readonly _gitService: IGitService;
  private readonly _conflictResolutionService: IConflictResolutionService;

  constructor(gitService: IGitService, conflictResolutionService: IConflictResolutionService) {
    this._gitService = gitService;
    this._conflictResolutionService = conflictResolutionService;
  }

  /**
   * Entry point. If `repo` is omitted, picks one from the git service; if
   * more than one is available and no pre-selection exists, asks the user.
   *
   * @param repo - The repository to pull into. If omitted, resolved from
   *   the active git service state.
   * @param preset - Optional preset pre-filling the strategy flag.
   * @param prefilledSource - Optional remote+branch to skip step 1 entirely.
   */
  async show(
    repo?: IRepository,
    preset?: 'rebase' | 'merge',
    prefilledSource?: IPullSourceChoice
  ): Promise<PullDialogOutcome> {
    const targetRepo = repo ?? (await this._pickRepository());
    if (!targetRepo) {
      return { status: 'cancelled', step: 'source' };
    }

    const defaultRebase = readConfig('pullRebase');

    return runPullDialog({
      repo: targetRepo,
      gitService: this._gitService,
      conflictResolutionService: this._conflictResolutionService,
      defaultRebase,
      prefilledSource,
      preset,
      showQuickPickSingle: (items, options) =>
        vscode.window.showQuickPick(
          items as ReadonlyArray<vscode.QuickPickItem>,
          options
        ) as Thenable<(typeof items)[number] | undefined>,
      showQuickPickMulti: (items, options) =>
        vscode.window.showQuickPick(
          items as ReadonlyArray<vscode.QuickPickItem>,
          options
        ) as Thenable<ReadonlyArray<(typeof items)[number]> | undefined>,
      showInformationMessage: (msg) => vscode.window.showInformationMessage(msg),
      showWarningMessage: (msg) => vscode.window.showWarningMessage(msg),
      showErrorMessage: (msg) => vscode.window.showErrorMessage(msg),
    });
  }

  private async _pickRepository(): Promise<IRepository | undefined> {
    const repos = this._gitService.getRepositories();
    if (repos.length === 0) {
      void vscode.window.showErrorMessage('No Git repository found in workspace');
      return undefined;
    }
    if (repos.length === 1) {
      return repos[0];
    }
    const items = repos.map((r) => ({
      label: r.rootUri.fsPath.split(/[\\/]/).filter(Boolean).pop() ?? r.rootUri.fsPath,
      description: r.rootUri.fsPath,
      repo: r,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Pull — Choose Repository',
      placeHolder: 'Select a repository',
    });
    return picked?.repo;
  }
}

/**
 * Factory — mirrors the rest of `src/services/*.ts`.
 */
export function createPullDialog(
  gitService: IGitService,
  conflictResolutionService: IConflictResolutionService
): PullDialog {
  return new PullDialog(gitService, conflictResolutionService);
}
