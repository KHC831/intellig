/**
 * Unit tests for T2-04 selective revert + Drop Selected Changes.
 *
 * Covers:
 *  - Selective revert: when the user deselects files, `git revert -n`
 *    + `git checkout HEAD -- <excluded>` + `git commit` is invoked;
 *    when everything stays selected, fall through to `gitService.revert`.
 *    User cancel at the picker → no-op.
 *  - Drop Selected Changes: refuses on non-HEAD commits; refuses on
 *    pushed commits; requires a single modal confirm; soft-reset +
 *    checkout HEAD + commit -C on confirm; "all files dropped" path
 *    skips the re-commit.
 */

/*
 * Stub factories synthesise IGitService / IRebaseService implementations
 * whose member signatures return `Promise<T>`. No-await stub bodies are
 * intentional here.
 */

import '../../../test/setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { CommitContextMenuCommands } from '../../../commands/CommitContextMenuCommands';
import { IGitService, IRepository, IDiff } from '../../../services/interfaces/IGitService';
import { IRebaseService } from '../../../services/interfaces/IRebaseService';
import { GitToolWindowProvider } from '../../../services/GitToolWindowProvider';
import { EventEmitter, Uri } from '../../mocks/vscode';
import { writableWindow } from '../../helpers/windowStub';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface CliExec {
  args: string[];
  options: { cwd?: string; throwOnError?: boolean };
}

interface MockCli {
  executed: CliExec[];
  setResponse(
    match: RegExp | string,
    response: { exitCode: number; stdout: string; stderr: string }
  ): void;
  exec: (
    args: string[],
    options: { cwd?: string; throwOnError?: boolean }
  ) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    combined: string;
  }>;
  onCommandExecuted: () => { dispose: () => void };
  dispose: () => void;
}

