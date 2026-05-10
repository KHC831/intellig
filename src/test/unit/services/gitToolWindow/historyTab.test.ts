/**
 * Unit tests for the T2-07 History tab.
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

import '../../../../test/setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { EventEmitter, Uri } from '../../../mocks/vscode';
import type {
  IBranch,
  ICommit,
  IGitService,
  IFileHistoryOptions,
  IRepository,
} from '../../../../services/interfaces/IGitService';
import {
  HistoryTab,
  buildCompareWithLocalTitle,
  buildDiffAnyTwoTitle,
  buildFileAtRevisionUri,
  createInitialHistoryTabState,
  reduceHistoryState,
  type IHistoryTabState,
} from '../../../../services/gitToolWindow/tabs/HistoryTab';

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
  beforeEach(() => {
    origExecuteCommand = vscode.commands.executeCommand;
    origShowError = vscode.window.showErrorMessage;
  });
  afterEach(() => {
    (vscode.commands as any).executeCommand = origExecuteCommand;
    (vscode.window as any).showErrorMessage = origShowError;
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
    (vscode.commands as any).executeCommand = async (
      command: string,
      ...args: unknown[]
    ): Promise<undefined> => {
      if (command === 'vscode.diff') {
        diffCalls.push({
          left: args[0] as vscode.Uri,
          right: args[1] as vscode.Uri,
          title: args[2] as string,
        });
      }
      return undefined;
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
    (vscode.commands as any).executeCommand = async (
      command: string,
      ...args: unknown[]
    ): Promise<undefined> => {
      if (command === 'vscode.diff') {
        diffCalls.push({
          left: args[0] as vscode.Uri,
          right: args[1] as vscode.Uri,
          title: args[2] as string,
        });
      }
      return undefined;
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
    (vscode.commands as any).executeCommand = async (command: string): Promise<undefined> => {
      if (command === 'vscode.diff') {
        diffCalls.push(command);
      }
      return undefined;
    };
    await tab.compareWith('a', 'b');
    await tab.compareWithLocal('a');
    assert.strictEqual(diffCalls.length, 0);
  });

  // ── openAtRevision ─────────────────────────────────────────────────────

  it('openAtRevision runs vscode.open on the intellig-git URI', async () => {
    const repo = mkRepo();
    const { service } = mkGitService({ repo, commits: [mkCommit('abc')] });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');

    const openCalls: vscode.Uri[] = [];
    (vscode.commands as any).executeCommand = async (
      command: string,
      ...args: unknown[]
    ): Promise<undefined> => {
      if (command === 'vscode.open') {
        openCalls.push(args[0] as vscode.Uri);
      }
      return undefined;
    };

    await tab.openAtRevision('abcdef1');
    assert.strictEqual(openCalls.length, 1);
    assert.ok(openCalls[0].toString().includes('intellig-git:'));
    assert.ok(openCalls[0].toString().includes('src/a.ts'));
  });

  // ── Malformed messages ─────────────────────────────────────────────────

  it('drops malformed messages silently', async () => {
    const repo = mkRepo();
    const { service, calls } = mkGitService({ repo, commits: [] });
    const tab = new HistoryTab(service);
    await tab.handleMessage(undefined as any);
    await tab.handleMessage(null as any);
    await tab.handleMessage({} as any);
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
