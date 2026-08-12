import * as vscode from 'vscode';
import type { IGitService, IGitServiceCli, IRepository } from '../services';
import type { ILogFilter } from '../git-core/interfaces/IGitToolWindowProvider';
import { buildGitArgs } from '../git-core/gitCli';
import { sanitizeGitError } from '../git-core/gitError';
import { resolveRepo } from '../utils/resolveRepo';
import { buildIntelligGitUri } from '../commands/registration/explorerCommands';

/**
 * The repository SCOPE the Git tool window's selector emits. `'all'` shows
 * the merged multi-root log; a `repository` scope narrows the LOG to a single
 * repo and records that repo on the branch tree (whose grouped multi-root
 * layout persists either way — the selector filters the log, not the tree).
 */
export type RepositoryScopeSelection =
  | { readonly kind: 'all' }
  | { readonly kind: 'repository'; readonly repository: IRepository };

/**
 * Minimal provider surface that {@link loadAllPanelDataCore} drives. Declared
 * structurally so unit tests can pass a lightweight stub that records the
 * `setHasRepository` argument without standing up a full
 * `GitToolWindowProvider`.
 */
export interface ILoadAllPanelDataProvider {
  setAvailableRepositories(repos: IRepository[]): void;
  setHasRepository(hasRepository: boolean): void;
}

/**
 * Dependencies for {@link loadAllPanelDataCore}, injected so the
 * `activate`-scoped `loadAllPanelData` closure stays a thin delegation and the
 * bounded-loading guarantee can be unit-tested at the fix's call site.
 */
export interface ILoadAllPanelDataDeps {
  discoverAllRepositories: () => Promise<IRepository[]>;
  provider: ILoadAllPanelDataProvider | undefined;
  loadLogCommits: (filter?: ILogFilter) => Promise<void>;
  /**
   * The tool window's ACTIVE log filter. Every load through this path — the
   * initial load and each watcher/refresh-triggered reload — reapplies it,
   * so a background refresh can never silently widen a filtered log back to
   * all commits while the filter row still shows the old values.
   */
  activeLogFilter?: () => ILogFilter | undefined;
}

/**
 * Core of the Git tool window's "load all panel data" flow, extracted from the
 * `activate`-scoped `loadAllPanelData` closure so the no-repository wiring is
 * directly testable.
 *
 * The load-bearing line for Requirement 3 is
 * `provider.setHasRepository(repositories.length > 0)`: repository detection has
 * completed by the time `discoverAllRepositories` resolves, so reporting the
 * outcome to the provider always resolves the transient Loading_State. When
 * repositories exist, `updateLogState` (reached via `loadLogCommits`) later
 * flips `_hasRepository=true` and renders the graph; when there are none, this
 * call is the only signal that leaves Loading and lands the view in
 * No_Repository_State, so the tool window never stays stuck on the spinner.
 *
 * @internal — exported only for
 * `src/test/unit/extension/loadAllPanelData.test.ts`. Do not call from
 * production code outside the `loadAllPanelData` closure without review.
 */
export async function loadAllPanelDataCore(deps: ILoadAllPanelDataDeps): Promise<void> {
  const repositories = await deps.discoverAllRepositories();

  // Pass all discovered repositories to the provider for the repository selector.
  if (deps.provider) {
    deps.provider.setAvailableRepositories(repositories);
    // Repository detection has now completed. Resolve the loading state with the
    // detection outcome so the tool window never stays stuck on the spinner.
    deps.provider.setHasRepository(repositories.length > 0);
  }

  await deps.loadLogCommits(deps.activeLogFilter?.());
}

/**
 * Minimal surfaces of the providers that {@link wireRepositorySelection}
 * needs. Declared structurally so unit tests can pass lightweight stubs and
 * record both wiring effects (graph reload + branch tree refresh) without
 * standing up the full extension host.
 */
export interface IRepoSelectionToolWindowProvider {
  onDidChangeRepositoryScope: vscode.Event<RepositoryScopeSelection>;
}
export interface IRepoSelectionBranchTreeProvider {
  setRepository(repo: IRepository): void;
}

/**
 * Wire the Git tool window's repository scope off the single
 * `onDidChangeRepositoryScope` event:
 *   - scope `'all'`        → merged multi-root log (`loadAllRootsLog`)
 *   - scope `repository`   → single-repo log (`loadLogCommitsForRepo`) +
 *                            record the repo on the branch tree
 *                            (`setRepository` — the tree's grouped layout
 *                            persists; only its fallback repo updates)
 *
 * Routing everything off one event is what keeps the log and the branch
 * tree's recorded repo from disagreeing — the original bug was the dropdown
 * updating one view while the other silently desynced.
 *
 * Returns the disposables so the caller can register them with
 * `context.subscriptions.push(...)`.
 *
 * @internal — exported for `src/test/unit/extension/repoSelectionWiring.test.ts`.
 */
