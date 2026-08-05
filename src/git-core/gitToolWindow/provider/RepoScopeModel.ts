/**
 * The Git tool window's repository-scope state machine: the available-repo
 * list, the selected/merged scope, the visible-roots subset, the per-commit
 * repo-root index for the merged log, and the parsed-remote cache. Owned by
 * GitToolWindowProvider as `provider.repoScope`; every effect (render, state
 * event, scope event, config read) goes through {@link IRepoScopeHost} so the
 * model never touches the webview or vscode.
 */

import * as path from 'path';
import type { RepositoryScopeSelection } from '../../../registration/wiring';
import { abbreviateHomePath } from '../../../utils/displayPath';
import { getLogger } from '../../../utils/logger';
import { normalizeRepoPath, normalizeRepoPathString } from '../../../utils/normalizeRepoPath';
import { parseRemoteUrl, type IRemoteUrl } from '../../../utils/remoteUrl';
import type { ICommit, IRepository } from '../../interfaces/IGitService';

const REPO_STATE_FIELD_SEP = '\u0000';
const REPO_STATE_SECTION_SEP = '\u0001';

/**
 * The provider-side effects this model is allowed to cause. Function-typed
 * call-time lambdas (live reads), built once in the provider constructor.
 */
export interface IRepoScopeHost {
  render: () => void;
  fireStateChange: () => void;
  fireScopeChange: (e: RepositoryScopeSelection) => void;
  /** `intellig.log.showAllRoots` — config reads stay host-side. */
  readShowAllRootsConfig: () => boolean;
}

export class RepoScopeModel {
  private _availableRepositories: IRepository[] = [];
  private _selectedRepositoryIndex: number = 0;
  /** `'all'` for the merged multi-root view, or the selected repo's index. */
  private _repositoryScope: 'all' | number = 0;
  /** Whether the user explicitly chose the scope (vs. the config default). */
  private _scopeUserChosen: boolean = false;
  /**
   * The visible subset of root fsPaths in merged scope, or `null` when every
   * available root is shown. An explicit EMPTY array means "show none".
   */
  private _visibleRepoRoots: string[] | null = null;
  /**
   * Per-commit repo root for the merged log window; `null` records an
   * ambiguous hash (present in more than one root — fail closed).
   */
  private _commitRepoRoots: Map<string, string | null> = new Map();
  /** Parsed first-remote per repo root fsPath; `undefined` = unparseable. */
  private readonly _parsedRemoteCache: Map<string, IRemoteUrl | undefined> = new Map();

  constructor(private readonly _host: IRepoScopeHost) {}