function makeMockCli(): MockCli {
  const responses: Array<{
    match: RegExp | string;
    response: { exitCode: number; stdout: string; stderr: string };
  }> = [];
  const executed: CliExec[] = [];
  return {
    executed,
    setResponse(match, response) {
      responses.unshift({ match, response });
    },
    async exec(args, options) {
      executed.push({ args, options });
      const joined = args.join(' ');
      for (const { match, response } of responses) {
        if (typeof match === 'string' ? joined === match : match.test(joined)) {
          if (options.throwOnError && response.exitCode !== 0) {
            throw new Error(`Git command failed: ${response.stderr}`);
          }
          return { ...response, combined: response.stdout + response.stderr };
        }
      }
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
    onCommandExecuted: () => ({ dispose: () => {} }),
    dispose: () => {},
  };
}

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

function makeGitService(
  repo: IRepository,
  overrides: {
    getCommitDiff?: (repo: IRepository, hash: string) => Promise<IDiff[]>;
    getCommit?: (repo: IRepository, hash: string) => Promise<{ hash: string; message: string }>;
    revertResult?: { success: boolean; conflicts?: string[] };
    revertThrows?: Error;
  } = {}
): IGitService & { calls: string[] } {
  const calls: string[] = [];
  const emitter = new EventEmitter<IRepository>();
  return {
    calls,
    onDidChangeRepository: emitter.event,
    getRepositories: () => [repo],
    getRepository: async () => repo,
    getBranches: async () => [],
    getTags: async () => [],
    commit: async () => {},
    amend: async () => {},
    createBranch: async () => {},
    checkout: async () => {},
    deleteBranch: async () => {},
    renameBranch: async () => {},
    mergeBranch: async () => ({ success: true }),
    rebaseBranch: async () => ({ success: true }),
    compareBranches: async () => ({
      commitsAhead: [],
      commitsBehind: [],
      aheadCount: 0,
      behindCount: 0,
      changedFiles: [],
    }),
    fetch: async () => ({ updatedRefs: [], ahead: 0, behind: 0, errors: [] }),
    onDidFetch: () => ({ dispose: () => {} }),
    resetToCommit: async () => {},
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
    stashBranch: async () => {},
    stashRename: async () => {},
    createTag: async () => {},
    deleteTag: async () => {},
    pushTag: async () => {},
    getLog: async () => [],
    getCommit: async (r: IRepository, h: string) => {
      calls.push(`getCommit:${h}`);
      if (overrides.getCommit) {
        return overrides.getCommit(r, h) as unknown as ReturnType<IGitService['getCommit']>;
      }
      return {
        hash: h,
        shortHash: h.substring(0, 8),
        message: 'feat: test commit subject\n\nbody',
        author: { name: '', email: '' },
        committer: { name: '', email: '' },
        parents: [],
        authorDate: new Date(),
        commitDate: new Date(),
      };
    },
    getFileHistory: async () => [],
    getDiff: async () => ({ path: '', status: 'modified' as const, hunks: [], binary: false }),
    getCommitDiff: async (r: IRepository, h: string) => {
      calls.push(`getCommitDiff:${h}`);
      if (overrides.getCommitDiff) {
        return overrides.getCommitDiff(r, h);
      }
      return [];
    },
    getMultiCommitDiff: async () => [],
    getBlame: async () => [],
    cherryPick: async () => ({ success: true }),
    cherryPickAbort: async () => {},
    cherryPickContinue: async () => ({ success: true }),
    revert: async (_r: IRepository, hashes: string[]) => {
      calls.push(`revert:${hashes.join(',')}`);
      if (overrides.revertThrows) {
        throw overrides.revertThrows;
      }
      return overrides.revertResult ?? { success: true };
    },
    revertAbort: async () => {
      calls.push('revertAbort');
    },
    revertContinue: async () => ({ success: true }),
    getStatus: async () => [],
    stage: async () => {},
    unstage: async () => {},
    stageHunk: async () => {},
    stageLines: async () => {},
    unstageHunk: async () => {},
    revertFile: async () => {},
    dispose: () => {},
  } as unknown as IGitService & { calls: string[] };
}

function makeRebase(): IRebaseService {
  const emitter = new EventEmitter<undefined>();
  return {
    startInteractiveRebase: async () => ({
      onto: '',
      originalBranch: '',
      commits: [],
      currentStep: 0,
      status: 'planning',
    }),
    getRebaseSession: () => undefined,
    updateRebasePlan: () => {},
    executeRebase: async () => ({ success: true, status: 'completed' as const }),
    continueRebase: async () => ({ success: true, status: 'completed' as const }),
    abortRebase: async () => {},
    skipCommit: async () => ({ success: true, status: 'completed' as const }),
    provideRewordMessage: async () => ({ success: true, status: 'completed' as const }),
    amendEditCommit: async () => ({ success: true, status: 'completed' as const }),
    onDidChangeRebaseSession: emitter.event,
    dispose: () => {},
  } as unknown as IRebaseService;
}

function makeProvider(): GitToolWindowProvider & { refreshCalls: number } {
  let count = 0;
  return {
    onDidRequestLogContextAction: () => ({ dispose: () => {} }),
    get refreshCalls(): number {
      return count;
    },
    refresh: () => {
      count++;
    },
  } as unknown as GitToolWindowProvider & { refreshCalls: number };
}

interface Trackers {
  info: string[];
  error: string[];
  warn: { message: string; items: string[]; modal: boolean; response?: string }[];
}

function installWindowStubs(
  quickPickResponder: (items: readonly { path: string }[], title?: string) => unknown,
  warnResponder: () => string | undefined = () => undefined
): { trackers: Trackers; restore: () => void } {
  const trackers: Trackers = { info: [], error: [], warn: [] };
  const oInfo = vscode.window.showInformationMessage;
  const oErr = vscode.window.showErrorMessage;
  const oWarn = vscode.window.showWarningMessage;
  const oQP = vscode.window.showQuickPick;

  const w = writableWindow();
  w.showInformationMessage = (m: string): Promise<string | undefined> => {
    trackers.info.push(m);
    return Promise.resolve(undefined);
  };
  w.showErrorMessage = (m: string): Promise<string | undefined> => {
    trackers.error.push(m);
    return Promise.resolve(undefined);
  };
  w.showWarningMessage = (
    m: string,
    optsOrFirst?: unknown,
    ...rest: unknown[]
  ): Promise<string | undefined> => {
    let modal = false;
    let items: string[] = [];
    const restStrings = rest.filter((i): i is string => typeof i === 'string');
    if (
      optsOrFirst &&
      typeof optsOrFirst === 'object' &&
      'modal' in optsOrFirst
    ) {
      modal = Boolean((optsOrFirst as { modal?: boolean }).modal);
      items = restStrings;
    } else if (typeof optsOrFirst === 'string') {
      items = [optsOrFirst, ...restStrings];
    } else {
      items = restStrings;
    }
    const response = warnResponder();
    trackers.warn.push({ message: m, items, modal, response });
    return Promise.resolve(response);
  };
  w.showQuickPick = async (
    items: unknown,
    opts?: unknown
  ): Promise<unknown | undefined> => {
    const arr = (await Promise.resolve(items)) as readonly { path: string }[];
    const options = (opts as { title?: string } | undefined) ?? {};
    return quickPickResponder(arr, options.title);
  };

  return {
    trackers,
    restore: () => {
      const r = writableWindow();
      r.showInformationMessage = oInfo as unknown as typeof r.showInformationMessage;
      r.showErrorMessage = oErr as unknown as typeof r.showErrorMessage;
      r.showWarningMessage = oWarn as unknown as typeof r.showWarningMessage;
      r.showQuickPick = oQP as unknown as typeof r.showQuickPick;
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CommitContextMenuCommands — T2-04 selective revert', () => {
  const testHash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80123';

  it('with zero/one file in the commit → falls through to gitService.revert (unchanged behaviour)', async () => {
    const repo = makeRepo();
    const gitService = makeGitService(repo, {
      // Only one changed file → no picker, straight to revert.
      getCommitDiff: async () => [
        { path: 'single.ts', status: 'modified', hunks: [], binary: false },
      ],
    });
    const commands = new CommitContextMenuCommands(gitService, makeRebase(), makeProvider());

    const { restore } = installWindowStubs(() => undefined);
    try {
      await commands._handleAction('revert', [testHash]);
      assert.ok(gitService.calls.includes(`revert:${testHash}`));
    } finally {
      restore();
    }
  });

  it('user keeps all files selected → fall through to gitService.revert', async () => {
    const repo = makeRepo();
    const gitService = makeGitService(repo, {
      getCommitDiff: async () => [
        { path: 'a.ts', status: 'modified', hunks: [], binary: false },
        { path: 'b.ts', status: 'added', hunks: [], binary: false },
      ],
    });
    const commands = new CommitContextMenuCommands(gitService, makeRebase(), makeProvider());

    // User keeps everything.
    const { restore } = installWindowStubs((items) => [...items]);
    try {
      await commands._handleAction('revert', [testHash]);
      assert.ok(
        gitService.calls.includes(`revert:${testHash}`),
        `expected gitService.revert to run, got calls: ${gitService.calls.join(', ')}`
      );
    } finally {
      restore();
    }
  });

  it('user cancels the picker → no revert, no toast', async () => {
    const repo = makeRepo();
    const gitService = makeGitService(repo, {
      getCommitDiff: async () => [
        { path: 'a.ts', status: 'modified', hunks: [], binary: false },
        { path: 'b.ts', status: 'added', hunks: [], binary: false },
      ],
    });
    const commands = new CommitContextMenuCommands(gitService, makeRebase(), makeProvider());

    const { trackers, restore } = installWindowStubs(() => undefined);
    try {
      await commands._handleAction('revert', [testHash]);
      assert.ok(!gitService.calls.some((c) => c.startsWith('revert:')));
      assert.strictEqual(trackers.info.length, 0);
      assert.strictEqual(trackers.error.length, 0);
    } finally {
      restore();
    }
  });

  it('user deselects some → uses git revert -n + checkout + commit', async () => {
    const repo = makeRepo();
    const gitService = makeGitService(repo, {
      getCommitDiff: async () => [
        { path: 'a.ts', status: 'modified', hunks: [], binary: false },
        { path: 'b.ts', status: 'added', hunks: [], binary: false },
        { path: 'c.ts', status: 'deleted', hunks: [], binary: false },
      ],
    });
    const cli = makeMockCli();
    const commands = new CommitContextMenuCommands(
      gitService,
      makeRebase(),
      makeProvider(),
      cli as any
    );

    // User picks only a.ts; b.ts and c.ts are deselected.
    const { trackers, restore } = installWindowStubs((items) => [items[0]]);
    try {
      await commands._handleAction('revert', [testHash]);

      const joined = cli.executed.map((e) => e.args.join(' '));
      assert.ok(
        joined.some((c) => c === `revert -n ${testHash}`),
        `expected 'git revert -n <hash>', got: ${joined.join(' | ')}`
      );
      assert.ok(
        joined.some((c) => c.startsWith('checkout HEAD -- ')),
        'expected git checkout HEAD -- <excluded files>'
      );
      assert.ok(
        joined.some((c) => c.startsWith('commit -m ')),
        'expected final git commit'
      );
      // Toast mentions count.
      assert.ok(trackers.info.some((m) => m.includes('1 of 3')));
    } finally {
      restore();
    }
  });

  it('deselect all files → no-op info toast, no revert', async () => {
    const repo = makeRepo();
    const gitService = makeGitService(repo, {
      getCommitDiff: async () => [
        { path: 'a.ts', status: 'modified', hunks: [], binary: false },
        { path: 'b.ts', status: 'added', hunks: [], binary: false },
      ],
    });
    const cli = makeMockCli();
    const commands = new CommitContextMenuCommands(
      gitService,
      makeRebase(),
      makeProvider(),
      cli as any
    );

    const { trackers, restore } = installWindowStubs(() => []);
    try {
      await commands._handleAction('revert', [testHash]);
      assert.ok(!gitService.calls.some((c) => c.startsWith('revert:')));
      assert.strictEqual(cli.executed.length, 0, 'no CLI ops on empty selection');
      assert.ok(trackers.info.some((m) => m.toLowerCase().includes('no files')));
    } finally {
      restore();
    }
  });

  it('CLI revert -n failure aborts the partial revert and surfaces an error', async () => {
    const repo = makeRepo();
    const gitService = makeGitService(repo, {
      getCommitDiff: async () => [
        { path: 'a.ts', status: 'modified', hunks: [], binary: false },
        { path: 'b.ts', status: 'added', hunks: [], binary: false },
      ],
    });
    const cli = makeMockCli();
    cli.setResponse(new RegExp(`^revert -n ${testHash}$`), {
      exitCode: 1,
      stdout: '',
      stderr: 'revert -n failed',
    });
    const commands = new CommitContextMenuCommands(
      gitService,
      makeRebase(),
      makeProvider(),
      cli as any
    );

    const { trackers, restore } = installWindowStubs((items) => [items[0]]);
    try {
      await commands._handleAction('revert', [testHash]);
      assert.strictEqual(trackers.error.length, 1);
      assert.ok(trackers.error[0].includes('revert -n failed'));
    } finally {
      restore();
    }
  });
});

describe('CommitContextMenuCommands — T2-04 Drop Selected Changes', () => {
  const testHash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80123';

  function makeHarness(diffs: IDiff[] = []): {
    commands: CommitContextMenuCommands;
    cli: MockCli;
    gitService: IGitService & { calls: string[] };
    provider: GitToolWindowProvider & { refreshCalls: number };
  } {
    const repo = makeRepo();
    const gitService = makeGitService(repo, { getCommitDiff: async () => diffs });
    const cli = makeMockCli();
    const provider = makeProvider();
    const commands = new CommitContextMenuCommands(gitService, makeRebase(), provider, cli as any);
    return { commands, cli, gitService, provider };
  }

  it('refuses when the commit is not HEAD', async () => {
    const { commands, cli } = makeHarness();
    cli.setResponse('rev-parse HEAD', { exitCode: 0, stdout: 'differentHash\n', stderr: '' });

    const { trackers, restore } = installWindowStubs(() => undefined);
    try {
      await commands.dropSelectedChangesFromCommit(testHash);
      assert.strictEqual(trackers.error.length, 1);
      assert.ok(
        trackers.error[0].includes('not HEAD') || trackers.error[0].includes('most recent commit')
      );
      // No destructive CLI ops — only the safety queries.
      const destructive = cli.executed
        .map((e) => e.args.join(' '))
        .filter(
          (c) =>
            c.startsWith('reset --soft') || c.startsWith('commit ') || c === `revert ${testHash}`
        );
      assert.strictEqual(destructive.length, 0);
    } finally {
      restore();
    }
  });

  it('refuses on pushed commits (remote branch contains the hash)', async () => {
    const { commands, cli } = makeHarness([
      { path: 'a.ts', status: 'modified', hunks: [], binary: false },
    ]);
    cli.setResponse('rev-parse HEAD', { exitCode: 0, stdout: `${testHash}\n`, stderr: '' });
    cli.setResponse(new RegExp(`^branch --remotes --contains ${testHash}$`), {
      exitCode: 0,
      stdout: '  origin/main\n',
      stderr: '',
    });

    const { trackers, restore } = installWindowStubs(() => undefined);
    try {
      await commands.dropSelectedChangesFromCommit(testHash);
      assert.strictEqual(trackers.error.length, 1);
      assert.ok(
        trackers.error[0].toLowerCase().includes('pushed'),
        `expected "pushed" in the error, got "${trackers.error[0]}"`
      );
    } finally {
      restore();
    }
  });

  it('user cancels the file picker → no git ops', async () => {
    const { commands, cli } = makeHarness([
      { path: 'a.ts', status: 'modified', hunks: [], binary: false },
      { path: 'b.ts', status: 'added', hunks: [], binary: false },
    ]);
    cli.setResponse('rev-parse HEAD', { exitCode: 0, stdout: `${testHash}\n`, stderr: '' });
    cli.setResponse(new RegExp(`^branch --remotes --contains ${testHash}$`), {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const { trackers, restore } = installWindowStubs(() => undefined);
    try {
      await commands.dropSelectedChangesFromCommit(testHash);
      assert.strictEqual(trackers.warn.length, 0, 'no confirm shown');
      const destructive = cli.executed
        .map((e) => e.args.join(' '))
        .filter((c) => c.startsWith('reset --soft') || c.startsWith('commit -C'));
      assert.strictEqual(destructive.length, 0);
    } finally {
      restore();
    }
  });

  it('user cancels the confirm modal → no git ops', async () => {
    const { commands, cli } = makeHarness([
      { path: 'a.ts', status: 'modified', hunks: [], binary: false },
      { path: 'b.ts', status: 'added', hunks: [], binary: false },
    ]);
    cli.setResponse('rev-parse HEAD', { exitCode: 0, stdout: `${testHash}\n`, stderr: '' });
    cli.setResponse(new RegExp(`^branch --remotes --contains ${testHash}$`), {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const { trackers, restore } = installWindowStubs(
      (items) => [items[0]],
      () => 'Cancel'
    );
    try {
      await commands.dropSelectedChangesFromCommit(testHash);
      assert.strictEqual(trackers.warn.length, 1, 'one confirm modal shown');
      assert.strictEqual(trackers.warn[0].modal, true);
      assert.deepStrictEqual(trackers.warn[0].items, ['Drop', 'Cancel']);
      const destructive = cli.executed
        .map((e) => e.args.join(' '))
        .filter((c) => c.startsWith('reset --soft') || c.startsWith('commit -C'));
      assert.strictEqual(destructive.length, 0);
    } finally {
      restore();
    }
  });

  it('drop some files: soft-reset → checkout HEAD -- dropped → commit -C <hash>', async () => {
    const { commands, cli } = makeHarness([
      { path: 'a.ts', status: 'modified', hunks: [], binary: false },
      { path: 'b.ts', status: 'added', hunks: [], binary: false },
      { path: 'c.ts', status: 'deleted', hunks: [], binary: false },
    ]);
    cli.setResponse('rev-parse HEAD', { exitCode: 0, stdout: `${testHash}\n`, stderr: '' });
    cli.setResponse(new RegExp(`^branch --remotes --contains ${testHash}$`), {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const { trackers, restore } = installWindowStubs(
      (items) => [items[0], items[1]], // drop a.ts + b.ts
      () => 'Drop'
    );
    try {
      await commands.dropSelectedChangesFromCommit(testHash);
      const joined = cli.executed.map((e) => e.args.join(' '));
      assert.ok(
        joined.some((c) => c === 'reset --soft HEAD^'),
        `missing reset --soft, got: ${joined.join(' | ')}`
      );
      assert.ok(
        joined.some(
          (c) => c.startsWith('checkout HEAD -- ') && c.includes('a.ts') && c.includes('b.ts')
        ),
        `missing checkout HEAD -- a.ts b.ts, got: ${joined.join(' | ')}`
      );
      assert.ok(
        joined.some((c) => c === `commit -C ${testHash}`),
        `missing commit -C <hash>, got: ${joined.join(' | ')}`
      );
      assert.ok(trackers.info.some((m) => m.includes('Dropped 2 file(s)')));
    } finally {
      restore();
    }
  });

  it('drop ALL files: no re-commit (the original commit disappears)', async () => {
    const { commands, cli } = makeHarness([
      { path: 'a.ts', status: 'modified', hunks: [], binary: false },
      { path: 'b.ts', status: 'added', hunks: [], binary: false },
    ]);
    cli.setResponse('rev-parse HEAD', { exitCode: 0, stdout: `${testHash}\n`, stderr: '' });
    cli.setResponse(new RegExp(`^branch --remotes --contains ${testHash}$`), {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const { trackers, restore } = installWindowStubs(
      (items) => [...items], // drop everything
      () => 'Drop'
    );
    try {
      await commands.dropSelectedChangesFromCommit(testHash);
      const joined = cli.executed.map((e) => e.args.join(' '));
      assert.ok(joined.some((c) => c === 'reset --soft HEAD^'));
      assert.ok(joined.some((c) => c.startsWith('checkout HEAD -- ')));
      // No re-commit should have happened.
      assert.ok(!joined.some((c) => c.startsWith('commit -C')));
      assert.ok(trackers.info.some((m) => m.includes('Removed commit')));
    } finally {
      restore();
    }
  });

  it('refuses on empty hash', async () => {
    const { commands, cli } = makeHarness();
    const { trackers, restore } = installWindowStubs(() => undefined);
    try {
      await commands.dropSelectedChangesFromCommit('');
      assert.strictEqual(trackers.error.length, 0);
      // No CLI calls — early return before any check.
      assert.strictEqual(cli.executed.length, 0);
    } finally {
      restore();
    }
  });
});

// ─── R5 H-3 — multi-root repo resolution ────────────────────────────────────

describe('CommitContextMenuCommands — R5 H-3 multi-root repo resolution', () => {
  const testHash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80123';

  function makeMultiRepoGitService(repos: IRepository[]): IGitService & { calls: string[] } {
    const calls: string[] = [];
    const emitter = new EventEmitter<IRepository>();
    return {
      calls,
      onDidChangeRepository: emitter.event,
      getRepositories: () => repos,
      getRepository: async () => repos[0],
      getBranches: async () => [],
      getTags: async () => [],
      commit: async () => {},
      amend: async () => {},
      createBranch: async () => {},
      checkout: async () => {},
      deleteBranch: async () => {},
      renameBranch: async () => {},
      mergeBranch: async () => ({ success: true }),
      rebaseBranch: async () => ({ success: true }),
      compareBranches: async () => ({
        commitsAhead: [],
        commitsBehind: [],
        aheadCount: 0,
        behindCount: 0,
        changedFiles: [],
      }),
      fetch: async () => ({ updatedRefs: [], ahead: 0, behind: 0, errors: [] }),
      onDidFetch: () => ({ dispose: () => {} }),
      resetToCommit: async () => {},
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
      stashBranch: async () => {},
      stashRename: async () => {},
      createTag: async () => {},
      deleteTag: async () => {},
      pushTag: async () => {},
      getLog: async () => [],
      getCommit: async (_r: IRepository, h: string) => ({
        hash: h,
        shortHash: h.substring(0, 8),
        message: 'feat: test',
        author: { name: '', email: '' },
        committer: { name: '', email: '' },
        parents: [],
        authorDate: new Date(),
        commitDate: new Date(),
      }),
      getFileHistory: async () => [],
      getDiff: async () => ({ path: '', status: 'modified' as const, hunks: [], binary: false }),
      getCommitDiff: async (r: IRepository) => {
        calls.push(`getCommitDiff:${r.rootUri.fsPath}`);
        return [
          { path: 'a.ts', status: 'modified' as const, hunks: [], binary: false },
          { path: 'b.ts', status: 'added' as const, hunks: [], binary: false },
        ];
      },
      getMultiCommitDiff: async () => [],
      getBlame: async () => [],
      cherryPick: async () => ({ success: true }),
      cherryPickAbort: async () => {},
      cherryPickContinue: async () => ({ success: true }),
      revert: async () => ({ success: true }),
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
    } as unknown as IGitService & { calls: string[] };
  }

  it('dropSelectedChangesFromCommit targets the repo that owns the active editor (preferActive)', async () => {
    // Two repos: A (repositories[0], the OLD wrong answer) and B (where the
    // active editor lives, the RIGHT answer post-fix).
    const repoA: IRepository = {
      rootUri: Uri.file('/repos/alpha'),
      state: 'idle',
      head: { name: 'refs/heads/main', commit: 'aaaa1111', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
    const repoB: IRepository = {
      rootUri: Uri.file('/repos/beta'),
      state: 'idle',
      head: { name: 'refs/heads/main', commit: 'bbbb2222', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
    const gitService = makeMultiRepoGitService([repoA, repoB]);
    const cli = makeMockCli();
    cli.setResponse('rev-parse HEAD', { exitCode: 0, stdout: `${testHash}\n`, stderr: '' });
    cli.setResponse(new RegExp(`^branch --remotes --contains ${testHash}$`), {
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    // Inject a stub resolver that reflects the "active editor in repoB"
    // decision — equivalent to resolveRepo(preferActive: true) landing on B.
    const resolver = async (): Promise<IRepository | undefined> => repoB;

    const commands = new CommitContextMenuCommands(
      gitService,
      makeRebase(),
      makeProvider(),
      cli as any,
      undefined,
      resolver
    );

    const { restore } = installWindowStubs(
      (items) => [items[0]], // drop first file
      () => 'Drop'
    );
    try {
      await commands.dropSelectedChangesFromCommit(testHash);

      // Every destructive CLI op must have been invoked with repoB's cwd,
      // not repoA's. Before the H-3 fix this would have been repoA.
      const cwds = new Set(cli.executed.map((e) => e.options.cwd));
      assert.ok(
        cwds.has(repoB.rootUri.fsPath),
        `no CLI call in repoB's cwd; saw ${[...cwds].join(', ')}`
      );
      assert.ok(
        !cwds.has(repoA.rootUri.fsPath),
        `regression: CLI ran in repoA's cwd; saw ${[...cwds].join(', ')}`
      );

      // Also assert that getCommitDiff was called on repoB (so the webview
      // picker showed the right diff).
      assert.ok(
        gitService.calls.includes(`getCommitDiff:${repoB.rootUri.fsPath}`),
        `getCommitDiff not invoked on repoB; calls: ${gitService.calls.join(', ')}`
      );
    } finally {
      restore();
    }
  });

  it('revert targets the repo the resolver picked, not repositories[0]', async () => {
    const repoA: IRepository = {
      rootUri: Uri.file('/repos/alpha'),
      state: 'idle',
      head: { name: 'refs/heads/main', commit: 'aaaa1111', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
    const repoB: IRepository = {
      rootUri: Uri.file('/repos/beta'),
      state: 'idle',
      head: { name: 'refs/heads/main', commit: 'bbbb2222', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };

    const reverted: Array<{ cwd: string; hashes: string[] }> = [];
    const gitService = makeMultiRepoGitService([repoA, repoB]);
    // Override revert to record which repo was targeted.
    (gitService as unknown as { revert: unknown }).revert = async (
      r: IRepository,
      hashes: string[]
    ) => {
      reverted.push({ cwd: r.rootUri.fsPath, hashes });
      return { success: true };
    };

    const resolver = async (): Promise<IRepository | undefined> => repoB;

    const commands = new CommitContextMenuCommands(
      gitService,
      makeRebase(),
      makeProvider(),
      makeMockCli() as any,
      undefined,
      resolver
    );

    // Single-file commit → selective revert skipped, falls through to
    // gitService.revert exactly like the standard path.
    (gitService as unknown as { getCommitDiff: unknown }).getCommitDiff = async () => [
      { path: 'x.ts', status: 'modified' as const, hunks: [], binary: false },
    ];

    const { restore } = installWindowStubs(() => undefined);
    try {
      await commands._handleAction('revert', [testHash]);
      assert.strictEqual(reverted.length, 1);
      assert.strictEqual(reverted[0].cwd, repoB.rootUri.fsPath);
    } finally {
      restore();
    }
  });
});
