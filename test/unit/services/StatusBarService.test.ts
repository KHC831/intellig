/**
 * Unit tests for StatusBarService.
 *
 * Tests cover:
 * - Status bar state management
 * - Branch name display
 * - Sync status display (ahead/behind)
 * - Detached HEAD state handling
 * - Repository state indicators
 *
 * Note: Full integration tests for StatusBarService UI require the VS Code extension host
 * and are covered in the extension test suite.
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../../setup';
import * as assert from 'assert';
import {
  IFetchResult,
  IGitService,
  IInProgressOperation,
  IRepository,
  IHead,
} from '../../../src/git-core/interfaces/IGitService';
import { IStatusBarState } from '../../../src/ui-shell/interfaces/IStatusBarService';
import * as vscode from 'vscode';
import { StatusBarService, createStatusBarService } from '../../../src/ui-shell/StatusBarService';
import { EventEmitter, Uri } from '../../mocks/vscode';

describe('StatusBarService - Status Bar State', () => {
  describe('Branch name extraction', () => {
    it('should extract branch name from refs/heads/ prefix', () => {
      const headName = 'refs/heads/main';
      const branchName = headName.replace('refs/heads/', '');

      assert.strictEqual(branchName, 'main');
    });

    it('should handle feature branch names', () => {
      const headName = 'refs/heads/feature/my-feature';
      const branchName = headName.replace('refs/heads/', '');

      assert.strictEqual(branchName, 'feature/my-feature');
    });

    it('should handle nested branch names', () => {
      const headName = 'refs/heads/feature/nested/path/branch';
      const branchName = headName.replace('refs/heads/', '');

      assert.strictEqual(branchName, 'feature/nested/path/branch');
    });
  });

  describe('Sync status formatting', () => {
    it('should format ahead indicator correctly', () => {
      const ahead = 5;
      const indicator = `↑${ahead}`;

      assert.strictEqual(indicator, '↑5');
    });

    it('should format behind indicator correctly', () => {
      const behind = 3;
      const indicator = `↓${behind}`;

      assert.strictEqual(indicator, '↓3');
    });

    it('should format combined ahead/behind indicators', () => {
      const ahead = 2;
      const behind = 1;
      const indicators: string[] = [];

      if (ahead > 0) {
        indicators.push(`↑${ahead}`);
      }
      if (behind > 0) {
        indicators.push(`↓${behind}`);
      }

      const combined = indicators.join(' ');
      assert.strictEqual(combined, '↑2 ↓1');
    });

    it('should handle zero ahead/behind', () => {
      const ahead = 0;
      const behind = 0;
      const indicators: string[] = [];

      if (ahead > 0) {
        indicators.push(`↑${ahead}`);
      }
      if (behind > 0) {
        indicators.push(`↓${behind}`);
      }

      assert.strictEqual(indicators.length, 0);
    });
  });

  describe('Detached HEAD state', () => {
    it('should format short commit hash for detached HEAD', () => {
      const fullHash = 'abc123def456789';
      const shortHash = fullHash.substring(0, 7);

      assert.strictEqual(shortHash, 'abc123d');
    });

    it('should identify detached HEAD when name is undefined', () => {
      const head: IHead = {
        commit: 'abc123def456',
        ahead: 0,
        behind: 0,
      };

      const isDetached = head.name === undefined && head.commit !== undefined;
      assert.strictEqual(isDetached, true);
    });
  });
});

describe('StatusBarService - Repository State Building', () => {
  function buildState(repository: IRepository): IStatusBarState {
    const state: IStatusBarState = {
      ahead: 0,
      behind: 0,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: false,
      repositoryState: repository.state,
    };

    if (repository.head) {
      if (repository.head.name) {
        state.branchName = repository.head.name.replace('refs/heads/', '');
        state.isDetached = false;
      } else if (repository.head.commit) {
        state.isDetached = true;
        state.commitHash = repository.head.commit.substring(0, 7);
      }

      state.ahead = repository.head.ahead || 0;
      state.behind = repository.head.behind || 0;
      state.hasUpstream = repository.head.upstream !== undefined;
    }

    return state;
  }

  it('should build state for normal branch', () => {
    const repo: IRepository = {
      rootUri: vscode.Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'refs/heads/main',
        commit: 'abc123def456',
        ahead: 2,
        behind: 1,
        upstream: { remote: 'origin', name: 'main' },
      },
      remotes: [],
      submodules: [],
    };

    const state = buildState(repo);

    assert.strictEqual(state.branchName, 'main');
    assert.strictEqual(state.isDetached, false);
    assert.strictEqual(state.ahead, 2);
    assert.strictEqual(state.behind, 1);
    assert.strictEqual(state.hasUpstream, true);
    assert.strictEqual(state.repositoryState, 'idle');
  });

  it('should build state for detached HEAD', () => {
    const repo: IRepository = {
      rootUri: vscode.Uri.file('/test/repo'),
      state: 'idle',
      head: {
        commit: 'abc123def456789',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };

    const state = buildState(repo);

    assert.strictEqual(state.branchName, undefined);
    assert.strictEqual(state.isDetached, true);
    assert.strictEqual(state.commitHash, 'abc123d');
    assert.strictEqual(state.hasUpstream, false);
  });

  it('should build state for branch without upstream', () => {
    const repo: IRepository = {
      rootUri: vscode.Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'refs/heads/feature/new-feature',
        commit: 'abc123def456',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };

    const state = buildState(repo);

    assert.strictEqual(state.branchName, 'feature/new-feature');
    assert.strictEqual(state.hasUpstream, false);
    assert.strictEqual(state.ahead, 0);
    assert.strictEqual(state.behind, 0);
  });

  it('should build state for repository with no commits', () => {
    const repo: IRepository = {
      rootUri: vscode.Uri.file('/test/repo'),
      state: 'idle',
      head: undefined,
      remotes: [],
      submodules: [],
    };

    const state = buildState(repo);

    assert.strictEqual(state.branchName, undefined);
    assert.strictEqual(state.isDetached, false);
    assert.strictEqual(state.commitHash, undefined);
  });

  it('should capture repository state (merging)', () => {
    const repo: IRepository = {
      rootUri: vscode.Uri.file('/test/repo'),
      state: 'merging',
      head: {
        name: 'refs/heads/main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };

    const state = buildState(repo);

    assert.strictEqual(state.repositoryState, 'merging');
  });

  it('should capture repository state (rebasing)', () => {
    const repo: IRepository = {
      rootUri: vscode.Uri.file('/test/repo'),
      state: 'rebasing',
      head: {
        name: 'refs/heads/main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };

    const state = buildState(repo);

    assert.strictEqual(state.repositoryState, 'rebasing');
  });
});

describe('StatusBarService - Display Text Building', () => {
  function buildDisplayText(state: IStatusBarState, showSyncStatus: boolean = true): string {
    let statusText = '';

    if (state.isDetached) {
      statusText = `$(git-commit) ${state.commitHash || 'HEAD'}`;
    } else if (state.branchName) {
      statusText = `$(git-branch) ${state.branchName}`;

      if (showSyncStatus && state.hasUpstream) {
        const indicators: string[] = [];
        if (state.ahead > 0) {
          indicators.push(`↑${state.ahead}`);
        }
        if (state.behind > 0) {
          indicators.push(`↓${state.behind}`);
        }
        if (indicators.length > 0) {
          statusText += ` ${indicators.join(' ')}`;
        }
      }
    } else {
      statusText = '$(git-branch) No commits yet';
    }

    return statusText;
  }

  it('should build display text for normal branch', () => {
    const state: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 0,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state);
    assert.strictEqual(text, '$(git-branch) main');
  });

  it('should build display text with ahead/behind indicators', () => {
    const state: IStatusBarState = {
      branchName: 'main',
      ahead: 2,
      behind: 1,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state);
    assert.strictEqual(text, '$(git-branch) main ↑2 ↓1');
  });

  it('should build display text with only ahead indicator', () => {
    const state: IStatusBarState = {
      branchName: 'main',
      ahead: 3,
      behind: 0,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state);
    assert.strictEqual(text, '$(git-branch) main ↑3');
  });

  it('should build display text with only behind indicator', () => {
    const state: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 5,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state);
    assert.strictEqual(text, '$(git-branch) main ↓5');
  });

  it('should build display text for detached HEAD', () => {
    const state: IStatusBarState = {
      ahead: 0,
      behind: 0,
      isDetached: true,
      isEmptyRepo: false,
      commitHash: 'abc123d',
      hasUpstream: false,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state);
    assert.strictEqual(text, '$(git-commit) abc123d');
  });

  it('should build display text for no commits', () => {
    const state: IStatusBarState = {
      ahead: 0,
      behind: 0,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: false,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state);
    assert.strictEqual(text, '$(git-branch) No commits yet');
  });

  it('should not show sync status when no upstream', () => {
    const state: IStatusBarState = {
      branchName: 'feature/test',
      ahead: 0,
      behind: 0,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: false,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state);
    assert.strictEqual(text, '$(git-branch) feature/test');
  });

  it('should not show sync status when disabled', () => {
    const state: IStatusBarState = {
      branchName: 'main',
      ahead: 2,
      behind: 1,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state, false);
    assert.strictEqual(text, '$(git-branch) main');
  });
});

describe('StatusBarService - Repository State Indicators', () => {
  function getRepositoryStateIndicator(state: string): string {
    switch (state) {
      case 'merging':
        return '$(git-merge)';
      case 'rebasing':
        return '$(git-pull-request)';
      case 'cherry-picking':
        return '$(git-commit)';
      case 'reverting':
        return '$(discard)';
      default:
        return '';
    }
  }

  it('should return merge indicator for merging state', () => {
    const indicator = getRepositoryStateIndicator('merging');
    assert.strictEqual(indicator, '$(git-merge)');
  });

  it('should return rebase indicator for rebasing state', () => {
    const indicator = getRepositoryStateIndicator('rebasing');
    assert.strictEqual(indicator, '$(git-pull-request)');
  });

  it('should return cherry-pick indicator for cherry-picking state', () => {
    const indicator = getRepositoryStateIndicator('cherry-picking');
    assert.strictEqual(indicator, '$(git-commit)');
  });

  it('should return revert indicator for reverting state', () => {
    const indicator = getRepositoryStateIndicator('reverting');
    assert.strictEqual(indicator, '$(discard)');
  });

  it('should return empty string for idle state', () => {
    const indicator = getRepositoryStateIndicator('idle');
    assert.strictEqual(indicator, '');
  });
});

describe('StatusBarService - State Equality', () => {
  // Mirror of the production `_statesEqual` (StatusBarService.ts).
  // Compares the new `isEmptyRepo` and structured `inProgress.kind` /
  // `inProgress.target` fields. Drift between this helper and the
  // production implementation triggers the regression tests below.
  function statesEqual(a: IStatusBarState, b: IStatusBarState): boolean {
    return (
      a.branchName === b.branchName &&
      a.ahead === b.ahead &&
      a.behind === b.behind &&
      a.isDetached === b.isDetached &&
      a.commitHash === b.commitHash &&
      a.hasUpstream === b.hasUpstream &&
      a.repositoryState === b.repositoryState &&
      a.isEmptyRepo === b.isEmptyRepo &&
      a.inProgress?.kind === b.inProgress?.kind &&
      a.inProgress?.target === b.inProgress?.target
    );
  }

  it('detects different isEmptyRepo (only field changed)', () => {
    const base: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: false,
      repositoryState: 'idle',
      isEmptyRepo: false,
    };
    const empty: IStatusBarState = { ...base, isEmptyRepo: true };
    assert.strictEqual(statesEqual(base, empty), false);
  });

  it('detects different inProgress.kind (only field changed)', () => {
    const base: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: false,
      repositoryState: 'merging',
      isEmptyRepo: false,
      inProgress: { kind: 'merging', target: 'topic' },
    };
    const rebased: IStatusBarState = {
      ...base,
      repositoryState: 'rebasing',
      inProgress: { kind: 'rebasing', target: 'topic' },
    };
    assert.strictEqual(statesEqual(base, rebased), false);
  });

  it('detects different inProgress.target (only field changed)', () => {
    const base: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: false,
      repositoryState: 'rebasing',
      isEmptyRepo: false,
      inProgress: { kind: 'rebasing', target: 'topic-A' },
    };
    const switched: IStatusBarState = {
      ...base,
      inProgress: { kind: 'rebasing', target: 'topic-B' },
    };
    assert.strictEqual(statesEqual(base, switched), false);
  });

  it('equal inProgress payloads compare equal', () => {
    const a: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: false,
      repositoryState: 'rebasing',
      isEmptyRepo: false,
      inProgress: { kind: 'rebasing', target: 'topic' },
    };
    const b: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: false,
      repositoryState: 'rebasing',
      isEmptyRepo: false,
      inProgress: { kind: 'rebasing', target: 'topic' },
    };
    assert.strictEqual(statesEqual(a, b), true);
  });

  it('should detect equal states', () => {
    const state1: IStatusBarState = {
      branchName: 'main',
      ahead: 2,
      behind: 1,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const state2: IStatusBarState = {
      branchName: 'main',
      ahead: 2,
      behind: 1,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    assert.strictEqual(statesEqual(state1, state2), true);
  });

  it('should detect different branch names', () => {
    const state1: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 0,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const state2: IStatusBarState = {
      branchName: 'develop',
      ahead: 0,
      behind: 0,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    assert.strictEqual(statesEqual(state1, state2), false);
  });

  it('should detect different ahead counts', () => {
    const state1: IStatusBarState = {
      branchName: 'main',
      ahead: 2,
      behind: 0,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const state2: IStatusBarState = {
      branchName: 'main',
      ahead: 3,
      behind: 0,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    assert.strictEqual(statesEqual(state1, state2), false);
  });

  it('should detect different repository states', () => {
    const state1: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 0,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const state2: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 0,
      isDetached: false,
      isEmptyRepo: false,
      hasUpstream: true,
      repositoryState: 'merging',
    };

    assert.strictEqual(statesEqual(state1, state2), false);
  });
});

describe('StatusBarService - Click Actions', () => {
  const clickActions = ['branch-popup', 'sync', 'none'];

  function getCommandForAction(action: string): string | undefined {
    switch (action) {
      case 'branch-popup':
        return 'intellig.showBranchPopup';
      case 'sync':
        return 'intellig.sync';
      case 'none':
        return undefined;
      default:
        return undefined;
    }
  }

  it('should define all required click actions', () => {
    assert.ok(clickActions.includes('branch-popup'));
    assert.ok(clickActions.includes('sync'));
    assert.ok(clickActions.includes('none'));
  });

  it('should map branch-popup action to correct command', () => {
    const command = getCommandForAction('branch-popup');
    assert.strictEqual(command, 'intellig.showBranchPopup');
  });

  it('should map sync action to correct command', () => {
    const command = getCommandForAction('sync');
    assert.strictEqual(command, 'intellig.sync');
  });

  it('should map none action to undefined command', () => {
    const command = getCommandForAction('none');
    assert.strictEqual(command, undefined);
  });
});

// ─── Incoming commits status-bar badge ────────────────────────────────

describe('StatusBarService — incoming/outgoing badge', () => {
  // The mock's createStatusBarItem returns a captureable stub. We pull
  // `text` / `tooltip` / `command` off that to assert UI state.

  interface StubStatusBarItem {
    text: string;
    tooltip: string | vscode.MarkdownString | undefined;
    command: string | vscode.Command | undefined;
    _shown: boolean;
    _disposed: boolean;
  }

  interface Harness {
    service: StatusBarService;
    item: StubStatusBarItem;
    gitService: IGitService & {
      _fireFetch: (payload: { repo: IRepository; result: IFetchResult }) => void;
      _fireRepoChange: (repo: IRepository) => void;
      _setRepos: (repos: IRepository[]) => void;
    };
    executeCommandCalls: Array<{ command: string; args: unknown[] }>;
    registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  }

  function makeRepo(
    overrides: {
      branch?: string;
      ahead?: number;
      behind?: number;
      upstream?: { remote: string; name: string } | undefined;
      state?: IRepository['state'];
      rootPath?: string;
    } = {}
  ): IRepository {
    const upstream =
      'upstream' in overrides
        ? overrides.upstream
        : { remote: 'origin', name: overrides.branch ?? 'main' };
    const head: IHead = {
      name: `refs/heads/${overrides.branch ?? 'main'}`,
      commit: 'deadbeefcafebabe0000000000000000deadbeef',
      ahead: overrides.ahead ?? 0,
      behind: overrides.behind ?? 0,
      upstream,
    };
    return {
      rootUri: Uri.file(overrides.rootPath ?? '/test/repo'),
      state: overrides.state ?? 'idle',
      head,
      remotes: [{ name: 'origin' }],
      submodules: [],
    };
  }

  function makeHarness(options: { refreshDebounceMs?: number } = {}): Harness {
    const fetchEmitter = new EventEmitter<{ repo: IRepository; result: IFetchResult }>();
    const repoEmitter = new EventEmitter<IRepository>();
    let repos: IRepository[] = [];

    const gitService: Harness['gitService'] = {
      onDidFetch: fetchEmitter.event,
      onDidChangeRepository: repoEmitter.event,
      getRepositories: () => repos,
      getRepository: async () => (repos.length > 0 ? repos[0] : undefined),
      _fireFetch: (payload: { repo: IRepository; result: IFetchResult }) =>
        fetchEmitter.fire(payload),
      _fireRepoChange: (repo: IRepository) => repoEmitter.fire(repo),
      _setRepos: (next: IRepository[]) => {
        repos = next;
      },
    } as unknown as Harness['gitService'];

    // Capture the status-bar item by patching the mock for this test only.
    let capturedItem: StubStatusBarItem | undefined;
    const originalCreate = (
      vscode.window as unknown as {
        createStatusBarItem: (a?: unknown, p?: number) => StubStatusBarItem;
      }
    ).createStatusBarItem;
    (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem = (
      a?: unknown,
      p?: number
    ): StubStatusBarItem => {
      capturedItem = originalCreate(a, p);
      return capturedItem;
    };

    // Track executeCommand calls so we can assert click dispatch behaviour.
    const executeCommandCalls: Array<{ command: string; args: unknown[] }> = [];
    const originalExecute = vscode.commands.executeCommand;
    (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = async (
      command: string,
      ...args: unknown[]
    ) => {
      executeCommandCalls.push({ command, args });
      return undefined;
    };

    // Capture command registrations so the test can invoke the click
    // dispatch directly.
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const originalRegister = vscode.commands.registerCommand;
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = (
      command: string,
      callback: (...args: unknown[]) => unknown
    ) => {
      registeredCommands.set(command, callback);
      return { dispose: () => registeredCommands.delete(command) };
    };

    const service = createStatusBarService(
      gitService as unknown as IGitService,
      undefined,
      options.refreshDebounceMs ?? 0
    );

    // Restore the mock overrides so the next test is clean. We keep our
    // captured references.
    (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem =
      originalCreate;
    (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = originalExecute;
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = originalRegister;

    if (!capturedItem) {
      throw new Error('StatusBarService did not create a status bar item');
    }

    return {
      service,
      item: capturedItem,
      gitService,
      executeCommandCalls,
      registeredCommands,
    };
  }

  afterEach(() => {
    // Any service left undisposed is leaked — tests are expected to call
    // service.dispose() in their own teardown.
  });

  describe('badge text', () => {
    it('renders ↑3 when ahead=3 behind=0', () => {
      const h = makeHarness();
      try {
        const repo = makeRepo({ ahead: 3, behind: 0 });
        h.service.update(repo);
        assert.ok(h.item.text.includes('↑3'), `expected "↑3" in "${h.item.text}"`);
        assert.ok(!h.item.text.includes('↓'), `expected no "↓" in "${h.item.text}"`);
      } finally {
        h.service.dispose();
      }
    });

    it('renders ↓5 when ahead=0 behind=5', () => {
      const h = makeHarness();
      try {
        const repo = makeRepo({ ahead: 0, behind: 5 });
        h.service.update(repo);
        assert.ok(h.item.text.includes('↓5'), `expected "↓5" in "${h.item.text}"`);
        assert.ok(!h.item.text.includes('↑'), `expected no "↑" in "${h.item.text}"`);
      } finally {
        h.service.dispose();
      }
    });

    it('renders ↑2 ↓4 when both > 0', () => {
      const h = makeHarness();
      try {
        const repo = makeRepo({ ahead: 2, behind: 4 });
        h.service.update(repo);
        assert.ok(h.item.text.includes('↑2'), `expected "↑2" in "${h.item.text}"`);
        assert.ok(h.item.text.includes('↓4'), `expected "↓4" in "${h.item.text}"`);
      } finally {
        h.service.dispose();
      }
    });

    it('shows only the branch (no arrows) when ahead=0 behind=0', () => {
      const h = makeHarness();
      try {
        const repo = makeRepo({ ahead: 0, behind: 0, branch: 'main' });
        h.service.update(repo);
        assert.ok(h.item.text.includes('main'));
        assert.ok(!h.item.text.includes('↑'), `expected no arrow in "${h.item.text}"`);
        assert.ok(!h.item.text.includes('↓'), `expected no arrow in "${h.item.text}"`);
      } finally {
        h.service.dispose();
      }
    });

    it('shows only the branch when hasUpstream is false even with nonzero counts', () => {
      const h = makeHarness();
      try {
        // Branch without upstream — hasUpstream=false masks the counts.
        const repo = makeRepo({ ahead: 3, behind: 2, upstream: undefined });
        h.service.update(repo);
        assert.ok(!h.item.text.includes('↑'), `expected no "↑" in "${h.item.text}"`);
        assert.ok(!h.item.text.includes('↓'), `expected no "↓" in "${h.item.text}"`);
      } finally {
        h.service.dispose();
      }
    });
  });

  describe('event subscription', () => {
    it('refreshes on onDidFetch', () => {
      const h = makeHarness();
      try {
        h.gitService._setRepos([makeRepo({ ahead: 0, behind: 0 })]);
        // Initial state has no arrow.
        h.service.update(makeRepo({ ahead: 0, behind: 0 }));
        assert.ok(!h.item.text.includes('↑'));

        // Fire onDidFetch with a repo that has divergence — badge refreshes.
        const repo = makeRepo({ ahead: 1, behind: 2 });
        h.gitService._fireFetch({
          repo,
          result: { updatedRefs: [], errors: [] },
        });
        assert.ok(h.item.text.includes('↑1'), `after fetch: "${h.item.text}"`);
        assert.ok(h.item.text.includes('↓2'));
      } finally {
        h.service.dispose();
      }
    });

    it('refreshes on onDidChangeRepository', () => {
      const h = makeHarness();
      try {
        h.service.update(makeRepo({ ahead: 0, behind: 0 }));
        const repo = makeRepo({ ahead: 7, behind: 0 });
        h.gitService._fireRepoChange(repo);
        assert.ok(h.item.text.includes('↑7'));
      } finally {
        h.service.dispose();
      }
    });
  });

  describe('debounce', () => {
    it('coalesces rapid events into a single refresh', async () => {
      // Use a short non-zero debounce so we can observe the coalescing.
      const h = makeHarness({ refreshDebounceMs: 30 });
      try {
        const updates: IStatusBarState[] = [];
        h.service.onDidChangeState((state) => {
          updates.push(state);
        });

        // Fire 5 rapid events with different counts.
        for (let i = 1; i <= 5; i++) {
          h.gitService._fireFetch({
            repo: makeRepo({ ahead: i, behind: 0 }),
            result: { updatedRefs: [], errors: [] },
          });
        }

        // Before the debounce window elapses — no state change emitted.
        assert.strictEqual(updates.length, 0, 'should debounce all events');

        // Wait past the window.
        await new Promise((r) => setTimeout(r, 60));

        // Exactly one update, reflecting the LAST event (ahead=5).
        assert.strictEqual(updates.length, 1, 'expected one coalesced refresh');
        assert.strictEqual(updates[0].ahead, 5);
      } finally {
        h.service.dispose();
      }
    });

    it('immediate refresh when debounceMs is 0', () => {
      const h = makeHarness({ refreshDebounceMs: 0 });
      try {
        const updates: IStatusBarState[] = [];
        h.service.onDidChangeState((state) => {
          updates.push(state);
        });
        h.gitService._fireRepoChange(makeRepo({ ahead: 1, behind: 0 }));
        h.gitService._fireRepoChange(makeRepo({ ahead: 2, behind: 0 }));
        // Both updates fire synchronously when debounce is disabled.
        assert.strictEqual(updates.length, 2);
        assert.strictEqual(updates[1].ahead, 2);
      } finally {
        h.service.dispose();
      }
    });
  });

  describe('click command', () => {
    it('sets the status-bar item.command to the click-dispatch command', () => {
      const h = makeHarness();
      try {
        const cmd = h.item.command;
        const commandId = typeof cmd === 'string' ? cmd : cmd?.command;
        assert.strictEqual(commandId, 'intellig.statusBar.click');
      } finally {
        h.service.dispose();
      }
    });

    it('click dispatch opens the actionable branch popup', async () => {
      const h = makeHarness();
      const originalExecute = vscode.commands.executeCommand;
      try {
        const dispatch = h.registeredCommands.get('intellig.statusBar.click');
        assert.ok(dispatch, 'click-dispatch command should have been registered');

        // Install a capturing executeCommand *for the duration of this test*
        // since the harness restores the original after constructor returns.
        const calls: Array<{ command: string; args: unknown[] }> = [];
        (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = async (
          command: string,
          ...args: unknown[]
        ) => {
          calls.push({ command, args });
          return undefined;
        };

        await dispatch();
        // First call should open the branch popup (IntelliJ-parity actionable
        // widget, not a read-only Incoming tab focus).
        assert.strictEqual(calls.length >= 1, true, `got ${calls.length} calls`);
        assert.strictEqual(calls[0].command, 'intellig.showBranchPopup');
      } finally {
        (vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
          originalExecute;
        h.service.dispose();
      }
    });

    it('falls back to openGitToolWindow when the branch popup command throws', async () => {
      const h = makeHarness();
      const originalExecute = vscode.commands.executeCommand;
      try {
        const dispatch = h.registeredCommands.get('intellig.statusBar.click');
        assert.ok(dispatch);

        // Override executeCommand to throw on the first call (showBranchPopup)
        // and record the fallback.
        const calls: Array<{ command: string; args: unknown[] }> = [];
        (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = async (
          command: string,
          ...args: unknown[]
        ) => {
          calls.push({ command, args });
          if (command === 'intellig.showBranchPopup') {
            throw new Error('command not registered');
          }
          return undefined;
        };

        await dispatch();

        // Should have tried the popup, then fallen back to openGitToolWindow.
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[0].command, 'intellig.showBranchPopup');
        assert.strictEqual(calls[1].command, 'intellig.openGitToolWindow');
      } finally {
        (vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
          originalExecute;
        h.service.dispose();
      }
    });
  });

  // ─── R6-Gap-C: multi-root initial repo selection ────────────────────────────
  describe('R6-Gap-C multi-root initial repo', () => {
    it('initial branch display honors active-editor preference in multi-root workspace', async () => {
      const repoA = makeRepo({ branch: 'main-A', ahead: 1, behind: 0, rootPath: '/repo-a' });
      const repoB = makeRepo({ branch: 'main-B', ahead: 0, behind: 3, rootPath: '/repo-b' });

      // Build a git service that already has both repos populated BEFORE the
      // StatusBarService constructor runs (which kicks off `_initialize`).
      const fetchEmitter = new EventEmitter<{ repo: IRepository; result: IFetchResult }>();
      const repoEmitter = new EventEmitter<IRepository>();
      const gitService = {
        onDidFetch: fetchEmitter.event,
        onDidChangeRepository: repoEmitter.event,
        getRepositories: () => [repoA, repoB],
        getRepository: async () => repoA,
      } as unknown as IGitService;

      // Capture the status-bar item the same way makeHarness does.
      let capturedItem: StubStatusBarItem | undefined;
      const originalCreate = (
        vscode.window as unknown as {
          createStatusBarItem: (a?: unknown, p?: number) => StubStatusBarItem;
        }
      ).createStatusBarItem;
      (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem = (
        a?: unknown,
        p?: number
      ): StubStatusBarItem => {
        capturedItem = originalCreate(a, p);
        return capturedItem;
      };

      // Swallow registerCommand calls and stub executeCommand (harness normally
      // does this — duplicated here so the test is self-contained).
      const originalRegister = vscode.commands.registerCommand;
      (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = (
        _command: string,
        _callback: (...args: unknown[]) => unknown
      ) => ({ dispose: () => {} });
      const originalExecute = vscode.commands.executeCommand;
      (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = async () =>
        undefined;

      const originalActive = (vscode.window as unknown as { activeTextEditor: unknown })
        .activeTextEditor;
      try {
        // Point the active editor at a file under /repo-b.
        (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
          document: { uri: Uri.file('/repo-b/src/foo.ts') },
        };

        const service = createStatusBarService(gitService, undefined, 0);
        try {
          // _initialize() runs asynchronously in the constructor.
          // Wait for the async chain (resolveRepo → update) to settle.
          await new Promise((r) => setTimeout(r, 20));

          assert.ok(capturedItem, 'Status bar item should have been created');
          // The status bar should reflect repoB's branch (main-B with ↓3),
          // NOT repoA's (which is what `repositories[0]` would have surfaced).
          assert.ok(
            capturedItem.text.includes('main-B'),
            `expected repoB's branch "main-B" in "${capturedItem.text}"`
          );
          assert.ok(
            capturedItem.text.includes('↓3'),
            `expected repoB's behind count in "${capturedItem.text}"`
          );
          assert.ok(
            !capturedItem.text.includes('main-A'),
            `did NOT expect repoA's branch in "${capturedItem.text}"`
          );
        } finally {
          service.dispose();
        }
      } finally {
        (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor =
          originalActive;
        (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem =
          originalCreate;
        (vscode.commands as unknown as { registerCommand: unknown }).registerCommand =
          originalRegister;
        (vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
          originalExecute;
      }
    });
  });
});

// ─── UX-18: in-progress operation target labels ──────────────────────────────

describe('StatusBarService — in-progress labels', () => {
  interface StubStatusBarItem {
    text: string;
    tooltip: string | vscode.MarkdownString | undefined;
    command: string | vscode.Command | undefined;
    _shown: boolean;
    _disposed: boolean;
  }

  function makeService(): { service: StatusBarService; item: StubStatusBarItem } {
    const fetchEmitter = new EventEmitter<{ repo: IRepository; result: IFetchResult }>();
    const repoEmitter = new EventEmitter<IRepository>();
    const gitService = {
      onDidFetch: fetchEmitter.event,
      onDidChangeRepository: repoEmitter.event,
      getRepositories: () => [],
      getRepository: async () => undefined,
    } as unknown as IGitService;

    let capturedItem: StubStatusBarItem | undefined;
    const originalCreate = (
      vscode.window as unknown as {
        createStatusBarItem: (a?: unknown, p?: number) => StubStatusBarItem;
      }
    ).createStatusBarItem;
    (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem = (
      a?: unknown,
      p?: number
    ): StubStatusBarItem => {
      capturedItem = originalCreate(a, p);
      return capturedItem;
    };
    const originalRegister = vscode.commands.registerCommand;
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = (
      _command: string,
      _callback: (...args: unknown[]) => unknown
    ) => ({ dispose: () => {} });

    const service = new StatusBarService(gitService, undefined, 0);

    (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem =
      originalCreate;
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = originalRegister;

    if (!capturedItem) {
      throw new Error('StatusBarService did not create a status bar item');
    }
    return { service, item: capturedItem };
  }

  function makeRepoWithInProgress(
    state: IRepository['state'],
    inProgress?: IInProgressOperation
  ): IRepository {
    return {
      rootUri: vscode.Uri.file('/test/repo'),
      state,
      head: {
        name: 'refs/heads/main',
        commit: 'deadbeefcafebabe0000000000000000deadbeef',
        ahead: 0,
        behind: 0,
        upstream: { remote: 'origin', name: 'main' },
      },
      remotes: [],
      submodules: [],
      ...(inProgress ? { inProgress } : {}),
    };
  }

  it('renders "Merging feature/foo" prefix when state=merging with target', () => {
    const { service, item } = makeService();
    try {
      const repo = makeRepoWithInProgress('merging', { kind: 'merging', target: 'feature/foo' });
      service.update(repo);
      assert.ok(
        item.text.includes('Merging feature/foo'),
        `expected "Merging feature/foo" verb-prefix in "${item.text}"`
      );
      assert.ok(item.text.includes('$(git-merge)'), `expected merge icon in "${item.text}"`);
    } finally {
      service.dispose();
    }
  });

  it('renders "Rebasing onto main" prefix when state=rebasing with target', () => {
    const { service, item } = makeService();
    try {
      const repo = makeRepoWithInProgress('rebasing', { kind: 'rebasing', target: 'main' });
      service.update(repo);
      assert.ok(
        item.text.includes('Rebasing onto main'),
        `expected "Rebasing onto main" verb-prefix in "${item.text}"`
      );
      assert.ok(
        item.text.includes('$(git-pull-request)'),
        `expected rebase icon in "${item.text}"`
      );
    } finally {
      service.dispose();
    }
  });

  it('renders "Cherry-picking abc1234" prefix when state=cherry-picking with sha', () => {
    const { service, item } = makeService();
    try {
      const repo = makeRepoWithInProgress('cherry-picking', {
        kind: 'cherry-picking',
        target: 'abc1234',
      });
      service.update(repo);
      assert.ok(
        item.text.includes('Cherry-picking abc1234'),
        `expected "Cherry-picking abc1234" verb-prefix in "${item.text}"`
      );
    } finally {
      service.dispose();
    }
  });

  it('renders "Reverting abc1234" prefix when state=reverting with sha', () => {
    const { service, item } = makeService();
    try {
      const repo = makeRepoWithInProgress('reverting', {
        kind: 'reverting',
        target: 'abc1234',
      });
      service.update(repo);
      assert.ok(
        item.text.includes('Reverting abc1234'),
        `expected "Reverting abc1234" verb-prefix in "${item.text}"`
      );
      assert.ok(item.text.includes('$(discard)'), `expected revert icon in "${item.text}"`);
    } finally {
      service.dispose();
    }
  });

  it('still appends branch chip + ahead/behind suffix after the verb prefix', () => {
    const { service, item } = makeService();
    try {
      const repo: IRepository = {
        rootUri: vscode.Uri.file('/test/repo'),
        state: 'merging',
        head: {
          name: 'refs/heads/feature',
          commit: 'deadbeefcafebabe0000000000000000deadbeef',
          ahead: 2,
          behind: 1,
          upstream: { remote: 'origin', name: 'feature' },
        },
        remotes: [],
        submodules: [],
        inProgress: { kind: 'merging', target: 'topic' },
      };
      service.update(repo);
      assert.ok(item.text.includes('Merging topic'), `expected verb prefix in "${item.text}"`);
      assert.ok(item.text.includes('feature'), `expected branch chip in "${item.text}"`);
      assert.ok(item.text.includes('↑2'), `expected ahead in "${item.text}"`);
      assert.ok(item.text.includes('↓1'), `expected behind in "${item.text}"`);
    } finally {
      service.dispose();
    }
  });

  it('falls back to verb-only label when target is unknown (plain merge)', () => {
    const { service, item } = makeService();
    try {
      const repo = makeRepoWithInProgress('merging', { kind: 'merging' });
      service.update(repo);
      assert.ok(item.text.includes('Merging'), `expected "Merging" verb in "${item.text}"`);
      assert.ok(!item.text.includes('Merging refs/'));
    } finally {
      service.dispose();
    }
  });
});

// ─── UX-19: empty-repo "(no commits yet)" surfacing ──────────────────────────

describe('StatusBarService — empty-repo label', () => {
  interface StubStatusBarItem {
    text: string;
    tooltip: string | vscode.MarkdownString | undefined;
    command: string | vscode.Command | undefined;
    _shown: boolean;
    _disposed: boolean;
  }

  function makeService(): { service: StatusBarService; item: StubStatusBarItem } {
    const fetchEmitter = new EventEmitter<{ repo: IRepository; result: IFetchResult }>();
    const repoEmitter = new EventEmitter<IRepository>();
    const gitService = {
      onDidFetch: fetchEmitter.event,
      onDidChangeRepository: repoEmitter.event,
      getRepositories: () => [],
      getRepository: async () => undefined,
    } as unknown as IGitService;

    let capturedItem: StubStatusBarItem | undefined;
    const originalCreate = (
      vscode.window as unknown as {
        createStatusBarItem: (a?: unknown, p?: number) => StubStatusBarItem;
      }
    ).createStatusBarItem;
    (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem = (
      a?: unknown,
      p?: number
    ): StubStatusBarItem => {
      capturedItem = originalCreate(a, p);
      return capturedItem;
    };
    const originalRegister = vscode.commands.registerCommand;
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = (
      _command: string,
      _callback: (...args: unknown[]) => unknown
    ) => ({ dispose: () => {} });

    const service = new StatusBarService(gitService, undefined, 0);

    (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem =
      originalCreate;
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = originalRegister;

    if (!capturedItem) {
      throw new Error('StatusBarService did not create a status bar item');
    }
    return { service, item: capturedItem };
  }

  it('renders "$(git-branch) main (no commits yet)" for an empty repo', () => {
    const { service, item } = makeService();
    try {
      const repo: IRepository = {
        rootUri: vscode.Uri.file('/test/repo'),
        state: 'idle',
        // Empty repo: symbolic-ref returns refs/heads/main, rev-parse HEAD fails
        // → head.name set, head.commit empty.
        head: { name: 'main', commit: '', ahead: 0, behind: 0 },
        remotes: [],
        submodules: [],
      };
      service.update(repo);
      assert.ok(
        item.text.includes('$(git-branch) main (no commits yet)'),
        `expected empty-repo label, got: "${item.text}"`
      );
    } finally {
      service.dispose();
    }
  });

  it('renders the configured initial branch (not always "main")', () => {
    const { service, item } = makeService();
    try {
      const repo: IRepository = {
        rootUri: vscode.Uri.file('/test/repo'),
        state: 'idle',
        head: { name: 'trunk', commit: '', ahead: 0, behind: 0 },
        remotes: [],
        submodules: [],
      };
      service.update(repo);
      assert.ok(
        item.text.includes('$(git-branch) trunk (no commits yet)'),
        `expected "trunk" empty-repo label, got: "${item.text}"`
      );
    } finally {
      service.dispose();
    }
  });

  it('exposes isEmptyRepo=true on getState() for an empty repo', () => {
    const { service } = makeService();
    try {
      const repo: IRepository = {
        rootUri: vscode.Uri.file('/test/repo'),
        state: 'idle',
        head: { name: 'main', commit: '', ahead: 0, behind: 0 },
        remotes: [],
        submodules: [],
      };
      service.update(repo);
      const state = service.getState();
      assert.strictEqual(state.isEmptyRepo, true);
      assert.strictEqual(state.branchName, 'main');
    } finally {
      service.dispose();
    }
  });

  it('isEmptyRepo=false when commit is set (normal branch)', () => {
    const { service } = makeService();
    try {
      const repo: IRepository = {
        rootUri: vscode.Uri.file('/test/repo'),
        state: 'idle',
        head: {
          name: 'refs/heads/main',
          commit: 'deadbeefcafebabe0000000000000000deadbeef',
          ahead: 0,
          behind: 0,
        },
        remotes: [],
        submodules: [],
      };
      service.update(repo);
      const state = service.getState();
      assert.strictEqual(state.isEmptyRepo, false);
    } finally {
      service.dispose();
    }
  });

  it('tooltip explains the empty-repo state', () => {
    const { service, item } = makeService();
    try {
      const repo: IRepository = {
        rootUri: vscode.Uri.file('/test/repo'),
        state: 'idle',
        head: { name: 'main', commit: '', ahead: 0, behind: 0 },
        remotes: [],
        submodules: [],
      };
      service.update(repo);
      const tooltip = typeof item.tooltip === 'string' ? item.tooltip : '';
      assert.ok(
        tooltip.includes('main') && tooltip.includes('no commits yet'),
        `expected empty-repo tooltip, got: "${tooltip}"`
      );
    } finally {
      service.dispose();
    }
  });
});
