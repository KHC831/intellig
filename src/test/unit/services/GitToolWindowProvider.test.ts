/**
 * Unit tests for GitToolWindowProvider
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../ui-shell/GitToolWindowProvider';
import { EventEmitter, Uri, Webview } from '../../mocks/vscode';
import type { IGitService, IRepository } from '../../../git-core/interfaces/IGitService';
import type { ICommitNode, IBranchRef } from '../../../git-core/commitGraph';
import type { IRemoteUrl } from '../../../utils/remoteUrl';

/**
 * Test-surface reaching into {@link GitToolWindowProvider}'s private
 * parsed-remote cache state. The cache-invalidation contract is not
 * observable through the public API (no getter exposes cache membership
 * without also mutating it), so the tests below assert it via a narrow
 * cast through this surface.
 *
 * Kept deliberately small (single field the test genuinely drives) per
 * docs/testing.md §3. No `I`-prefix; no kitchen-sink fields.
 */
interface GitToolWindowProviderInternals {
  _parsedRemoteCache: Map<string, IRemoteUrl | undefined>;
}

describe('GitToolWindowProvider', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('constructor', () => {
    it('should initialize with hasRepository as false', () => {
      const state = provider.getState();
      assert.strictEqual(state.hasRepository, false);
    });
  });

  describe('getState', () => {
    it('should return initial state with hasRepository false', () => {
      const state = provider.getState();
      assert.strictEqual(state.hasRepository, false);
    });
  });

  describe('addConsoleEntry', () => {
    it('should not throw when adding a console entry', () => {
      // Console entries are stored internally but no longer exposed via getState
      assert.doesNotThrow(() => {
        provider.addConsoleEntry({
          command: 'git status',
          output: 'On branch main',
          isError: false,
        });
      });
    });

    it('should fire onDidChangeState event', (done) => {
      const disposable = provider.onDidChangeState(() => {
        disposable.dispose();
        done();
      });

      provider.addConsoleEntry({
        command: 'git status',
        output: 'On branch main',
        isError: false,
      });
    });
  });

  describe('clearConsole', () => {
    it('should not throw when clearing console', () => {
      provider.addConsoleEntry({
        command: 'git status',
        output: 'On branch main',
        isError: false,
      });

      assert.doesNotThrow(() => {
        provider.clearConsole();
      });
    });

    it('should fire onDidChangeState event', (done) => {
      provider.addConsoleEntry({
        command: 'git status',
        output: 'On branch main',
        isError: false,
      });

      const disposable = provider.onDidChangeState(() => {
        disposable.dispose();
        done();
      });

      provider.clearConsole();
    });
  });

  describe('setHasRepository', () => {
    it('should set hasRepository to true', () => {
      provider.setHasRepository(true);

      const state = provider.getState();
      assert.strictEqual(state.hasRepository, true);
    });

    it('should set hasRepository to false', () => {
      provider.setHasRepository(true);
      provider.setHasRepository(false);

      const state = provider.getState();
      assert.strictEqual(state.hasRepository, false);
    });

    it('should fire onDidChangeState event when value changes', (done) => {
      const disposable = provider.onDidChangeState(() => {
        disposable.dispose();
        done();
      });

      provider.setHasRepository(true);
    });

    it('should not fire event when value is the same', () => {
      let eventCount = 0;

      // First call transitions from loading state, so it fires once
      provider.setHasRepository(false);

      const disposable = provider.onDidChangeState(() => {
        eventCount++;
      });

      provider.setHasRepository(false); // Same as current value, should not fire
      assert.strictEqual(eventCount, 0);

      disposable.dispose();
    });
  });

  describe('refresh', () => {
    it('should fire onDidChangeState event', (done) => {
      const disposable = provider.onDidChangeState(() => {
        disposable.dispose();
        done();
      });

      provider.refresh();
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      // Should not throw
      provider.dispose();
    });

    it('should be safe to call multiple times', () => {
      provider.dispose();
      provider.dispose();
      // Should not throw
    });
  });
});

