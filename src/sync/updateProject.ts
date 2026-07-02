import type {
  IFileStatus,
  IPullOptions,
  IRepository,
  RepositoryState,
} from '../git-core/interfaces/IGitService';
import { isConflictedStatus } from '../git-core/gitParser';
import { combinedGitErrorText, sanitizeGitError } from '../git-core/gitError';

/**
 * Inputs for the Update Project preflight guard — the subset of repository
 * state GitUpdateProcess inspects before deciding an update is possible.
 */
export interface IUpdateProjectState {
  /** The repo's in-progress operation kind, if any (`repo.inProgress?.kind`). */
  inProgressKind?: Exclude<RepositoryState, 'idle'>;
  /** Whether the working tree currently has unmerged (conflicted) files. */
  hasUnmergedFiles: boolean;
}

/**
 * Decide whether an "Update Project" may proceed — IntelliJ git4idea
 * `GitUpdateProcess` parity. That process refuses to update when a rebase or
 * merge is already in progress, or when the working tree has unmerged files
 * (GitUpdateProcess.java: `checkRebaseInProgress() || isMergeInProgress() ||
 * areUnmergedFiles()`). A cherry-pick or revert in progress is NOT one of its
 * blockers, so those pass.
 *
 * @returns a human-readable reason the update is blocked, or `undefined` when
 *   the repo is ready to update. Pure — no git access.
 */
export function updateProjectBlockedReason(state: IUpdateProjectState): string | undefined {
  if (state.inProgressKind === 'rebasing') {
    return 'A rebase is in progress. Finish or abort it before updating.';
  }
  if (state.inProgressKind === 'merging') {
    return 'A merge is in progress. Finish or abort it before updating.';
  }
  if (state.hasUnmergedFiles) {
    return 'There are unresolved merge conflicts. Resolve them before updating.';
  }
  return undefined;
}

// ─── Update method (GitUpdateOptionsDialog / UpdateMethod parity) ─────────────

/**
 * The user-selectable update strategy. Mirrors git4idea's `UpdateMethod`
 * (BRANCH_DEFAULT / MERGE / REBASE). RESET is out of scope for the pure-Git
 * parity surface here.
 */
export type UpdateMethod = 'branch-default' | 'merge' | 'rebase';

/**
 * Resolve `branch-default` to a concrete merge-or-rebase strategy.
 *
 * git4idea's `GitUpdater.getUpdater(BRANCH_DEFAULT)` reads, in order:
 *   1. `branch.<name>.rebase` (per-branch override)
 *   2. `pull.rebase` (repo / global default)
 *   3. otherwise MERGE.
 *
 * IntelliG does not yet expose a `git config` read on the service (that needs
 * a new git op — a deferred cross-cutting change), so the per-branch override
 * (step 1) is approximated by the IntelliG `intellig.pullRebase` setting,
 * which is the IntelliG analog of `pull.rebase` (step 2). When the explicit
 * method is `merge` or `rebase`, that wins outright.
 *
 * @param method   the user's chosen method
 * @param pullRebaseDefault the `intellig.pullRebase` config value
 * @returns the concrete strategy: `true` = rebase, `false` = merge.
 */
export function resolveUpdateRebase(method: UpdateMethod, pullRebaseDefault: boolean): boolean {
  switch (method) {
    case 'rebase':
      return true;
    case 'merge':
      return false;
    case 'branch-default':
      return pullRebaseDefault;
  }
}

/**
 * Build the {@link IPullOptions} for a single-root update with the resolved
 * strategy. Update Project always fetches with prune first (handled by the
 * caller) then pulls; the pull carries the strategy + prune.
 */
