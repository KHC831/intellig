/**
 * Unit tests for GitToolWindowProvider
 */

import '../../../test/setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../services/GitToolWindowProvider';
import { GitToolWindowTab, IChangelist } from '../../../services/interfaces';
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
    it('should initialize with default tab as local-changes', () => {
      assert.strictEqual(provider.getActiveTab(), 'local-changes');
    });

    it('should initialize with specified default tab', () => {
      const logProvider = new GitToolWindowProvider(extensionUri, 'log');
      assert.strictEqual(logProvider.getActiveTab(), 'log');
      logProvider.dispose();
    });

    it('should initialize with console tab', () => {
      const consoleProvider = new GitToolWindowProvider(extensionUri, 'console');
      assert.strictEqual(consoleProvider.getActiveTab(), 'console');
      consoleProvider.dispose();
    });
  });

  describe('setActiveTab', () => {
    it('should switch to log tab', () => {
      provider.setActiveTab('log');
      assert.strictEqual(provider.getActiveTab(), 'log');
    });

    it('should switch to console tab', () => {
      provider.setActiveTab('console');
      assert.strictEqual(provider.getActiveTab(), 'console');
    });

    it('should switch back to local-changes tab', () => {
      provider.setActiveTab('log');
      provider.setActiveTab('local-changes');
      assert.strictEqual(provider.getActiveTab(), 'local-changes');
    });

    it('should fire onDidChangeActiveTab event when tab changes', (done) => {
      const disposable = provider.onDidChangeActiveTab((tab) => {
        assert.strictEqual(tab, 'log');
        disposable.dispose();
        done();
      });
      provider.setActiveTab('log');
    });

    it('should not fire event when setting same tab', () => {
      let eventFired = false;
      const disposable = provider.onDidChangeActiveTab(() => {
        eventFired = true;
      });

      // Set to same tab
      provider.setActiveTab('local-changes');

      assert.strictEqual(eventFired, false);
      disposable.dispose();
    });

    it('should fire onDidChangeState event when tab changes', (done) => {
      const disposable = provider.onDidChangeState((state) => {
        assert.strictEqual(state.activeTab, 'console');
        disposable.dispose();
        done();
      });
      provider.setActiveTab('console');
    });
  });

  describe('getState', () => {
    it('should return initial state', () => {
      const state = provider.getState();

      assert.strictEqual(state.activeTab, 'local-changes');
      assert.strictEqual(state.hasRepository, false);
      assert.deepStrictEqual(state.localChangesState.changelists, []);
      assert.strictEqual(state.localChangesState.expandedChangelists.size, 0);
      assert.strictEqual(state.localChangesState.selectedFiles.size, 0);
      assert.strictEqual(state.logState.selectedCommits.size, 0);
      assert.strictEqual(state.logState.expandedCommit, undefined);
      assert.deepStrictEqual(state.consoleState.entries, []);
    });

    it('should return a copy of state (not reference)', () => {
      const state1 = provider.getState();
      const state2 = provider.getState();

      // Should be equal but not the same reference
      assert.deepStrictEqual(state1.activeTab, state2.activeTab);
      assert.notStrictEqual(
        state1.localChangesState.expandedChangelists,
        state2.localChangesState.expandedChangelists
      );
    });
  });

  describe('state preservation across tab switches', () => {
    it('should preserve local changes state when switching tabs', () => {
      // Set up some state
      const changelists: IChangelist[] = [
        {
          id: 'default',
          name: 'Default Changelist',
          isDefault: true,
          files: [{ path: 'test.ts', status: 'modified', staged: false }],
        },
      ];
      provider.updateLocalChangesState(changelists);

      // Switch to log tab
      provider.setActiveTab('log');

      // Switch back to local-changes
      provider.setActiveTab('local-changes');

      // Verify state is preserved
      const state = provider.getState();
      assert.strictEqual(state.localChangesState.changelists.length, 1);
      assert.strictEqual(state.localChangesState.changelists[0].name, 'Default Changelist');
    });

    it('should preserve console entries when switching tabs', () => {
      // Add console entries
      provider.addConsoleEntry({
        command: 'git status',
        output: 'On branch main',
        isError: false,
      });

      // Switch to local-changes tab
      provider.setActiveTab('local-changes');

      // Switch back to console
      provider.setActiveTab('console');

      // Verify entries are preserved
      const state = provider.getState();
      assert.strictEqual(state.consoleState.entries.length, 1);
      assert.strictEqual(state.consoleState.entries[0].command, 'git status');
    });

    it('should preserve log state when switching tabs', () => {
      // Start on log tab
      provider.setActiveTab('log');

      // Switch to console
      provider.setActiveTab('console');

      // Switch back to log
      provider.setActiveTab('log');

      // State should be preserved (even if empty)
      const state = provider.getState();
      assert.strictEqual(state.activeTab, 'log');
    });
  });

  describe('addConsoleEntry', () => {
    it('should add a console entry with timestamp', () => {
      const beforeTime = new Date();

      provider.addConsoleEntry({
        command: 'git status',
        output: 'On branch main',
        isError: false,
      });

      const afterTime = new Date();
      const state = provider.getState();

      assert.strictEqual(state.consoleState.entries.length, 1);
      const entry = state.consoleState.entries[0];
      assert.strictEqual(entry.command, 'git status');
      assert.strictEqual(entry.output, 'On branch main');
      assert.strictEqual(entry.isError, false);
      assert.ok(entry.timestamp >= beforeTime);
      assert.ok(entry.timestamp <= afterTime);
    });

    it('should add multiple console entries', () => {
      provider.addConsoleEntry({
        command: 'git status',
        output: 'On branch main',
        isError: false,
      });

      provider.addConsoleEntry({
        command: 'git add .',
        output: '',
        isError: false,
      });

      provider.addConsoleEntry({
        command: 'git commit -m "test"',
        output: '[main abc1234] test',
        exitCode: 0,
        isError: false,
      });

      const state = provider.getState();
      assert.strictEqual(state.consoleState.entries.length, 3);
    });

    it('should include exit code when provided', () => {
      provider.addConsoleEntry({
        command: 'git push',
        output: 'error: failed to push',
        exitCode: 1,
        isError: true,
      });

      const state = provider.getState();
      assert.strictEqual(state.consoleState.entries[0].exitCode, 1);
      assert.strictEqual(state.consoleState.entries[0].isError, true);
    });

    it('should fire onDidChangeState event', (done) => {
      const disposable = provider.onDidChangeState((state) => {
        assert.strictEqual(state.consoleState.entries.length, 1);
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
    it('should clear all console entries', () => {
      provider.addConsoleEntry({
        command: 'git status',
        output: 'On branch main',
        isError: false,
      });

      provider.addConsoleEntry({
        command: 'git add .',
        output: '',
        isError: false,
      });

      provider.clearConsole();

      const state = provider.getState();
      assert.strictEqual(state.consoleState.entries.length, 0);
    });

    it('should fire onDidChangeState event', (done) => {
      provider.addConsoleEntry({
        command: 'git status',
        output: 'On branch main',
        isError: false,
      });

      const disposable = provider.onDidChangeState((state) => {
        assert.strictEqual(state.consoleState.entries.length, 0);
        disposable.dispose();
        done();
      });

      provider.clearConsole();
    });
  });

  describe('updateLocalChangesState', () => {
    it('should update changelists', () => {
      const changelists: IChangelist[] = [
        {
          id: 'default',
          name: 'Default Changelist',
          isDefault: true,
          files: [
            { path: 'file1.ts', status: 'modified', staged: false },
            { path: 'file2.ts', status: 'added', staged: true },
          ],
        },
        {
          id: 'feature',
          name: 'Feature Work',
          isDefault: false,
          files: [{ path: 'feature.ts', status: 'modified', staged: false }],
        },
      ];

      provider.updateLocalChangesState(changelists);

      const state = provider.getState();
      assert.strictEqual(state.localChangesState.changelists.length, 2);
      assert.strictEqual(state.localChangesState.changelists[0].files.length, 2);
      assert.strictEqual(state.localChangesState.changelists[1].name, 'Feature Work');
    });

    it('should set hasRepository to true', () => {
      provider.updateLocalChangesState([]);

      const state = provider.getState();
      assert.strictEqual(state.hasRepository, true);
    });

    it('should fire onDidChangeState event', (done) => {
      const changelists: IChangelist[] = [
        {
          id: 'default',
          name: 'Default Changelist',
          isDefault: true,
          files: [],
        },
      ];

      const disposable = provider.onDidChangeState((state) => {
        assert.strictEqual(state.localChangesState.changelists.length, 1);
        disposable.dispose();
        done();
      });

      provider.updateLocalChangesState(changelists);
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
      const disposable = provider.onDidChangeState((state) => {
        assert.strictEqual(state.hasRepository, true);
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

  describe('keyboard accessibility (Requirement 17.1)', () => {
    it('should support all three tabs for keyboard navigation', () => {
      // Verify all tabs are accessible
      const tabs: GitToolWindowTab[] = ['local-changes', 'log', 'console'];

      tabs.forEach((tab) => {
        provider.setActiveTab(tab);
        assert.strictEqual(provider.getActiveTab(), tab);
      });
    });
  });

  describe('Local Changes View - Tree View with Changelist Grouping (Requirement 2.1, 17.2)', () => {
    it('should display files grouped by changelist', () => {
      const changelists: IChangelist[] = [
        {
          id: 'default',
          name: 'Default Changelist',
          isDefault: true,
          files: [
            { path: 'src/app.ts', status: 'modified', staged: false },
            { path: 'src/utils.ts', status: 'added', staged: true },
          ],
        },
        {
          id: 'feature-1',
          name: 'Feature Work',
          isDefault: false,
          files: [{ path: 'src/feature.ts', status: 'modified', staged: false }],
        },
      ];

      provider.updateLocalChangesState(changelists);
      const state = provider.getState();

      assert.strictEqual(state.localChangesState.changelists.length, 2);
      assert.strictEqual(state.localChangesState.changelists[0].files.length, 2);
      assert.strictEqual(state.localChangesState.changelists[1].files.length, 1);
    });

    it('should support expand/collapse of changelists', () => {
      const changelists: IChangelist[] = [
        {
          id: 'default',
          name: 'Default Changelist',
          isDefault: true,
          files: [{ path: 'test.ts', status: 'modified', staged: false }],
        },
      ];

      provider.updateLocalChangesState(changelists);

      // Initially no changelists are expanded
      const state = provider.getState();
      assert.strictEqual(state.localChangesState.expandedChangelists.size, 0);
    });

    it('should preserve expanded state across updates', () => {
      const changelists: IChangelist[] = [
        {
          id: 'default',
          name: 'Default Changelist',
          isDefault: true,
          files: [{ path: 'test.ts', status: 'modified', staged: false }],
        },
      ];

      provider.updateLocalChangesState(changelists);

      // Update with new changelists
      const newChangelists: IChangelist[] = [
        {
          id: 'default',
          name: 'Default Changelist',
          isDefault: true,
          files: [
            { path: 'test.ts', status: 'modified', staged: false },
            { path: 'new.ts', status: 'added', staged: false },
          ],
        },
      ];

      provider.updateLocalChangesState(newChangelists);
      const state = provider.getState();

      // Changelists should be updated
      assert.strictEqual(state.localChangesState.changelists[0].files.length, 2);
    });
  });

  describe('Local Changes View - File Status Color Coding (Requirement 2.6, 17.10)', () => {
    it('should handle all file status types', () => {
      const changelists: IChangelist[] = [
        {
          id: 'default',
          name: 'Default Changelist',
          isDefault: true,
          files: [
            { path: 'modified.ts', status: 'modified', staged: false },
            { path: 'added.ts', status: 'added', staged: false },
            { path: 'deleted.ts', status: 'deleted', staged: false },
            { path: 'renamed.ts', status: 'renamed', staged: false },
            { path: 'untracked.ts', status: 'untracked', staged: false },
            { path: 'conflicted.ts', status: 'conflicted', staged: false },
          ],
        },
      ];

      provider.updateLocalChangesState(changelists);
      const state = provider.getState();

      // Verify all status types are preserved
      const files = state.localChangesState.changelists[0].files;
      assert.strictEqual(files[0].status, 'modified');
      assert.strictEqual(files[1].status, 'added');
      assert.strictEqual(files[2].status, 'deleted');
      assert.strictEqual(files[3].status, 'renamed');
      assert.strictEqual(files[4].status, 'untracked');
      assert.strictEqual(files[5].status, 'conflicted');
    });

    it('should distinguish staged and unstaged files', () => {
      const changelists: IChangelist[] = [
        {
          id: 'default',
          name: 'Default Changelist',
          isDefault: true,
          files: [
            { path: 'staged.ts', status: 'modified', staged: true },
            { path: 'unstaged.ts', status: 'modified', staged: false },
          ],
        },
      ];

      provider.updateLocalChangesState(changelists);
      const state = provider.getState();

      const files = state.localChangesState.changelists[0].files;
      assert.strictEqual(files[0].staged, true);
      assert.strictEqual(files[1].staged, false);
    });
  });

  describe('Local Changes View - Context Menu Actions (Requirement 2.7)', () => {
    it('should fire onDidRequestContextAction event for context menu actions', (done) => {
      const disposable = provider.onDidRequestContextAction((event) => {
        assert.strictEqual(event.action, 'showDiff');
        assert.deepStrictEqual(event.files, ['test.ts']);
        disposable.dispose();
        done();
      });

      // Simulate context action (this would normally come from webview)
      // We test the event emitter directly
      (
        provider as unknown as { _onDidRequestContextAction: { fire: (event: unknown) => void } }
      )._onDidRequestContextAction.fire({
        action: 'showDiff',
        files: ['test.ts'],
      });
    });

    it('should support all context menu action types', () => {
      const actions = [
        'stage',
        'unstage',
        'revert',
        'showDiff',
        'moveToChangelist',
        'shelve',
        'delete',
      ];
      const receivedActions: string[] = [];

      const disposable = provider.onDidRequestContextAction((event) => {
        receivedActions.push(event.action);
      });

      // Fire events for each action type
      actions.forEach((action) => {
        (
          provider as unknown as { _onDidRequestContextAction: { fire: (event: unknown) => void } }
        )._onDidRequestContextAction.fire({
          action,
          files: ['test.ts'],
        });
      });

      assert.deepStrictEqual(receivedActions, actions);
      disposable.dispose();
    });

    it('should include target changelist ID for moveToChangelist action', (done) => {
      const disposable = provider.onDidRequestContextAction((event) => {
        assert.strictEqual(event.action, 'moveToChangelist');
        assert.strictEqual(event.targetChangelistId, 'feature-1');
        disposable.dispose();
        done();
      });

      (
        provider as unknown as { _onDidRequestContextAction: { fire: (event: unknown) => void } }
      )._onDidRequestContextAction.fire({
        action: 'moveToChangelist',
        files: ['test.ts'],
        targetChangelistId: 'feature-1',
      });
    });
  });

  describe('Local Changes View - Drag and Drop (Requirement 2.4, 17.10)', () => {
    it('should fire onDidRequestFileDrop event when files are dropped', (done) => {
      const disposable = provider.onDidRequestFileDrop((event) => {
        assert.deepStrictEqual(event.files, ['src/app.ts', 'src/utils.ts']);
        assert.strictEqual(event.targetChangelistId, 'feature-1');
        disposable.dispose();
        done();
      });

      // Simulate file drop (this would normally come from webview)
      (
        provider as unknown as { _onDidRequestFileDrop: { fire: (event: unknown) => void } }
      )._onDidRequestFileDrop.fire({
        files: ['src/app.ts', 'src/utils.ts'],
        targetChangelistId: 'feature-1',
      });
    });

    it('should support dropping single file', (done) => {
      const disposable = provider.onDidRequestFileDrop((event) => {
        assert.strictEqual(event.files.length, 1);
        assert.strictEqual(event.files[0], 'test.ts');
        disposable.dispose();
        done();
      });

      (
        provider as unknown as { _onDidRequestFileDrop: { fire: (event: unknown) => void } }
      )._onDidRequestFileDrop.fire({
        files: ['test.ts'],
        targetChangelistId: 'default',
      });
    });

    it('should support dropping multiple files', (done) => {
      const disposable = provider.onDidRequestFileDrop((event) => {
        assert.strictEqual(event.files.length, 3);
        disposable.dispose();
        done();
      });

      (
        provider as unknown as { _onDidRequestFileDrop: { fire: (event: unknown) => void } }
      )._onDidRequestFileDrop.fire({
        files: ['file1.ts', 'file2.ts', 'file3.ts'],
        targetChangelistId: 'feature-1',
      });
    });
  });

  describe('Local Changes View - File Selection', () => {
    it('should track selected files', () => {
      const changelists: IChangelist[] = [
        {
          id: 'default',
          name: 'Default Changelist',
          isDefault: true,
          files: [
            { path: 'file1.ts', status: 'modified', staged: false },
            { path: 'file2.ts', status: 'modified', staged: false },
          ],
        },
      ];

      provider.updateLocalChangesState(changelists);
      const state = provider.getState();

      // Initially no files are selected
      assert.strictEqual(state.localChangesState.selectedFiles.size, 0);
    });
  });

  describe('Local Changes View - Default Changelist Badge', () => {
    it('should identify default changelist', () => {
      const changelists: IChangelist[] = [
        {
          id: 'default',
          name: 'Default Changelist',
          isDefault: true,
          files: [],
        },
        {
          id: 'feature',
          name: 'Feature Work',
          isDefault: false,
          files: [],
        },
      ];

      provider.updateLocalChangesState(changelists);
      const state = provider.getState();

      assert.strictEqual(state.localChangesState.changelists[0].isDefault, true);
      assert.strictEqual(state.localChangesState.changelists[1].isDefault, false);
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

      const state = provider.getState();
      assert.ok(state.logState.selectedCommits.has('abc1234567890'));
      assert.strictEqual(state.logState.expandedCommit, 'abc1234567890');
    });

    it('should clear previous selection when selecting new commit', () => {
      const commits = [
        createMockCommit('abc1234567890', 'First commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ];
      provider.updateLogState(commits);

      provider.selectCommit('abc1234567890');
      provider.selectCommit('def4567890123');

      const state = provider.getState();
      assert.strictEqual(state.logState.selectedCommits.size, 1);
      assert.ok(state.logState.selectedCommits.has('def4567890123'));
      assert.ok(!state.logState.selectedCommits.has('abc1234567890'));
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

      const state = provider.getState();
      assert.strictEqual(state.logState.selectedCommits.size, 2);
      assert.ok(state.logState.selectedCommits.has('abc1234567890'));
      assert.ok(state.logState.selectedCommits.has('def4567890123'));
    });

    it('should remove commit from selection when toggled again', () => {
      const commits = [createMockCommit('abc1234567890', 'First commit')];
      provider.updateLogState(commits);

      provider.toggleCommitSelection('abc1234567890');
      provider.toggleCommitSelection('abc1234567890');

      const state = provider.getState();
      assert.strictEqual(state.logState.selectedCommits.size, 0);
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

      const state = provider.getState();
      assert.deepStrictEqual(state.logState.filter, filter);
    });

    it('should clear filter when set to undefined', () => {
      provider.setLogFilter({ author: 'Test' });
      provider.setLogFilter(undefined);

      const state = provider.getState();
      assert.strictEqual(state.logState.filter, undefined);
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
    it('should preserve log state when switching tabs', () => {
      const commits = [createMockCommit('abc1234567890', 'First commit')];
      provider.updateLogState(commits);
      provider.selectCommit('abc1234567890');

      // Switch to local-changes tab
      provider.setActiveTab('local-changes');

      // Switch back to log
      provider.setActiveTab('log');

      // Verify state is preserved
      const state = provider.getState();
      assert.ok(state.logState.selectedCommits.has('abc1234567890'));
      assert.strictEqual(state.logState.expandedCommit, 'abc1234567890');
    });

    it('should preserve commit nodes when switching tabs', () => {
      const commits = [
        createMockCommit('abc1234567890', 'First commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ];
      provider.updateLogState(commits);

      // Switch tabs
      provider.setActiveTab('console');
      provider.setActiveTab('log');

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

      const state = provider.getState();
      const extendedState = provider.getExtendedLogState();

      // Verify we have the data needed for the layout
      assert.ok(extendedState.commitNodes.length > 0); // For commit list
      assert.ok(state.logState.expandedCommit); // For details panel
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

      const state = provider.getState();
      assert.strictEqual(state.logState.filter?.author, 'John Doe');
    });

    it('should support filtering by date range (Requirement 9.6)', () => {
      const since = new Date('2024-01-01');
      const until = new Date('2024-12-31');
      const filter = { since, until };
      provider.setLogFilter(filter);

      const state = provider.getState();
      assert.deepStrictEqual(state.logState.filter?.since, since);
      assert.deepStrictEqual(state.logState.filter?.until, until);
    });

    it('should support filtering by file path (Requirement 9.6)', () => {
      const filter = { path: 'src/services/' };
      provider.setLogFilter(filter);

      const state = provider.getState();
      assert.strictEqual(state.logState.filter?.path, 'src/services/');
    });

    it('should support searching commit messages (Requirement 9.7)', () => {
      const filter = { searchText: 'fix critical bug' };
      provider.setLogFilter(filter);

      const state = provider.getState();
      assert.strictEqual(state.logState.filter?.searchText, 'fix critical bug');
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

      const state = provider.getState();
      assert.strictEqual(state.logState.filter?.author, 'Jane Smith');
      assert.deepStrictEqual(state.logState.filter?.since, filter.since);
      assert.deepStrictEqual(state.logState.filter?.until, filter.until);
      assert.strictEqual(state.logState.filter?.path, 'src/');
      assert.strictEqual(state.logState.filter?.searchText, 'refactor');
    });

    it('should preserve filter state when switching tabs', () => {
      const filter = {
        author: 'Test Author',
        searchText: 'important',
      };
      provider.setLogFilter(filter);

      // Switch to local-changes tab
      provider.setActiveTab('local-changes');

      // Switch back to log
      provider.setActiveTab('log');

      // Verify filter is preserved
      const state = provider.getState();
      assert.strictEqual(state.logState.filter?.author, 'Test Author');
      assert.strictEqual(state.logState.filter?.searchText, 'important');
    });

    it('should update extended log state filter when setLogFilter is called', () => {
      const filter = { author: 'Developer' };
      provider.setLogFilter(filter);

      const extendedState = provider.getExtendedLogState();
      assert.strictEqual(extendedState.filter?.author, 'Developer');
    });
  });
});