describe('Log View', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  // Helper to create mock commits
  function createMockCommit(
    hash: string,
    message: string,
    parents: string[] = [],
    authorName = 'Test Author'
  ): {
    hash: string;
    shortHash: string;
    message: string;
    body?: string;
    author: { name: string; email: string };
    committer: { name: string; email: string };
    parents: string[];
    authorDate: Date;
    commitDate: Date;
  } {
    return {
      hash,
      shortHash: hash.substring(0, 7),
      message,
      author: {
        name: authorName,
        email: `${authorName.toLowerCase().replace(' ', '.')}@example.com`,
      },
      committer: {
        name: authorName,
        email: `${authorName.toLowerCase().replace(' ', '.')}@example.com`,
      },
      parents,
      authorDate: new Date(),
      commitDate: new Date(),
    };
  }

  describe('updateLogState', () => {
    it('should update log state with commits', () => {
      // `updateLogState` now stably sorts via `sortCommitsStable`
      // (oldest-first by date, with topological tie-break on parents)
      // and reverses for newest-first display order. With identical
      // `commitDate` timestamps and `def` listing `abc` as parent,
      // the topological tie-break places `abc` first (oldest), then
      // `.reverse()` makes the display order `[def, abc]` — child first,
      // parent second, matching `git log`'s newest-first convention.
      const commits = [
        createMockCommit('abc1234567890', 'First commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ];

      provider.updateLogState(commits);

      const extendedState = provider.getExtendedLogState();
      assert.strictEqual(extendedState.commitNodes.length, 2);
      assert.strictEqual(extendedState.commitNodes[0].commit.hash, 'def4567890123');
      assert.strictEqual(extendedState.commitNodes[1].commit.hash, 'abc1234567890');
    });

    it('should generate graph visualization data', () => {
      const commits = [
        createMockCommit('abc1234567890', 'First commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ];

      provider.updateLogState(commits);

      const extendedState = provider.getExtendedLogState();
      // Each commit should have graph column and lines
      assert.ok(extendedState.commitNodes[0].graphColumn !== undefined);
      assert.ok(Array.isArray(extendedState.commitNodes[0].graphLines));
    });

    it('should include branch labels on commits', () => {
      const commits = [createMockCommit('abc1234567890', 'First commit')];
      const branchMap = new Map<string, IBranchRef[]>();
      branchMap.set('abc1234567890', [
        { name: 'main', type: 'local' },
        { name: 'feature/test', type: 'local' },
      ]);

      provider.updateLogState(commits, branchMap);

      const extendedState = provider.getExtendedLogState();
      assert.deepStrictEqual(extendedState.commitNodes[0].branches, [
        { name: 'main', type: 'local' },
        { name: 'feature/test', type: 'local' },
      ]);
    });

    it('should include tag labels on commits', () => {
      const commits = [createMockCommit('abc1234567890', 'First commit')];
      const tagMap = new Map<string, string[]>();
      tagMap.set('abc1234567890', ['v1.0.0', 'release']);

      provider.updateLogState(commits, undefined, tagMap);

      const extendedState = provider.getExtendedLogState();
      assert.deepStrictEqual(extendedState.commitNodes[0].tags, ['v1.0.0', 'release']);
    });

    it('should set hasRepository to true', () => {
      provider.updateLogState([]);

      const state = provider.getState();
      assert.strictEqual(state.hasRepository, true);
    });

    it('should fire onDidChangeState event', (done) => {
      const commits = [createMockCommit('abc1234567890', 'First commit')];

      const disposable = provider.onDidChangeState(() => {
        disposable.dispose();
        done();
      });

      provider.updateLogState(commits);
    });
  });

  describe('selectCommit', () => {
    it('should select a commit', () => {
      const commits = [
        createMockCommit('abc1234567890', 'First commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ];
      provider.updateLogState(commits);

      provider.selectCommit('abc1234567890');

      const extState = provider.getExtendedLogState();
      assert.ok(extState.selectedCommits.has('abc1234567890'));
      assert.strictEqual(extState.expandedCommit, 'abc1234567890');
    });

    it('should clear previous selection when selecting new commit', () => {
      const commits = [
        createMockCommit('abc1234567890', 'First commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ];
      provider.updateLogState(commits);

      provider.selectCommit('abc1234567890');
      provider.selectCommit('def4567890123');

      const extState = provider.getExtendedLogState();
      assert.strictEqual(extState.selectedCommits.size, 1);
      assert.ok(extState.selectedCommits.has('def4567890123'));
      assert.ok(!extState.selectedCommits.has('abc1234567890'));
    });

    it('should fire onDidSelectCommit event', (done) => {
      const commits = [createMockCommit('abc1234567890', 'First commit')];
      provider.updateLogState(commits);

      const disposable = provider.onDidSelectCommit((hash) => {
        assert.strictEqual(hash, 'abc1234567890');
        disposable.dispose();
        done();
      });

      provider.selectCommit('abc1234567890');
    });
  });

  describe('toggleCommitSelection', () => {
    it('should add commit to selection', () => {
      const commits = [
        createMockCommit('abc1234567890', 'First commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ];
      provider.updateLogState(commits);

      provider.toggleCommitSelection('abc1234567890');
      provider.toggleCommitSelection('def4567890123');

      const extState = provider.getExtendedLogState();
      assert.strictEqual(extState.selectedCommits.size, 2);
      assert.ok(extState.selectedCommits.has('abc1234567890'));
      assert.ok(extState.selectedCommits.has('def4567890123'));
    });

    it('should remove commit from selection when toggled again', () => {
      const commits = [createMockCommit('abc1234567890', 'First commit')];
      provider.updateLogState(commits);

      provider.toggleCommitSelection('abc1234567890');
      provider.toggleCommitSelection('abc1234567890');

      const extState = provider.getExtendedLogState();
      assert.strictEqual(extState.selectedCommits.size, 0);
    });
  });

  describe('getSelectedCommits', () => {
    it('should return array of selected commit hashes', () => {
      const commits = [
        createMockCommit('abc1234567890', 'First commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ];
      provider.updateLogState(commits);

      provider.toggleCommitSelection('abc1234567890');
      provider.toggleCommitSelection('def4567890123');

      const selected = provider.getSelectedCommits();
      assert.strictEqual(selected.length, 2);
      assert.ok(selected.includes('abc1234567890'));
      assert.ok(selected.includes('def4567890123'));
    });

    it('should return empty array when no commits selected', () => {
      const selected = provider.getSelectedCommits();
      assert.deepStrictEqual(selected, []);
    });
  });

  describe('setLogFilter', () => {
    it('should set log filter', () => {
      const filter = {
        author: 'Test Author',
        since: new Date('2024-01-01'),
        until: new Date('2024-12-31'),
        path: 'src/',
        searchText: 'fix',
      };

      provider.setLogFilter(filter);

      const extState = provider.getExtendedLogState();
      assert.deepStrictEqual(extState.filter, filter);
    });

    it('should clear filter when set to undefined', () => {
      provider.setLogFilter({ author: 'Test' });
      provider.setLogFilter(undefined);

      const extState = provider.getExtendedLogState();
      assert.strictEqual(extState.filter, undefined);
    });
  });

  describe('Log Context Menu Actions', () => {
    it('should fire onDidRequestLogContextAction for cherry-pick', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'cherryPick');
        assert.deepStrictEqual(event.commitHashes, ['abc1234567890']);
        disposable.dispose();
        done();
      });

      // Simulate context action
      (
        provider as unknown as { _onDidRequestLogContextAction: { fire: (event: unknown) => void } }
      )._onDidRequestLogContextAction.fire({
        action: 'cherryPick',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire onDidRequestLogContextAction for revert', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'revert');
        assert.deepStrictEqual(event.commitHashes, ['abc1234567890']);
        disposable.dispose();
        done();
      });

      (
        provider as unknown as { _onDidRequestLogContextAction: { fire: (event: unknown) => void } }
      )._onDidRequestLogContextAction.fire({
        action: 'revert',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire onDidRequestLogContextAction for createPatch', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'createPatch');
        disposable.dispose();
        done();
      });

      (
        provider as unknown as { _onDidRequestLogContextAction: { fire: (event: unknown) => void } }
      )._onDidRequestLogContextAction.fire({
        action: 'createPatch',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire onDidRequestLogContextAction for checkoutRevision', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'checkoutRevision');
        disposable.dispose();
        done();
      });

      (
        provider as unknown as { _onDidRequestLogContextAction: { fire: (event: unknown) => void } }
      )._onDidRequestLogContextAction.fire({
        action: 'checkoutRevision',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire onDidRequestLogContextAction for resetToHere', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'resetToHere');
        disposable.dispose();
        done();
      });

      (
        provider as unknown as { _onDidRequestLogContextAction: { fire: (event: unknown) => void } }
      )._onDidRequestLogContextAction.fire({
        action: 'resetToHere',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should support all context menu action types', () => {
      const actions = [
        'copyHash',
        'createPatch',
        'cherryPick',
        'checkoutRevision',
        'showRepoAtRevision',
        'compareWithLocal',
        'resetToHere',
        'revert',
        'undoCommit',
        'dropCommit',
        'editCommitMessage',
        'mergeIntoCurrent',
        'interactiveRebase',
      ];
      const receivedActions: string[] = [];

      const disposable = provider.onDidRequestLogContextAction((event) => {
        receivedActions.push(event.action);
      });

      actions.forEach((action) => {
        (
          provider as unknown as {
            _onDidRequestLogContextAction: { fire: (event: unknown) => void };
          }
        )._onDidRequestLogContextAction.fire({
          action,
          commitHashes: ['abc1234567890'],
        });
      });

      assert.deepStrictEqual(receivedActions, actions);
      disposable.dispose();
    });
  });

  describe('Commit File Diff', () => {
    it('should fire onDidRequestCommitDiff when double-clicking a file in commit details', (done) => {
      const disposable = provider.onDidRequestCommitDiff((event) => {
        assert.strictEqual(event.commitHash, 'abc1234567890');
        assert.strictEqual(event.filePath, 'src/test.ts');
        disposable.dispose();
        done();
      });

      (
        provider as unknown as { _onDidRequestCommitDiff: { fire: (event: unknown) => void } }
      )._onDidRequestCommitDiff.fire({
        commitHash: 'abc1234567890',
        filePath: 'src/test.ts',
      });
    });
  });

  describe('getExtendedLogState', () => {
    it('should return a copy of extended log state', () => {
      const commits = [createMockCommit('abc1234567890', 'First commit')];
      const branchMap = new Map<string, IBranchRef[]>();
      branchMap.set('abc1234567890', [{ name: 'main', type: 'local' }]);

      provider.updateLogState(commits, branchMap);

      const state1 = provider.getExtendedLogState();
      const state2 = provider.getExtendedLogState();

      // Should be equal but not the same reference
      assert.notStrictEqual(state1.selectedCommits, state2.selectedCommits);
      assert.notStrictEqual(state1.branchMap, state2.branchMap);
      assert.notStrictEqual(state1.tagMap, state2.tagMap);
    });
  });

  describe('Log View state preservation', () => {
    it('should preserve log state across operations', () => {
      const commits = [createMockCommit('abc1234567890', 'First commit')];
      provider.updateLogState(commits);
      provider.selectCommit('abc1234567890');

      // Verify state is preserved
      const extState = provider.getExtendedLogState();
      assert.ok(extState.selectedCommits.has('abc1234567890'));
      assert.strictEqual(extState.expandedCommit, 'abc1234567890');
    });

    it('should preserve commit nodes across updates', () => {
      const commits = [
        createMockCommit('abc1234567890', 'First commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ];
      provider.updateLogState(commits);

      // Verify commit nodes are preserved
      const extendedState = provider.getExtendedLogState();
      assert.strictEqual(extendedState.commitNodes.length, 2);
    });
  });

  describe('IntelliJ-style Log Layout', () => {
    it('should display commit graph on the left with details on the right', () => {
      // This is a structural test - the layout is defined in the HTML template
      // We verify that the state supports this layout
      const commits = [createMockCommit('abc1234567890', 'First commit')];
      provider.updateLogState(commits);
      provider.selectCommit('abc1234567890');

      const extendedState = provider.getExtendedLogState();

      // Verify we have the data needed for the layout
      assert.ok(extendedState.commitNodes.length > 0); // For commit list
      assert.ok(extendedState.expandedCommit); // For details panel
    });
  });

  describe('Log Filtering UI', () => {
    it('should fire onDidRequestLogFilter event when filter is applied', (done) => {
      const filter = {
        author: 'Test Author',
        searchText: 'fix bug',
      };

      const disposable = provider.onDidRequestLogFilter((receivedFilter) => {
        assert.strictEqual(receivedFilter?.author, 'Test Author');
        assert.strictEqual(receivedFilter?.searchText, 'fix bug');
        disposable.dispose();
        done();
      });

      // Simulate filter request
      (
        provider as unknown as { _onDidRequestLogFilter: { fire: (filter: unknown) => void } }
      )._onDidRequestLogFilter.fire(filter);
    });

    it('should fire onDidRequestLogFilter with undefined when filter is cleared', (done) => {
      const disposable = provider.onDidRequestLogFilter((receivedFilter) => {
        assert.strictEqual(receivedFilter, undefined);
        disposable.dispose();
        done();
      });

      // Simulate clearing filter
      (
        provider as unknown as { _onDidRequestLogFilter: { fire: (filter: unknown) => void } }
      )._onDidRequestLogFilter.fire(undefined);
    });

    it('should support filtering by author', () => {
      const filter = { author: 'John Doe' };
      provider.setLogFilter(filter);

      const extState = provider.getExtendedLogState();
      assert.strictEqual(extState.filter?.author, 'John Doe');
    });

    it('should support filtering by date range', () => {
      const since = new Date('2024-01-01');
      const until = new Date('2024-12-31');
      const filter = { since, until };
      provider.setLogFilter(filter);

      const extState = provider.getExtendedLogState();
      assert.deepStrictEqual(extState.filter?.since, since);
      assert.deepStrictEqual(extState.filter?.until, until);
    });

    it('should support filtering by file path', () => {
      const filter = { path: 'src/services/' };
      provider.setLogFilter(filter);

      const extState = provider.getExtendedLogState();
      assert.strictEqual(extState.filter?.path, 'src/services/');
    });

    it('should support searching commit messages', () => {
      const filter = { searchText: 'fix critical bug' };
      provider.setLogFilter(filter);

      const extState = provider.getExtendedLogState();
      assert.strictEqual(extState.filter?.searchText, 'fix critical bug');
    });

    it('should support combining multiple filter criteria', () => {
      const filter = {
        author: 'Jane Smith',
        since: new Date('2024-06-01'),
        until: new Date('2024-06-30'),
        path: 'src/',
        searchText: 'refactor',
      };
      provider.setLogFilter(filter);

      const extState = provider.getExtendedLogState();
      assert.strictEqual(extState.filter?.author, 'Jane Smith');
      assert.deepStrictEqual(extState.filter?.since, filter.since);
      assert.deepStrictEqual(extState.filter?.until, filter.until);
      assert.strictEqual(extState.filter?.path, 'src/');
      assert.strictEqual(extState.filter?.searchText, 'refactor');
    });

    it('should preserve filter state across operations', () => {
      const filter = {
        author: 'Test Author',
        searchText: 'important',
      };
      provider.setLogFilter(filter);

      // Perform other operations (refresh, etc.)
      provider.refresh();

      // Verify filter is preserved
      const extState = provider.getExtendedLogState();
      assert.strictEqual(extState.filter?.author, 'Test Author');
      assert.strictEqual(extState.filter?.searchText, 'important');
    });

    it('should update extended log state filter when setLogFilter is called', () => {
      const filter = { author: 'Developer' };
      provider.setLogFilter(filter);

      const extendedState = provider.getExtendedLogState();
      assert.strictEqual(extendedState.filter?.author, 'Developer');
    });
  });
});

describe('Initial Data Request and No-Repository State', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  /**
   * Create a mock WebviewView for testing resolveWebviewView.
   */
  function createMockWebviewView(): {
    webview: {
      html: string;
      options: { enableScripts?: boolean; localResourceRoots?: unknown[] };
      cspSource: string;
      onDidReceiveMessage: (listener: (e: unknown) => void) => { dispose: () => void };
      postMessage: (message: unknown) => Promise<boolean>;
      asWebviewUri: (localResource: unknown) => unknown;
    };
    visible: boolean;
    onDidChangeVisibility: (listener: () => void) => { dispose: () => void };
    onDidDispose: (listener: () => void) => { dispose: () => void };
  } {
    return {
      webview: {
        html: '',
        options: {},
        cspSource: 'mock-csp-source',
        onDidReceiveMessage: (_listener: (e: unknown) => void) => ({ dispose: () => {} }),
        postMessage: (_message: unknown) => Promise.resolve(true),
        asWebviewUri: (localResource: unknown) => localResource,
      },
      visible: true,
      onDidChangeVisibility: (_listener: () => void) => ({ dispose: () => {} }),
      onDidDispose: (_listener: () => void) => ({ dispose: () => {} }),
    };
  }

  describe('onDidRequestInitialData event', () => {
    it('should fire onDidRequestInitialData when resolveWebviewView is called', (done) => {
      const disposable = provider.onDidRequestInitialData(() => {
        disposable.dispose();
        done();
      });

      const mockView = createMockWebviewView();
      provider.resolveWebviewView(
        mockView as unknown as Parameters<typeof provider.resolveWebviewView>[0],
        {} as Parameters<typeof provider.resolveWebviewView>[1],
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose: () => {} }),
        } as Parameters<typeof provider.resolveWebviewView>[2]
      );
    });

    it('should fire onDidRequestInitialData exactly once per resolveWebviewView call', () => {
      let fireCount = 0;
      const disposable = provider.onDidRequestInitialData(() => {
        fireCount++;
      });

      const mockView = createMockWebviewView();
      provider.resolveWebviewView(
        mockView as unknown as Parameters<typeof provider.resolveWebviewView>[0],
        {} as Parameters<typeof provider.resolveWebviewView>[1],
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose: () => {} }),
        } as Parameters<typeof provider.resolveWebviewView>[2]
      );

      assert.strictEqual(fireCount, 1);
      disposable.dispose();
    });

    it('should set webview HTML content before firing onDidRequestInitialData', () => {
      let htmlWasSetWhenEventFired = false;
      const mockView = createMockWebviewView();

      const disposable = provider.onDidRequestInitialData(() => {
        htmlWasSetWhenEventFired = mockView.webview.html.length > 0;
      });

      provider.resolveWebviewView(
        mockView as unknown as Parameters<typeof provider.resolveWebviewView>[0],
        {} as Parameters<typeof provider.resolveWebviewView>[1],
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose: () => {} }),
        } as Parameters<typeof provider.resolveWebviewView>[2]
      );

      assert.strictEqual(htmlWasSetWhenEventFired, true);
      disposable.dispose();
    });
  });

  describe('onDidRequestRefresh event', () => {
    it('should fire onDidRequestRefresh when refresh() is called', (done) => {
      const disposable = provider.onDidRequestRefresh(() => {
        disposable.dispose();
        done();
      });

      provider.refresh();
    });

    it('should fire both onDidChangeState and onDidRequestRefresh on refresh', () => {
      let stateChanged = false;
      let refreshRequested = false;

      const disposable1 = provider.onDidChangeState(() => {
        stateChanged = true;
      });
      const disposable2 = provider.onDidRequestRefresh(() => {
        refreshRequested = true;
      });

      provider.refresh();

      assert.strictEqual(stateChanged, true);
      assert.strictEqual(refreshRequested, true);

      disposable1.dispose();
      disposable2.dispose();
    });
  });

  describe('setNoRepository', () => {
    it('should set hasRepository to false', () => {
      // First set to true
      provider.setHasRepository(true);
      assert.strictEqual(provider.getState().hasRepository, true);

      // Then call setNoRepository
      provider.setNoRepository();
      assert.strictEqual(provider.getState().hasRepository, false);
    });

    it('should fire onDidChangeState when transitioning from has-repository to no-repository', (done) => {
      provider.setHasRepository(true);

      const disposable = provider.onDidChangeState(() => {
        assert.strictEqual(provider.getState().hasRepository, false);
        disposable.dispose();
        done();
      });

      provider.setNoRepository();
    });

    it('should not fire event when already in no-repository state', () => {
      // Transition out of loading state first
      provider.setNoRepository();

      let eventFired = false;
      const disposable = provider.onDidChangeState(() => {
        eventFired = true;
      });

      provider.setNoRepository(); // Already in no-repo state, should not fire
      assert.strictEqual(eventFired, false);

      disposable.dispose();
    });
  });

  describe('resolveWebviewView webview setup', () => {
    it('should configure webview with enableScripts', () => {
      const mockView = createMockWebviewView();
      provider.resolveWebviewView(
        mockView as unknown as Parameters<typeof provider.resolveWebviewView>[0],
        {} as Parameters<typeof provider.resolveWebviewView>[1],
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose: () => {} }),
        } as Parameters<typeof provider.resolveWebviewView>[2]
      );

      assert.strictEqual(mockView.webview.options.enableScripts, true);
    });

    it('should set HTML content on the webview', () => {
      const mockView = createMockWebviewView();
      provider.resolveWebviewView(
        mockView as unknown as Parameters<typeof provider.resolveWebviewView>[0],
        {} as Parameters<typeof provider.resolveWebviewView>[1],
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose: () => {} }),
        } as Parameters<typeof provider.resolveWebviewView>[2]
      );

      assert.ok(mockView.webview.html.length > 0, 'Webview HTML should be set');
      assert.ok(mockView.webview.html.includes('<!DOCTYPE html>'), 'Should contain valid HTML');
    });
  });
});

