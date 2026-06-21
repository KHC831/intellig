/**
 * Unit tests for the History tab.
 *
 * Covers:
 *   - Pure helpers (`buildFileAtRevisionUri`, `buildDiffAnyTwoTitle`,
 *     `buildCompareWithLocalTitle`, `reduceHistoryState`).
 *   - `HistoryTab` class behaviour: loadFile, --follow toggle, branch filter,
 *     compare-with (diff two), compare-with-local, empty-state handling.
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { EventEmitter, Uri } from '../../../mocks/vscode';
import { writableCommands, writableWindow, writableWorkspace } from '../../../typed/windowStub';
import type {
  IBranch,
  ICommit,
  IDiff,
  IGitService,
  IFileHistoryOptions,
  IRepository,
} from '../../../../src/git-core/interfaces/IGitService';
import {
  HistoryTab,
  NO_FILE_LOADED_MESSAGE,
  buildCompareWithLocalTitle,
  buildDiffAnyTwoTitle,
  buildFileAtRevisionUri,
  createInitialHistoryTabState,
  reduceHistoryState,
  type IHistoryTabState,
} from '../../../../src/git-core/gitToolWindow/tabs/HistoryTab';
import type { IWebviewTabMessage } from '../../../../src/git-core/gitToolWindow/tabRouter';

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('HistoryTab — pure helpers', () => {
  describe('buildFileAtRevisionUri', () => {
    it('constructs an `intellig-git:` URI with URL-encoded ref', () => {
      const uri = buildFileAtRevisionUri('src/foo.ts', 'origin/main');
      const str = uri.toString();
      assert.ok(str.includes('intellig-git:'), `expected intellig-git scheme: "${str}"`);
      assert.ok(str.includes('src/foo.ts'), `expected path: "${str}"`);
      assert.ok(
        str.includes('origin%2Fmain') || str.includes('origin/main'),
        `expected encoded ref: "${str}"`
      );
    });
  });

  describe('buildDiffAnyTwoTitle', () => {
    it('formats the title with short hashes', () => {
      const title = buildDiffAnyTwoTitle('src/foo.ts', 'abcdef1234567', 'fedcba7654321');
      assert.strictEqual(title, 'foo.ts (abcdef1 ↔ fedcba7)');
    });
    it('uses basename only, never the full path', () => {
      const title = buildDiffAnyTwoTitle('nested/deep/path/bar.ts', 'abc', 'def');
      assert.ok(title.startsWith('bar.ts'), title);
    });
  });

  describe('buildCompareWithLocalTitle', () => {
    it('formats the title as `<basename> (<shortRev> ↔ Working Tree)`', () => {
      assert.strictEqual(
        buildCompareWithLocalTitle('src/foo.ts', 'abcdef1234567'),
        'foo.ts (abcdef1 ↔ Working Tree)'
      );
    });
  });

  describe('reduceHistoryState', () => {
    const base: IHistoryTabState = {
      ...createInitialHistoryTabState(),
      filePath: 'src/a.ts',
      commits: [],
      selectedCommit: 'aaa',
    };

    it('selectRevision replaces selection and clears compare anchor', () => {
      const next = reduceHistoryState(base, { type: 'history.selectRevision', rev: 'bbb' });
      assert.strictEqual(next.selectedCommit, 'bbb');
      assert.strictEqual(next.compareCommit, undefined);
    });

    it('selectRevision with additive=true promotes prior selection to compare anchor', () => {
      const next = reduceHistoryState(base, {
        type: 'history.selectRevision',
        rev: 'bbb',
        additive: true,
      });
      assert.strictEqual(next.selectedCommit, 'bbb');
      assert.strictEqual(next.compareCommit, 'aaa');
    });

    it('selectRevision ignores messages without a rev', () => {
      const next = reduceHistoryState(base, { type: 'history.selectRevision' });
      assert.strictEqual(next, base);
    });

    it('toggleFollowRenames flips the flag by default', () => {
      const next = reduceHistoryState(base, { type: 'history.toggleFollowRenames' });
      assert.strictEqual(next.followRenames, !base.followRenames);
    });

    it('toggleFollowRenames honors an explicit value', () => {
      const next = reduceHistoryState(base, {
        type: 'history.toggleFollowRenames',
        value: true,
      });
      assert.strictEqual(next.followRenames, true);
    });

    it('setBranchFilter stores the branch or clears it on empty string', () => {
      const set = reduceHistoryState(base, {
        type: 'history.setBranchFilter',
        branch: 'feature/x',
      });
      assert.strictEqual(set.branchFilter, 'feature/x');
      const cleared = reduceHistoryState(set, {
        type: 'history.setBranchFilter',
        branch: '',
      });
      assert.strictEqual(cleared.branchFilter, undefined);
    });
  });
});

// ─── HistoryTab class behaviour ──────────────────────────────────────────────

describe('HistoryTab — class behaviour', () => {
  interface MockGitCalls {
    getFileHistory: Array<{ path: string; options: IFileHistoryOptions | undefined }>;
  }

  function mkRepo(): IRepository {
    return {
      rootUri: Uri.file('/repo'),
      state: 'idle',
      head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
  }

  function mkCommit(hash: string, message = 'msg'): ICommit {
    return {
      hash,
      shortHash: hash.substring(0, 7),
      message,
      author: { name: 'Test', email: 't@example.com' },
      committer: { name: 'Test', email: 't@example.com' },
      parents: [],
      authorDate: new Date('2020-01-01'),
      commitDate: new Date('2020-01-01'),
    };
  }

  function mkGitService(opts: {
    repo: IRepository;
    commits: ICommit[];
    branches?: IBranch[];
    throwOnHistory?: boolean;
  }): { service: IGitService; calls: MockGitCalls } {
    const repoChange = new EventEmitter<IRepository>();
    const calls: MockGitCalls = { getFileHistory: [] };
    const service = {
      onDidChangeRepository: repoChange.event,
      getRepositories: () => [opts.repo],
      getRepository: async () => opts.repo,
      getBranches: async () => opts.branches ?? [],
      getFileHistory: async (
        _repo: IRepository,
        path: string,
        options?: IFileHistoryOptions
      ): Promise<ICommit[]> => {
        calls.getFileHistory.push({ path, options });
        if (opts.throwOnHistory) {
          throw new Error('boom');
        }
        return opts.commits;
      },
    } as unknown as IGitService;
    return { service, calls };
  }

  // Preserve and restore vscode mocks per test.
  let origExecuteCommand: typeof vscode.commands.executeCommand;
  let origShowError: typeof vscode.window.showErrorMessage;
  let origShowInfo: typeof vscode.window.showInformationMessage;
  let origOpenDoc: ReturnType<typeof writableWorkspace>['openTextDocument'];
  let origShowDoc: ReturnType<typeof writableWindow>['showTextDocument'];
  beforeEach(() => {
    origExecuteCommand = vscode.commands.executeCommand;
    origShowError = vscode.window.showErrorMessage;
    origShowInfo = vscode.window.showInformationMessage;
    origOpenDoc = writableWorkspace().openTextDocument;
    origShowDoc = writableWindow().showTextDocument;
  });
  afterEach(() => {
    writableWorkspace().openTextDocument = origOpenDoc;
    writableWindow().showTextDocument = origShowDoc;
    writableCommands().executeCommand = origExecuteCommand as unknown as (
      command: string,
      ...rest: unknown[]
    ) => Promise<unknown>;
    writableWindow().showErrorMessage = origShowError as unknown as (
      message: string,
      ...items: string[]
    ) => Promise<string | undefined>;
    writableWindow().showInformationMessage = origShowInfo as unknown as (
      message: string,
      ...items: string[]
    ) => Promise<string | undefined>;
  });

  // ── loadFile ───────────────────────────────────────────────────────────

  it('loadFile calls getFileHistory with the path and no extras by default', async () => {
    const repo = mkRepo();
    const { service, calls } = mkGitService({ repo, commits: [mkCommit('abc')] });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');
    assert.strictEqual(calls.getFileHistory.length, 1);
    const first = calls.getFileHistory[0];
    assert.strictEqual(first.path, 'src/a.ts');
    assert.strictEqual(first.options?.follow, false);
    assert.strictEqual(first.options?.branch, undefined);
    assert.strictEqual(tab.getState().commits.length, 1);
    assert.strictEqual(tab.getState().selectedCommit, 'abc');
  });

  it('loadFile with follow-renames toggled passes follow:true', async () => {
    const repo = mkRepo();
    const { service, calls } = mkGitService({ repo, commits: [] });
    const tab = new HistoryTab(service);
    await tab.handleMessage({ type: 'history.toggleFollowRenames', value: true });
    await tab.loadFile('src/a.ts');
    assert.strictEqual(calls.getFileHistory[0].options?.follow, true);
  });

  it('loadFile passes the branch filter through', async () => {
    const repo = mkRepo();
    const { service, calls } = mkGitService({ repo, commits: [mkCommit('abc')] });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts', 'release/2.0');
    assert.strictEqual(calls.getFileHistory[0].options?.branch, 'release/2.0');
    assert.strictEqual(tab.getState().branchFilter, 'release/2.0');
  });

  it('loadFile surfaces an empty-state commit list when git returns nothing', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({ repo, commits: [] });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/ghost.ts');
    const state = tab.getState();
    assert.strictEqual(state.commits.length, 0);
    assert.strictEqual(state.selectedCommit, undefined);
    assert.strictEqual(state.loading, false);
    assert.strictEqual(state.error, undefined);
  });

  it('loadFile surfaces the error string when getFileHistory throws', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({ repo, commits: [], throwOnHistory: true });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');
    const state = tab.getState();
    assert.strictEqual(state.error, 'boom');
    assert.strictEqual(state.commits.length, 0);
  });

  it('changing the branch filter via message triggers a reload', async () => {
    const repo = mkRepo();
    const { service, calls } = mkGitService({ repo, commits: [mkCommit('abc')] });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');
    calls.getFileHistory.length = 0;
    await tab.handleMessage({ type: 'history.setBranchFilter', branch: 'develop' });
    assert.strictEqual(calls.getFileHistory.length, 1);
    assert.strictEqual(calls.getFileHistory[0].options?.branch, 'develop');
  });

  // ── Compare ────────────────────────────────────────────────────────────

  it('compareWith opens a vscode.diff with intellig-git: URIs for both sides', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({ repo, commits: [mkCommit('abc'), mkCommit('def')] });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');

    const diffCalls: Array<{ left: vscode.Uri; right: vscode.Uri; title: string }> = [];
    writableCommands().executeCommand = (command: string, ...args: unknown[]): Promise<unknown> => {
      if (command === 'vscode.diff') {
        diffCalls.push({
          left: args[0] as vscode.Uri,
          right: args[1] as vscode.Uri,
          title: args[2] as string,
        });
      }
      return Promise.resolve(undefined);
    };

    await tab.compareWith('abcdef1', 'fedcba2');
    assert.strictEqual(diffCalls.length, 1);
    assert.ok(diffCalls[0].left.toString().includes('intellig-git:'));
    assert.ok(diffCalls[0].right.toString().includes('intellig-git:'));
    assert.ok(diffCalls[0].title.includes('abcdef1'));
    assert.ok(diffCalls[0].title.includes('fedcba2'));
  });

  it('compareWithLocal opens diff with intellig-git: + on-disk URI', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({ repo, commits: [mkCommit('abc')] });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');

    const diffCalls: Array<{ left: vscode.Uri; right: vscode.Uri; title: string }> = [];
    writableCommands().executeCommand = (command: string, ...args: unknown[]): Promise<unknown> => {
      if (command === 'vscode.diff') {
        diffCalls.push({
          left: args[0] as vscode.Uri,
          right: args[1] as vscode.Uri,
          title: args[2] as string,
        });
      }
      return Promise.resolve(undefined);
    };

    await tab.compareWithLocal('abcdef1');
    assert.strictEqual(diffCalls.length, 1);
    assert.ok(diffCalls[0].left.toString().includes('intellig-git:'));
    // Right side is a local file URI built from /repo + path.
    assert.ok(
      diffCalls[0].right.fsPath.includes('src/a.ts') ||
        diffCalls[0].right.path.includes('src/a.ts'),
      `right URI should point at working-tree file; got: ${diffCalls[0].right.toString()}`
    );
    assert.ok(diffCalls[0].title.includes('Working Tree'));
  });

  it('compareWith / compareWithLocal are no-ops when no filePath is loaded', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({ repo, commits: [] });
    const tab = new HistoryTab(service);
    const diffCalls: unknown[] = [];
    writableCommands().executeCommand = (command: string): Promise<unknown> => {
      if (command === 'vscode.diff') {
        diffCalls.push(command);
      }
      return Promise.resolve(undefined);
    };
    await tab.compareWith('a', 'b');
    await tab.compareWithLocal('a');
    assert.strictEqual(diffCalls.length, 0);
  });

  // ──: user feedback on empty-state fall-through ─────────────────────

  it('openAtRevision, compareWith, compareWithLocal show an info toast when filePath is unset', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({ repo, commits: [] });
    const tab = new HistoryTab(service);
    const infoMessages: string[] = [];
    writableWindow().showInformationMessage = (message: string): Promise<string | undefined> => {
      infoMessages.push(message);
      return Promise.resolve(undefined);
    };

    await tab.openAtRevision('abc');
    await tab.compareWith('a', 'b');
    await tab.compareWithLocal('a');
    assert.strictEqual(
      infoMessages.length,
      3,
      `expected 3 info toasts, got ${infoMessages.length}`
    );
    for (const msg of infoMessages) {
      assert.strictEqual(msg, NO_FILE_LOADED_MESSAGE);
    }
  });

  // ──: compareWithLocal joins repo root via Uri.joinPath ─────────────

  it('compareWithLocal joins the repo rootUri via Uri.joinPath (no ad-hoc / separator)', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({ repo, commits: [mkCommit('abc')] });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/nested/a.ts');

    const diffCalls: Array<{ left: vscode.Uri; right: vscode.Uri; title: string }> = [];
    writableCommands().executeCommand = (command: string, ...args: unknown[]): Promise<unknown> => {
      if (command === 'vscode.diff') {
        diffCalls.push({
          left: args[0] as vscode.Uri,
          right: args[1] as vscode.Uri,
          title: args[2] as string,
        });
      }
      return Promise.resolve(undefined);
    };

    await tab.compareWithLocal('abcdef1');
    assert.strictEqual(diffCalls.length, 1);
    // Uri.joinPath combines root /repo + subpath src/nested/a.ts.
    const expected = Uri.joinPath(repo.rootUri, 'src/nested/a.ts');
    assert.strictEqual(diffCalls[0].right.toString(), expected.toString());
    // Must not contain double separators (which the old `/` fallback could
    // produce if the root URI trailing-slash heuristic misfired).
    assert.ok(
      !diffCalls[0].right.path.includes('//'),
      `right URI path should not contain '//': ${diffCalls[0].right.toString()}`
    );
  });

  // ── openAtRevision ─────────────────────────────────────────────────────

  it('openAtRevision runs vscode.open on the intellig-git URI', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({ repo, commits: [mkCommit('abc')] });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');

    const openCalls: vscode.Uri[] = [];
    writableCommands().executeCommand = (command: string, ...args: unknown[]): Promise<unknown> => {
      if (command === 'vscode.open') {
        openCalls.push(args[0] as vscode.Uri);
      }
      return Promise.resolve(undefined);
    };

    await tab.openAtRevision('abcdef1');
    assert.strictEqual(openCalls.length, 1);
    assert.ok(openCalls[0].toString().includes('intellig-git:'));
    assert.ok(openCalls[0].toString().includes('src/a.ts'));
  });

  // ── getVersion (open the file content at a revision) ────────────────────

  it('getVersion fetches content via getFileAtRevision and opens it read-only', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({ repo, commits: [mkCommit('abc1234')] });
    const fileCalls: Array<{ path: string; rev: string }> = [];
    (service as unknown as { getFileAtRevision: unknown }).getFileAtRevision = async (
      _repo: IRepository,
      path: string,
      rev: string
    ): Promise<string> => {
      fileCalls.push({ path, rev });
      return 'OLD CONTENT';
    };
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');

    const opened: Array<{ content?: string }> = [];
    const shown: unknown[] = [];
    writableWorkspace().openTextDocument = async (
      options: string | vscode.Uri | { content?: string; language?: string }
    ): Promise<{
      uri: vscode.Uri;
      getText: () => string;
      languageId: string;
      isUntitled: boolean;
    }> => {
      const opts = options as { content?: string };
      opened.push(opts);
      return {
        uri: Uri.parse('untitled:Untitled-1'),
        getText: () => opts.content ?? '',
        languageId: 'plaintext',
        isUntitled: true,
      };
    };
    writableWindow().showTextDocument = async (doc: unknown): Promise<{ document: unknown }> => {
      shown.push(doc);
      return { document: doc };
    };

    await tab.getVersion('abc1234');
    assert.deepStrictEqual(fileCalls, [{ path: 'src/a.ts', rev: 'abc1234' }]);
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0].content, 'OLD CONTENT');
    assert.strictEqual(shown.length, 1);
  });

  it('getVersion routes through handleMessage(history.getVersion)', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({ repo, commits: [mkCommit('abc1234')] });
    const fileCalls: string[] = [];
    (service as unknown as { getFileAtRevision: unknown }).getFileAtRevision = async (
      _repo: IRepository,
      _path: string,
      rev: string
    ): Promise<string> => {
      fileCalls.push(rev);
      return 'x';
    };
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');
    writableWorkspace().openTextDocument = async (): Promise<{
      uri: vscode.Uri;
      getText: () => string;
      languageId: string;
      isUntitled: boolean;
    }> => ({
      uri: Uri.parse('untitled:Untitled-1'),
      getText: () => 'x',
      languageId: 'plaintext',
      isUntitled: true,
    });
    writableWindow().showTextDocument = async (doc: unknown): Promise<{ document: unknown }> => ({
      document: doc,
    });

    await tab.handleMessage({ type: 'history.getVersion', rev: 'abc1234' });
    assert.deepStrictEqual(fileCalls, ['abc1234']);
  });

  it('getVersion shows the no-file info toast when filePath is unset', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({ repo, commits: [] });
    const tab = new HistoryTab(service);
    const infoMessages: string[] = [];
    writableWindow().showInformationMessage = (message: string): Promise<string | undefined> => {
      infoMessages.push(message);
      return Promise.resolve(undefined);
    };
    await tab.getVersion('abc1234');
    assert.deepStrictEqual(infoMessages, [NO_FILE_LOADED_MESSAGE]);
  });

  it('getVersion drops a stale fetch when the loaded file changed mid-flight', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({
      repo,
      commits: [mkCommit('abc1234'), mkCommit('def5678')],
    });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');

    let resolveFetch: (value: string) => void = () => {};
    (service as unknown as { getFileAtRevision: unknown }).getFileAtRevision =
      (): Promise<string> =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        });

    const opened: unknown[] = [];
    writableWorkspace().openTextDocument = async (
      options: string | vscode.Uri | { content?: string; language?: string }
    ): Promise<{
      uri: vscode.Uri;
      getText: () => string;
      languageId: string;
      isUntitled: boolean;
    }> => {
      opened.push(options);
      return {
        uri: Uri.parse('untitled:Untitled-1'),
        getText: () => '',
        languageId: 'plaintext',
        isUntitled: true,
      };
    };

    const inFlight = tab.getVersion('abc1234');
    // The user loads a different file before the fetch resolves.
    await tab.loadFile('src/other.ts');
    resolveFetch('STALE CONTENT');
    await inFlight;
    assert.strictEqual(opened.length, 0, 'a stale revision fetch must not open an editor');
  });

  // ── Malformed messages ─────────────────────────────────────────────────

  it('drops malformed messages silently', async () => {
    const repo = mkRepo();
    const { service, calls } = mkGitService({ repo, commits: [] });
    const tab = new HistoryTab(service);
    // Deliberately feed shapes the production type forbids — this is the
    // whole point of the "drops malformed messages silently" assertion.
    // Cast through `unknown` so the test documents that these are the
    // hostile inputs the router can legitimately hand us (e.g. a renderer
    // that drops fields, or a rogue postMessage).
    await tab.handleMessage(undefined as unknown as IWebviewTabMessage);
    await tab.handleMessage(null as unknown as IWebviewTabMessage);
    await tab.handleMessage({} as unknown as IWebviewTabMessage);
    await tab.handleMessage({ type: 'history.loadFile' }); // no path
    assert.strictEqual(calls.getFileHistory.length, 0);
  });

  // ── onStateChange hook ─────────────────────────────────────────────────

  it('fires onStateChange when state mutates', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({ repo, commits: [mkCommit('abc')] });
    const snapshots: IHistoryTabState[] = [];
    const tab = new HistoryTab(service, {
      onStateChange: (s): void => {
        snapshots.push(s);
      },
    });
    await tab.loadFile('src/a.ts');
    // At least: loading=true snapshot + final snapshot.
    assert.ok(snapshots.length >= 2, `expected ≥2 snapshots, got ${snapshots.length}`);
    const last = snapshots[snapshots.length - 1];
    assert.strictEqual(last.loading, false);
    assert.strictEqual(last.commits.length, 1);
  });
});

// ─── Affected paths (changed files of the selected revision) ──────────────────

describe('HistoryTab — affected paths', () => {
  function mkRepo(): IRepository {
    return {
      rootUri: Uri.file('/repo'),
      state: 'idle',
      head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
  }

  function mkCommit(hash: string): ICommit {
    return {
      hash,
      shortHash: hash.substring(0, 7),
      message: 'msg',
      author: { name: 'Test', email: 't@example.com' },
      committer: { name: 'Test', email: 't@example.com' },
      parents: [],
      authorDate: new Date('2020-01-01'),
      commitDate: new Date('2020-01-01'),
    };
  }

  function mkDiff(path: string, status: IDiff['status'], oldPath?: string): IDiff {
    return { path, oldPath, status, hunks: [], binary: false };
  }

  interface CommitDiffCalls {
    hashes: string[];
  }

  function mkGitService(opts: {
    repo: IRepository;
    commits: ICommit[];
    diffsByHash?: Record<string, IDiff[]>;
    throwOnCommitDiff?: boolean;
    omitCommitDiff?: boolean;
  }): { service: IGitService; calls: CommitDiffCalls } {
    const repoChange = new EventEmitter<IRepository>();
    const calls: CommitDiffCalls = { hashes: [] };
    const base = {
      onDidChangeRepository: repoChange.event,
      getRepositories: () => [opts.repo],
      getRepository: async () => opts.repo,
      getBranches: async () => [],
      getFileHistory: async (): Promise<ICommit[]> => opts.commits,
    } as Record<string, unknown>;
    if (!opts.omitCommitDiff) {
      base.getCommitDiff = async (_repo: IRepository, hash: string): Promise<IDiff[]> => {
        calls.hashes.push(hash);
        if (opts.throwOnCommitDiff) {
          throw new Error('diff-boom');
        }
        return opts.diffsByHash?.[hash] ?? [];
      };
    }
    return { service: base as unknown as IGitService, calls };
  }

  it('loadFile auto-loads the affected paths of the first (auto-selected) commit', async () => {
    const repo = mkRepo();
    const { service, calls } = mkGitService({
      repo,
      commits: [mkCommit('abc1234'), mkCommit('def5678')],
      diffsByHash: { abc1234: [mkDiff('src/a.ts', 'modified'), mkDiff('src/b.ts', 'added')] },
    });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');
    assert.deepStrictEqual(calls.hashes, ['abc1234']);
    const paths = tab.getState().affectedPaths.map((p) => p.path);
    assert.deepStrictEqual(paths, ['src/a.ts', 'src/b.ts']);
    assert.strictEqual(tab.getState().affectedPaths[0].status, 'modified');
  });

  it('selecting a revision fetches and replaces the affected paths for that commit', async () => {
    const repo = mkRepo();
    const { service, calls } = mkGitService({
      repo,
      commits: [mkCommit('abc1234'), mkCommit('def5678')],
      diffsByHash: {
        abc1234: [mkDiff('src/a.ts', 'modified')],
        def5678: [mkDiff('src/old.ts', 'renamed', 'src/older.ts')],
      },
    });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');
    calls.hashes.length = 0;
    await tab.handleMessage({ type: 'history.selectRevision', rev: 'def5678' });
    assert.deepStrictEqual(calls.hashes, ['def5678']);
    const affected = tab.getState().affectedPaths;
    assert.strictEqual(affected.length, 1);
    assert.strictEqual(affected[0].path, 'src/old.ts');
    assert.strictEqual(affected[0].status, 'renamed');
    assert.strictEqual(affected[0].oldPath, 'src/older.ts');
  });

  it('does not re-fetch affected paths when the selection does not change', async () => {
    const repo = mkRepo();
    const { service, calls } = mkGitService({
      repo,
      commits: [mkCommit('abc1234')],
      diffsByHash: { abc1234: [mkDiff('src/a.ts', 'modified')] },
    });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');
    calls.hashes.length = 0;
    // Re-selecting the already-selected commit is a no-op for the reducer.
    await tab.handleMessage({ type: 'history.selectRevision', rev: 'abc1234' });
    assert.deepStrictEqual(calls.hashes, []);
  });

  it('surfaces an affected-paths error when getCommitDiff throws', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({
      repo,
      commits: [mkCommit('abc1234')],
      throwOnCommitDiff: true,
    });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');
    const state = tab.getState();
    assert.strictEqual(state.affectedPathsError, 'diff-boom');
    assert.deepStrictEqual(state.affectedPaths, []);
    assert.strictEqual(state.affectedPathsLoading, false);
  });

  it('clears affected paths when a load yields no commits', async () => {
    const repo = mkRepo();
    const { service, calls } = mkGitService({ repo, commits: [] });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/ghost.ts');
    assert.deepStrictEqual(tab.getState().affectedPaths, []);
    assert.deepStrictEqual(calls.hashes, []);
  });

  it('tolerates a git service without getCommitDiff (optional-method guard)', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({
      repo,
      commits: [mkCommit('abc1234')],
      omitCommitDiff: true,
    });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');
    assert.deepStrictEqual(tab.getState().affectedPaths, []);
    assert.strictEqual(tab.getState().affectedPathsError, undefined);
  });
});