export function wireRepositorySelection(deps: {
  toolWindowProvider: IRepoSelectionToolWindowProvider;
  branchTreeProvider: IRepoSelectionBranchTreeProvider;
  loadLogCommitsForRepo: (repo: IRepository, filter?: ILogFilter) => Promise<void>;
  loadAllRootsLog: (filter?: ILogFilter) => Promise<void>;
  /**
   * The tool window's ACTIVE log filter, read at event time (the filter can
   * change between wiring and any given scope event). Scope reloads reapply
   * it for the same reason `loadAllPanelDataCore` does: a reload that drops
   * the filter silently widens a filtered log back to all commits while the
   * filter row still shows the old values.
   */
  activeLogFilter: () => ILogFilter | undefined;
}): vscode.Disposable[] {
  const scopeListener = deps.toolWindowProvider.onDidChangeRepositoryScope(async (scope) => {
    const filter = deps.activeLogFilter();
    if (scope.kind === 'all') {
      await deps.loadAllRootsLog(filter);
      return;
    }
    deps.branchTreeProvider.setRepository(scope.repository);
    await deps.loadLogCommitsForRepo(scope.repository, filter);
  });
  return [scopeListener];
}

/**
 * Minimal provider surface for {@link wireAvailableRepositorySync}.
 */
export interface IAvailableRepositoriesProvider {
  setAvailableRepositories(repos: IRepository[]): void;
}

/**
 * Minimal GitService surface for {@link wireAvailableRepositorySync}.
 */
export interface IAvailableRepositoriesGitService {
  getRepositories(): IRepository[];
  onDidChangeRepository: vscode.Event<IRepository>;
  onDidRemoveRepository: vscode.Event<IRepository>;
}

/**
 * Keep the Git tool window's available-repository list in sync with
 * GitService's authoritative repository set.
 *
 * Derives the list purely from `getRepositories()` on every
 * `onDidChangeRepository` / `onDidRemoveRepository` — the events that fire when
 * GitService's own discovery completes, including for NESTED repos found
 * asynchronously after a workspace folder is added. This replaces a redundant
 * `onDidChangeWorkspaceFolders` listener that re-resolved the folder root with a
 * root-only `getRepository(folder.uri)` and read the repo list before nested
 * discovery finished, so the provider could momentarily miss nested repos.
 *
 * Pushes on every event. `onDidChangeRepository` fires on each
 * commit/checkout/fetch, and a reload REPLACES the repository objects even when
 * the root set is identical — the stored array feeds action paths, so a caller
 * that skipped the push would freeze superseded objects into them.
 * `setAvailableRepositories` stores unconditionally and repaints only when the
 * document-visible state changed, so the churn this used to guard against is
 * handled where the render decision lives.
 *
 * Returns the disposables so the caller can register them with
 * `context.subscriptions.push(...)`.
 *
 * @internal — exported for
 *   `src/test/unit/extension/availableRepositorySync.test.ts`.
 */
export function wireAvailableRepositorySync(deps: {
  provider: IAvailableRepositoriesProvider;
  gitService: IAvailableRepositoriesGitService;
}): vscode.Disposable[] {
  const sync = (): void => {
    deps.provider.setAvailableRepositories(deps.gitService.getRepositories());
  };

  return [deps.gitService.onDidChangeRepository(sync), deps.gitService.onDidRemoveRepository(sync)];
}

/**
 * Provider surface {@link resolveCommitRepoByRoot} reads to map a commit hash
 * to its source repository root. Declared structurally so the resolution is
 * unit-testable without standing up a full `GitToolWindowProvider`.
 */
export interface ICommitRepoRootSource {
  getRepoRootForCommit(hash: string): string | undefined;
}

/**
 * Resolve the repository a CLICKED commit belongs to in the merged "all roots"
 * log. Returns the repo whose root the provider recorded for `hash`, or
 * `undefined` when no root is recorded (single-repo / specific-scope log) or
 * the recorded root no longer resolves — in which case the caller falls back
 * to its existing chain (`getSelectedRepository()` etc.).
 *
 * Without this, commit-select / commit-diff in 'all' scope ran against the
 * single "context" repo, producing wrong/empty diffs for foreign-repo commits
 * (often the newest commit in the interleaved merged log).
 *
 * @internal — exported for
 *   `src/test/unit/extension/commitRepoResolution.test.ts`.
 */