describe('Multi-Repository Selection State', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  /**
   * Helper to create a mock IRepository.
   */
  function createMockRepository(rootPath: string): {
    rootUri: ReturnType<typeof Uri.file>;
    state: 'idle';
    remotes: never[];
    submodules: never[];
  } {
    return {
      rootUri: Uri.file(rootPath),
      state: 'idle' as const,
      remotes: [],
      submodules: [],
    };
  }

  describe('setAvailableRepositories', () => {
    it('should store the available repositories', () => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];

      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const selected = provider.getSelectedRepository();
      assert.ok(selected, 'Should have a selected repository');
      assert.strictEqual(selected.rootUri.fsPath, '/workspace/repo-a');
    });

    it('should default to the first repository (index 0)', () => {
      const repos = [
        createMockRepository('/workspace/alpha'),
        createMockRepository('/workspace/beta'),
        createMockRepository('/workspace/gamma'),
      ];

      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const selected = provider.getSelectedRepository();
      assert.strictEqual(selected!.rootUri.fsPath, '/workspace/alpha');
    });

    it('should fire onDidChangeState event', (done) => {
      const repos = [createMockRepository('/workspace/repo')];

      const disposable = provider.onDidChangeState(() => {
        disposable.dispose();
        done();
      });

      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );
    });

    it('should fall back to first repository when selected index becomes out of bounds', () => {
      const repos3 = [
        createMockRepository('/workspace/a'),
        createMockRepository('/workspace/b'),
        createMockRepository('/workspace/c'),
      ];

      provider.setAvailableRepositories(
        repos3 as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      // Simulate selecting the third repo (index 2)
      (
        provider as unknown as { _handleRepositorySelection: (index: number) => void }
      )._handleRepositorySelection(2);
      assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/workspace/c');

      // Now update with only 2 repos — index 2 is out of bounds
      const repos2 = [createMockRepository('/workspace/a'), createMockRepository('/workspace/b')];
      provider.setAvailableRepositories(
        repos2 as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      // Should fall back to first repository
      assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/workspace/a');
    });

    it('should handle empty repository list', () => {
      provider.setAvailableRepositories([]);

      const selected = provider.getSelectedRepository();
      assert.strictEqual(selected, undefined);
    });

    it('should preserve selected index when it is still valid after update', () => {
      const repos = [
        createMockRepository('/workspace/a'),
        createMockRepository('/workspace/b'),
        createMockRepository('/workspace/c'),
      ];

      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      // Select the second repo (index 1)
      (
        provider as unknown as { _handleRepositorySelection: (index: number) => void }
      )._handleRepositorySelection(1);
      assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/workspace/b');

      // Update with 3 repos — index 1 is still valid
      const updatedRepos = [
        createMockRepository('/workspace/x'),
        createMockRepository('/workspace/y'),
        createMockRepository('/workspace/z'),
      ];
      provider.setAvailableRepositories(
        updatedRepos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      // Index 1 should still be selected
      assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/workspace/y');
    });
  });

  describe('getSelectedRepository', () => {
    it('should return undefined when no repositories are available', () => {
      const selected = provider.getSelectedRepository();
      assert.strictEqual(selected, undefined);
    });

    it('should return the first repository by default', () => {
      const repos = [
        createMockRepository('/workspace/first'),
        createMockRepository('/workspace/second'),
      ];

      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const selected = provider.getSelectedRepository();
      assert.strictEqual(selected!.rootUri.fsPath, '/workspace/first');
    });

    it('should return the selected repository after selection change', () => {
      const repos = [createMockRepository('/workspace/a'), createMockRepository('/workspace/b')];

      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      // Select the second repo
      (
        provider as unknown as { _handleRepositorySelection: (index: number) => void }
      )._handleRepositorySelection(1);

      const selected = provider.getSelectedRepository();
      assert.strictEqual(selected!.rootUri.fsPath, '/workspace/b');
    });
  });

  describe('_handleRepositorySelection', () => {
    it('should update the selected repository index', () => {
      const repos = [
        createMockRepository('/workspace/a'),
        createMockRepository('/workspace/b'),
        createMockRepository('/workspace/c'),
      ];

      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      (
        provider as unknown as { _handleRepositorySelection: (index: number) => void }
      )._handleRepositorySelection(2);

      assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/workspace/c');
    });

    it('should fire onDidChangeState event', (done) => {
      const repos = [createMockRepository('/workspace/a'), createMockRepository('/workspace/b')];

      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const disposable = provider.onDidChangeState(() => {
        disposable.dispose();
        done();
      });

      (
        provider as unknown as { _handleRepositorySelection: (index: number) => void }
      )._handleRepositorySelection(1);
    });

    it('should fire onDidSelectRepository event with the selected repository', (done) => {
      const repos = [createMockRepository('/workspace/a'), createMockRepository('/workspace/b')];

      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const disposable = provider.onDidSelectRepository((repo) => {
        assert.strictEqual(repo.rootUri.fsPath, '/workspace/b');
        disposable.dispose();
        done();
      });

      (
        provider as unknown as { _handleRepositorySelection: (index: number) => void }
      )._handleRepositorySelection(1);
    });

    it('should clamp negative index to 0', () => {
      const repos = [createMockRepository('/workspace/a'), createMockRepository('/workspace/b')];

      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      (
        provider as unknown as { _handleRepositorySelection: (index: number) => void }
      )._handleRepositorySelection(-1);

      assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/workspace/a');
    });

    it('should clamp index exceeding array length to last valid index', () => {
      const repos = [createMockRepository('/workspace/a'), createMockRepository('/workspace/b')];

      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      (
        provider as unknown as { _handleRepositorySelection: (index: number) => void }
      )._handleRepositorySelection(99);

      assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/workspace/b');
    });

    it('should do nothing when no repositories are available', () => {
      let eventFired = false;
      const disposable = provider.onDidSelectRepository(() => {
        eventFired = true;
      });

      (
        provider as unknown as { _handleRepositorySelection: (index: number) => void }
      )._handleRepositorySelection(0);

      assert.strictEqual(eventFired, false);
      assert.strictEqual(provider.getSelectedRepository(), undefined);

      disposable.dispose();
    });
  });

  describe('selectRepository webview message handling', () => {
    it('should handle selectRepository message via _handleWebviewMessage', () => {
      const repos = [createMockRepository('/workspace/a'), createMockRepository('/workspace/b')];

      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      // Simulate the webview message
      (
        provider as unknown as {
          _handleWebviewMessage: (msg: { type: string; repositoryIndex: number }) => void;
        }
      )._handleWebviewMessage({
        type: 'selectRepository',
        repositoryIndex: 1,
      });

      assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/workspace/b');
    });

    it('should fire onDidSelectRepository when selectRepository message is received', (done) => {
      const repos = [createMockRepository('/workspace/a'), createMockRepository('/workspace/b')];

      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const disposable = provider.onDidSelectRepository((repo) => {
        assert.strictEqual(repo.rootUri.fsPath, '/workspace/b');
        disposable.dispose();
        done();
      });

      (
        provider as unknown as {
          _handleWebviewMessage: (msg: { type: string; repositoryIndex: number }) => void;
        }
      )._handleWebviewMessage({
        type: 'selectRepository',
        repositoryIndex: 1,
      });
    });
  });

  describe('session persistence (Requirement 1.7)', () => {
    it('should persist selected repository index across setAvailableRepositories calls when index is valid', () => {
      const repos = [
        createMockRepository('/workspace/a'),
        createMockRepository('/workspace/b'),
        createMockRepository('/workspace/c'),
      ];

      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      // Select index 1
      (
        provider as unknown as { _handleRepositorySelection: (index: number) => void }
      )._handleRepositorySelection(1);
      assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/workspace/b');

      // Re-set same repos (simulating webview reload within same session)
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      // Index should still be 1
      assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/workspace/b');
    });
  });

  describe('_getRepositorySelectorHtml', () => {
    it('should return empty string when no repositories are available', () => {
      provider.setAvailableRepositories([]);
      const html = provider._getRepositorySelectorHtml();
      assert.strictEqual(html, '');
    });

    it('should return empty string when only one repository is available', () => {
      const repos = [createMockRepository('/workspace/my-repo')];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const html = provider._getRepositorySelectorHtml();
      assert.strictEqual(html, '');
    });

    it('should render a select dropdown when multiple repositories are available', () => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const html = provider._getRepositorySelectorHtml();
      assert.ok(html.includes('<select'), 'Should contain a <select> element');
      assert.ok(html.includes('</select>'), 'Should close the <select> element');
      assert.ok(html.includes('repository-selector'), 'Should have repository-selector class');
    });

    it('should display folder name (last path segment) for each repository', () => {
      const repos = [
        createMockRepository('/workspace/frontend'),
        createMockRepository('/workspace/backend'),
        createMockRepository('/home/user/projects/shared-lib'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const html = provider._getRepositorySelectorHtml();
      assert.ok(html.includes('frontend'), 'Should display folder name "frontend"');
      assert.ok(html.includes('backend'), 'Should display folder name "backend"');
      assert.ok(html.includes('shared-lib'), 'Should display folder name "shared-lib"');
    });

    it('should render an option for each repository with correct value', () => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const html = provider._getRepositorySelectorHtml();
      assert.ok(html.includes('value="0"'), 'Should have option with value 0');
      assert.ok(html.includes('value="1"'), 'Should have option with value 1');
    });

    it('should mark the selected repository option as selected', () => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
        createMockRepository('/workspace/repo-c'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      // Select the second repo
      (
        provider as unknown as { _handleRepositorySelection: (index: number) => void }
      )._handleRepositorySelection(1);

      const html = provider._getRepositorySelectorHtml();
      // The option with value="1" should have the selected attribute
      assert.ok(html.includes('value="1" selected'), 'Second option should be marked as selected');
      // The option with value="0" should NOT have selected
      assert.ok(
        !html.includes('value="0" selected'),
        'First option should not be marked as selected'
      );
    });

    it('should NOT call acquireVsCodeApi inside the selector HTML (regression: dropdown was a no-op)', () => {
      // VS Code only allows acquireVsCodeApi() once per webview lifetime.
      // The main inline script already acquires it, so any second call
      // inside the selector throws DOMException and silently drops the
      // user's selection. This test pins the fix in place.
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const html = provider._getRepositorySelectorHtml();
      assert.ok(
        !html.includes('acquireVsCodeApi'),
        'Selector HTML must not call acquireVsCodeApi — the change listener is wired from the main inline script'
      );
      assert.ok(
        !html.includes('onchange='),
        'Selector HTML must not use an inline onchange handler'
      );
    });

    it('should wire the selectRepository message via the main inline script', () => {
      // The change listener that posts `selectRepository` is registered
      // from `_getInlineScript`, where the single `vscode` API instance
      // already lives.
      const inlineScript = (
        provider as unknown as { _getInlineScript: () => string }
      )._getInlineScript();
      assert.ok(
        inlineScript.includes('selectRepository'),
        'Inline script should post the selectRepository message type'
      );
      assert.ok(
        inlineScript.includes('repositoryIndex'),
        'Inline script should reference repositoryIndex in the payload'
      );
      assert.ok(
        inlineScript.includes('repository-selector'),
        'Inline script should bind the change listener to the .repository-selector element'
      );
    });

    it('should escape HTML special characters in folder names', () => {
      const repos = [
        createMockRepository('/workspace/repo<em>test'),
        createMockRepository('/workspace/normal-repo'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const html = provider._getRepositorySelectorHtml();
      assert.ok(!html.includes('<em>'), 'Should escape HTML tags in folder names');
      assert.ok(html.includes('&lt;em&gt;'), 'Should contain escaped tag');
    });
  });

  describe('_getGraphPanelHtml repository selector integration', () => {
    it('should include repository selector in graph panel when multiple repos exist', () => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      // Need commits to render the graph panel (not the empty state)
      const commits = [
        {
          hash: 'abc1234567890',
          shortHash: 'abc1234',
          message: 'Test commit',
          author: { name: 'Test', email: 'test@test.com' },
          committer: { name: 'Test', email: 'test@test.com' },
          parents: [],
          authorDate: new Date(),
          commitDate: new Date(),
        },
      ];
      provider.updateLogState(commits);

      const graphHtml = provider._getGraphPanelHtml(provider.getExtendedLogState().commitNodes);
      assert.ok(
        graphHtml.includes('repository-selector'),
        'Graph panel should include repository selector'
      );
      assert.ok(graphHtml.includes('repo-a'), 'Should show repo-a folder name');
      assert.ok(graphHtml.includes('repo-b'), 'Should show repo-b folder name');
    });

    it('should not include repository selector in graph panel when only one repo exists', () => {
      const repos = [createMockRepository('/workspace/only-repo')];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const commits = [
        {
          hash: 'abc1234567890',
          shortHash: 'abc1234',
          message: 'Test commit',
          author: { name: 'Test', email: 'test@test.com' },
          committer: { name: 'Test', email: 'test@test.com' },
          parents: [],
          authorDate: new Date(),
          commitDate: new Date(),
        },
      ];
      provider.updateLogState(commits);

      const graphHtml = provider._getGraphPanelHtml(provider.getExtendedLogState().commitNodes);
      assert.ok(
        !graphHtml.includes('repository-selector'),
        'Graph panel should not include repository selector'
      );
    });

    it('should not include repository selector in graph panel when no repos exist', () => {
      provider.setAvailableRepositories([]);

      const graphHtml = provider._getGraphPanelHtml([]);
      assert.ok(
        !graphHtml.includes('repository-selector'),
        'Graph panel should not include repository selector'
      );
    });
  });
});

