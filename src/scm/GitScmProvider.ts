import * as path from 'path';
import * as vscode from 'vscode';

import { formatActionFailureToast } from '../git-core/gitError';
import type { IFileStatus, IGitService, IRepository, StatusCode } from '../services';
import { runBeforeCommitChecks } from '../commits/CheckinChecks';

/**
 * Command id wired to each SourceControl's `acceptInputCommand`. Internal
 * (not contributed to the palette or any menu): VS Code invokes it when the
 * user accepts the commit input (Ctrl+Enter) for the IntelliG SourceControl.
 */
export const SCM_ACCEPT_COMMIT_COMMAND = 'intellig.scm.acceptCommit';

/**
 * Minimal slice of the VS Code SCM factory the provider depends on, declared so
 * unit tests can inject a fake that records the created `SourceControl`s /
 * resource groups without standing up an extension host. Production wires this
 * to the real {@link vscode.scm}.
 */
export interface IScmApi {
  createSourceControl(id: string, label: string, rootUri?: vscode.Uri): vscode.SourceControl;
}

/** Default {@link IScmApi} backed by the live `vscode.scm` namespace. */
const defaultScmApi: IScmApi = {
  createSourceControl: (id, label, rootUri) => vscode.scm.createSourceControl(id, label, rootUri),
};

/** The two resource-group ids; also used as the group-keying handles. */
const STAGED_GROUP_ID = 'staged';
const CHANGES_GROUP_ID = 'changes';

/** Theme + icon descriptor for a status code (mirrors git4idea status colors). */
interface IStatusDecoration {
  /** Human label shown in the tooltip and the diff-tab suffix (e.g. "Modified"). */
  label: string;
  /** Colored codicon conveying the status letter/color in the SCM view. */
  icon: vscode.ThemeIcon;
  /** Render the path struck through (deleted files). */
  strikeThrough: boolean;
}

/**
 * Map a single git short status code to its SCM decoration. The `diff-*`
 * codicons carry VS Code's native add/modify/delete coloring, so pairing each
 * with the matching `gitDecoration.*` theme color reproduces IntelliJ's
 * Local-Changes status letter/color without a global FileDecorationProvider
 * (which would also paint the file in the Explorer and collide with built-in
 * git).
 */
function decorationFor(code: StatusCode): IStatusDecoration {
  switch (code) {
    case 'A':
      return {
        label: 'Added',
        icon: new vscode.ThemeIcon(
          'diff-added',
          new vscode.ThemeColor('gitDecoration.addedResourceForeground')
        ),
        strikeThrough: false,
      };
    case 'D':
      return {
        label: 'Deleted',
        icon: new vscode.ThemeIcon(
          'diff-removed',
          new vscode.ThemeColor('gitDecoration.deletedResourceForeground')
        ),
        strikeThrough: true,
      };
    case 'R':
      return {
        label: 'Renamed',
        icon: new vscode.ThemeIcon(
          'diff-renamed',
          new vscode.ThemeColor('gitDecoration.renamedResourceForeground')
        ),
        strikeThrough: false,
      };
    case 'C':
      return {
        label: 'Copied',
        icon: new vscode.ThemeIcon(
          'diff-renamed',
          new vscode.ThemeColor('gitDecoration.renamedResourceForeground')
        ),
        strikeThrough: false,
      };
    case 'U':
      return {
        label: 'Conflict',
        icon: new vscode.ThemeIcon(
          'warning',
          new vscode.ThemeColor('gitDecoration.conflictingResourceForeground')
        ),
        strikeThrough: false,
      };
    case '?':
      return {
        label: 'Untracked',
        icon: new vscode.ThemeIcon(
          'diff-added',
          new vscode.ThemeColor('gitDecoration.untrackedResourceForeground')
        ),
        strikeThrough: false,
      };
    case '!':
      return {
        label: 'Ignored',
        icon: new vscode.ThemeIcon(
          'diff-ignored',
          new vscode.ThemeColor('gitDecoration.ignoredResourceForeground')
        ),
        strikeThrough: false,
      };
    case 'M':
    default:
      return {
        label: 'Modified',
        icon: new vscode.ThemeIcon(
          'diff-modified',
          new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
        ),
        strikeThrough: false,
      };
  }
}

/** Which side of the partition a resource belongs to — drives the diff title. */
type GroupKind = 'staged' | 'changes';