  public setAvailableRepositories(repos: IRepository[]): void {
    // Identity-stable selection across reloads.
    //
    // Keying by INDEX alone broke after any mutation that triggered
    // `loadAllPanelData` (drop commit, squash, rebase, etc.). The
    // gitService's repo cache iteration order is insertion-order, and
    // a watcher tear-down + re-add (which happens on
    // reloadRepository's invalidate path) can shift a repo's slot in
    // the cache — making `_selectedRepositoryIndex = 2` silently
    // point at a DIFFERENT repo on the next render. Symptom: user
    // dropped a commit on repo A, dropdown silently jumped to repo B.
    //
    // Fix: remember the selected repo's `rootUri.fsPath` BEFORE
    // overwriting `_availableRepositories`, then re-resolve the index
    // by matching that path against the new list. Falls back to 0
    // when the previously-selected repo is no longer present (folder
    // removed from workspace) — the prior contract.
    // Identity comparison goes through `normalizeRepoPath` (L14) so a
    // Windows drive-letter-case or slash-flavor difference between the
    // old and new list entries doesn't read as a different repo and
    // silently drop the user's selection.
    const previousSelected = this._availableRepositories[this._selectedRepositoryIndex];
    const previousSelectedPath = previousSelected
      ? normalizeRepoPath(previousSelected.rootUri)
      : undefined;
    const previousRepoCount = this._availableRepositories.length;
    const previousDocumentState = this._repositoryDocumentState();

    this._availableRepositories = repos;

    if (repos.length === 0) {
      this._selectedRepositoryIndex = 0;
    } else if (previousSelectedPath !== undefined) {
      const matched = repos.findIndex((r) => normalizeRepoPath(r.rootUri) === previousSelectedPath);
      this._selectedRepositoryIndex = matched >= 0 ? matched : 0;
    } else if (this._selectedRepositoryIndex >= repos.length) {
      // No prior selection (cold start) and the saved index is
      // out-of-bounds — fall back to first.
      this._selectedRepositoryIndex = 0;
    }

    const previousScope = this._repositoryScope;
    this._resolveRepositoryScope(repos);

    // Prune a visible-roots subset to the roots that still exist (identity by
    // normalized path, mirroring the index re-resolution above). An EXPLICIT
    // empty set (the "show none" state) is left untouched — it isn't a shrunken
    // subset, it's a deliberate selection the user must undo themselves.
    if (this._visibleRepoRoots && this._visibleRepoRoots.length > 0) {
      const present = new Set(repos.map((r) => normalizeRepoPath(r.rootUri)));
      const kept = this._visibleRepoRoots.filter((p) => present.has(normalizeRepoPathString(p)));
      if (kept.length === 1) {
        // A subset that shrank to a single surviving root becomes the single-repo
        // scope — mirroring the checkbox rule "exactly one checked → that repo".
        // Collapsing it to "show all" instead would resurrect roots the user
        // explicitly excluded (the other survivors) into the view.
        const survivor = normalizeRepoPathString(kept[0]);
        const idx = repos.findIndex((r) => normalizeRepoPath(r.rootUri) === survivor);
        if (idx >= 0) {
          this._selectedRepositoryIndex = idx;
          this._repositoryScope = idx;
        }
        this._visibleRepoRoots = null;
      } else {
        // 0 survivors, or a subset that now covers every root, is no longer a
        // "some but not all" subset → show all. A real 2..n-1 subset is kept.
        this._visibleRepoRoots = kept.length === 0 || kept.length === repos.length ? null : kept;
      }
    }

    // Render only when the repository list changed something the document
    // shows. This runs on every watcher-driven reload, and each render replaces
    // `webview.html` — with a fresh nonce, so it is always a real iframe reload
    // that takes the filter draft, scroll and focus with it. Rendering here
    // unconditionally meant the log's own fingerprint guard downstream never
    // got the chance to skip anything.
    //
    // The store above is unconditional on purpose: a reload REPLACES repository
    // objects and the stored array feeds action paths, so skipping it to avoid
    // a render would leave stale objects wired into real operations.
    if (this._repositoryDocumentState() !== previousDocumentState) {
      this._host.render();
    }
    this._host.fireStateChange();

    // Announce an effective-scope change so the log + branch wiring (which
    // follow this event) re-route eagerly instead of waiting for the next
    // repo-change/refresh. The effective scope is either merged 'all' or a
    // specific repo (by identity), and it can change in BOTH directions when the
    // repo set changes:
    //   - shrink to one repo   → merged 'all' collapses to that single repo.
    //   - grow past one repo    → the single scope restores to merged 'all'.
    //   - the scoped repo drops → scope re-resolves to another single repo.
    // Compare the resolved scope by identity against the pre-update scope so
    // every real transition fires and an unchanged scope (merged→merged, or the
    // same repo whose index merely shifted) stays silent. Skip the initial cold
    // population (no prior repos): the branch tree already defaults to 'all'.
    if (previousRepoCount > 0) {
      const newScopeIsAll = this._repositoryScope === 'all';
      const newRepo = newScopeIsAll
        ? undefined
        : this._availableRepositories[this._selectedRepositoryIndex];
      const newRepoPath = newRepo ? normalizeRepoPath(newRepo.rootUri) : undefined;
      const prevScopeIsAll = previousScope === 'all';
      const prevRepoPath = prevScopeIsAll ? undefined : previousSelectedPath;
      if (prevScopeIsAll !== newScopeIsAll || prevRepoPath !== newRepoPath) {
        if (newScopeIsAll) {
          this._host.fireScopeChange({ kind: 'all' });
        } else if (newRepo) {
          this._host.fireScopeChange({ kind: 'repository', repository: newRepo });
        }
      }
    }
  }

  /**
   * Serialized view of every repo-list fact the rendered document shows.
   * `setAvailableRepositories` compares before/after to skip no-op renders.
   */
  private _repositoryDocumentState(): string {
    const roots = this._availableRepositories
      .map((r) => normalizeRepoPath(r.rootUri))
      .join(REPO_STATE_FIELD_SEP);
    const visible =
      this._visibleRepoRoots === null
        ? 'all'
        : `subset:${this._visibleRepoRoots.map(normalizeRepoPathString).join(REPO_STATE_FIELD_SEP)}`;
    return [
      roots,
      String(this._selectedRepositoryIndex),
      String(this._repositoryScope),
      visible,
    ].join(REPO_STATE_SECTION_SEP);
  }

