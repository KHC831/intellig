/**
 * `onDidChangeWorkspaceFolders` must reconcile removals against the live
 * `workspace.workspaceFolders` set, not the event delta.
 *
 * A tool that adds a folder by REPLACING the workspace folder list can fire a
 * spurious `removed` for folders it also keeps. Acting on that delta tombstoned
 * a still-present repo (`removeRepositoryWatcher` adds it to `_removedRoots`, so
 * later watcher-driven reloads skip it), and it vanished from every repository
 * picker until window reload — the multi-root "repository dropdown only shows
 * the selected repo + the new one" bug. The genuinely-removed case must still
 * evict.
 */

import '../../setup';
import * as assert from 'assert';
import { okAsync, ResultAsync } from 'neverthrow';
import { GitService } from '../../../src/git-core/GitService';
import { GitError } from '../../../src/git-core/errors';
import * as vscodeMock from '../../mocks/vscode';
import { IRepoScanFs } from '../../../src/git-core/repoScan';

const { Uri, workspace, fireWorkspaceFoldersChange } = vscodeMock;

class StubGitCli {
  public readonly rootByPath: Map<string, string | undefined> = new Map();
  setRoot(query: string, root: string | undefined): void {
    this.rootByPath.set(query, root);
  }
  getRepositoryRoot(p: string): ResultAsync<string | undefined, GitError> {
    return okAsync(this.rootByPath.get(p));
  }
  async exec(): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }
  get onCommandExecuted(): () => { dispose: () => void } {
    return (): { dispose: () => void } => ({ dispose: (): void => {} });
  }
  dispose(): void {}
}

interface Surface {
  _gitCli: StubGitCli;
  loadRepository: (root: string) => Promise<unknown>;
  setupRepositoryWatcher: (root: string) => void;
  discoverRepository: (path: string) => Promise<void>;
  _repoScanFs: IRepoScanFs;
}

function makeFsStub(): IRepoScanFs {
  return {
    async readdir(): Promise<never[]> {
      return [];
    },
    async realpath(p: string): Promise<string> {
      return p;
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

function folder(
  p: string,
  index: number
): { uri: ReturnType<typeof Uri.file>; name: string; index: number } {
  return { uri: Uri.file(p), name: p, index };
}

describe('GitService — workspace-folder change reconciles against live folder set', () => {
  let gitService: GitService;
  let stubCli: StubGitCli;

  const A = '/work/alpha';
  const B = '/work/beta';
  const C = '/work/gamma';
  const D = '/work/delta';

  beforeEach(async () => {
    stubCli = new StubGitCli();
    gitService = new GitService();
    const surface = gitService as unknown as Surface;
    surface._gitCli = stubCli;
    surface._repoScanFs = makeFsStub();
    surface.setupRepositoryWatcher = (): void => {};
    // Records into _repositories and clears the tombstone the way the real
    // loadRepository does (first-insertion funnel), so a re-discovery of a
    // tombstoned root resurrects it.
    surface.loadRepository = async (root: string): Promise<unknown> => {
      const repo = { rootUri: Uri.file(root), state: 'idle', head: undefined, remotes: [] };
      const gs = gitService as unknown as {
        _repositories: Map<string, unknown>;
        _removedRoots: Set<string>;
        _onDidChangeRepository: { fire: (r: unknown) => void };
        _fileWatchers: Map<string, unknown>;
      };
      const firstInsertion = !gs._fileWatchers.has(root);
      gs._removedRoots.delete(root);
      gs._repositories.set(root, { repository: repo, lastUpdated: Date.now() });
      if (firstInsertion) {
        gs._fileWatchers.set(root, []);
        gs._onDidChangeRepository.fire(repo);
      }
      return repo;
    };

    for (const p of [A, B, C, D]) {
      stubCli.setRoot(p, p);
    }
    workspace.workspaceFolders = [folder(A, 0), folder(B, 1), folder(C, 2)];
    await surface.discoverRepository(A);
    await surface.discoverRepository(B);
    await surface.discoverRepository(C);
    assert.deepStrictEqual(roots(), [A, B, C]);
  });

  afterEach(() => {
    workspace.workspaceFolders = undefined as unknown[] | undefined;
    gitService.dispose();
  });

  function roots(): string[] {
    return gitService
      .getRepositories()
      .map((r) => r.rootUri.fsPath)
      .sort();
  }

  it('keeps a repo whose folder is still present when the add event spuriously reports it removed', async () => {
    // The tool adds D; the workspace now contains A, B, C, D, but the event it
    // fires spuriously reports B removed and only D added.
    workspace.workspaceFolders = [folder(A, 0), folder(B, 1), folder(C, 2), folder(D, 3)];
    fireWorkspaceFoldersChange({ removed: [folder(B, 1)], added: [folder(D, 3)] });
    await flush();

    assert.deepStrictEqual(
      roots(),
      [A, B, C, D].sort(),
      'B is still a workspace folder and must remain tracked'
    );
  });

  it('still evicts a repo whose folder is genuinely gone from the workspace', async () => {
    // B is truly removed: it is no longer in workspace.workspaceFolders.
    workspace.workspaceFolders = [folder(A, 0), folder(C, 2)];
    const removed: string[] = [];
    const sub = gitService.onDidRemoveRepository((r) => removed.push(r.rootUri.fsPath));
    try {
      fireWorkspaceFoldersChange({ removed: [folder(B, 1)] });
      await flush();
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(roots(), [A, C], 'a genuinely removed folder must be evicted');
    assert.deepStrictEqual(
      removed,
      [B],
      'onDidRemoveRepository fires for the genuinely removed repo'
    );
  });

  it('deleting one repo via a folder-list replace evicts only it, not the survivors', async () => {
    // First establish D as a fourth tracked repo.
    workspace.workspaceFolders = [folder(A, 0), folder(B, 1), folder(C, 2), folder(D, 3)];
    await (gitService as unknown as Surface).discoverRepository(D);
    assert.deepStrictEqual(roots(), [A, B, C, D].sort());

    // A tool deletes D by replacing the folder list; the event reports every
    // folder removed and re-adds only the survivors. Only D is genuinely gone.
    workspace.workspaceFolders = [folder(A, 0), folder(B, 1), folder(C, 2)];
    fireWorkspaceFoldersChange({
      removed: [folder(A, 0), folder(B, 1), folder(C, 2), folder(D, 3)],
      added: [folder(A, 0), folder(B, 1), folder(C, 2)],
    });
    await flush();

    assert.deepStrictEqual(
      roots(),
      [A, B, C],
      'the three survivors stay tracked; the workspace must not collapse to a single repo'
    );
  });
});
