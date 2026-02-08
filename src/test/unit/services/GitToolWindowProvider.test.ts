/**
 * Unit tests for GitToolWindowProvider
 */

import '../../../test/setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../services/GitToolWindowProvider';
import { Uri } from '../../mocks/vscode';

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
      const disposable = provider.onDidChangeState(() => {
        eventCount++;
      });

      provider.setHasRepository(false); // Same as initial value
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

describe('Log View (Requirement 9.1, 9.2, 9.3, 9.4, 9.5, 17.5)', () => {
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
    it('should update log state with commits (Requirement 9.1)', () => {
      const commits = [
        createMockCommit('abc1234567890', 'First commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ];

      provider.updateLogState(commits);

      const extendedState = provider.getExtendedLogState();
      assert.strictEqual(extendedState.commitNodes.length, 2);
      assert.strictEqual(extendedState.commitNodes[0].commit.hash, 'abc1234567890');
      assert.strictEqual(extendedState.commitNodes[1].commit.hash, 'def4567890123');
    });

    it('should generate graph visualization data (Requirement 9.1)', () => {
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

    it('should include branch labels on commits (Requirement 9.2)', () => {
      const commits = [createMockCommit('abc1234567890', 'First commit')];
      const branchMap = new Map<string, string[]>();
      branchMap.set('abc1234567890', ['main', 'feature/test']);

      provider.updateLogState(commits, branchMap);

      const extendedState = provider.getExtendedLogState();
      assert.deepStrictEqual(extendedState.commitNodes[0].branches, ['main', 'feature/test']);
    });

    it('should include tag labels on commits (Requirement 9.2)', () => {
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
    it('should select a commit (Requirement 9.3)', () => {
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
    it('should add commit to selection (Requirement 9.8)', () => {
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
    it('should set log filter (Requirement 9.6)', () => {
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

  describe('Log Context Menu Actions (Requirement 9.5)', () => {
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

    it('should fire onDidRequestLogContextAction for createBranch', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'createBranch');
        disposable.dispose();
        done();
      });

      (
        provider as unknown as { _onDidRequestLogContextAction: { fire: (event: unknown) => void } }
      )._onDidRequestLogContextAction.fire({
        action: 'createBranch',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire onDidRequestLogContextAction for createTag', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'createTag');
        disposable.dispose();
        done();
      });

      (
        provider as unknown as { _onDidRequestLogContextAction: { fire: (event: unknown) => void } }
      )._onDidRequestLogContextAction.fire({
        action: 'createTag',
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
        'cherryPick',
        'revert',
        'createBranch',
        'createTag',
        'resetToHere',
        'showDiff',
        'copyHash',
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

  describe('Commit File Diff (Requirement 9.4)', () => {
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
      const branchMap = new Map<string, string[]>();
      branchMap.set('abc1234567890', ['main']);

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

  describe('IntelliJ-style Log Layout (Requirement 17.5)', () => {
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

  describe('Log Filtering UI (Requirement 9.6, 9.7)', () => {
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

    it('should support filtering by author (Requirement 9.6)', () => {
      const filter = { author: 'John Doe' };
      provider.setLogFilter(filter);

      const extState = provider.getExtendedLogState();
      assert.strictEqual(extState.filter?.author, 'John Doe');
    });

    it('should support filtering by date range (Requirement 9.6)', () => {
      const since = new Date('2024-01-01');
      const until = new Date('2024-12-31');
      const filter = { since, until };
      provider.setLogFilter(filter);

      const extState = provider.getExtendedLogState();
      assert.deepStrictEqual(extState.filter?.since, since);
      assert.deepStrictEqual(extState.filter?.until, until);
    });

    it('should support filtering by file path (Requirement 9.6)', () => {
      const filter = { path: 'src/services/' };
      provider.setLogFilter(filter);

      const extState = provider.getExtendedLogState();
      assert.strictEqual(extState.filter?.path, 'src/services/');
    });

    it('should support searching commit messages (Requirement 9.7)', () => {
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

describe('Initial Data Request and No-Repository State (Requirements 5.3, 5.4)', () => {
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
        postMessage: async (_message: unknown) => true,
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
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as Parameters<typeof provider.resolveWebviewView>[2]
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
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as Parameters<typeof provider.resolveWebviewView>[2]
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
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as Parameters<typeof provider.resolveWebviewView>[2]
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
      // Initial state is hasRepository: false
      let eventFired = false;
      const disposable = provider.onDidChangeState(() => {
        eventFired = true;
      });

      provider.setNoRepository();
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
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as Parameters<typeof provider.resolveWebviewView>[2]
      );

      assert.strictEqual(mockView.webview.options.enableScripts, true);
    });

    it('should set HTML content on the webview', () => {
      const mockView = createMockWebviewView();
      provider.resolveWebviewView(
        mockView as unknown as Parameters<typeof provider.resolveWebviewView>[0],
        {} as Parameters<typeof provider.resolveWebviewView>[1],
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as Parameters<typeof provider.resolveWebviewView>[2]
      );

      assert.ok(mockView.webview.html.length > 0, 'Webview HTML should be set');
      assert.ok(mockView.webview.html.includes('<!DOCTYPE html>'), 'Should contain valid HTML');
    });
  });
});