  /**
   * Resolve {@link _repositoryScope} after the available-repository list
   * changes.
   *
   * - No explicit user choice yet: re-derive the default from
   *   `intellig.log.showAllRoots` on EVERY population — `'all'` when the flag
   *   is on AND there's more than one repo, otherwise the single (context)
   *   repo. The flag defaults to ON, so a multi-root workspace opens to the
   *   merged log, matching the branch view. Re-deriving (rather than seeding
   *   once) is what makes the default follow incremental discovery: a
   *   single-repo first paint promotes to merged once the second repo arrives.
   * - After an explicit choice ({@link _scopeUserChosen}): preserve it. `'all'`
   *   is kept while multiple repos remain and collapses to the single repo when
   *   the workspace drops to one; a specific-repo scope tracks the
   *   identity-stable context index resolved above.
   */
  private _resolveRepositoryScope(repos: IRepository[]): void {
    if (repos.length === 0) {
      // No repos to show — PRESERVE the current scope rather than clobbering it
      // to a single-repo index, so a merged 'all' scope survives the workspace
      // emptying and refilling (close then reopen all folders). Nothing indexes
      // the scope while the list is empty; the next non-empty population
      // re-derives it correctly.
      return;
    }

    if (!this._scopeUserChosen) {
      this._repositoryScope =
        repos.length > 1 && this._host.readShowAllRootsConfig()
          ? 'all'
          : this._selectedRepositoryIndex;
      return;
    }

    if (this._repositoryScope === 'all') {
      this._repositoryScope = repos.length > 1 ? 'all' : this._selectedRepositoryIndex;
      return;
    }

    this._repositoryScope = this._selectedRepositoryIndex;
  }

  /**
   * Handle a repository scope change from the webview.
   *
   * Accepts either the `'all'` sentinel (merged multi-root view) or a numeric
   * repository index. Numeric indices are clamped to the valid range with a
   * warning. Fires the host's scope-change event for both cases so the
   * extension host can re-route the log and branches in lockstep.
   *
   * @param selection - The repository index, or `'all'`, selected by the user
   */
  public handleRepositorySelection(selection: number | 'all'): void {
    if (this._availableRepositories.length === 0) {
      return;
    }

    if (selection === 'all') {
      this._repositoryScope = 'all';
      this._visibleRepoRoots = null;
      this._scopeUserChosen = true;
      this._host.fireStateChange();
      this._host.fireScopeChange({ kind: 'all' });
      return;
    }

    // A non-integer (e.g. `NaN` from `Number('x')` in a garbled webview message)
    // passes both `< 0` and `>= len` as false, so the clamp below wouldn't fire
    // and `NaN` would brick the scope state. Reject it outright.
    if (!Number.isInteger(selection)) {
      getLogger()
        .child({ component: 'RepoScopeModel' })
        .warn('ignoring non-integer repository index', { index: selection });
      return;
    }

    // Clamp to valid range
    let clampedIndex = selection;
    if (selection < 0 || selection >= this._availableRepositories.length) {
      getLogger()
        .child({ component: 'RepoScopeModel' })
        .warn('repository index out of bounds; clamping to valid range', {
          index: selection,
          maxIndex: this._availableRepositories.length - 1,
        });
      clampedIndex = Math.max(0, Math.min(selection, this._availableRepositories.length - 1));
    }

    this._selectedRepositoryIndex = clampedIndex;
    this._repositoryScope = clampedIndex;
    this._visibleRepoRoots = null;
    this._scopeUserChosen = true;
    this._host.fireStateChange();

    const selectedRepo = this._availableRepositories[clampedIndex];
    this._host.fireScopeChange({ kind: 'repository', repository: selectedRepo });
  }