describe('_getBranchLabelsHtml', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  /**
   * Helper to create a minimal ICommitNode for branch label testing.
   *
   * Accepts either bare branch names or fully-typed {@link IBranchRef}
   * entries. A bare string is coerced to a typed ref using the historical
   * `name.includes('/')` convention purely as fixture sugar so the legacy
   * fixtures below keep their expected output. The Bug E tests pass explicit
   * `{ name, type }` refs to exercise the type-driven classification that the
   * production chip renderer now relies on (a LOCAL `feature/foo` must NOT
   * render as remote).
   */
  function makeNode(branches: Array<string | IBranchRef>): ICommitNode {
    const refs: IBranchRef[] = branches.map((b) =>
      typeof b === 'string' ? { name: b, type: b.includes('/') ? 'remote' : 'local' } : b
    );
    return {
      commit: {
        hash: 'abc1234567890abcdef1234567890abcdef123456',
        shortHash: 'abc1234',
        message: 'Test commit',
        author: { name: 'Test', email: 'test@test.com' },
        committer: { name: 'Test', email: 'test@test.com' },
        parents: [],
        authorDate: new Date(),
        commitDate: new Date(),
      },
      graphColumn: 0,
      graphLines: [{ fromColumn: 0, toColumn: 0, color: '#4CAF50', type: 'commit' as const }],
      branches: refs,
      tags: [],
    };
  }

  describe('empty branches', () => {
    it('should return empty string when branches array is empty', () => {
      const node = makeNode([]);
      const html = provider._getBranchLabelsHtml(node);
      assert.strictEqual(html, '');
    });

    it('should return empty string when branches is undefined-like (empty array)', () => {
      const node = makeNode([]);
      node.branches = [];
      const html = provider._getBranchLabelsHtml(node);
      assert.strictEqual(html, '');
    });
  });

  describe('local branch labels', () => {
    it('should render a local branch with branch-label-local class', () => {
      const node = makeNode(['main']);
      const html = provider._getBranchLabelsHtml(node);
      assert.ok(html.includes('branch-label-local'), 'Should have branch-label-local class');
      assert.ok(html.includes('main'), 'Should contain branch name');
    });

    it('should render multiple local branches', () => {
      const node = makeNode(['main', 'develop']);
      const html = provider._getBranchLabelsHtml(node);
      assert.ok(html.includes('main'), 'Should contain "main"');
      assert.ok(html.includes('develop'), 'Should contain "develop"');
      const localCount = (html.match(/branch-label-local/g) || []).length;
      assert.strictEqual(localCount, 2, 'Should have 2 local branch labels');
    });
  });

  describe('remote branch labels', () => {
    it('should render a remote branch with branch-label-remote class', () => {
      const node = makeNode(['origin/main']);
      const html = provider._getBranchLabelsHtml(node);
      assert.ok(html.includes('branch-label-remote'), 'Should have branch-label-remote class');
      assert.ok(html.includes('origin/main'), 'Should contain branch name');
    });

    it('should render upstream remote branches as remote', () => {
      const node = makeNode(['upstream/feature']);
      const html = provider._getBranchLabelsHtml(node);
      assert.ok(html.includes('branch-label-remote'), 'Should have branch-label-remote class');
    });
  });

  describe('mixed local and remote branches', () => {
    it('should render both local and remote branches with correct classes', () => {
      const node = makeNode(['main', 'origin/main']);
      const html = provider._getBranchLabelsHtml(node);
      assert.ok(html.includes('branch-label-local'), 'Should have local class');
      assert.ok(html.includes('branch-label-remote'), 'Should have remote class');
      assert.ok(html.includes('main'), 'Should contain "main"');
      assert.ok(html.includes('origin/main'), 'Should contain "origin/main"');
    });

    it('should render all branches when there are multiple local and remote', () => {
      const node = makeNode(['main', 'develop', 'origin/main', 'origin/develop']);
      const html = provider._getBranchLabelsHtml(node);
      const localCount = (html.match(/branch-label-local/g) || []).length;
      const remoteCount = (html.match(/branch-label-remote/g) || []).length;
      assert.strictEqual(localCount, 2, 'Should have 2 local labels');
      assert.strictEqual(remoteCount, 2, 'Should have 2 remote labels');
    });
  });

  // Bug E — branch chips are classified by the typed IBranchRef.type
  // (sourced from IBranch.type / refs-prefix), NOT by a name.includes('/')
  // heuristic. A local branch whose name contains a `/` (`feature/foo`,
  // `fix/bar`) must render the LOCAL affordances, never the cloud icon.
  describe('Bug E — type-driven branch classification', () => {
    it('renders a local branch with a `/` in its name using the local icon, not the cloud', () => {
      const node = makeNode([{ name: 'feature/foo', type: 'local' }]);
      const html = provider._getBranchLabelsHtml(node);

      assert.ok(
        html.includes('codicon-git-branch'),
        'local `feature/foo` must use codicon-git-branch'
      );
      assert.ok(
        html.includes('branch-label-local'),
        'local `feature/foo` must use branch-label-local'
      );
      assert.ok(
        html.includes('aria-label="Local branch: feature/foo"'),
        'local `feature/foo` must carry the "Local branch:" aria-label'
      );
      assert.ok(
        !html.includes('codicon-cloud'),
        'local `feature/foo` must NOT use the remote cloud icon (the Bug E regression)'
      );
      assert.ok(
        !html.includes('branch-label-remote'),
        'local `feature/foo` must NOT use branch-label-remote'
      );
    });

    it('renders a remote branch using the cloud icon and remote affordances', () => {
      const node = makeNode([{ name: 'origin/main', type: 'remote' }]);
      const html = provider._getBranchLabelsHtml(node);

      assert.ok(html.includes('codicon-cloud'), 'remote `origin/main` must use codicon-cloud');
      assert.ok(
        html.includes('branch-label-remote'),
        'remote `origin/main` must use branch-label-remote'
      );
      assert.ok(
        html.includes('aria-label="Remote branch: origin/main"'),
        'remote `origin/main` must carry the "Remote branch:" aria-label'
      );
      assert.ok(
        !html.includes('codicon-git-branch'),
        'remote `origin/main` must NOT use the local branch icon'
      );
      assert.ok(
        !html.includes('branch-label-local'),
        'remote `origin/main` must NOT use branch-label-local'
      );
    });

    it('renders mixed local + remote chips on the same commit, each with its own affordance', () => {
      const node = makeNode([
        { name: 'feature/foo', type: 'local' },
        { name: 'origin/feature/foo', type: 'remote' },
      ]);
      const html = provider._getBranchLabelsHtml(node);

      // Both chips present with the right icon/class/aria for their type.
      assert.ok(
        html.includes('aria-label="Local branch: feature/foo"'),
        'local chip must announce "Local branch: feature/foo"'
      );
      assert.ok(
        html.includes('aria-label="Remote branch: origin/feature/foo"'),
        'remote chip must announce "Remote branch: origin/feature/foo"'
      );
      assert.strictEqual(
        (html.match(/branch-label-local/g) || []).length,
        1,
        'exactly one local chip'
      );
      assert.strictEqual(
        (html.match(/branch-label-remote/g) || []).length,
        1,
        'exactly one remote chip'
      );
      assert.strictEqual(
        (html.match(/codicon-git-branch/g) || []).length,
        1,
        'exactly one local (git-branch) icon'
      );
      assert.strictEqual(
        (html.match(/codicon-cloud/g) || []).length,
        1,
        'exactly one remote (cloud) icon'
      );
    });
  });

  describe('HTML escaping', () => {
    it('should escape HTML special characters in branch names', () => {
      const node = makeNode(['feature/<script>']);
      const html = provider._getBranchLabelsHtml(node);
      assert.ok(!html.includes('<script>'), 'Should not contain unescaped script tag');
      assert.ok(html.includes('&lt;script&gt;'), 'Should contain escaped script tag');
    });

    it('should escape ampersands in branch names', () => {
      const node = makeNode(['feature/a&b']);
      const html = provider._getBranchLabelsHtml(node);
      assert.ok(html.includes('&amp;'), 'Should escape ampersand');
    });

    it('should escape quotes in branch names', () => {
      const node = makeNode(['feature/"test"']);
      const html = provider._getBranchLabelsHtml(node);
      assert.ok(!html.includes('"test"'), 'Should not contain unescaped quotes in content');
      assert.ok(html.includes('&quot;'), 'Should contain escaped quotes');
    });
  });

  describe('span element structure', () => {
    it('should render each branch as a <span> element', () => {
      const node = makeNode(['main']);
      const html = provider._getBranchLabelsHtml(node);
      assert.ok(html.includes('<span'), 'Should contain <span> element');
      assert.ok(html.includes('</span>'), 'Should close <span> element');
    });

    it('should render one <span> per branch', () => {
      const node = makeNode(['main', 'develop', 'origin/main']);
      const html = provider._getBranchLabelsHtml(node);
      const spanCount = (html.match(/<span/g) || []).length;
      assert.strictEqual(spanCount, 3, 'Should have 3 span elements');
    });
  });

  describe('integration with _getGraphPanelHtml', () => {
    it('should include branch labels in commit row when branches exist', () => {
      const commits = [
        {
          hash: 'abc1234567890abcdef1234567890abcdef123456',
          shortHash: 'abc1234',
          message: 'Test commit',
          author: { name: 'Test', email: 'test@test.com' },
          committer: { name: 'Test', email: 'test@test.com' },
          parents: [],
          authorDate: new Date(),
          commitDate: new Date(),
        },
      ];
      const branchMap = new Map<string, IBranchRef[]>();
      branchMap.set('abc1234567890abcdef1234567890abcdef123456', [
        { name: 'main', type: 'local' },
        { name: 'origin/main', type: 'remote' },
      ]);

      provider.updateLogState(commits, branchMap);

      const graphHtml = provider._getGraphPanelHtml(provider.getExtendedLogState().commitNodes);
      assert.ok(graphHtml.includes('branch-label-local'), 'Should include local branch label');
      assert.ok(graphHtml.includes('branch-label-remote'), 'Should include remote branch label');
    });

    it('should not include branch labels when commit has no branches', () => {
      const commits = [
        {
          hash: 'abc1234567890abcdef1234567890abcdef123456',
          shortHash: 'abc1234',
          message: 'Test commit',
          author: { name: 'Test', email: 'test@test.com' },
          committer: { name: 'Test', email: 'test@test.com' },
          parents: [],
          authorDate: new Date(),
          commitDate: new Date(),
        },
      ];

      provider.updateLogState(commits);

      const graphHtml = provider._getGraphPanelHtml(provider.getExtendedLogState().commitNodes);
      assert.ok(!graphHtml.includes('branch-label-local'), 'Should not include local branch label');
      assert.ok(
        !graphHtml.includes('branch-label-remote'),
        'Should not include remote branch label'
      );
    });
  });

  describe('branch label CSS styles in webview HTML', () => {
    it('should include .branch-label-local CSS class with correct styles', () => {
      const mockWebview = {
        html: '',
        options: {},
        cspSource: 'https://mock.csp.source',
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: () => Promise.resolve(true),
        asWebviewUri: (uri: Uri) => uri,
      } as unknown as Webview;

      const html = provider._getThreePanelHtmlContent(
        mockWebview as unknown as import('vscode').Webview,
        []
      );

      assert.ok(
        html.includes('.branch-label-local'),
        'Should include .branch-label-local CSS class'
      );
      // Chip backgrounds switched from FG-tier
      // gitDecoration-* tokens (which themes use for the SCM tree) to
      // the semantically-correct badge-* family. Local + remote share
      // the same background; local-vs-remote distinction lives in the
      // codicon prefix (cloud vs git-branch). The earlier hex literal
      // (#2d5a1e) is retained as the CSS-var fallback for themes that
      // don't define badge-*.
      assert.ok(
        html.includes('background: var(--vscode-badge-background, #2d5a1e)'),
        'Local label background must use var(--vscode-badge-background) with #2d5a1e fallback'
      );
      assert.ok(
        html.includes('color: var(--vscode-badge-foreground, #a5d6a7)'),
        'Local label foreground must use var(--vscode-badge-foreground) with #a5d6a7 fallback'
      );
    });

    it('should include .branch-label-remote CSS class with correct styles', () => {
      const mockWebview = {
        html: '',
        options: {},
        cspSource: 'https://mock.csp.source',
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: () => Promise.resolve(true),
        asWebviewUri: (uri: Uri) => uri,
      } as unknown as Webview;

      const html = provider._getThreePanelHtmlContent(
        mockWebview as unknown as import('vscode').Webview,
        []
      );

      assert.ok(
        html.includes('.branch-label-remote'),
        'Should include .branch-label-remote CSS class'
      );
      // Remote chip uses the same badge-* family
      // as local; the secondary remote-only override block retains the
      // earlier #1a3a5c / #90caf9 hex pair as a fallback when neither
      // badge-* nor the legacy gitDecoration-* family is defined. The
      // hex literals MUST ship (CSS var fallback discipline + future
      // hi-contrast drift detection).
      assert.ok(
        html.includes('--vscode-gitDecoration-renamedResourceForeground, #1a3a5c'),
        'Remote label must retain #1a3a5c hex as legacy fallback'
      );
      assert.ok(
        html.includes('--vscode-gitDecoration-modifiedResourceForeground, #90caf9'),
        'Remote label must retain #90caf9 hex as legacy fallback'
      );
      assert.ok(
        html.includes('var(--vscode-badge-background'),
        'Remote label must use var(--vscode-badge-background) as primary'
      );
      assert.ok(
        html.includes('var(--vscode-badge-foreground'),
        'Remote label must use var(--vscode-badge-foreground) as primary'
      );
    });

    it('should include correct font-size, padding, border-radius, and margin-left for branch labels', () => {
      const mockWebview = {
        html: '',
        options: {},
        cspSource: 'https://mock.csp.source',
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: () => Promise.resolve(true),
        asWebviewUri: (uri: Uri) => uri,
      } as unknown as Webview;

      const html = provider._getThreePanelHtmlContent(
        mockWebview as unknown as import('vscode').Webview,
        []
      );

      // Both classes share the same sizing/spacing properties
      assert.ok(html.includes('font-size: 11px'), 'Should include font-size 11px');
      assert.ok(html.includes('padding: 1px 5px'), 'Should include padding 1px 5px');
      assert.ok(html.includes('border-radius: 3px'), 'Should include border-radius 3px');
      assert.ok(html.includes('margin-left: 4px'), 'Should include margin-left 4px');
    });
  });

  // ───: parsed-remote cache invalidation on repo change ────────────────
  describe('_parsedRemoteCache — TL-17 invalidation', () => {
    function mkRepo(rootPath: string, remoteUrl: string | undefined): IRepository {
      return {
        rootUri: Uri.file(rootPath),
        state: 'idle',
        head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
        remotes: remoteUrl ? [{ name: 'origin', fetchUrl: remoteUrl, pushUrl: remoteUrl }] : [],
        submodules: [],
      };
    }

    function mkGitService(repos: IRepository[]): {
      service: IGitService;
      fire: (r: IRepository) => void;
    } {
      const emitter = new EventEmitter<IRepository>();
      const service = {
        onDidChangeRepository: emitter.event,
        getRepositories: () => repos,
      } as unknown as IGitService;
      return { service, fire: (r: IRepository) => emitter.fire(r) };
    }

    /**
     * Seed a parsed-remote cache entry for `repo` as-if `_getSelectedRepoRemote`
     * had run against it. Local to this suite (not on the production class)
     * per docs/testing.md §3. Writes directly to `_parsedRemoteCache` — the
     * value is a minimal `IRemoteUrl` shape; these tests only assert
     * key-level membership, so the specific parse result is irrelevant.
     */
    function seedCacheForRepo(internals: GitToolWindowProviderInternals, repo: IRepository): void {
      internals._parsedRemoteCache.set(repo.rootUri.fsPath, {
        host: 'github.com',
        owner: 'acme',
        repo: 'seed',
        provider: 'github',
        pathPrefix: 'acme',
      });
    }

    it('drops the cached entry for a repo when onDidChangeRepository fires for it', () => {
      const repoA = mkRepo('/repo-a', 'git@github.com:acme/a.git');
      const repoB = mkRepo('/repo-b', 'git@github.com:acme/b.git');
      const { service, fire } = mkGitService([repoA, repoB]);
      provider.attachGitService(service);
      provider.setAvailableRepositories([repoA, repoB]);

      // Seed the cache entry for repo A via the TestSurface cast.
      const internals = provider as unknown as GitToolWindowProviderInternals;
      seedCacheForRepo(internals, repoA);
      assert.strictEqual(
        internals._parsedRemoteCache.has(repoA.rootUri.fsPath),
        true,
        'cache seeded for repo A'
      );

      // Fire onDidChangeRepository for repo A — its cache entry must be dropped.
      fire(repoA);

      assert.strictEqual(
        internals._parsedRemoteCache.has(repoA.rootUri.fsPath),
        false,
        'cache entry for repo A is evicted after onDidChangeRepository fires'
      );
    });

    it('leaves other cached entries intact when a different repo changes', () => {
      const repoA = mkRepo('/repo-a', 'git@github.com:acme/a.git');
      const repoB = mkRepo('/repo-b', 'git@github.com:acme/b.git');
      const { service, fire } = mkGitService([repoA, repoB]);
      provider.attachGitService(service);
      provider.setAvailableRepositories([repoA, repoB]);

      const internals = provider as unknown as GitToolWindowProviderInternals;
      seedCacheForRepo(internals, repoA);
      seedCacheForRepo(internals, repoB);
      assert.strictEqual(internals._parsedRemoteCache.has(repoA.rootUri.fsPath), true);
      assert.strictEqual(internals._parsedRemoteCache.has(repoB.rootUri.fsPath), true);

      // Fire onDidChangeRepository ONLY for repo B.
      fire(repoB);

      assert.strictEqual(
        internals._parsedRemoteCache.has(repoA.rootUri.fsPath),
        true,
        'unrelated repo A cache entry should survive'
      );
      assert.strictEqual(
        internals._parsedRemoteCache.has(repoB.rootUri.fsPath),
        false,
        'changed repo B cache entry should be evicted'
      );
    });

    it('clears the entire cache on a fresh attachGitService call', () => {
      const repoA = mkRepo('/repo-a', 'git@github.com:acme/a.git');
      const { service: service1 } = mkGitService([repoA]);
      provider.attachGitService(service1);
      provider.setAvailableRepositories([repoA]);

      const internals = provider as unknown as GitToolWindowProviderInternals;
      seedCacheForRepo(internals, repoA);
      assert.strictEqual(
        internals._parsedRemoteCache.has(repoA.rootUri.fsPath),
        true,
        'cache seeded'
      );

      const { service: service2 } = mkGitService([repoA]);
      provider.attachGitService(service2);

      assert.strictEqual(
        internals._parsedRemoteCache.size,
        0,
        'cache fully cleared on re-attach to a new GitService'
      );
    });
  });
});

