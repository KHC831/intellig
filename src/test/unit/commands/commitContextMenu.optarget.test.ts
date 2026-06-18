/**
 * H-1 — commit context-menu actions must target the CLICKED commit's OWN
 * repository in the merged "All Repositories" scope, not the dropdown's
 * context repo.
 *
 * In 'all' scope the merged log interleaves commits from every root. The
 * provider records each commit's source root (`getRepoRootForCommit`). Before
 * this fix every `_handleAction` arm resolved the repo via
 * `getSelectedRepository()` (the context repo), so clicking a foreign-repo
 * commit ran the foreign hash against the wrong repo — "bad revision" at best,
 * and WRONG-REPO DATA LOSS for the destructive arms (reset/drop/undo/push)
 * when hashes happen to resolve (shared history / forks).
 *
 * These specs pin that the clicked commit's hash is threaded into repo
 * resolution: the op runs against repo B (the commit's own repo) even though
 * the context repo is A. They also pin the unchanged single-repo /
 * specific-scope fallback (no recorded root → context repo).
 */

import '../../setup';
import * as assert from 'assert';
import { CommitContextMenuCommands } from '../../../commits/CommitContextMenuCommands';
import type { IGitService, IRepository } from '../../../git-core/interfaces/IGitService';
import type { IRebaseService, IRebaseSession } from '../../../git-core/interfaces/IRebaseService';
import { GitToolWindowProvider } from '../../../ui-shell/GitToolWindowProvider';
import { EventEmitter, Uri } from '../../mocks/vscode';
import { writableWindow, writableCommands, writableEnv } from '../../typed/windowStub';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const ROOT_A = '/work/alpha';
const ROOT_B = '/work/beta';
// Valid lowercase-hex hashes (pass HASH_RE). FOREIGN_HASH + HASH_B2 "belong to"
// repo B; HASH_A1 "belongs to" repo A — used to build cross-repo selections.
const FOREIGN_HASH = 'beebeebeebeebeebeebeebeebeebeebeebeebeeb';
const HASH_B2 = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const HASH_A1 = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';