/**
 * Build one {@link vscode.SourceControlResourceState} for `relPath` at the
 * given status `code`.
 *
 * Click-to-diff mirrors IntelliJ's Local-Changes double-click, which compares
 * the working copy against the repository (HEAD) revision: the left side is the
 * committed file served by the `intellig-git:` content provider, the right side
 * is the live working-tree file. For untracked/added files `git show HEAD:` has
 * no content and the provider returns an empty document, so the diff renders as
 * a full addition.
 */
function makeResource(
  repoRoot: vscode.Uri,
  relPath: string,
  code: StatusCode,
  kind: GroupKind
): vscode.SourceControlResourceState {
  const decoration = decorationFor(code);
  const absPath = path.join(repoRoot.fsPath, relPath);
  const fileUri = vscode.Uri.file(absPath);
  // The intellig-git content provider keys off `uri.path` (repo-relative) and
  // `uri.query` (the ref). Build from explicit components rather than
  // interpolating into `Uri.parse(...)`: a relPath containing `?` or `#` would
  // otherwise be split into the query/fragment, corrupting the path the
  // provider reads. `query` keeps the legacy `encodeURIComponent(ref)` contract.
  const headUri = vscode.Uri.from({
    scheme: 'intellig-git',
    path: relPath,
    query: encodeURIComponent('HEAD'),
  });
  const suffix = kind === 'staged' ? 'Staged' : decoration.label;
  const title = `${path.basename(relPath)} (${suffix})`;

  return {
    resourceUri: fileUri,
    decorations: {
      tooltip: decoration.label,
      strikeThrough: decoration.strikeThrough,
      iconPath: decoration.icon,
    },
    command: {
      command: 'vscode.diff',
      title: 'Open Diff',
      arguments: [headUri, fileUri, title],
    },
    contextValue: `intellig.scm.${kind}.${code}`,
  };
}

/**
 * Partition a `git status` snapshot into the Staged and Changes resource lists.
 *
 * Rules (matching VS Code's built-in git and IntelliJ's Local Changes):
 *  - An unmerged/conflicted file (`U` on either side) is a single Changes entry
 *    and never appears in Staged.
 *  - Otherwise an index status other than clean (` `) or untracked (`?`) yields
 *    a Staged entry, and a non-clean worktree status yields a Changes entry; a
 *    file edited in both index and worktree appears in both groups.
 *
 * Exported for direct unit testing of the partition logic.
 */
export function buildScmResources(
  statuses: IFileStatus[],
  repoRoot: vscode.Uri
): { staged: vscode.SourceControlResourceState[]; changes: vscode.SourceControlResourceState[] } {
  const staged: vscode.SourceControlResourceState[] = [];
  const changes: vscode.SourceControlResourceState[] = [];

  for (const s of statuses) {
    if (s.indexStatus === 'U' || s.workTreeStatus === 'U') {
      changes.push(makeResource(repoRoot, s.path, 'U', 'changes'));
      continue;
    }
    if (s.indexStatus !== ' ' && s.indexStatus !== '?') {
      staged.push(makeResource(repoRoot, s.path, s.indexStatus, 'staged'));
    }
    if (s.workTreeStatus !== ' ') {
      changes.push(makeResource(repoRoot, s.path, s.workTreeStatus, 'changes'));
    }
  }

  return { staged, changes };
}

/** Per-repository SCM handles tracked by the provider. */
interface IRepoScm {
  repo: IRepository;
  sourceControl: vscode.SourceControl;
  stagedGroup: vscode.SourceControlResourceGroup;
  changesGroup: vscode.SourceControlResourceGroup;
}

/**
 * Native VS Code SCM integration ("IntelliG Git") — the analog of IntelliJ's
 * Local Changes view. Surfaces each discovered repository's working tree as a
 * {@link vscode.SourceControl} with a **Staged Changes** and a **Changes**
 * resource group, populated from the existing {@link IGitService.getStatus}
 * model and refreshed on the existing repo-change event. No new git operations
 * are introduced.
 */
