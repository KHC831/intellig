/**
 * Unit specs for the native VS Code SCM integration (`src/scm/GitScmProvider`).
 *
 * The provider mirrors IntelliJ's Local Changes: a `vscode.SourceControl`
 * ("IntelliG Git") whose resource groups reflect the working tree. These specs
 * pin the partition rules (which group a file lands in given its index/worktree
 * status), the per-resource decoration + click-to-diff command, and the
 * lifecycle wiring (seed on init, refresh on repo-change, dispose on
 * repo-removal) — all driven through an injected SCM-API seam so no extension
 * host is required.
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { okAsync } from 'neverthrow';

import { EventEmitter, Uri } from '../../mocks/vscode';
import { createMockGitService } from '../../mocks/mockGitService';
import { GitScmProvider, buildScmResources, type IScmApi } from '../../../src/scm/GitScmProvider';
import type { IFileStatus, IRepository } from '../../../src/services';

function repoAt(fsPath: string): IRepository {
  return {
    rootUri: Uri.file(fsPath) as unknown as IRepository['rootUri'],
    state: 'idle',
    remotes: [],
    submodules: [],
  };
}

function status(
  filePath: string,
  indexStatus: IFileStatus['indexStatus'],
  workTreeStatus: IFileStatus['workTreeStatus']
): IFileStatus {
  return { path: filePath, indexStatus, workTreeStatus };
}

/** Records every SourceControl/group the provider creates. */
class FakeGroup {
  resourceStates: vscode.SourceControlResourceState[] = [];
  hideWhenEmpty = false;
  disposed = false;
  constructor(
    public readonly id: string,
    public readonly label: string
  ) {}
  dispose(): void {
    this.disposed = true;
  }
}

class FakeSourceControl {
  readonly groups: FakeGroup[] = [];
  readonly inputBox = { value: '', visible: true };
  disposed = false;
  constructor(
    public readonly id: string,
    public readonly label: string,
    public readonly rootUri?: vscode.Uri
  ) {}
  createResourceGroup(id: string, label: string): vscode.SourceControlResourceGroup {
    const g = new FakeGroup(id, label);
    this.groups.push(g);
    return g as unknown as vscode.SourceControlResourceGroup;
  }
  dispose(): void {
    this.disposed = true;
  }
  group(id: string): FakeGroup {
    const g = this.groups.find((x) => x.id === id);
    if (!g) {
      throw new Error(`group ${id} not created`);
    }
    return g;
  }
}

function fakeScmApi(): { api: IScmApi; created: FakeSourceControl[] } {
  const created: FakeSourceControl[] = [];
  const api: IScmApi = {
    createSourceControl: (id, label, rootUri): vscode.SourceControl => {
      const sc = new FakeSourceControl(id, label, rootUri);
      created.push(sc);
      return sc as unknown as vscode.SourceControl;
    },
  };
  return { api, created };
}

describe('buildScmResources — working-tree partition', () => {
  const root = Uri.file('/repo') as unknown as IRepository['rootUri'];

  it('routes a worktree-only modification to the Changes group and not Staged', () => {
    const { staged, changes } = buildScmResources([status('src/a.ts', ' ', 'M')], root);
    assert.equal(staged.length, 0);
    assert.equal(changes.length, 1);
  });

  it('routes an index-only addition to the Staged group and not Changes', () => {
    const { staged, changes } = buildScmResources([status('src/new.ts', 'A', ' ')], root);
    assert.equal(staged.length, 1);
    assert.equal(changes.length, 0);
  });

  it('lists a file with both staged and unstaged edits in BOTH groups', () => {
    const { staged, changes } = buildScmResources([status('src/a.ts', 'M', 'M')], root);
    assert.equal(staged.length, 1);
    assert.equal(changes.length, 1);
  });

  it('routes an untracked file to the Changes group only', () => {
    const { staged, changes } = buildScmResources([status('docs/new.md', '?', '?')], root);
    assert.equal(staged.length, 0);
    assert.equal(changes.length, 1);
  });

  it('routes a conflicted (unmerged) file to the Changes group only, never Staged', () => {
    const { staged, changes } = buildScmResources([status('src/c.ts', 'U', 'U')], root);
    assert.equal(staged.length, 0);
    assert.equal(changes.length, 1);
  });

  it('marks a worktree deletion with a strike-through decoration', () => {
    const { changes } = buildScmResources([status('src/gone.ts', ' ', 'D')], root);
    assert.equal(changes[0].decorations?.strikeThrough, true);
  });

  it('resolves the resource URI to the absolute on-disk path under the repo root', () => {
    const { changes } = buildScmResources([status('src/a.ts', ' ', 'M')], root);
    assert.equal(changes[0].resourceUri.fsPath, path.join('/repo', 'src/a.ts'));
  });

  it('attaches a vscode.diff click command with a HEAD-side left and the working file on the right', () => {
    const { changes } = buildScmResources([status('src/a.ts', ' ', 'M')], root);
    const cmd = changes[0].command;
    assert.ok(cmd, 'resource should carry a click command');
    assert.equal(cmd?.command, 'vscode.diff');
    const args = cmd?.arguments as [vscode.Uri, vscode.Uri, string];
    assert.equal(args.length, 3);
    // Left side is the committed (HEAD) revision served by the intellig-git
    // provider, built from explicit URI components: scheme + repo-relative path
    // + the ref in the query (the provider reads uri.path + uri.query).
    assert.equal(args[0].scheme, 'intellig-git', 'left arg uses the intellig-git scheme');
    assert.equal(args[0].path, 'src/a.ts', 'left arg path is the repo-relative file');
    assert.equal(decodeURIComponent(args[0].query), 'HEAD', 'left arg pins the HEAD ref');
    // Right side is the live working-tree file.
    assert.equal(args[1].fsPath, path.join('/repo', 'src/a.ts'));
  });

  it('keeps a "?"-bearing filename intact in the head URI path (no query split)', () => {
    const { changes } = buildScmResources([status('src/a?b.ts', ' ', 'M')], root);
    const args = changes[0].command?.arguments as [vscode.Uri, vscode.Uri, string];
    // A literal `?` in the filename must stay in the path, not bleed into the
    // query — the bug that `Uri.parse('intellig-git:src/a?b.ts?HEAD')` caused.
    assert.equal(args[0].path, 'src/a?b.ts', 'the "?" filename must survive in the path');
    assert.equal(decodeURIComponent(args[0].query), 'HEAD', 'the ref stays HEAD');
  });
});