export async function resolveCommitRepoByRoot(
  provider: ICommitRepoRootSource | undefined,
  gitService: Pick<IGitService, 'getRepository'>,
  hash: string
): Promise<IRepository | undefined> {
  const repoRoot = provider?.getRepoRootForCommit(hash);
  if (!repoRoot) {
    return undefined;
  }
  return gitService.getRepository(vscode.Uri.file(repoRoot));
}

/**
 * Provider surface for {@link resolveRepoForCommitDiff}: the recorded-root
 * lookup plus the tool-window's currently selected repo.
 */
export interface ICommitDiffRepoSource extends ICommitRepoRootSource {
  getSelectedRepository?(): IRepository | undefined;
}

/**
 * Resolve the repository to open a commit's file diff against —
 * NON-INTERACTIVELY, always returning the repo that actually CONTAINS the
 * commit.
 *
 * The "Changed files" double-click-to-diff handler previously fell back to
 * `resolveRepo`, which pops a "Choose Repository" QuickPick in a multi-repo
 * workspace (the user was prompted when they should not be), and never verified
 * the chosen repo held the commit — so a wrong pick ran
 * `getCommitDiff(wrongRepo, hash)`, found no matching file, and opened a BLANK
 * diff. This resolver never prompts: it tries the commit's recorded source root,
 * then the tool-window's selected repo, then every open repo, returning the
 * first whose `getCommit(hash)` succeeds. Returns `undefined` only when no open
 * repo contains the commit (caller surfaces an informative error, not a blank
 * view).
 */