export function buildUpdatePullOptions(rebase: boolean): IPullOptions {
  return {
    rebase: rebase || undefined,
    // When not rebasing we leave merge as git's default (no --no-ff): a plain
    // `git pull` fast-forwards when possible, which is IntelliJ's MERGE
    // behaviour.
    prune: true,
    // Save local changes around the update — git4idea's GitUpdateProcess
    // stashes/shelves before updating and restores after. Without it a dirty
    // working tree dead-ends the pull on "local changes would be overwritten"
    // and every such repo becomes an error row. `_pull` already detects an
    // autostash-pop conflict and routes it into the Resolve Conflicts flow.
    // MERGE-mode `--autostash` needs git >= 2.27 — this flag SETS the
    // project's supported-git floor (gitVersion.MIN_SUPPORTED_GIT).
    autostash: true,
  };
}

// ─── Update Info summary (Update Info tab payload) ────────────────────────────

/** Per-repository outcome of an Update Project run. */
export interface IUpdateRepoResult {
  /** Repo display name (last path segment). */
  name: string;
  /** Absolute repo root path. */
  rootPath: string;
  /** Branch that was updated. */
  branch: string | undefined;
  /** Resolved strategy used for this repo. */
  rebase: boolean;
  /** Commits pulled in (incoming count consumed by the update). */
  incoming: number;
  /** Outcome status. */
  status: 'updated' | 'up-to-date' | 'conflict' | 'error';
  /** Error / conflict detail, when `status` is `conflict` or `error`. */
  detail?: string;
}

/** Aggregate summary feeding the Update Info tab. */
export interface IUpdateInfoSummary {
  /** Method the user selected (before per-repo resolution). */
  method: UpdateMethod;
  /** Per-repo results, in run order. */
  repos: IUpdateRepoResult[];
  /** Convenience: total commits pulled across all repos. */
  totalIncoming: number;
  /** True when every repo finished `updated` or `up-to-date`. */
  allClean: boolean;
}

/**
 * Fold per-repo results into the aggregate summary. Pure — exported for tests
 * and reused by the Update Info tab.
 */
export function summarizeUpdate(
  method: UpdateMethod,
  repos: IUpdateRepoResult[]
): IUpdateInfoSummary {
  const totalIncoming = repos.reduce((sum, r) => sum + r.incoming, 0);
  const allClean = repos.every((r) => r.status === 'updated' || r.status === 'up-to-date');
  return { method, repos, totalIncoming, allClean };
}

/** Last path segment of a repo root, for display. */
export function repoDisplayName(repo: IRepository): string {
  const fsPath = repo.rootUri.fsPath;
  return fsPath.split(/[\\/]/).filter(Boolean).pop() ?? fsPath;
}

// ─── Dependency-injected Update Project flow ──────────────────────────────────

/** Minimal git surface the update flow needs (frozen IGitService methods + 0a). */
export interface IUpdateGitService {
  getStatus(repo: IRepository): Promise<IFileStatus[]>;
  fetch(repo: IRepository, options?: { all?: boolean; prune?: boolean }): Promise<unknown>;
  pull(repo: IRepository, options?: IPullOptions): Promise<void>;
  getIncomingOutgoing(repo: IRepository): Promise<{
    branch: string;
    upstream?: string;
    incoming: number;
    outgoing: number;
    noUpstream: boolean;
  }>;
  reloadRepository(repo: IRepository): Promise<unknown>;
}

/**
 * Conflict heuristic shared with the Pull dialog. Scans the COMBINED git
 * output (stdout+stderr), not just `error.message` (= one stream) — git writes
 * the "CONFLICT" marker to stdout, so a `.message`-only check misses a
 * conflicting pull whose stderr carries unrelated hint text.
 */
export function isUpdateConflict(error: unknown): boolean {
  return /CONFLICT/i.test(combinedGitErrorText(error));
}

/** Dependencies for {@link runUpdateProject}, kept discrete for testing. */
export interface IRunUpdateProjectDeps {
  /** Repos to update (already multi-root resolved by the caller). */
  repos: IRepository[];
  gitService: IUpdateGitService;
  /** Chosen update method. */
  method: UpdateMethod;
  /** `intellig.pullRebase` setting, seeding branch-default resolution. */
  pullRebaseDefault: boolean;
}