export class GitScmProvider implements vscode.Disposable {
  private readonly repos = new Map<string, IRepoScm>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly gitService: IGitService,
    private readonly scm: IScmApi = defaultScmApi
  ) {}

  /**
   * Subscribe to repository add/change/remove and seed a SourceControl for
   * every already-discovered repository.
   */
  async initialize(): Promise<void> {
    this.disposables.push(
      vscode.commands.registerCommand(
        SCM_ACCEPT_COMMIT_COMMAND,
        (sourceControl: vscode.SourceControl) => this.commitFromInput(sourceControl)
      ),
      this.gitService.onDidChangeRepository((repo) => void this.syncRepo(repo)),
      this.gitService.onDidRemoveRepository((repo) => this.removeRepo(repo))
    );
    await Promise.all(this.gitService.getRepositories().map((repo) => this.syncRepo(repo)));
  }

  /**
   * Commit handler wired to each SourceControl's `acceptInputCommand`. Reads
   * the message from the SourceControl's input box and commits the repository's
   * staged changes, mirroring the built-in Git extension's commit-on-accept —
   * the native home for "Commit File" (ADR-014): the explorer action stages the
   * file, the user types a message here and accepts to commit. An empty message
   * is a no-op so a stray Ctrl+Enter never produces an empty commit.
   */
  async commitFromInput(sourceControl: vscode.SourceControl): Promise<void> {
    const entry = [...this.repos.values()].find((e) => e.sourceControl === sourceControl);
    if (!entry) {
      return;
    }
    const message = sourceControl.inputBox.value.trim();
    if (message.length === 0) {
      void vscode.window.showInformationMessage('Enter a commit message to commit.');
      return;
    }

    // Mirror the commit dialog / tool window: run the IDE before-commit checks
    // (missing identity, unresolved merge, detached HEAD) before a native
    // Ctrl+Enter commit, so the SCM accept path can't silently skip them. This
    // path has no `--no-verify` affordance, so the checks always run. The
    // committed set is the staged files (a no-pathspec `git commit` records the
    // index).
    let stagedPaths: string[] = [];
    try {
      const statuses = await this.gitService.getStatus(entry.repo);
      stagedPaths = statuses
        .filter(
          (s) =>
            s.indexStatus !== 'U' &&
            s.workTreeStatus !== 'U' &&
            s.indexStatus !== ' ' &&
            s.indexStatus !== '?'
        )
        .map((s) => s.path);
    } catch {
      stagedPaths = [];
    }
    const proceed = await runBeforeCommitChecks(this.gitService, entry.repo, stagedPaths);
    if (!proceed) {
      return;
    }

    try {
      await this.gitService.commit(entry.repo, message, {});
      sourceControl.inputBox.value = '';
      await this.syncRepo(entry.repo);
    } catch (error) {
      void vscode.window.showErrorMessage(formatActionFailureToast('Failed to commit', error));
    }
  }

  /** Lazily create (if needed) and refresh the SourceControl for `repo`. */
  private async syncRepo(repo: IRepository): Promise<void> {
    const key = repo.rootUri.fsPath;
    let entry = this.repos.get(key);
    if (!entry) {
      const sourceControl = this.scm.createSourceControl('intellig', 'IntelliG Git', repo.rootUri);
      // Commit the staged changes when the user accepts the input (Ctrl+Enter),
      // so the explorer "Commit File" action — which stages the file then
      // reveals this view — can be completed without a webview (ADR-014).
      sourceControl.acceptInputCommand = {
        command: SCM_ACCEPT_COMMIT_COMMAND,
        title: 'Commit',
        arguments: [sourceControl],
      };
      sourceControl.inputBox.placeholder = 'Message (Ctrl+Enter to commit)';
      const stagedGroup = sourceControl.createResourceGroup(STAGED_GROUP_ID, 'Staged Changes');
      const changesGroup = sourceControl.createResourceGroup(CHANGES_GROUP_ID, 'Changes');
      // An empty group is noise (mirrors built-in git): hide until populated.
      stagedGroup.hideWhenEmpty = true;
      changesGroup.hideWhenEmpty = true;
      entry = { repo, sourceControl, stagedGroup, changesGroup };
      this.repos.set(key, entry);
    }

    let statuses: IFileStatus[];
    try {
      statuses = await this.gitService.getStatus(repo);
    } catch {
      // A transient status failure should leave the last-known groups intact
      // rather than blanking the view.
      return;
    }

    const { staged, changes } = buildScmResources(statuses, repo.rootUri);
    entry.stagedGroup.resourceStates = staged;
    entry.changesGroup.resourceStates = changes;
  }

  /** Tear down the SourceControl for a repository that left tracking. */
  private removeRepo(repo: IRepository): void {
    const key = repo.rootUri.fsPath;
    const entry = this.repos.get(key);
    if (!entry) {
      return;
    }
    entry.changesGroup.dispose();
    entry.stagedGroup.dispose();
    entry.sourceControl.dispose();
    this.repos.delete(key);
  }

  dispose(): void {
    for (const entry of this.repos.values()) {
      entry.changesGroup.dispose();
      entry.stagedGroup.dispose();
      entry.sourceControl.dispose();
    }
    this.repos.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