export async function resolveRepoForCommitDiff(
  provider: ICommitDiffRepoSource | undefined,
  gitService: Pick<IGitService, 'getRepository' | 'getRepositories' | 'getCommit'>,
  hash: string
): Promise<IRepository | undefined> {
  const contains = async (repo: IRepository | undefined): Promise<IRepository | undefined> => {
    if (!repo) {
      return undefined;
    }
    try {
      await gitService.getCommit(repo, hash);
      return repo;
    } catch {
      return undefined;
    }
  };

  const byRoot = await contains(await resolveCommitRepoByRoot(provider, gitService, hash));
  if (byRoot) {
    return byRoot;
  }
  const selected = await contains(provider?.getSelectedRepository?.());
  if (selected) {
    return selected;
  }
  for (const repo of gitService.getRepositories()) {
    const hit = await contains(repo);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/**
 * Build the left/right `intellig-git:` URIs for the "Changed files"
 * double-click diff of `filePath` at `commitHash`, comparing the commit
 * against its first parent (`<hash>~1`).
 *
 * Both URIs encode `repoRootFsPath` (the repo resolved by
 * {@link resolveRepoForCommitDiff}) so the content provider resolves the diff
 * against the repo that actually owns the commit. Omitting the root left the
 * provider to GUESS in a multi-root workspace — prompting for a repo and, on a
 * wrong/empty resolution, opening a blank or all-added ("all green") diff.
 *
 * @internal — exported for `src/test/unit/extension/commitFileDiffUris.test.ts`.
 */
export function buildCommitFileDiffUris(
  filePath: string,
  commitHash: string,
  repoRootFsPath: string
): { leftUri: vscode.Uri; rightUri: vscode.Uri } {
  return {
    leftUri: buildIntelligGitUri(filePath, `${commitHash}~1`, repoRootFsPath),
    rightUri: buildIntelligGitUri(filePath, commitHash, repoRootFsPath),
  };
}

/**
 * HEAD anchor (graph spine + current-branch highlight) for a freshly loaded
 * log.
 *
 * In the merged "All Repositories" scope the log interleaves commits from every
 * root, so anchoring to ONE repo's HEAD would colour only that repo's current
 * branch yellow and pin only its first-parent spine to lane 0 across the
 * combined graph — misleadingly singling out the context repo. IntelliJ
 * highlights EACH root's HEAD; matching that faithfully needs per-row repo
 * identity on the branch chips (the combined branch map keys chips by commit
 * hash, dropping which root they came from) plus a multi-spine layout, beyond
 * this view's model. So merged mode SUPPRESSES the anchor — no single-repo HEAD
 * highlight, no single-repo spine. Single-repo / specific scope keeps the
 * repo's own HEAD (hash for the lane-0 spine, de-prefixed branch name for the
 * yellow current-branch chip).
 *
 * @internal — exported for `src/test/unit/extension/commitRepoResolution.test.ts`.
 */
export function resolveLogHeadAnchor(
  merged: boolean,
  headRepo: Pick<IRepository, 'head'> | undefined
): { headHash?: string; headBranchName?: string } {
  if (merged) {
    return {};
  }
  return {
    headHash: headRepo?.head?.commit,
    headBranchName: headRepo?.head?.name?.replace(/^refs\/heads\//, ''),
  };
}

/**
 * Minimal git-service surface that {@link wireRebasePausedWarning} consumes.
 * Declared structurally so unit tests can pass a lightweight stub without
 * standing up the full `GitService`. Only the two members the wiring
 * actually touches are listed.
 */
export interface IRebaseWarningGitService {
  getRepositories(): IRepository[];
  onDidChangeRepository: vscode.Event<IRepository>;
}

/**
 * Toast surface the rebase-paused warning routes through. Split out from
 * `vscode.window` so the unit test can capture invocations without
 * monkey-patching the real namespace.
 */
export interface IRebaseWarningToastSurface {
  showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>;
}

/**
 * Command-execution surface for the warning's actionable items. Same
 * dependency-injection rationale as {@link IRebaseWarningToastSurface}.
 */
export interface IRebaseWarningCommandRunner {
  executeCommand(command: string): Thenable<unknown>;
}

/**
 * One paused-operation toast shape: the message built for a repo plus the
 * button → command routing. Kept in a single table so the rebase and git-am
 * arms cannot drift (the am arm exists precisely because am sessions used to
 * masquerade as rebases and be offered recovery commands git refuses).
 */
const PAUSED_OPERATION_TOASTS: Record<
  'rebasing' | 'applying',
  { message: (repoName: string) => string; actions: ReadonlyArray<[string, string]> }
> = {
  rebasing: {
    message: (repoName) =>
      `A rebase is paused in '${repoName}'. ` +
      `Resolve any conflicts and continue, or abort to restore the pre-rebase state.`,
    actions: [
      ['Continue', 'intellig.rebase.continue'],
      ['Abort', 'intellig.rebase.abort'],
      ['Skip Commit', 'intellig.rebase.skip'],
    ],
  },
  applying: {
    message: (repoName) =>
      `A patch apply (git am) is paused in '${repoName}'. ` +
      `Resolve any conflicts and continue, or abort to restore the pre-apply state.`,
    actions: [
      ['Continue', 'intellig.am.continue'],
      ['Abort', 'intellig.am.abort'],
      ['Skip Patch', 'intellig.am.skip'],
    ],
  },
};

/**
 * Surface a warning toast when ANY open repository has a paused operation the
 * user must finish by hand — `inProgress.kind === 'rebasing'` (paused rebase)
 * or `'applying'` (paused `git am` session) — gated on a per-repo warned-set
 * so the same paused operation isn't re-announced on every
 * `onDidChangeRepository` event.
 *
 * Each kind offers its OWN recovery buttons ({@link PAUSED_OPERATION_TOASTS}):
 * a paused rebase routes to `intellig.rebase.continue/abort/skip`, a paused am
 * session to `intellig.am.continue/abort/skip`. The two must never cross —
 * git refuses `rebase --continue/--abort` during an am session (and vice
 * versa), so a mislabeled toast is a dead end. Without this surface, a user
 * who reloaded VS Code mid-operation (or inherited a paused one from a CLI
 * session) had to know the recovery commands by name before any UI signal
 * appeared. See `KNOWN-ISSUES.md` "Rebase recovery" entry for the original
 * deferral rationale.
 *
 * Returns disposables so the caller can register them with
 * `context.subscriptions.push(...)`. The helper itself manages the
 * warned-set; callers don't need to clean it up.
 *
 * @internal — exported for
 *   `src/test/unit/extension/rebasePausedWarning.test.ts`.
 */
export function wireRebasePausedWarning(deps: {
  gitService: IRebaseWarningGitService;
  window: IRebaseWarningToastSurface;
  commands: IRebaseWarningCommandRunner;
  /**
   * True when the extension itself is driving this rebase (a squash /
   * interactive-rebase episode owns a live RebaseService session). Such a
   * rebase transiently reports `rebasing` while it runs to completion, and owns
   * its OWN progress/conflict/pause messaging — so this generic
   * inherited-rebase toast must not fire for it. Absent → treat nothing as
   * managed (every rebasing repo warns, the pre-existing behavior).
   */
  isManagedRebase?: (repo: IRepository) => boolean;
}): vscode.Disposable[] {
  // Per-repo warned KIND — a value change (rebasing → applying, or any kind →
  // idle → kind) re-arms the toast, so a different paused operation on the
  // same repo is announced with its own recovery actions.
  const warned = new Map<string, 'rebasing' | 'applying'>();

  const fireForRepo = async (repo: IRepository): Promise<void> => {
    const rootPath = repo.rootUri.fsPath;
    const inProgressKind = repo.inProgress?.kind;

    // Reset the warned-set entry whenever the paused operation clears so a
    // future one will re-warn. The clear can happen after the user runs
    // continue/abort/skip, or when an external tool ends the operation.
    if (inProgressKind !== 'rebasing' && inProgressKind !== 'applying') {
      warned.delete(rootPath);
      return;
    }

    // A rebase the extension is actively driving (squash / interactive rebase)
    // transiently reports `rebasing` mid-run and owns its own messaging; don't
    // fire the generic inherited-rebase toast for it. am sessions are never
    // extension-driven rebase episodes, so the gate is rebase-only.
    if (inProgressKind === 'rebasing' && deps.isManagedRebase?.(repo)) {
      return;
    }

    if (warned.get(rootPath) === inProgressKind) {
      return;
    }
    warned.set(rootPath, inProgressKind);

    const toast = PAUSED_OPERATION_TOASTS[inProgressKind];
    const choice = await deps.window.showWarningMessage(
      toast.message(rootPath.split('/').pop() ?? rootPath),
      ...toast.actions.map(([label]) => label)
    );
    const chosen = toast.actions.find(([label]) => label === choice);
    if (chosen) {
      await deps.commands.executeCommand(chosen[1]);
    }
    // Other choices (Esc / dismissed): leave the warned-set entry in
    // place. The user explicitly dismissed; don't re-warn until the
    // operation state changes.
  };

  // Initial scan: any repo already in `rebasing` state at activation
  // gets a warning. Fire-and-forget so activation isn't blocked by a
  // slow toast pipeline.
  for (const repo of deps.gitService.getRepositories()) {
    void fireForRepo(repo);
  }

  // Per-repo listener: re-evaluates the warned-set whenever a repo's
  // state transitions in or out of `rebasing`.
  const changeListener = deps.gitService.onDidChangeRepository((repo) => {
    void fireForRepo(repo);
  });

  return [changeListener];
}

/**
 * Resolve the content of an `intellig-git:` URI by running `git show <ref>:<path>`.
 *
 * Exported so it is unit-testable. The production entry point
 * `registerGitContentProvider` wires this to the module-level `extensionServices`
 * and to the real `vscode.workspace.workspaceFolders` fallback; tests call this
 * directly with a `GitService` whose `_gitCli` has been swapped for a mock.
 *
 * Query-shape contract (ADR pending): producers MUST emit
 * `intellig-git:${path}?${encodeURIComponent(ref)}`. This function
 * `decodeURIComponent`s the query exactly once so refs containing `/`
 * (`origin/main` → `origin%2Fmain` on the wire) round-trip back to `git show`.
 *
 * @internal — exported only for `src/test/unit/extension/contentProvider.test.ts`.
 * Do not call from production code or new tests outside that file without review.
 */
export async function provideGitShowContent(
  uri: vscode.Uri,
  gitService: IGitService,
  workspaceFolders?: readonly { uri: vscode.Uri }[]
): Promise<string> {
  const filePath = uri.path;
  // Two query shapes are accepted (the provider is shared by many producers):
  //
  //   - STRUCTURED: `ref=<ref>&repoRoot=<absRepoRoot>` — emitted by producers
  //     that know the repo root (the explorer diff commands). `repoRoot` is
  //     essential when `filePath` is repo-root-relative AND the workspace
  //     folder is an ANCESTOR of the repo (a nested repo / submodule, or a
  //     multi-root workspace): the folder-fallback below would otherwise
  //     resolve the wrong root and `git show` would fail.
  //   - LEGACY: the entire query is `encodeURIComponent(ref)` with no
  //     repoRoot — every other producer (commit/branch/history diffs). These
  //     keep relying on the hint/active/first-folder fallback chain.
  //
  // Discriminate on BOTH structured keys being present: `buildIntelligGitUri`
  // only emits the structured form when a repoRoot is set, and it always
  // includes `ref`, so a structured URI always has both keys. A legacy query
  // is `encodeURIComponent(ref)` — a single keyless token (any `=`/`&` in the
  // ref is `%3D`/`%26`), so it can never carry two keys. A one-key check would
  // misclassify a legacy ref literally named `ref` (query `ref` →
  // `URLSearchParams('ref').get('ref')` is `''`, not `null`) — and a
  // `repoRoot`-only check would just move that collision to a ref named
  // `repoRoot`. Requiring both keys is collision-free.
  let ref: string;
  let repoRootHint: string | undefined;
  const params = new URLSearchParams(uri.query);
  if (params.has('ref') && params.has('repoRoot')) {
    ref = params.get('ref') ?? '';
    repoRootHint = params.get('repoRoot') ?? undefined;
  } else {
    // A malformed percent-encoding (e.g. `%GG`) throws a raw `URIError` from
    // the platform `decodeURIComponent`. Wrap it in a friendly error that
    // identifies the contract violation so logs point at the URI rather than
    // at an opaque "URI malformed" message.
    try {
      ref = decodeURIComponent(uri.query);
    } catch (err) {
      throw new Error(`Malformed ref in intellig-git URI: ${uri.query}`, { cause: err });
    }
  }

  if (!ref) {
    throw new Error('No git ref specified in URI query');
  }

  // The git-show token is `${ref}:${filePath}`. `ref` is defended by
  // `--end-of-options` (below). `filePath` rides after the first `:`, so it
  // can't inject a flag, but a `:` inside it would make the rev:path split
  // ambiguous. No in-tree producer emits a colon-bearing path (all route
  // through repoRelativePath), so reject it before exec rather than hand git a
  // confusing token.
  if (filePath.includes(':')) {
    throw new Error(`Invalid file path in intellig-git URI (contains ':'): ${filePath}`);
  }

  // Prefer the explicit repoRoot the producer encoded — the only reliable
  // hint when `filePath` is repo-relative. Fall back to the legacy chain:
  // the path hint (works only for absolute paths), the active editor, then
  // the first workspace folder.
  let repo = repoRootHint
    ? await gitService.getRepository(vscode.Uri.file(repoRootHint))
    : undefined;
  if (!repo) {
    repo = await resolveRepo(gitService, {
      hintRepoPath: filePath,
      preferActive: true,
      silent: true,
    });
  }
  if (!repo) {
    const folders = workspaceFolders ?? vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      repo = await gitService.getRepository(folders[0].uri);
    }
  }
  if (!repo) {
    throw new Error('No Git repository found');
  }
  try {
    // `gitCli` is exposed via the `@internal` {@link IGitServiceCli} escape
    // hatch — the frozen {@link IGitService} composite deliberately doesn't
    // wrap raw `git show <ref>:<path>`. An eventual role-interface
    // decomposition (see backlog) would fold this into a proper method.
    //
    // `ref` is repo/producer-controlled (a malicious clone can hand-author
    // `refs/tags/--output=…` in packed-refs, reachable via any
    // `intellig-git:?ref=` opener). Route the rev:path token through
    // `buildGitArgs` so `--end-of-options` is spliced ahead of it — git can
    // then never parse a `-`-leading ref as a flag (e.g. `git show
    // --output=<file>`, an arbitrary out-of-repo file write).
    const result = await (gitService as unknown as IGitServiceCli).gitCli.exec(
      buildGitArgs('show', [], [`${ref}:${filePath}`]),
      {
        cwd: repo.rootUri.fsPath,
      }
    );
    if (result.exitCode !== 0) {
      // A path that is simply absent at this revision (a newly-added file
      // diffed against HEAD) is the expected empty case — render an empty doc
      // so the diff shows a full addition. Any OTHER non-zero exit (corrupt
      // object, unreadable repo) must surface rather than masquerade as an
      // empty file. An empty stderr is treated as the benign absence case.
      const stderr = (result.stderr ?? '').trim();
      const looksAbsent =
        stderr === '' ||
        /does not exist|exists on disk, but not in|no such path|invalid object name|not a valid object name|bad revision/i.test(
          stderr
        );
      if (looksAbsent) {
        return '';
      }
      throw new Error(`git show failed: ${sanitizeGitError(stderr)}`);
    }
    return result.stdout;
  } catch (err) {
    // A path-absent non-zero exit returned '' above. Reaching here means the
    // exec itself threw (spawn failure, etc.) or git reported a real error —
    // surface it instead of silently rendering an empty file.
    throw err instanceof Error ? err : new Error(String(err));
  }
}