describe('GitToolWindow state machine (Requirement 3)', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  /**
   * Minimal mock Webview sufficient for the state-machine HTML methods,
   * which only read `cspSource` and `asWebviewUri`.
   */
  function createMockWebview(): Webview {
    return {
      html: '',
      options: {},
      cspSource: 'https://mock.csp.source',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (uri: Uri) => uri,
    } as unknown as Webview;
  }

  /**
   * Reach the private `_getHtmlContent` state-machine selector. The three
   * rendered views are not otherwise observable without going through
   * `resolveWebviewView`, so the tests below assert the rendered output via
   * this narrow cast.
   */
  function renderHtml(p: GitToolWindowProvider, webview: Webview): string {
    return (p as unknown as { _getHtmlContent: (w: Webview) => string })._getHtmlContent(webview);
  }

  // Markers that uniquely identify each of the three rendered views.
  const LOADING_MARKER = 'Loading git graph';
  const NO_REPO_MARKER = 'No Git repository found in this workspace.';
  const GRAPH_MARKER = 'three-panel-layout';

  it('renders the loading view for a freshly constructed provider (Loading state)', () => {
    // Construct → _isLoading=true, _hasRepository=false (Loading state).
    const webview = createMockWebview();

    const html = renderHtml(provider, webview);

    assert.ok(html.includes(LOADING_MARKER), 'Should render the loading spinner text');
    assert.ok(
      !html.includes(NO_REPO_MARKER),
      'Should not render the no-repository message while loading'
    );
    assert.ok(!html.includes(GRAPH_MARKER), 'Should not render the graph while loading');
  });

  it('renders the no-repository view after setHasRepository(false) (Loading → NoRepository)', () => {
    // Repository_Detection completes with no repo → setHasRepository(false)
    // leaves the Loading state and lands in No_Repository_State (Req 3.1, 3.2).
    const webview = createMockWebview();
    provider.setHasRepository(false);

    const html = renderHtml(provider, webview);

    assert.ok(html.includes(NO_REPO_MARKER), 'Should render the no-repository message');
    assert.ok(html.includes('Initialize Repository'), 'Should render the init-repository control');
    assert.ok(
      !html.includes(LOADING_MARKER),
      'Should not render the loading spinner once detection has completed'
    );
    assert.ok(!html.includes(GRAPH_MARKER), 'Should not render the graph with no repository');
  });

  it('renders the graph view after setHasRepository(true) then updateLogState(...) (Loading → Graph)', () => {
    // Repository present → setHasRepository(true) leaves Loading, and
    // updateLogState fills the commit graph (Req 3.3).
    const webview = createMockWebview();
    provider.setHasRepository(true);
    provider.updateLogState([
      {
        hash: 'abc1234567890',
        shortHash: 'abc1234',
        message: 'First commit',
        author: { name: 'Test Author', email: 'test@example.com' },
        committer: { name: 'Test Author', email: 'test@example.com' },
        parents: [],
        authorDate: new Date(),
        commitDate: new Date(),
      },
    ] as Parameters<typeof provider.updateLogState>[0]);

    const html = renderHtml(provider, webview);

    assert.ok(html.includes(GRAPH_MARKER), 'Should render the three-panel graph layout');
    assert.ok(!html.includes(LOADING_MARKER), 'Should not render the loading spinner once loaded');
    assert.ok(
      !html.includes(NO_REPO_MARKER),
      'Should not render the no-repository message once a repository is present'
    );
  });
});