function makeRepo(root: string, headCommit?: string): IRepository {
  return {
    rootUri: Uri.file(root),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: headCommit, ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

interface OpCall {
  method: string;
  repo: IRepository;
  args: unknown[];
}

/**
 * Git service whose `getRepository(uri)` dispatches by fsPath through a
 * `byRoot` map — the seam that lets a hash-resolved root select repo B. Every
 * commit-operating method records the repo it was handed so the specs can
 * assert which repo the op actually ran against.
 */
function makeGitService(byRoot: Map<string, IRepository>): IGitService & { opCalls: OpCall[] } {
  const opCalls: OpCall[] = [];
  const emitter = new EventEmitter<IRepository>();
  const record =
    (method: string) =>
    async (repo: IRepository, ...args: unknown[]): Promise<{ success: true }> => {
      opCalls.push({ method, repo, args });
      return { success: true };
    };
  return {
    opCalls,
    onDidChangeRepository: emitter.event,
    getRepositories: () => [...byRoot.values()],
    getRepository: async (uri: { fsPath: string }) => byRoot.get(uri.fsPath),
    reloadRepository: async (repo: IRepository) => repo,
    getBranches: async () => [],
    getTags: async () => [],
    commit: async () => {},
    amend: async () => {},
    createBranch: async () => {},
    checkout: record('checkout'),
    deleteBranch: async () => {},
    renameBranch: async () => {},
    setBranchUpstream: async () => {},
    mergeBranch: record('mergeBranch'),
    rebaseBranch: async () => ({ success: true }),
    compareBranches: async () => ({
      commitsAhead: [],
      commitsBehind: [],
      aheadCount: 0,
      behindCount: 0,
      changedFiles: [],
    }),
    fetch: async () => {},
    pull: async () => {},
    push: async () => {},
    getRemotes: async () => [],
    addRemote: async () => {},
    removeRemote: async () => {},
    stash: async () => {},
    stashList: async () => [],
    stashApply: async () => {},
    stashPop: async () => {},
    stashDrop: async () => {},
    stashShow: async () => [],
    createTag: async () => {},
    deleteTag: async () => {},
    pushTag: async () => {},
    getLog: async () => [],
    getCommit: async (repo: IRepository, hash: string) => {
      opCalls.push({ method: 'getCommit', repo, args: [hash] });
      return {
        hash,
        shortHash: hash.substring(0, 8),
        message: 'feat: a commit',
        author: { name: '', email: '' },
        committer: { name: '', email: '' },
        parents: ['parent0000000000000000000000000000000000'],
        authorDate: new Date(),
        commitDate: new Date(),
      };
    },
    getFileHistory: async () => [],
    getDiff: async () => ({ path: '', status: 'modified' as const, hunks: [], binary: false }),
    getCommitDiff: async () => [],
    getMultiCommitDiff: async () => [],
    getBlame: async () => [],
    cherryPick: record('cherryPick'),
    cherryPickAbort: async () => {},
    cherryPickContinue: async () => ({ success: true }),
    revert: record('revert'),
    revertAbort: async () => {},
    revertContinue: async () => ({ success: true }),
    getStatus: async () => [],
    stage: async () => {},
    unstage: async () => {},
    stageHunk: async () => {},
    stageLines: async () => {},
    unstageHunk: async () => {},
    revertFile: async () => {},
    dispose: () => {},
  } as unknown as IGitService & { opCalls: OpCall[] };
}

interface RebaseCall {
  method: string;
  repo: IRepository;
}

function makeRebaseService(): IRebaseService & { rebaseCalls: RebaseCall[] } {
  const sessionEmitter = new EventEmitter<undefined>();
  const rebaseCalls: RebaseCall[] = [];
  const session: IRebaseSession = {
    onto: 'onto',
    originalBranch: 'main',
    commits: [{ hash: FOREIGN_HASH, message: 'feat: a commit', action: 'pick' }],
    currentStep: 0,
    status: 'planning',
  };
  return {
    rebaseCalls,
    startInteractiveRebase: async (repo: IRepository) => {
      rebaseCalls.push({ method: 'startInteractiveRebase', repo });
      return session;
    },
    getRebaseSession: () => undefined,
    updateRebasePlan: () => {},
    executeRebase: async () => ({ success: true, status: 'completed' as const }),
    continueRebase: async () => ({ success: true, status: 'completed' as const }),
    abortRebase: async () => {},
    skipCommit: async () => ({ success: true, status: 'completed' as const }),
    provideRewordMessage: async () => ({ success: true, status: 'completed' as const }),
    provideSquashMessage: async () => ({ success: true, status: 'completed' as const }),
    amendEditCommit: async () => ({ success: true, status: 'completed' as const }),
    onDidChangeRebaseSession: sessionEmitter.event,
    dispose: () => {},
  } as unknown as IRebaseService & { rebaseCalls: RebaseCall[] };
}

type MockGitCli = import('../../../git-core/gitCli').GitCli & {
  execCalls: { argv: string[]; cwd: string | undefined }[];
};

/** GitCli stub that reports a clean working tree and records exec cwd. */
function makeCleanGitCli(): MockGitCli {
  const execCalls: { argv: string[]; cwd: string | undefined }[] = [];
  return {
    execCalls,
    exec: async (argv: string[], opts?: { cwd?: string }) => {
      execCalls.push({ argv, cwd: opts?.cwd });
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
    execString: async () => '',
    isAvailable: async () => true,
    getVersion: async () => '2.40.0',
    isRepository: async () => true,
    getRepositoryRoot: async () => ROOT_B,
    dispose: () => {},
    get gitPath() {
      return 'git';
    },
    set gitPath(_v: string) {},
    onCommandExecuted: (() => ({
      dispose: () => {},
    })) as unknown as MockGitCli['onCommandExecuted'],
  } as unknown as MockGitCli;
}

/**
 * Provider stub mirroring the merged 'all' scope: the dropdown's selected repo
 * is the CONTEXT repo, while `getRepoRootForCommit` maps the clicked hash to
 * its OWN source root.
 */
function makeProvider(
  selected: IRepository | undefined,
  rootByHash: Map<string, string>
): GitToolWindowProvider {
  return {
    onDidRequestLogContextAction: () => ({ dispose: () => {} }),
    refresh: () => {},
    getSelectedRepository: () => selected,
    getRepoRootForCommit: (hash: string) => rootByHash.get(hash),
  } as unknown as GitToolWindowProvider;
}

function stubWindow(): void {
  writableWindow().showInputBox = (opts?: import('vscode').InputBoxOptions) =>
    Promise.resolve(opts?.value ?? 'msg');
  writableWindow().showWarningMessage = () => Promise.resolve(undefined);
  writableWindow().showErrorMessage = () => Promise.resolve(undefined);
  writableWindow().showInformationMessage = () => Promise.resolve(undefined);
  writableWindow().showQuickPick = () => Promise.resolve(undefined);
}

// ─── Specs ───────────────────────────────────────────────────────────────────

describe("H-1 — commit menu targets the clicked commit's own repo in all-repos scope", () => {
  beforeEach(() => {
    stubWindow();
  });

  it("routes revert to the clicked foreign-repo commit's repo, not the context repo", async () => {
    const repoA = makeRepo(ROOT_A, 'aaaa000000000000000000000000000000000000');
    const repoB = makeRepo(ROOT_B);
    const gitService = makeGitService(
      new Map([
        [ROOT_A, repoA],
        [ROOT_B, repoB],
      ])
    );
    const provider = makeProvider(repoA, new Map([[FOREIGN_HASH, ROOT_B]]));
    const commands = new CommitContextMenuCommands(gitService, makeRebaseService(), provider);

    await commands._handleAction('revert', [FOREIGN_HASH]);

    const revert = gitService.opCalls.find((c) => c.method === 'revert');
    assert.ok(revert, 'gitService.revert should have been invoked');
    assert.strictEqual(
      revert.repo.rootUri.fsPath,
      ROOT_B,
      "revert must run against the commit's own repo (B), not the context repo (A)"
    );
  });

  it("routes drop commit to the clicked foreign-repo commit's repo", async () => {
    const repoA = makeRepo(ROOT_A, 'aaaa000000000000000000000000000000000000');
    const repoB = makeRepo(ROOT_B);
    const gitService = makeGitService(
      new Map([
        [ROOT_A, repoA],
        [ROOT_B, repoB],
      ])
    );
    const rebaseService = makeRebaseService();
    const provider = makeProvider(repoA, new Map([[FOREIGN_HASH, ROOT_B]]));
    const commands = new CommitContextMenuCommands(
      gitService,
      rebaseService,
      provider,
      makeCleanGitCli()
    );

    await commands._handleAction(
      'dropCommit',
      [FOREIGN_HASH],
      [{ hash: FOREIGN_HASH, parentCount: 1 }]
    );

    const start = rebaseService.rebaseCalls.find((c) => c.method === 'startInteractiveRebase');
    assert.ok(start, 'an interactive rebase should have been started for the drop');
    assert.strictEqual(
      start.repo.rootUri.fsPath,
      ROOT_B,
      "drop must rebase the commit's own repo (B), not the context repo (A)"
    );
  });

  it("runs undo commit (soft reset) in the clicked foreign-repo commit's working dir", async () => {
    // Undo Commit only runs when the clicked hash is HEAD of the resolved
    // repo — so repo B's HEAD is the foreign hash. If resolution wrongly
    // picked context repo A (HEAD = aaaa…), the HEAD guard would reject and no
    // reset would run; asserting the reset ran in B's cwd proves B was chosen.
    const repoA = makeRepo(ROOT_A, 'aaaa000000000000000000000000000000000000');
    const repoB = makeRepo(ROOT_B, FOREIGN_HASH);
    const gitService = makeGitService(
      new Map([
        [ROOT_A, repoA],
        [ROOT_B, repoB],
      ])
    );
    const gitCli = makeCleanGitCli();
    const provider = makeProvider(repoA, new Map([[FOREIGN_HASH, ROOT_B]]));
    const commands = new CommitContextMenuCommands(
      gitService,
      makeRebaseService(),
      provider,
      gitCli
    );

    await commands._handleAction('undoCommit', [FOREIGN_HASH]);

    const reset = gitCli.execCalls.find((c) => c.argv[0] === 'reset');
    assert.ok(reset, 'a soft reset should have run for undo commit');
    assert.strictEqual(
      reset.cwd,
      ROOT_B,
      "undo commit's reset must run in the commit's own repo dir (B)"
    );
  });

  it('threads the clicked-commit repo root into the pushUpToCommit delegation', async () => {
    const repoA = makeRepo(ROOT_A, 'aaaa000000000000000000000000000000000000');
    const repoB = makeRepo(ROOT_B);
    const gitService = makeGitService(
      new Map([
        [ROOT_A, repoA],
        [ROOT_B, repoB],
      ])
    );
    const provider = makeProvider(repoA, new Map([[FOREIGN_HASH, ROOT_B]]));
    const commands = new CommitContextMenuCommands(gitService, makeRebaseService(), provider);

    let executed: { cmd: string; args: unknown[] } | undefined;
    writableCommands().executeCommand = (cmd: string, ...args: unknown[]) => {
      executed = { cmd, args };
      return Promise.resolve(undefined);
    };

    await commands._handleAction('pushUpToCommit', [FOREIGN_HASH]);

    assert.ok(executed, 'pushUpToCommit should delegate to the registered command');
    assert.strictEqual(executed.cmd, 'intellig.pushUpToCommit');
    assert.deepStrictEqual(
      executed.args,
      [FOREIGN_HASH, ROOT_B],
      "the clicked commit's own repo root (B) must be passed so push does not re-resolve to the context repo"
    );
  });

  it('threads the clicked-commit repo root into the newBranch delegation', async () => {
    const repoA = makeRepo(ROOT_A, 'aaaa000000000000000000000000000000000000');
    const repoB = makeRepo(ROOT_B);
    const gitService = makeGitService(
      new Map([
        [ROOT_A, repoA],
        [ROOT_B, repoB],
      ])
    );
    const provider = makeProvider(repoA, new Map([[FOREIGN_HASH, ROOT_B]]));
    const commands = new CommitContextMenuCommands(gitService, makeRebaseService(), provider);

    let executed: { cmd: string; args: unknown[] } | undefined;
    writableCommands().executeCommand = (cmd: string, ...args: unknown[]) => {
      executed = { cmd, args };
      return Promise.resolve(undefined);
    };

    await commands._handleAction('newBranch', [FOREIGN_HASH]);

    assert.ok(executed, 'newBranch should delegate to the registered command');
    assert.strictEqual(executed.cmd, 'intellig.commit.newBranch');
    assert.deepStrictEqual(executed.args, [FOREIGN_HASH, ROOT_B]);
  });

  it('falls back to the context repo when no source root is recorded (single-repo / specific scope)', async () => {
    const localHash = 'cafe000000000000000000000000000000000000';
    const repoA = makeRepo(ROOT_A, 'aaaa000000000000000000000000000000000000');
    const gitService = makeGitService(new Map([[ROOT_A, repoA]]));
    // No recorded root for the hash → resolution must use the context repo.
    const provider = makeProvider(repoA, new Map());
    const commands = new CommitContextMenuCommands(gitService, makeRebaseService(), provider);

    await commands._handleAction('revert', [localHash]);

    const revert = gitService.opCalls.find((c) => c.method === 'revert');
    assert.ok(revert, 'gitService.revert should have been invoked');
    assert.strictEqual(revert.repo.rootUri.fsPath, ROOT_A);
  });

  it('falls back to the context repo when the recorded root no longer resolves', async () => {
    const repoA = makeRepo(ROOT_A, 'aaaa000000000000000000000000000000000000');
    // byRoot has only A: a recorded '/work/gone' root won't resolve to a repo.
    const gitService = makeGitService(new Map([[ROOT_A, repoA]]));
    const provider = makeProvider(repoA, new Map([[FOREIGN_HASH, '/work/gone']]));
    const commands = new CommitContextMenuCommands(gitService, makeRebaseService(), provider);

    await commands._handleAction('revert', [FOREIGN_HASH]);

    const revert = gitService.opCalls.find((c) => c.method === 'revert');
    assert.ok(revert, 'gitService.revert should have been invoked');
    assert.strictEqual(
      revert.repo.rootUri.fsPath,
      ROOT_A,
      'an unresolvable recorded root must fall back to the context repo'
    );
  });
});

// ─── L-2 — resolve by the clicked row, not the hash-keyed last-writer map ──────

describe("L-2 — commit menu resolves the clicked row's own repo, not the hash-keyed index", () => {
  // A single hash present in BOTH roots (shared history / fork / mirror). The
  // provider's hash→root index can only hold ONE root for it; whichever repo
  // wrote the merged log last wins. The rendered row, by contrast, carries its
  // OWN repoRoot, so resolving by the clicked row is unambiguous.
  const SHARED_HASH = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

  beforeEach(() => {
    stubWindow();
  });

  it("routes revert to the clicked row's repoRoot (B) even when the hash index last-wrote repo A for that shared hash", async () => {
    const repoA = makeRepo(ROOT_A, 'aaaa000000000000000000000000000000000000');
    const repoB = makeRepo(ROOT_B);
    const gitService = makeGitService(
      new Map([
        [ROOT_A, repoA],
        [ROOT_B, repoB],
      ])
    );
    // Index last-wrote A for the shared hash AND A is the context repo — so
    // anything other than the clicked row's own root resolves to A.
    const provider = makeProvider(repoA, new Map([[SHARED_HASH, ROOT_A]]));
    const commands = new CommitContextMenuCommands(gitService, makeRebaseService(), provider);

    await commands._handleAction(
      'revert',
      [SHARED_HASH],
      [{ hash: SHARED_HASH, parentCount: 1, repoRoot: ROOT_B }]
    );

    const revert = gitService.opCalls.find((c) => c.method === 'revert');
    assert.ok(revert, 'gitService.revert should have been invoked');
    assert.strictEqual(
      revert.repo.rootUri.fsPath,
      ROOT_B,
      "revert must target the clicked row's repo (B), not the index's last-writer (A)"
    );
  });

  it('detects a cross-repo selection from the rows even when the index collapsed both hashes onto one root', async () => {
    const warnings: string[] = [];
    writableWindow().showWarningMessage = (message: string) => {
      warnings.push(message);
      return Promise.resolve(undefined);
    };
    const repoA = makeRepo(ROOT_A, 'aaaa000000000000000000000000000000000000');
    const repoB = makeRepo(ROOT_B);
    const gitService = makeGitService(
      new Map([
        [ROOT_A, repoA],
        [ROOT_B, repoB],
      ])
    );
    // The index maps BOTH selected hashes to ROOT_A (last-writer collapsed the
    // shared second hash onto A), so a map-only guard would see one root and
    // wrongly let the op through. The rows say otherwise: one is A, one is B.
    const provider = makeProvider(
      repoA,
      new Map([
        [HASH_A1, ROOT_A],
        [SHARED_HASH, ROOT_A],
      ])
    );
    const commands = new CommitContextMenuCommands(
      gitService,
      makeRebaseService(),
      provider,
      makeCleanGitCli()
    );

    await commands._handleAction(
      'cherryPick',
      [HASH_A1, SHARED_HASH],
      [
        { hash: HASH_A1, parentCount: 1, repoRoot: ROOT_A },
        { hash: SHARED_HASH, parentCount: 1, repoRoot: ROOT_B },
      ]
    );

    assert.strictEqual(
      gitService.opCalls.find((c) => c.method === 'cherryPick'),
      undefined,
      'cherryPick must not run when the selected rows straddle two repos'
    );
    assert.strictEqual(warnings.length, 1, 'a cross-repo warning toast should be shown');
    assert.match(warnings[0], /multiple repositories/i);
  });
});

// ─── Cross-repo multi-selection guard ─────────────────────────────────────────

describe('H-1 — cross-repo multi-selection guard refuses ops that span repositories', () => {
  let warnings: string[];

  beforeEach(() => {
    stubWindow();
    warnings = [];
    writableWindow().showWarningMessage = (message: string) => {
      warnings.push(message);
      return Promise.resolve(undefined);
    };
  });

  /** Both B-hashes and one A-hash recorded; A+B selections straddle repos. */
  function crossRepoSetup(): {
    commands: CommitContextMenuCommands;
    gitService: ReturnType<typeof makeGitService>;
    rebaseService: ReturnType<typeof makeRebaseService>;
  } {
    const repoA = makeRepo(ROOT_A, 'aaaa000000000000000000000000000000000000');
    const repoB = makeRepo(ROOT_B);
    const gitService = makeGitService(
      new Map([
        [ROOT_A, repoA],
        [ROOT_B, repoB],
      ])
    );
    const rebaseService = makeRebaseService();
    const provider = makeProvider(
      repoA,
      new Map([
        [FOREIGN_HASH, ROOT_B],
        [HASH_B2, ROOT_B],
        [HASH_A1, ROOT_A],
      ])
    );
    const commands = new CommitContextMenuCommands(
      gitService,
      rebaseService,
      provider,
      makeCleanGitCli()
    );
    return { commands, gitService, rebaseService };
  }

  it('refuses cherryPick across a cross-repo selection without invoking the op', async () => {
    const { commands, gitService } = crossRepoSetup();

    await commands._handleAction('cherryPick', [FOREIGN_HASH, HASH_A1]);

    assert.strictEqual(
      gitService.opCalls.find((c) => c.method === 'cherryPick'),
      undefined,
      'cherryPick must not run on a cross-repo selection'
    );
    assert.strictEqual(warnings.length, 1, 'a cross-repo warning toast should be shown');
    assert.match(warnings[0], /multiple repositories/i);
  });

  it('refuses dropCommit across a cross-repo selection without starting a rebase', async () => {
    const { commands, rebaseService } = crossRepoSetup();

    await commands._handleAction(
      'dropCommit',
      [FOREIGN_HASH, HASH_A1],
      [
        { hash: FOREIGN_HASH, parentCount: 1 },
        { hash: HASH_A1, parentCount: 1 },
      ]
    );

    assert.strictEqual(
      rebaseService.rebaseCalls.length,
      0,
      'drop must not start a rebase on a cross-repo selection'
    );
    assert.strictEqual(warnings.length, 1);
  });

  it('does NOT refuse a same-repo multi-selection (op runs against that repo)', async () => {
    const { commands, gitService } = crossRepoSetup();

    // Both hashes recorded under repo B → one root → no false refusal.
    await commands._handleAction('revert', [FOREIGN_HASH, HASH_B2]);

    const revert = gitService.opCalls.find((c) => c.method === 'revert');
    assert.ok(revert, 'a same-repo multi revert should run');
    assert.strictEqual(revert.repo.rootUri.fsPath, ROOT_B);
    assert.strictEqual(warnings.length, 0, 'no cross-repo warning for a same-repo selection');
  });

  it('does NOT refuse a multi-selection when no source roots are recorded', async () => {
    const repoA = makeRepo(ROOT_A, 'aaaa000000000000000000000000000000000000');
    const gitService = makeGitService(new Map([[ROOT_A, repoA]]));
    // Empty rootByHash → no recorded roots → guard is a no-op.
    const provider = makeProvider(repoA, new Map());
    const commands = new CommitContextMenuCommands(gitService, makeRebaseService(), provider);

    await commands._handleAction('revert', [FOREIGN_HASH, HASH_B2]);

    const revert = gitService.opCalls.find((c) => c.method === 'revert');
    assert.ok(revert, 'a no-recorded-roots multi revert should run');
    assert.strictEqual(revert.repo.rootUri.fsPath, ROOT_A);
    assert.strictEqual(warnings.length, 0);
  });

  it('refuses copyCommitMessage across a cross-repo selection (uniform with the other multi arms)', async () => {
    const { commands, gitService } = crossRepoSetup();
    let clipboard = '';
    writableEnv().clipboard = {
      writeText: (text: string) => {
        clipboard = text;
        return Promise.resolve();
      },
      readText: () => Promise.resolve(''),
    };

    await commands._handleAction('copyCommitMessage', [FOREIGN_HASH, HASH_A1]);

    assert.strictEqual(
      gitService.opCalls.find((c) => c.method === 'getCommit'),
      undefined,
      'copy must not read commit messages from a single resolved repo for a cross-repo selection'
    );
    assert.strictEqual(clipboard, '', 'nothing should be copied for a cross-repo selection');
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /multiple repositories/i);
  });
});