  /**
   * Handle a multi-repository scope change from the "Repository" log filter,
   * where the user checks the subset of roots to show. The checked set collapses
   * to the existing single/all scopes at the extremes so those paths (HEAD
   * spine, root column, branch-option source) are unchanged:
   *   - all (or none) checked → `'all'`, no visible subset.
   *   - exactly one checked   → that single-repo scope.
   *   - 2 .. n-1 checked      → merged `'all'` filtered to {@link _visibleRepoRoots}.
   *
   * Roots arrive as fsPath strings from the untrusted webview and are matched by
   * normalized path (spec L14); unknown roots are ignored. The subset case fires
   * a single `{ kind: 'all' }` scope change — the loader re-reads the subset from
   * {@link getVisibleRepoRoots} — so the merged log re-routes in lockstep.
   *
   * @param roots - fsPaths of the repositories the user checked
   */
  public handleVisibleRepositoriesSelection(roots: string[]): void {
    if (this._availableRepositories.length === 0) {
      return;
    }
    // roots arrives from the untrusted webview; drop any non-string element so a
    // tampered payload can't throw inside normalizeRepoPathString (it would be
    // caught + logged upstream, but the selection would silently no-op).
    const checked = new Set(
      roots.filter((p): p is string => typeof p === 'string').map((p) => normalizeRepoPathString(p))
    );
    const matched = this._availableRepositories.filter((r) =>
      checked.has(normalizeRepoPath(r.rootUri))
    );
    const n = this._availableRepositories.length;

    if (matched.length === n) {
      this.handleRepositorySelection('all'); // every repo checked → show all
      return;
    }
    if (matched.length === 1) {
      this.handleRepositorySelection(this._availableRepositories.indexOf(matched[0]));
      return;
    }

    // 0 (none checked) or 2..n-1 (a partial subset) both stay in the merged
    // scope with an explicit visible set. An EMPTY set means "show no commits"
    // — unchecking everything must NOT snap back to "all"; the user re-checks
    // (or ticks "All repositories") to restore.
    this._repositoryScope = 'all';
    this._visibleRepoRoots = matched.map((r) => r.rootUri.fsPath);
    this._scopeUserChosen = true;
    this._host.fireStateChange();
    this._host.fireScopeChange({ kind: 'all' });
  }

  /**
   * Reset an explicit EMPTY visible-roots selection back to "all". Part of
   * "the filter" for the Clear button: without it, Clear leaves the list
   * empty.
   */
  public clearEmptyVisibleRepoScope(): void {
    if (this._visibleRepoRoots !== null && this._visibleRepoRoots.length === 0) {
      this._visibleRepoRoots = null;
      this._host.fireStateChange();
      this._host.fireScopeChange({ kind: 'all' });
    }
  }

  /**
   * Rebuild the per-commit repo-root index from a log snapshot so
   * commit-targeted ops resolve the right repo in the merged view. Rebuilt
   * (not merged) so a refresh that drops commits drops their mappings too.
   * Called by `updateLogState` with each new snapshot.
   */
  public rebuildCommitRoots(commits: readonly ICommit[]): void {
    this._commitRepoRoots = new Map();
    for (const commit of commits) {
      if (commit.repoRoot) {
        const existing = this._commitRepoRoots.get(commit.hash);
        if (existing === undefined) {
          this._commitRepoRoots.set(commit.hash, commit.repoRoot);
        } else if (existing !== null && existing !== commit.repoRoot) {
          // Same hash from a second root (two checkouts of one repo in the
          // merged view) — the hash is ambiguous; mark it so the lookup
          // refuses rather than aiming an action at an arbitrary checkout.
          this._commitRepoRoots.set(commit.hash, null);
        }
      }
    }
  }

  /** Drop the cached parsed remote for one repo root (it mutated). */
  public invalidateRemote(fsPath: string): void {
    this._parsedRemoteCache.delete(fsPath);
  }

  /** Drop every cached parsed remote (unkeyed change or service re-attach). */
  public clearRemoteCache(): void {
    this._parsedRemoteCache.clear();
  }

  /**
   * Get the currently selected repository.
   * Returns undefined if no repositories are available.
   */
  public getSelectedRepository(): IRepository | undefined {
    if (this._availableRepositories.length === 0) {
      return undefined;
    }
    return this._availableRepositories[this._selectedRepositoryIndex];
  }

  /** The identity-stable index backing {@link getSelectedRepository}. */
  public getSelectedRepositoryIndex(): number {
    return this._selectedRepositoryIndex;
  }

  /** The available-repository list as last populated (live array — read only). */
  public getAvailableRepositories(): IRepository[] {
    return this._availableRepositories;
  }

  /** The effective scope: `'all'` merged, or the selected repo index. */
  public getRepositoryScope(): 'all' | number {
    return this._repositoryScope;
  }

  /**
   * Whether the current scope is the merged "all repositories" view (vs. a
   * single repository). The selector's runtime source of truth — drives both
   * the merged log and the grouped branch tree.
   */
  public isAllReposSelected(): boolean {
    return this._repositoryScope === 'all';
  }

  /**
   * The visible subset of repository root fsPaths in merged scope, or `null`
   * when every available root is shown. The merged log loader intersects the
   * discovered repos with this to honor a "some but not all roots" selection.
   */
  public getVisibleRepoRoots(): string[] | null {
    return this._visibleRepoRoots;
  }