describe('GitScmProvider — lifecycle', () => {
  it('creates one "IntelliG Git" source control with Changes + Staged Changes groups on init', async () => {
    const repo = repoAt('/repo');
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => [status('src/a.ts', ' ', 'M')],
    });
    const { api, created } = fakeScmApi();

    const provider = new GitScmProvider(git, api);
    await provider.initialize();

    assert.equal(created.length, 1);
    assert.equal(created[0].label, 'IntelliG Git');
    const labels = created[0].groups.map((g) => g.label).sort();
    assert.deepEqual(labels, ['Changes', 'Staged Changes']);
    provider.dispose();
  });

  it('populates the Changes group from getStatus on init', async () => {
    const repo = repoAt('/repo');
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => [status('src/a.ts', ' ', 'M'), status('docs/n.md', '?', '?')],
    });
    const { api, created } = fakeScmApi();

    const provider = new GitScmProvider(git, api);
    await provider.initialize();

    const changes = created[0].group('changes');
    assert.equal(changes.resourceStates.length, 2);
    provider.dispose();
  });

  it('refreshes resource states when the repository changes', async () => {
    const repo = repoAt('/repo');
    let files: IFileStatus[] = [status('src/a.ts', ' ', 'M')];
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => files,
    });
    const { api, created } = fakeScmApi();

    const provider = new GitScmProvider(git, api);
    await provider.initialize();
    assert.equal(created[0].group('changes').resourceStates.length, 1);

    // Stage the file (now also a staged change) plus add an untracked one.
    files = [status('src/a.ts', 'M', 'M'), status('docs/n.md', '?', '?')];
    git.fireChangeRepository(repo);
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(created[0].group('changes').resourceStates.length, 2);
    assert.equal(created[0].group('staged').resourceStates.length, 1);
    provider.dispose();
  });

  it('disposes the source control when its repository is removed', async () => {
    const repo = repoAt('/repo');
    const removeEmitter = new EventEmitter<IRepository>();
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => [],
      onDidRemoveRepository: removeEmitter.event,
    });
    const { api, created } = fakeScmApi();

    const provider = new GitScmProvider(git, api);
    await provider.initialize();
    assert.equal(created[0].disposed, false);

    removeEmitter.fire(repo);
    assert.equal(created[0].disposed, true);
    provider.dispose();
  });

  it('disposes every source control it created on dispose()', async () => {
    const repo = repoAt('/repo');
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async () => [],
    });
    const { api, created } = fakeScmApi();

    const provider = new GitScmProvider(git, api);
    await provider.initialize();
    provider.dispose();

    assert.equal(created[0].disposed, true);
  });
});

describe('GitScmProvider — accept-commit status-read failure', () => {
  it('aborts the accept + surfaces an error and does NOT commit when getStatus fails', async () => {
    const repo = repoAt('/repo');
    let commitCalled = false;
    const git = createMockGitService(repo, {
      getRepositories: () => [repo],
      getStatus: async (): Promise<IFileStatus[]> => {
        throw new Error('status boom');
      },
      commit: () => {
        commitCalled = true;
        return okAsync(undefined);
      },
    });
    const { api } = fakeScmApi();
    const provider = new GitScmProvider(git, api);

    // Spy the error toast.
    const originalShow = vscode.window.showErrorMessage;
    let errorShown = 0;
    (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage =
      async (): Promise<string | undefined> => {
        errorShown += 1;
        return undefined;
      };

    const sc = new FakeSourceControl('intellig', 'IntelliG Git');
    sc.inputBox.value = 'my message';
    const entry = {
      repo,
      sourceControl: sc as unknown as vscode.SourceControl,
      stagedGroup: sc.createResourceGroup('staged', 'Staged Changes'),
      changesGroup: sc.createResourceGroup('changes', 'Changes'),
    };

    try {
      await (
        provider as unknown as {
          _runCommitFromInput: (
            e: typeof entry,
            s: vscode.SourceControl,
            m: string
          ) => Promise<void>;
        }
      )._runCommitFromInput(entry, sc as unknown as vscode.SourceControl, 'my message');
    } finally {
      (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = originalShow;
      provider.dispose();
    }

    assert.equal(commitCalled, false, 'must not commit when the staged set is unknown');
    assert.equal(errorShown, 1, 'must surface the status-read failure');
    assert.equal(sc.inputBox.value, 'my message', 'input box must not be cleared on abort');
  });
});
