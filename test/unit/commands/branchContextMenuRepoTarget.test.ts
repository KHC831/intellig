/**
 * Regression: branch context-menu actions must target the repository the
 * CLICKED leaf hangs under, not the tree's current/context repository.
 *
 * In a multi-root workspace the Branches tree groups branches under per-repo
 * nodes, and branch names collide across repos (every repo has `main` /
 * `master` / `develop`). Before the fix, every handler resolved the repo via
 * `branchTreeProvider.getRepository()` (the context repo) and ignored which
 * repo node the clicked branch belonged to — so right-clicking `main` under
 * repo B and choosing Delete/Rename/Checkout hit repo A's `main`. That is
 * wrong-repo data loss / history damage.
 *
 * The contract pinned here: a leaf carrying `repository === repoB` drives the
 * git op against repoB. A leaf with no `repository` (single-repo flat layout
 * or palette invocation) falls back to the context repo — unchanged behavior.
 */

import '../../setup';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import { IBranch, IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
import {
  installWarningMessageTracker,
  restoreMessageFunctions,
  writableWindow,
} from '../../typed/windowStub';

// ─── Mocks ───────────────────────────────────────────────────────────────────

interface Call<Args extends unknown[]> {
  args: Args;
}

interface RepoTargetingGitService {
  _calls: {
    checkout: Call<[IRepository, string, unknown?]>[];
    renameBranch: Call<[IRepository, string, string]>[];
    deleteBranch: Call<[IRepository, string, boolean?]>[];
    deleteTag: Call<[IRepository, string]>[];
    pushTag: Call<[IRepository, string, string]>[];
  };
}

function createMockGitService(): IGitService & RepoTargetingGitService {
  const calls: RepoTargetingGitService['_calls'] = {
    checkout: [],
    renameBranch: [],
    deleteBranch: [],
    deleteTag: [],
    pushTag: [],
  };
  const base = {
    _calls: calls,
    checkout: async (repo: IRepository, ref: string, options?: unknown) => {
      calls.checkout.push({ args: [repo, ref, options] });
    },
    renameBranch: async (repo: IRepository, oldName: string, newName: string) => {
      calls.renameBranch.push({ args: [repo, oldName, newName] });
    },
    deleteBranch: async (repo: IRepository, name: string, force?: boolean) => {
      calls.deleteBranch.push({ args: [repo, name, force] });
    },
    deleteTag: async (repo: IRepository, name: string) => {
      calls.deleteTag.push({ args: [repo, name] });
    },
    pushTag: async (repo: IRepository, name: string, remote: string) => {
      calls.pushTag.push({ args: [repo, name, remote] });
    },
    getRemotes: async () => [],
    reloadRepository: async (repo: IRepository) => repo,
  };
  return base as unknown as IGitService & RepoTargetingGitService;
}

function createMockBranchTreeProvider(contextRepo: IRepository | undefined): BranchTreeProvider {
  return {
    getRepository: () => contextRepo,
    refresh: () => {
      /* no-op */
    },
  } as unknown as BranchTreeProvider;
}

function repoAt(name: string): IRepository {
  return {
    rootUri: Uri.file(`/work/${name}`),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'a'.repeat(40), ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

/** A `local-branch` leaf optionally tagged with its owning repository. */
function localLeaf(name: string, repository?: IRepository): BranchTreeItem {
  const branch: IBranch = { name, type: 'local', commit: 'a'.repeat(40), isHead: false };
  return new BranchTreeItem(
    name,
    0,
    'local-branch',
    branch,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    repository
  );
}

/** A `tag` leaf optionally tagged with its owning repository. */
function tagLeaf(name: string, repository?: IRepository): BranchTreeItem {
  const tag = { name, commit: 'a'.repeat(40), isAnnotated: false };
  return new BranchTreeItem(
    name,
    0,
    'tag',
    undefined,
    tag,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    repository
  );
}

interface Handlers {
  _handleDelete(item: BranchTreeItem): Promise<void>;
  _handleRename(item: BranchTreeItem): Promise<void>;
  _handleCheckout(item: BranchTreeItem): Promise<void>;
  _handleTagDelete(item: BranchTreeItem): Promise<void>;
  _handleTagPush(item: BranchTreeItem): Promise<void>;
}

function makeCommands(gitService: IGitService, contextRepo: IRepository | undefined): Handlers {
  const provider = createMockBranchTreeProvider(contextRepo);
  return new BranchContextMenuCommands(gitService, provider) as unknown as Handlers;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('BranchContextMenuCommands — action targets the clicked leaf repository', () => {
  let repoA: IRepository; // the tree's current/context repo
  let repoB: IRepository; // a different repo whose node the leaf hangs under

  beforeEach(() => {
    repoA = repoAt('alpha');
    repoB = repoAt('beta');
  });

  afterEach(() => {
    restoreMessageFunctions();
  });

  it('deletes the branch in repoB when the clicked leaf belongs to repoB, not the context repoA', async () => {
    installWarningMessageTracker('Delete'); // confirm the modal
    const gitService = createMockGitService();
    const commands = makeCommands(gitService, repoA);

    await commands._handleDelete(localLeaf('main', repoB));

    assert.strictEqual(gitService._calls.deleteBranch.length, 1);
    assert.strictEqual(
      gitService._calls.deleteBranch[0].args[0],
      repoB,
      'deleteBranch must target repoB (the clicked leaf repo), not repoA'
    );
  });

  it('renames the branch in repoB when the clicked leaf belongs to repoB', async () => {
    writableWindow().showInputBox = async (): Promise<string | undefined> => 'renamed';
    const gitService = createMockGitService();
    const commands = makeCommands(gitService, repoA);

    await commands._handleRename(localLeaf('main', repoB));

    assert.strictEqual(gitService._calls.renameBranch.length, 1);
    assert.strictEqual(
      gitService._calls.renameBranch[0].args[0],
      repoB,
      'renameBranch must target repoB (the clicked leaf repo), not repoA'
    );
  });

  it('checks out the branch in repoB when the clicked leaf belongs to repoB', async () => {
    const gitService = createMockGitService();
    const commands = makeCommands(gitService, repoA);

    await commands._handleCheckout(localLeaf('main', repoB));

    assert.strictEqual(gitService._calls.checkout.length, 1);
    assert.strictEqual(
      gitService._calls.checkout[0].args[0],
      repoB,
      'checkout must target repoB (the clicked leaf repo), not repoA'
    );
  });

  // --- single-repo / palette no-regression: leaf without a repository falls
  //     back to the context repo, exactly as before. ---

  it('falls back to the context repo when the leaf carries no repository (single-repo / palette)', async () => {
    installWarningMessageTracker('Delete');
    const gitService = createMockGitService();
    const commands = makeCommands(gitService, repoA);

    await commands._handleDelete(localLeaf('main')); // no repository on the leaf

    assert.strictEqual(gitService._calls.deleteBranch.length, 1);
    assert.strictEqual(
      gitService._calls.deleteBranch[0].args[0],
      repoA,
      'no leaf repository → fall back to the context repo (unchanged behavior)'
    );
  });
});

describe('BranchContextMenuCommands — tag action targets the clicked leaf repository', () => {
  let repoA: IRepository; // the tree's current/context repo
  let repoB: IRepository; // a different repo whose node the tag leaf hangs under

  beforeEach(() => {
    repoA = repoAt('alpha');
    repoB = repoAt('beta');
  });

  afterEach(() => {
    restoreMessageFunctions();
  });

  it('deletes the tag in repoB when the clicked tag leaf belongs to repoB, not the context repoA', async () => {
    installWarningMessageTracker('Delete'); // confirm the modal
    const gitService = createMockGitService();
    const commands = makeCommands(gitService, repoA);

    await commands._handleTagDelete(tagLeaf('v1.0', repoB));

    assert.strictEqual(gitService._calls.deleteTag.length, 1);
    assert.strictEqual(
      gitService._calls.deleteTag[0].args[0],
      repoB,
      'deleteTag must target repoB (the clicked leaf repo), not repoA'
    );
  });

  it('pushes the tag in repoB when the clicked tag leaf belongs to repoB', async () => {
    const gitService = createMockGitService();
    const commands = makeCommands(gitService, repoA);

    await commands._handleTagPush(tagLeaf('v1.0', repoB));

    assert.strictEqual(gitService._calls.pushTag.length, 1);
    assert.strictEqual(
      gitService._calls.pushTag[0].args[0],
      repoB,
      'pushTag must target repoB (the clicked leaf repo), not repoA'
    );
  });

  it('falls back to the context repo when the tag leaf carries no repository', async () => {
    installWarningMessageTracker('Delete');
    const gitService = createMockGitService();
    const commands = makeCommands(gitService, repoA);

    await commands._handleTagDelete(tagLeaf('v1.0')); // no repository on the leaf

    assert.strictEqual(gitService._calls.deleteTag.length, 1);
    assert.strictEqual(
      gitService._calls.deleteTag[0].args[0],
      repoA,
      'no leaf repository → fall back to the context repo (unchanged behavior)'
    );
  });
});