  /**
   * The repositories currently in scope for merged-view work (branch-filter
   * options, etc.). The full available list unless a subset is active, in which
   * case only the chosen roots (matched by normalized path).
   */
  public getVisibleRepositories(): IRepository[] {
    if (!this._visibleRepoRoots) {
      return this._availableRepositories;
    }
    const visible = new Set(this._visibleRepoRoots.map((p) => normalizeRepoPathString(p)));
    return this._availableRepositories.filter((r) => visible.has(normalizeRepoPath(r.rootUri)));
  }

  /**
   * The default-branch short names of the in-scope repositories — the trunk set
   * the graph coloring pins to blue and gives the mainline-owning tier. In a
   * single-repo scope that's the one selected repo's default; in the merged view
   * it's the union across the visible repos. Empty when no in-scope repo reports
   * a default (the coloring then falls back to `main`/`master`).
   */
  public trunkBranchNamesForScope(): string[] {
    const inScope = this.isAllReposSelected()
      ? this.getVisibleRepositories()
      : [this.getSelectedRepository()];
    const names = new Set<string>();
    for (const repo of inScope) {
      if (repo?.defaultBranch) {
        names.add(repo.defaultBranch);
      }
    }
    return [...names];
  }

  /**
   * Source repository root for a commit in the merged "all roots" log, or
   * `undefined` when the commit isn't from the merged view (single-repo /
   * specific-scope log), isn't in the current snapshot, or — fail closed —
   * exists in MORE THAN ONE root (two checkouts of the same repo carry
   * identical hashes; the hash alone cannot say which one was meant).
   * Commit-targeted operations use this to act on the repo the CLICKED
   * commit belongs to rather than the single "context" repo
   * {@link getSelectedRepository} returns. Callers deciding what to PIN want
   * {@link resolveCommitRepoPin}, which keeps the ambiguous answer distinct
   * from the not-recorded one.
   */
  public getRepoRootForCommit(hash: string): string | undefined {
    return this._commitRepoRoots.get(hash) ?? undefined;
  }

  /**
   * The repo root a commit-targeted action should PIN, or `undefined` to let
   * the command resolve the repo itself.
   *
   * Three cases, and they are not the same:
   *  - the snapshot names an owner → pin it;
   *  - the snapshot says AMBIGUOUS (the hash lives in more than one root) →
   *    pin nothing. The command's own probing resolver finds the owner;
   *    substituting the selected repo would pin an arbitrary one, and callers
   *    that trust a pin skip probing and act on a repo that never held the
   *    commit;
   *  - the snapshot knows nothing (single-repo or specific-scope log, where
   *    per-commit roots are not recorded) → the selected repo IS the context.
   */
  public resolveCommitRepoPin(hash: string): string | undefined {
    const known = this._commitRepoRoots.get(hash);
    if (known !== undefined) {
      // `null` is the recorded ambiguous verdict — fail closed.
      return known ?? undefined;
    }
    return this.getSelectedRepository()?.rootUri.fsPath;
  }

  /**
   * Parse and cache the first remote URL for the currently selected
   * repository. Falls back to `origin` when present, otherwise the first
   * remote. Returns `undefined` when the repo has no remotes or when the
   * URL can't be parsed (e.g. custom SCP-style remote we don't know about).
   *
   * The cache key is the repo's root filesystem path; entries survive
   * repository-selector changes.
   */
  public getSelectedRepoRemote(): IRemoteUrl | undefined {
    const repo = this.getSelectedRepository();
    if (!repo) {
      return undefined;
    }
    const key = repo.rootUri.fsPath;
    if (this._parsedRemoteCache.has(key)) {
      return this._parsedRemoteCache.get(key);
    }
    const remotes = repo.remotes ?? [];
    if (remotes.length === 0) {
      this._parsedRemoteCache.set(key, undefined);
      return undefined;
    }
    const preferred = remotes.find((r) => r.name === 'origin') ?? remotes[0];
    const url = preferred.fetchUrl ?? preferred.pushUrl;
    const parsed = parseRemoteUrl(url);
    this._parsedRemoteCache.set(key, parsed);
    return parsed;
  }

  /**
   * The selected repository's display identity — its root basename and
   * home-abbreviated root path — for the changed-files heading. Undefined
   * when no repository is selected.
   */
  public getSelectedRepoProject(): { name: string; path: string } | undefined {
    const repo = this.getSelectedRepository();
    if (!repo) {
      return undefined;
    }
    const fsPath = repo.rootUri.fsPath;
    return { name: path.basename(fsPath) || fsPath, path: abbreviateHomePath(fsPath) };
  }
}