/**
 * Run Update Project across one or more roots — git4idea `GitUpdateProcess`
 * parity (minus the save-local-changes step, which IntelliG defers to the
 * caller / Pull dialog's autostash follow-up). For each repo:
 *
 *   1. Preflight-guard (skip + record `error` when blocked).
 *   2. `fetch --all --prune`.
 *   3. Read incoming count (0a) to populate the summary.
 *   4. `pull` with the resolved strategy; classify conflict vs error.
 *
 * Pure orchestration over the injected git surface — no `vscode` import — so it
 * is fully unit-testable. Returns the aggregate {@link IUpdateInfoSummary}
 * feeding the Update Info tab.
 */
export async function runUpdateProject(deps: IRunUpdateProjectDeps): Promise<IUpdateInfoSummary> {
  const rebase = resolveUpdateRebase(deps.method, deps.pullRebaseDefault);
  const results: IUpdateRepoResult[] = [];

  for (const repo of deps.repos) {
    const name = repoDisplayName(repo);
    const rootPath = repo.rootUri.fsPath;
    let branch = repo.head?.name?.replace('refs/heads/', '');

    // Preflight per-repo.
    const status = await deps.gitService.getStatus(repo);
    // Use isConflictedStatus so AA (both-added) and DD (both-deleted) entries
    // are caught alongside the U (unmerged) marker — they all signal a conflict
    // state that blocks an update.
    const hasUnmergedFiles = status.some(isConflictedStatus);
    const blocked = updateProjectBlockedReason({
      inProgressKind: repo.inProgress?.kind,
      hasUnmergedFiles,
    });
    if (blocked) {
      results.push({
        name,
        rootPath,
        branch,
        rebase,
        incoming: 0,
        status: 'error',
        detail: blocked,
      });
      continue;
    }

    try {
      await deps.gitService.fetch(repo, { all: true, prune: true });

      // Incoming count after fetch — what this update will consume.
      let incoming = 0;
      // Track whether the probe succeeded. When it throws we cannot know
      // whether incoming is 0 or not, so we must not skip the pull.
      let incomingKnown = false;
      try {
        const io = await deps.gitService.getIncomingOutgoing(repo);
        incoming = io.incoming;
        incomingKnown = true;
        branch = io.branch ?? branch;
        if (io.noUpstream) {
          results.push({
            name,
            rootPath,
            branch,
            rebase,
            incoming: 0,
            status: 'up-to-date',
            detail: 'No upstream configured.',
          });
          continue;
        }
        // eslint-disable-next-line no-restricted-syntax -- no logger in scope; a failure here is non-fatal and falls through to the pull below, which surfaces real errors to the user.
      } catch {
        // Non-fatal: fall through to the pull, which will surface real errors.
        // incomingKnown stays false → the incoming === 0 guard below is skipped.
      }

      if (incomingKnown && incoming === 0) {
        results.push({ name, rootPath, branch, rebase, incoming: 0, status: 'up-to-date' });
        await deps.gitService.reloadRepository(repo);
        continue;
      }

      await deps.gitService.pull(repo, buildUpdatePullOptions(rebase));
      await deps.gitService.reloadRepository(repo);
      results.push({ name, rootPath, branch, rebase, incoming, status: 'updated' });
    } catch (error) {
      // Scrub credentials before the message lands in the Update Info tab: a
      // push/pull/fetch stderr can embed `user:token@host` in a remote URL.
      const message = error instanceof Error ? error.message : 'Unknown error';
      results.push({
        name,
        rootPath,
        branch,
        rebase,
        incoming: 0,
        status: isUpdateConflict(error) ? 'conflict' : 'error',
        detail: sanitizeGitError(message),
      });
    }
  }

  return summarizeUpdate(deps.method, results);
}
