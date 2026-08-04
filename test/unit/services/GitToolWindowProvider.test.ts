/**
 * Unit tests for GitToolWindowProvider
 */

import '../../setup';
import { isUnsafeRef } from '../../../src/git-core/gitToolWindow/provider/logFilterSanitizer';
import { readGtwWebviewSource } from '../../helpers/gtwWebviewSource';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import { isLogContextAction } from '../../../src/git-core/gitToolWindow/provider/logActions';
import { computeMenuVisibility } from '../../../src/git-core/gitToolWindow/multiSelect';
import { EventEmitter, Uri, Webview, setMockConfigValue } from '../../mocks/vscode';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import type { ICommitNode, IBranchRef } from '../../../src/git-core/commitGraph';
import type { IRemoteUrl } from '../../../src/utils/remoteUrl';

/** Source of the bundled Git tool-window client entry (was `_getInlineScript()`). */
const ENTRY_SOURCE = readGtwWebviewSource();

/**
 * Test-surface reaching into {@link GitToolWindowProvider}'s private
 * parsed-remote cache state. The cache-invalidation contract is not
 * observable through the public API (no getter exposes cache membership
 * without also mutating it), so the tests below assert it via a narrow
 * cast through this surface.
 *
 * Kept deliberately small (single field the test genuinely drives) per
 * docs/testing.md section 3. No `I`-prefix; no kitchen-sink fields.
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

  describe('updateConsoleEntry', () => {
    it('should fire onDidChangeState event, like its sibling mutators', (done) => {
      provider.addConsoleEntry({
        id: 'stream-1',
        command: 'git clone',
        output: '',
        isError: false,
      });

      const disposable = provider.onDidChangeState(() => {
        disposable.dispose();
        done();
      });

      provider.updateConsoleEntry({ id: 'stream-1', output: 'bytes', exitCode: 0 });
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

  describe('getRepoRootForCommit — merged-log source index', () => {
    it('returns the recorded root for a hash unique to one repo', () => {
      provider.updateLogState([
        { ...createMockCommit('a'.repeat(40), 'one'), repoRoot: '/w/r1' },
        { ...createMockCommit('b'.repeat(40), 'two'), repoRoot: '/w/r2' },
      ]);
      assert.strictEqual(provider.getRepoRootForCommit('a'.repeat(40)), '/w/r1');
      assert.strictEqual(provider.getRepoRootForCommit('b'.repeat(40)), '/w/r2');
    });

    it('refuses to guess when the same hash exists in several repos', () => {
      // Two checkouts of one repo: the hash alone cannot identify a target
      // repo. Last-writer-wins here silently aimed commit-targeted (incl.
      // destructive) actions at an arbitrary checkout — fail closed instead;
      // callers fall back to their context-repo chain or the clicked row.
      provider.updateLogState([
        { ...createMockCommit('c'.repeat(40), 'same'), repoRoot: '/w/r1' },
        { ...createMockCommit('c'.repeat(40), 'same'), repoRoot: '/w/r2' },
      ]);
      assert.strictEqual(provider.getRepoRootForCommit('c'.repeat(40)), undefined);
    });
  });

  describe('updateLogState', () => {
    it('should update log state with commits', () => {
      // `updateLogState` trusts the topo-ordered input from
      // `git log --topo-order`, which is newest-first (parent appears
      // later than child). Pass commits newest-first; display order
      // matches input order verbatim.
      const commits = [
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
        createMockCommit('abc1234567890', 'First commit'),
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

  describe('isUnsafeRef — parity with the ops-layer ref guard', () => {
    it('rejects a leading dash and a leading dot', () => {
      assert.strictEqual(isUnsafeRef('-x'), true);
      assert.strictEqual(isUnsafeRef('.hidden'), true);
    });

    it('rejects a dash-leading path segment, like the ops guard it fronts', () => {
      // StashTagHistoryOps' getLog guard also throws on refs like `foo/-x`;
      // the webview-boundary check must not be weaker than the layer it
      // fronts, or the rejection surfaces as a logged error instead of a
      // clean filter no-op.
      assert.strictEqual(isUnsafeRef('foo/-x'), true);
    });

    it('accepts ordinary branch names', () => {
      assert.strictEqual(isUnsafeRef('main'), false);
      assert.strictEqual(isUnsafeRef('feature/log-filters'), false);
      assert.strictEqual(isUnsafeRef('origin/main'), false);
    });
  });

  describe('isLogContextAction — boundary allow-list', () => {
    it('accepts every known action, including destructive ones', () => {
      for (const a of [
        'copyHash',
        'cherryPick',
        'dropCommit',
        'resetToHere',
        'interactiveRebase',
      ]) {
        assert.strictEqual(isLogContextAction(a), true, `${a} must be allowed`);
      }
    });

    it('rejects an unknown / malformed / non-string action', () => {
      assert.strictEqual(isLogContextAction('rm -rf'), false);
      assert.strictEqual(isLogContextAction(''), false);
      assert.strictEqual(isLogContextAction('toString'), false, 'inherited props are not actions');
      assert.strictEqual(isLogContextAction('__proto__'), false);
      assert.strictEqual(isLogContextAction(undefined), false);
      assert.strictEqual(isLogContextAction(42), false);
    });
  });

  describe('_handleRepositorySelection — non-integer (NaN) guard', () => {
    it('ignores a NaN repository index instead of bricking the scope to NaN', () => {
      const repo = { rootUri: Uri.file('/r') } as unknown as IRepository;
      type Surface = {
        _availableRepositories: IRepository[];
        _repositoryScope: number | 'all';
        _selectedRepositoryIndex: number;
        _handleRepositorySelection: (s: number | 'all') => void;
      };
      const surface = provider as unknown as Surface;
      surface._availableRepositories = [repo];
      const scopeBefore = surface._repositoryScope;

      surface._handleRepositorySelection(Number('not-a-number'));

      assert.ok(
        !Number.isNaN(surface._selectedRepositoryIndex),
        'a NaN index must not become _selectedRepositoryIndex'
      );
      assert.strictEqual(
        surface._repositoryScope,
        scopeBefore,
        'scope must be unchanged by a NaN index'
      );
    });
  });

  describe('_handleCommitFileDoubleClick — stale-hash guard', () => {
    type DblClickSurface = {
      _extendedLogState: { commitNodes: { commit: { hash: string; parents: string[] } }[] };
      _handleCommitFileDoubleClick: (hash: string, path: string) => void;
    };

    it('fires the diff for a commit still in the rendered list', () => {
      const surface = provider as unknown as DblClickSurface;
      surface._extendedLogState.commitNodes = [{ commit: { hash: 'abc123', parents: [] } }];
      const fired: string[] = [];
      const sub = provider.onDidRequestCommitDiff((e) => fired.push(e.commitHash));
      try {
        surface._handleCommitFileDoubleClick('abc123', 'src/foo.ts');
      } finally {
        sub.dispose();
      }
      assert.deepStrictEqual(fired, ['abc123']);
    });

    it('drops a double-click whose commit hash is no longer rendered (no diff for a stale hash)', () => {
      const surface = provider as unknown as DblClickSurface;
      surface._extendedLogState.commitNodes = [{ commit: { hash: 'abc123', parents: [] } }];
      const fired: string[] = [];
      const sub = provider.onDidRequestCommitDiff((e) => fired.push(e.commitHash));
      try {
        surface._handleCommitFileDoubleClick('staleHash', 'src/foo.ts');
      } finally {
        sub.dispose();
      }
      assert.deepStrictEqual(fired, [], 'a stale hash must not reach the diff request');
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
        assert.strictEqual(event.filePath, 'test.ts');
        disposable.dispose();
        done();
      });

      (
        provider as unknown as { _onDidRequestCommitDiff: { fire: (event: unknown) => void } }
      )._onDidRequestCommitDiff.fire({
        commitHash: 'abc1234567890',
        filePath: 'test.ts',
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

  describe('_getLogFilterRowHtml (IntelliJ filter row)', () => {
    it('emits an always-visible filter row with the search field + the always-on popup buttons', () => {
      const html = provider._getLogFilterRowHtml();
      assert.ok(html.includes('class="log-filter-row"'), 'has the filter row');
      assert.ok(!/class="log-filter-row"[^>]*\shidden/.test(html), 'the row is not hidden');
      assert.ok(html.includes('id="filter-search"'), 'has search input');
      assert.ok(html.includes('data-popup="branch"'), 'has Branch popup');
      assert.ok(html.includes('data-popup="user"'), 'has User popup');
      assert.ok(html.includes('data-popup="date"'), 'has Date popup');
    });

    it('adds the Repository popup only in a multi-root workspace', () => {
      assert.ok(
        !provider._getLogFilterRowHtml().includes('data-popup="repo"'),
        'no Repository popup with zero/one repo'
      );
      const repo = (rootPath: string) => ({
        rootUri: Uri.file(rootPath),
        state: 'idle' as const,
        remotes: [],
        submodules: [],
      });
      provider.setAvailableRepositories([
        repo('/workspace/repo-a'),
        repo('/workspace/repo-b'),
      ] as Parameters<typeof provider.setAvailableRepositories>[0]);
      assert.ok(
        provider._getLogFilterRowHtml().includes('data-popup="repo"'),
        'Repository popup appears with multiple repos'
      );
    });

    it('places the search field before the popup buttons', () => {
      const html = provider._getLogFilterRowHtml();
      assert.ok(
        html.indexOf('id="filter-search"') < html.indexOf('data-popup="branch"'),
        'search precedes Branch'
      );
    });

    it('emits regex (.*) and match-case (Aa) toggles next to the search input', () => {
      const html = provider._getLogFilterRowHtml();
      assert.ok(html.includes('id="filter-search-regex"'), 'has regex toggle');
      assert.ok(html.includes('id="filter-search-case"'), 'has match-case toggle');
      assert.ok(html.includes('data-action="toggleSearchRegex"'), 'regex toggle wired');
      assert.ok(html.includes('data-action="toggleSearchCase"'), 'match-case toggle wired');
      assert.ok(
        html.indexOf('id="filter-search"') < html.indexOf('id="filter-search-regex"'),
        'search input precedes the regex toggle'
      );
    });

    it('reflects searchRegex/searchCaseSensitive state in aria-pressed + active class', () => {
      provider.setLogFilter({ searchText: 'token', searchRegex: true, searchCaseSensitive: true });
      const html = provider._getLogFilterRowHtml();
      assert.ok(
        /id="filter-search-regex"[^>]*aria-pressed="true"/.test(html),
        'regex toggle pressed'
      );
      assert.ok(
        /id="filter-search-case"[^>]*aria-pressed="true"/.test(html),
        'match-case toggle pressed'
      );
      assert.ok(html.includes('class="log-filter-toggle-btn active"'), 'active class applied');
    });

    it('uses data-action wiring only (CSP blocks inline handlers)', () => {
      const html = provider._getLogFilterRowHtml();
      assert.ok(!/onclick=/i.test(html), 'no inline onclick handlers');
      assert.ok(!/onkeyup=|onkeydown=|onchange=/i.test(html), 'no inline key/change handlers');
    });

    it('mirrors the active filter into data-f-* attributes + the search value', () => {
      provider.setLogFilter({ author: 'Jane Smith', searchText: 'refactor', path: 'src/' });
      const html = provider._getLogFilterRowHtml();
      assert.ok(html.includes('data-f-author="Jane Smith"'), 'author mirrored');
      assert.ok(html.includes('data-f-path="src/"'), 'path mirrored');
      assert.ok(html.includes('value="refactor"'), 'search value rehydrated');
    });

    it('shows the active branch/author as popup button values', () => {
      provider.setLogFilter({ branch: 'feature/x', author: 'jane' });
      const html = provider._getLogFilterRowHtml();
      assert.ok(/id="filter-branch-value">feature\/x</.test(html), 'Branch value shown');
      assert.ok(/id="filter-user-value">jane</.test(html), 'User value shown');
    });

    it('escapes filter values to prevent attribute-injection', () => {
      provider.setLogFilter({ searchText: '"><img src=x>' });
      const html = provider._getLogFilterRowHtml();
      assert.ok(!html.includes('"><img src=x>'), 'raw injection payload not present');
      assert.ok(html.includes('&quot;&gt;&lt;img'), 'value is HTML-escaped');
    });

    it('offers the Date presets and the custom Select… range', () => {
      const html = provider._getLogFilterRowHtml();
      assert.ok(html.includes('data-range="24h"'), 'Last 24 Hours preset');
      assert.ok(html.includes('data-range="7d"'), 'Last 7 Days preset');
      assert.ok(html.includes('data-action="dateSelectCustom"'), 'custom Select… entry');
      assert.ok(html.includes('id="filter-after-enabled"'), 'After bound checkbox');
      assert.ok(html.includes('id="filter-before-enabled"'), 'Before bound checkbox');
    });

    it('drops the removed controls (no-merges / first-parent / simplify / parents / cherry-compare / toggle / apply)', () => {
      const html = provider._getLogFilterRowHtml();
      assert.ok(!html.includes('filter-no-merges'), 'no No-Merges control');
      assert.ok(!html.includes('filter-first-parent'), 'no First-Parent control');
      assert.ok(!html.includes('filter-simplify-merges'), 'no Simplify-Merges control');
      assert.ok(!html.includes('filter-min-parents'), 'no parents control');
      assert.ok(!html.includes('filter-cherry-compare'), 'no Cherry-compare control');
      assert.ok(!html.includes('toggleLogFilters'), 'no Filter toggle button');
      assert.ok(!html.includes('data-action="applyLogFilter"'), 'no Apply button (applies live)');
    });
  });

  describe('_handleApplyLogFilter — filter mapping', () => {
    function applyFilter(p: GitToolWindowProvider, filter: unknown): void {
      (p as unknown as { _handleWebviewMessage: (msg: unknown) => void })._handleWebviewMessage({
        type: 'applyLogFilter',
        filter,
      });
    }

    it('maps a branch value through to the requested ILogFilter', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.strictEqual(filter?.branch, 'main');
        done();
      });
      applyFilter(provider, { branch: 'main' });
    });

    it('treats an empty branch string as absent', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.strictEqual(filter, undefined, 'empty branch alone collapses to no filter');
        done();
      });
      applyFilter(provider, {
        searchText: '',
        author: '',
        path: '',
        branch: '',
        since: null,
        until: null,
      });
    });

    it('maps a "A..B" branch value to logRange instead of branch', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.strictEqual(filter?.logRange, 'main..feature', 'range routed to logRange');
        assert.strictEqual(filter?.branch, undefined, 'range must not set branch');
        done();
      });
      applyFilter(provider, { branch: 'main..feature' });
    });

    it('maps search/author/path through to the requested ILogFilter', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.strictEqual(filter?.searchText, 'fix');
        assert.strictEqual(filter?.author, 'jane');
        assert.strictEqual(filter?.path, 'src/');
        done();
      });
      applyFilter(provider, { searchText: 'fix', author: 'jane', path: 'src/' });
    });

    it('maps a since date through to the requested ILogFilter', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.ok(filter?.since instanceof Date, 'since is a Date');
        assert.strictEqual(filter?.since?.getTime(), new Date('2026-01-01').getTime());
        done();
      });
      applyFilter(provider, { since: '2026-01-01' });
    });

    it('maps an until date through to the requested ILogFilter', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.ok(filter?.until instanceof Date, 'until is a Date');
        assert.strictEqual(filter?.until?.getTime(), new Date('2026-12-31').getTime());
        done();
      });
      applyFilter(provider, { until: '2026-12-31' });
    });

    it('keeps the regex/case toggles lit in the row HTML when the search box is empty', (done) => {
      // Toggle-first-then-type: the mode flags are UI properties independent
      // of the text (IntelliJ TextFilterModel), so a re-render must not
      // un-highlight them just because no text was committed yet.
      const disposable = provider.onDidRequestLogFilter(() => {
        disposable.dispose();
        const html = (
          provider as unknown as { _getLogFilterRowHtml(): string }
        )._getLogFilterRowHtml();
        const regexBtn = html.match(/<button[^>]*id="filter-search-regex"[^>]*>/)?.[0] ?? '';
        const caseBtn = html.match(/<button[^>]*id="filter-search-case"[^>]*>/)?.[0] ?? '';
        assert.ok(regexBtn.includes('aria-pressed="true"'), `regex toggle stays lit: ${regexBtn}`);
        assert.ok(caseBtn.includes('aria-pressed="true"'), `case toggle stays lit: ${caseBtn}`);
        done();
      });
      applyFilter(provider, { searchText: '', searchRegex: true, searchCaseSensitive: true });
    });

    it('mode toggles alone do not make the filter active', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.strictEqual(filter, undefined, 'flags without text are not a filter criterion');
        done();
      });
      applyFilter(provider, { searchText: '', searchRegex: true, searchCaseSensitive: true });
    });

    it('renders a posted search draft (not the applied text) as the input value', () => {
      (
        provider as unknown as { _handleWebviewMessage: (m: unknown) => void }
      )._handleWebviewMessage({ type: 'logSearchDraft', text: 'half-typ' });
      const html = (
        provider as unknown as { _getLogFilterRowHtml(): string }
      )._getLogFilterRowHtml();
      const input = html.match(/<input[^>]*id="filter-search"[^>]*>/)?.[0] ?? '';
      assert.ok(input.includes('value="half-typ"'), `draft survives a re-render: ${input}`);
    });

    it('carries the committed search text in data-f-search for webview rehydration', (done) => {
      const disposable = provider.onDidRequestLogFilter(() => {
        disposable.dispose();
        const html = (
          provider as unknown as { _getLogFilterRowHtml(): string }
        )._getLogFilterRowHtml();
        assert.ok(html.includes('data-f-search="fix"'), 'committed text rides its own attr');
        done();
      });
      applyFilter(provider, { searchText: 'fix' });
    });

    it('round-trips a timestamp since through data-f-since without truncating to a day', (done) => {
      const iso = '2026-07-17T15:30:00.000Z';
      const disposable = provider.onDidRequestLogFilter(() => {
        disposable.dispose();
        const html = (
          provider as unknown as { _getLogFilterRowHtml(): string }
        )._getLogFilterRowHtml();
        assert.ok(
          html.includes(`data-f-since="${iso}"`),
          'a preset timestamp must survive the row-attr round trip losslessly'
        );
        done();
      });
      applyFilter(provider, { since: iso });
    });

    it('an all-repos-unchecked scope renders the filtered empty state with a Clear affordance', () => {
      const repo = (rootPath: string) => ({
        rootUri: Uri.file(rootPath),
        state: 'idle' as const,
        remotes: [],
        submodules: [],
      });
      provider.setAvailableRepositories([
        repo('/workspace/repo-a'),
        repo('/workspace/repo-b'),
      ] as Parameters<typeof provider.setAvailableRepositories>[0]);
      (
        provider as unknown as { _handleWebviewMessage: (m: unknown) => void }
      )._handleWebviewMessage({ type: 'selectRepositories', roots: [] });
      const html = (
        provider as unknown as { _getEmptyGraphPanelHtml(): string }
      )._getEmptyGraphPanelHtml();
      assert.ok(
        !html.includes('No commits yet'),
        'an empty scope is a filter outcome, not a fresh repo'
      );
      assert.ok(html.includes('clearLogFilter'), 'Clear affordance offered');
    });

    it('Clear filter also resets an all-unchecked repo scope', () => {
      const repo = (rootPath: string) => ({
        rootUri: Uri.file(rootPath),
        state: 'idle' as const,
        remotes: [],
        submodules: [],
      });
      provider.setAvailableRepositories([
        repo('/workspace/repo-a'),
        repo('/workspace/repo-b'),
      ] as Parameters<typeof provider.setAvailableRepositories>[0]);
      const surface = provider as unknown as {
        _handleWebviewMessage: (m: unknown) => void;
        _getEmptyGraphPanelHtml(): string;
      };
      surface._handleWebviewMessage({ type: 'selectRepositories', roots: [] });
      surface._handleWebviewMessage({ type: 'clearLogFilter' });
      const html = surface._getEmptyGraphPanelHtml();
      assert.ok(
        html.includes('No commits yet'),
        'after Clear the scope is back to all repos — the empty list means a fresh repo again'
      );
    });

    it('the filter row offers a Jump to Commit button', () => {
      const html = (
        provider as unknown as { _getLogFilterRowHtml(): string }
      )._getLogFilterRowHtml();
      assert.ok(
        html.includes('data-action="jumpToCommit"'),
        'IntelliJ has a toolbar Find action; the filter row carries the analog button'
      );
    });

    it('a jumpToCommitRequest message executes the jump command', async () => {
      const executed: string[] = [];
      const commands = vscode.commands as unknown as {
        executeCommand: (id: string) => Promise<unknown>;
      };
      const original = commands.executeCommand;
      commands.executeCommand = async (id: string): Promise<unknown> => {
        executed.push(id);
        return undefined;
      };
      try {
        await (
          provider as unknown as { _handleWebviewMessage: (m: unknown) => Promise<void> | void }
        )._handleWebviewMessage({ type: 'jumpToCommitRequest' });
        assert.deepStrictEqual(executed, ['intellig.toolWindow.jumpToHash']);
      } finally {
        commands.executeCommand = original;
      }
    });

    it('maps a multi-author selection through to authors[] and labels the User button', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.deepStrictEqual(filter?.authors, ['Jane <j@x.com>', 'Bob <b@x.com>']);
        const html = (
          provider as unknown as { _getLogFilterRowHtml(): string }
        )._getLogFilterRowHtml();
        assert.ok(html.includes('2 users'), 'the User button summarizes the multi-selection');
        done();
      });
      applyFilter(provider, { authors: ['Jane <j@x.com>', 'Bob <b@x.com>'] });
    });

    it('drops a garbage since string (Invalid Date) so the filter collapses', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.strictEqual(filter, undefined, 'an invalid since alone collapses to no filter');
        done();
      });
      applyFilter(provider, { since: 'not-a-date' });
    });

    it('drops a garbage until string (Invalid Date) so the filter collapses', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.strictEqual(filter, undefined, 'an invalid until alone collapses to no filter');
        done();
      });
      applyFilter(provider, { until: 'garbage' });
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

    it('should preserve selected REPO (by path) — not by index — across reloads', () => {
      // The earlier contract keyed selection by INDEX. That broke the
      // common case of the gitService's repo cache reordering between
      // reloads (e.g. after a watcher tear-down + re-add on
      // reloadRepository). User dropped a commit on repo B, the
      // post-mutation reload returned [A, C, B] instead of [A, B, C],
      // and the "selected index = 1" silently pointed at C instead of B.
      // Fix: identity-stable selection by `rootUri.fsPath`.
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

      // Reload with the SAME repos but in a DIFFERENT order — the
      // selection MUST follow the repo's path, not the index.
      const reorderedRepos = [
        createMockRepository('/workspace/c'),
        createMockRepository('/workspace/a'),
        createMockRepository('/workspace/b'),
      ];
      provider.setAvailableRepositories(
        reorderedRepos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      assert.strictEqual(
        provider.getSelectedRepository()!.rootUri.fsPath,
        '/workspace/b',
        'selected repo must follow the path, NOT stay at index 1'
      );
    });

    it('falls back to the first repo when the previously-selected repo is no longer present', () => {
      // Folder removed from the workspace OR the repo's `.git` directory
      // was deleted. The previously-selected path no longer exists in
      // the new list — fall back to index 0 (the prior contract).
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
      )._handleRepositorySelection(2); // select /workspace/c
      assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/workspace/c');

      // Reload — /workspace/c is gone.
      const updatedRepos = [
        createMockRepository('/workspace/a'),
        createMockRepository('/workspace/b'),
      ];
      provider.setAvailableRepositories(
        updatedRepos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      assert.strictEqual(
        provider.getSelectedRepository()!.rootUri.fsPath,
        '/workspace/a',
        'must fall back to first repo when previous selection is gone'
      );
    });

    it('preserves the selection when the same list is supplied again (no-op reload)', () => {
      // The most common reload path: after a mutation, the discovered
      // repo list is identical to before. Selection must not flicker.
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
      )._handleRepositorySelection(1);
      assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/workspace/b');

      // Reload with the SAME list (different IRepository instances —
      // simulating a fresh fetch from gitService).
      const sameRepos = [
        createMockRepository('/workspace/a'),
        createMockRepository('/workspace/b'),
        createMockRepository('/workspace/c'),
      ];
      provider.setAvailableRepositories(
        sameRepos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      assert.strictEqual(provider.getSelectedRepository()!.rootUri.fsPath, '/workspace/b');
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
      (
        provider as unknown as { _handleRepositorySelection: (index: number) => void }
      )._handleRepositorySelection(0);

      assert.strictEqual(provider.getSelectedRepository(), undefined);
    });
  });

  describe('session persistence', () => {
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

  describe('Repository popup — multi-select scope checkboxes', () => {
    it('renders no repo checkboxes when no repositories are available', () => {
      provider.setAvailableRepositories([]);
      const html = provider._getLogFilterRowHtml();
      assert.ok(!html.includes('toggleRepoCheckbox'), 'no checkboxes with zero repos');
    });

    it('omits the Repository popup when only one repository is available', () => {
      const repos = [createMockRepository('/workspace/my-repo')];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );
      const html = provider._getLogFilterRowHtml();
      assert.ok(
        !html.includes('toggleRepoCheckbox') && !html.includes('data-popup="repo"'),
        'no Repository filter with a single repo'
      );
    });

    it('renders a checkbox per repo plus an "All repositories" reset when multiple repos exist', () => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );
      const html = provider._getLogFilterRowHtml();
      assert.ok(html.includes('data-action="toggleRepoCheckbox"'), 'has repo checkboxes');
      assert.ok(html.includes('data-repo-root="/workspace/repo-a"'), 'checkbox for repo-a');
      assert.ok(html.includes('data-repo-root="/workspace/repo-b"'), 'checkbox for repo-b');
      assert.ok(html.includes('data-action="toggleAllRepos"'), 'has the All-repositories reset');
      assert.ok(html.includes('All repositories'), 'All repositories label');
    });

    it('displays the folder name (last path segment) for each repository', () => {
      const repos = [
        createMockRepository('/workspace/frontend'),
        createMockRepository('/workspace/backend'),
        createMockRepository('/home/user/projects/shared-lib'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );
      const html = provider._getLogFilterRowHtml();
      assert.ok(html.includes('frontend'), 'shows folder name "frontend"');
      assert.ok(html.includes('backend'), 'shows folder name "backend"');
      assert.ok(html.includes('shared-lib'), 'shows folder name "shared-lib"');
    });

    it('checks only the scoped repo (and not "All repositories") in a single-repo scope', () => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
        createMockRepository('/workspace/repo-c'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );
      (
        provider as unknown as { _handleRepositorySelection: (index: number) => void }
      )._handleRepositorySelection(1);

      const html = provider._getLogFilterRowHtml();
      assert.ok(
        html.includes('data-repo-root="/workspace/repo-b" checked'),
        'scoped repo checkbox is checked'
      );
      assert.ok(
        !html.includes('data-repo-root="/workspace/repo-a" checked'),
        'unscoped repo checkbox is unchecked'
      );
      assert.ok(
        !html.includes('data-action="toggleAllRepos" checked'),
        '"All repositories" is unchecked when a concrete repo is scoped'
      );
    });

    it('checks every repo and "All repositories" when the scope is all', () => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );
      (
        provider as unknown as { _handleRepositorySelection(selection: number | 'all'): void }
      )._handleRepositorySelection('all');

      const html = provider._getLogFilterRowHtml();
      assert.ok(
        html.includes('data-action="toggleAllRepos" checked'),
        '"All repositories" is checked when scope is all'
      );
      assert.ok(html.includes('data-repo-root="/workspace/repo-a" checked'), 'repo-a checked');
      assert.ok(html.includes('data-repo-root="/workspace/repo-b" checked'), 'repo-b checked');
    });

    it('checks only the visible subset (not "All repositories") when a subset is active', () => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
        createMockRepository('/workspace/repo-c'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );
      (
        provider as unknown as { _handleVisibleRepositoriesSelection(roots: string[]): void }
      )._handleVisibleRepositoriesSelection(['/workspace/repo-a', '/workspace/repo-c']);

      const html = provider._getLogFilterRowHtml();
      assert.ok(html.includes('data-repo-root="/workspace/repo-a" checked'), 'repo-a checked');
      assert.ok(html.includes('data-repo-root="/workspace/repo-c" checked'), 'repo-c checked');
      assert.ok(
        !html.includes('data-repo-root="/workspace/repo-b" checked'),
        'repo-b (outside the subset) is unchecked'
      );
      assert.ok(
        !html.includes('data-action="toggleAllRepos" checked'),
        '"All repositories" is unchecked for a partial subset'
      );
    });

    it('escapes HTML special characters in repo folder names', () => {
      const repos = [
        createMockRepository('/workspace/repo<em>test'),
        createMockRepository('/workspace/normal-repo'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );
      const html = provider._getLogFilterRowHtml();
      assert.ok(!html.includes('<em>'), 'escapes HTML tags in folder names');
      assert.ok(html.includes('&lt;em&gt;'), 'contains the escaped tag');
    });

    it('wires repo-subset selection (selectRepositories / toggleRepoCheckbox) via the entry', () => {
      const inlineScript = ENTRY_SOURCE;
      assert.ok(
        inlineScript.includes('selectRepositories'),
        'entry posts the selectRepositories message type'
      );
      assert.ok(
        inlineScript.includes('toggleRepoCheckbox'),
        'entry handles the repo-checkbox action'
      );
      assert.ok(
        inlineScript.includes('toggleAllRepos'),
        'entry handles the All-repositories reset'
      );
    });

    it('uses no inline handlers / no second acquireVsCodeApi in the filter row HTML', () => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );
      const html = provider._getLogFilterRowHtml();
      assert.ok(!html.includes('acquireVsCodeApi'), 'no acquire in the row HTML');
      assert.ok(!/onchange=|onclick=/i.test(html), 'no inline handlers in the row HTML');
    });
  });

  describe('repository scope state', () => {
    it('exposes isAllReposSelected() reflecting the current scope', () => {
      // Pin a specific-repo starting scope (the merged-default is exercised by
      // the seeding tests); this test verifies the toggle, not the default.
      setMockConfigValue('intellig', 'log.showAllRoots', false);
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );
      const surface = provider as unknown as {
        _handleRepositorySelection(selection: number | 'all'): void;
        isAllReposSelected(): boolean;
      };

      // Explicit config-off → specific repo scope.
      assert.strictEqual(surface.isAllReposSelected(), false);

      surface._handleRepositorySelection('all');
      assert.strictEqual(surface.isAllReposSelected(), true);

      surface._handleRepositorySelection(0);
      assert.strictEqual(surface.isAllReposSelected(), false);
      setMockConfigValue('intellig', 'log.showAllRoots', undefined);
    });

    it('keeps getSelectedRepository() returning a concrete context repo even in all scope', () => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );
      (
        provider as unknown as { _handleRepositorySelection(selection: number | 'all'): void }
      )._handleRepositorySelection('all');

      const ctx = provider.getSelectedRepository();
      assert.ok(ctx, 'all scope still resolves a context repo for single-repo operations');
      assert.strictEqual(ctx.rootUri.fsPath, '/workspace/repo-a', 'context repo is the first repo');
    });

    it('fires onDidChangeRepositoryScope with kind=all when all is selected', (done) => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const sub = (
        provider as unknown as {
          onDidChangeRepositoryScope: (l: (s: { kind: string }) => void) => { dispose(): void };
        }
      ).onDidChangeRepositoryScope((scope) => {
        sub.dispose();
        assert.strictEqual(scope.kind, 'all');
        done();
      });

      (
        provider as unknown as { _handleRepositorySelection(selection: number | 'all'): void }
      )._handleRepositorySelection('all');
    });

    it('fires onDidChangeRepositoryScope with kind=repository carrying the chosen repo', (done) => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const sub = (
        provider as unknown as {
          onDidChangeRepositoryScope: (
            l: (s: { kind: string; repository?: { rootUri: { fsPath: string } } }) => void
          ) => { dispose(): void };
        }
      ).onDidChangeRepositoryScope((scope) => {
        sub.dispose();
        assert.strictEqual(scope.kind, 'repository');
        assert.strictEqual(scope.repository!.rootUri.fsPath, '/workspace/repo-b');
        done();
      });

      (
        provider as unknown as { _handleRepositorySelection(selection: number | 'all'): void }
      )._handleRepositorySelection(1);
    });
  });

  describe('repository scope collapse on repo-set shrink', () => {
    type ScopeEvent = { kind: string; repository?: { rootUri: { fsPath: string } } };

    function scopeSurface(): {
      _handleRepositorySelection(selection: number | 'all'): void;
      onDidChangeRepositoryScope: (l: (s: ScopeEvent) => void) => { dispose(): void };
    } {
      return provider as unknown as {
        _handleRepositorySelection(selection: number | 'all'): void;
        onDidChangeRepositoryScope: (l: (s: ScopeEvent) => void) => { dispose(): void };
      };
    }

    function setRepos(...paths: string[]): void {
      provider.setAvailableRepositories(
        paths.map((p) => createMockRepository(p)) as Parameters<
          typeof provider.setAvailableRepositories
        >[0]
      );
    }

    it('fires onDidChangeRepositoryScope once with the surviving repo when all-scope collapses to one repo', () => {
      const surface = scopeSurface();
      setRepos('/workspace/repo-a', '/workspace/repo-b');
      surface._handleRepositorySelection('all');

      // Subscribe AFTER entering all-scope so the selection event isn't counted.
      const events: ScopeEvent[] = [];
      const sub = surface.onDidChangeRepositoryScope((s) => events.push(s));

      // Workspace drops from two repos to one — the merged 'all' scope must
      // collapse to the single surviving repo and re-route eagerly.
      setRepos('/workspace/repo-a');
      sub.dispose();

      assert.strictEqual(events.length, 1, 'collapse must emit exactly one scope event');
      assert.strictEqual(events[0].kind, 'repository', 'collapsed scope routes to a single repo');
      assert.strictEqual(
        events[0].repository!.rootUri.fsPath,
        '/workspace/repo-a',
        'the scope event carries the surviving repo'
      );
    });

    it('does not fire a scope event when the all scope is preserved across a multi-repo reload', () => {
      const surface = scopeSurface();
      setRepos('/workspace/repo-a', '/workspace/repo-b');
      surface._handleRepositorySelection('all');

      const events: ScopeEvent[] = [];
      const sub = surface.onDidChangeRepositoryScope((s) => events.push(s));

      // Still more than one repo → scope stays 'all', so no collapse.
      setRepos('/workspace/repo-a', '/workspace/repo-c');
      sub.dispose();

      assert.strictEqual(events.length, 0, 'a preserved all scope must not emit a scope event');
    });

    it('does not fire a scope event when an already single-repo scope shrinks to one repo', () => {
      const surface = scopeSurface();
      // Pin an explicit specific-repo scope (not 'all') for this mechanics test.
      setMockConfigValue('intellig', 'log.showAllRoots', false);
      setRepos('/workspace/repo-a', '/workspace/repo-b');

      const events: ScopeEvent[] = [];
      const sub = surface.onDidChangeRepositoryScope((s) => events.push(s));

      setRepos('/workspace/repo-a');
      sub.dispose();

      assert.strictEqual(
        events.length,
        0,
        'a non-all scope shrinking the repo set is not a collapse and must not emit'
      );
      setMockConfigValue('intellig', 'log.showAllRoots', undefined);
    });
  });

  describe('the entry posts the repo-checkbox subset (Repository popup)', () => {
    it('collects the checked repo roots and posts a selectRepositories message', () => {
      const inlineScript = ENTRY_SOURCE;

      assert.ok(
        inlineScript.includes("type: 'selectRepositories'"),
        'entry must post the selectRepositories message'
      );
      assert.ok(
        inlineScript.includes('input[data-repo-root]'),
        'entry must read the repo-root checkboxes'
      );
      assert.ok(
        inlineScript.includes('toggleAllRepos'),
        'entry must mirror the All-repositories reset onto every checkbox'
      );
    });
  });

  describe('getRepoRootForCommit — per-commit source repo for the merged (all-roots) log', () => {
    function mergedCommit(hash: string, repoRoot?: string) {
      return {
        hash,
        shortHash: hash.slice(0, 7),
        message: `commit ${hash}`,
        author: { name: 'T', email: 't@t.com' },
        committer: { name: 'T', email: 't@t.com' },
        parents: [],
        authorDate: new Date(),
        commitDate: new Date(),
        repoRoot,
      };
    }

    it('returns the source repo root recorded for each merged commit', () => {
      provider.updateLogState([
        mergedCommit('aaaaaaa', '/work/alpha'),
        mergedCommit('bbbbbbb', '/work/beta'),
      ]);
      assert.strictEqual(provider.getRepoRootForCommit('aaaaaaa'), '/work/alpha');
      assert.strictEqual(provider.getRepoRootForCommit('bbbbbbb'), '/work/beta');
    });

    it('returns undefined for an untagged commit (single-repo / specific-scope log)', () => {
      provider.updateLogState([mergedCommit('ccccccc')]);
      assert.strictEqual(provider.getRepoRootForCommit('ccccccc'), undefined);
    });

    it('returns undefined for a hash not present in the rendered log', () => {
      provider.updateLogState([mergedCommit('aaaaaaa', '/work/alpha')]);
      assert.strictEqual(provider.getRepoRootForCommit('zzzzzzz'), undefined);
    });

    it('drops stale mappings when the log is replaced (no leak across reloads)', () => {
      provider.updateLogState([mergedCommit('aaaaaaa', '/work/alpha')]);
      provider.updateLogState([mergedCommit('bbbbbbb', '/work/beta')]);
      assert.strictEqual(provider.getRepoRootForCommit('aaaaaaa'), undefined);
      assert.strictEqual(provider.getRepoRootForCommit('bbbbbbb'), '/work/beta');
    });

    // undoCommit stays functional in merged scope even though the single-repo
    // HEAD spine / highlight is suppressed (headHash omitted): the per-root
    // HEAD set drives the enable rule for the clicked commit's own-repo HEAD.
    function postedMenuState(): Record<string, { enabled: boolean }> | undefined {
      const posted: Array<{ type?: string; state?: Record<string, { enabled: boolean }> }> = [];
      (provider as unknown as { _view: unknown })._view = {
        webview: {
          postMessage: (m: { type?: string; state?: Record<string, { enabled: boolean }> }) => {
            posted.push(m);
            return Promise.resolve(true);
          },
        },
      };
      (provider as unknown as { _postMenuStateUpdate: () => void })._postMenuStateUpdate();
      return posted.find((m) => m.type === 'updateMenuEnableState')?.state;
    }

    it('enables undoCommit for a root HEAD in merged scope despite the suppressed single headHash', () => {
      // Merged load: headHash omitted (spine/highlight suppressed). 'bbbbbbb'
      // is repo beta's HEAD, recorded via the per-root set.
      provider.updateLogState([
        mergedCommit('aaaaaaa', '/work/alpha'),
        mergedCommit('bbbbbbb', '/work/beta'),
      ]);
      provider.setMergedHeadCommitHashes(['bbbbbbb']);
      (
        provider as unknown as { _extendedLogState: { selectedCommits: Set<string> } }
      )._extendedLogState.selectedCommits = new Set(['bbbbbbb']);

      const state = postedMenuState();
      assert.ok(state, 'a menu-enable-state message should be posted');
      assert.strictEqual(
        state.undoCommit.enabled,
        true,
        "undoCommit must stay enabled for the clicked commit's own-repo HEAD in merged scope"
      );
    });

    it('keeps undoCommit disabled in merged scope for a commit that is no root HEAD', () => {
      provider.updateLogState([
        mergedCommit('aaaaaaa', '/work/alpha'),
        mergedCommit('bbbbbbb', '/work/beta'),
      ]);
      provider.setMergedHeadCommitHashes(['bbbbbbb']);
      (
        provider as unknown as { _extendedLogState: { selectedCommits: Set<string> } }
      )._extendedLogState.selectedCommits = new Set(['aaaaaaa']);

      const state = postedMenuState();
      assert.ok(state, 'a menu-enable-state message should be posted');
      assert.strictEqual(state.undoCommit.enabled, false);
    });
  });

  describe('_getGraphPanelHtml Repository-popup scope integration', () => {
    it('should include Repository-popup repo checkboxes in graph panel when multiple repos exist', () => {
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
        graphHtml.includes('toggleRepoCheckbox'),
        'Graph panel should include Repository-popup repo checkboxes'
      );
      assert.ok(graphHtml.includes('repo-a'), 'Should show repo-a folder name');
      assert.ok(graphHtml.includes('repo-b'), 'Should show repo-b folder name');
    });

    it('should not include repo checkboxes in graph panel when only one repo exists', () => {
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
        !graphHtml.includes('toggleRepoCheckbox'),
        'Graph panel should not include repo checkboxes for a single repo'
      );
    });

    it('should not include repo checkboxes in graph panel when no repos exist', () => {
      provider.setAvailableRepositories([]);

      const graphHtml = provider._getGraphPanelHtml([]);
      assert.ok(
        !graphHtml.includes('toggleRepoCheckbox'),
        'Graph panel should not include repo checkboxes with no repos'
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

  describe('chip icon color — validated before inlining into the style attribute', () => {
    it('inlines a valid hex color', () => {
      const node = makeNode(['main']);
      const colors = new Map([[node.commit.hash, '#aabbcc']]);
      const html = provider._getBranchLabelsHtml(node, colors);
      assert.ok(html.includes('style="color:#aabbcc"'), 'a valid hex color is inlined');
    });

    it('drops a non-hex color so it cannot inject into the style attribute', () => {
      const node = makeNode(['main']);
      const colors = new Map([[node.commit.hash, 'red;"></span><script>x</script>']]);
      const html = provider._getBranchLabelsHtml(node, colors);
      assert.ok(!html.includes('<script>'), 'a malicious value must not reach the output');
      assert.ok(!html.includes('style="color:red'), 'a non-hex color must not be inlined');
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

    it('collapses chips beyond MAX_INLINE_BRANCH_CHIPS into a +N summary chip', () => {
      // 4 branches at the same commit. The first 3 render inline (cap:
      // MAX_INLINE_BRANCH_CHIPS = 3); the remaining 1 collapses into a
      // single `+1` summary chip with the name available via
      // title=tooltip + data-collapsed-branches.
      const node = makeNode(['main', 'develop', 'origin/main', 'origin/develop']);
      const html = provider._getBranchLabelsHtml(node);

      // Inline: main + develop + origin/main.
      const inlineCount =
        (html.match(/branch-label-local/g) || []).length +
        (html.match(/branch-label-remote/g) || []).length;
      assert.strictEqual(inlineCount, 3, 'Three inline chips (cap: MAX_INLINE_BRANCH_CHIPS = 3)');
      assert.ok(html.includes('data-branch-name="main"'), 'first branch must render inline');
      assert.ok(html.includes('data-branch-name="develop"'), 'second branch must render inline');
      assert.ok(html.includes('data-branch-name="origin/main"'), 'third branch must render inline');

      // Collapsed summary chip carries the rest.
      const summaryMatch = html.match(/<span class="branch-label-collapsed"[^>]*>\+(\d+)</);
      assert.ok(summaryMatch, 'a +N summary chip must be rendered');
      assert.strictEqual(summaryMatch[1], '1', 'summary count must be 1 (the collapsed branch)');
      assert.ok(
        html.includes('data-collapsed-branches="[&quot;origin/develop&quot;]"'),
        'collapsed branch names must be carried as a JSON array in data-collapsed-branches'
      );
      assert.ok(
        html.includes('title="origin/develop"'),
        'tooltip must list the collapsed branch name so the user can discover it on hover'
      );
    });

    it('JSON-encodes a collapsed branch name containing a pipe (issue #23)', () => {
      // A branch name containing '|' must round-trip: the collapsed-ref
      // attribute carries it as JSON so the popup handler parses it as a
      // single ref, not two. `feat|x` is the 4th branch → it collapses.
      const node = makeNode(['main', 'develop', 'origin/main', 'feat|x']);
      const html = provider._getBranchLabelsHtml(node);

      // The name rides inside a JSON array; the literal pipe survives.
      assert.ok(
        html.includes('data-collapsed-branches="[&quot;feat|x&quot;]"'),
        'a pipe-bearing name must be JSON-encoded (single-element array), pipe intact'
      );
    });

    it('renders all chips inline when count is at the collapse threshold', () => {
      // Three refs all render inline (MAX_INLINE_BRANCH_CHIPS = 3); no
      // summary chip until the FOURTH ref.
      const node = makeNode(['main', 'develop', 'origin/main']);
      const html = provider._getBranchLabelsHtml(node);

      assert.ok(html.includes('data-branch-name="main"'));
      assert.ok(html.includes('data-branch-name="develop"'));
      assert.ok(html.includes('data-branch-name="origin/main"'));
      assert.ok(
        !html.includes('branch-label-collapsed'),
        'no summary chip when count <= MAX_INLINE_BRANCH_CHIPS'
      );
    });

    it('renders the collapsed +N chip as an interactive button (popup affordance)', () => {
      // The collapsed chip opens a clickable ref popup, so it must be a
      // keyboard-activatable button (WCAG 1.4.1 — interaction not
      // colour-only): role="button" + tabindex="0" + aria-haspopup, and
      // it must carry the JSON-encoded data-collapsed-branches the popup
      // handler consumes.
      const node = makeNode(['main', 'develop', 'origin/main', 'origin/develop']);
      const html = provider._getBranchLabelsHtml(node);
      const chipMatch = html.match(/<span class="branch-label-collapsed"[^>]*>/);
      assert.ok(chipMatch, 'collapsed chip is rendered');
      const chip = chipMatch[0];
      assert.ok(chip.includes('role="button"'), 'collapsed chip must be role="button"');
      assert.ok(chip.includes('tabindex="0"'), 'collapsed chip must be keyboard-focusable');
      assert.ok(chip.includes('aria-haspopup="true"'), 'collapsed chip advertises a popup');
      assert.ok(
        chip.includes('data-collapsed-branches="[&quot;origin/develop&quot;]"'),
        'collapsed chip carries the JSON-encoded ref list the popup consumes'
      );
      assert.ok(
        !chip.includes('role="img"'),
        'collapsed chip is no longer a decorative role="img"'
      );
    });

    it('never hides a lone non-current branch behind a bare +1', () => {
      // The original bug: a single non-current tip collapsed into "+1".
      // A lone branch must ALWAYS show its name — one chip is never past
      // the cap.
      const node = makeNode(['origin/feature']);
      const html = provider._getBranchLabelsHtml(node);

      assert.ok(
        html.includes('data-branch-name="origin/feature"'),
        'a lone branch must render its name inline, never as a bare +1'
      );
      assert.ok(
        !html.includes('branch-label-collapsed'),
        'a lone branch must NOT produce a +N summary chip'
      );
    });

    it('keeps the focused branch visible inline even when it would otherwise be collapsed', () => {
      // Focus is set on the FIFTH branch — without the focus-pin, it
      // would land in the +N collapse. Privileged refs sort to the front
      // of the inline set so the user always sees the focused chip.
      const node = makeNode(['main', 'develop', 'origin/main', 'origin/develop', 'feature/x']);
      const internals = provider as unknown as { _extendedLogState: { focusedBranchName: string } };
      internals._extendedLogState.focusedBranchName = 'feature/x';
      const html = provider._getBranchLabelsHtml(node);

      assert.ok(
        html.includes('data-branch-name="feature/x"'),
        'focused branch must render inline despite being beyond the cap'
      );
      assert.ok(html.includes('branch-label-focused'), 'focused chip must carry the focused class');
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

    it('renders a remote branch using the same git-branch icon as local chips', () => {
      // Per UX request, local and remote chips share the same
      // codicon-git-branch icon. The ref kind is still distinguishable
      // via the CSS class (`branch-label-remote`) and the aria-label
      // ("Remote branch: …") — only the visual icon is unified.
      const node = makeNode([{ name: 'origin/main', type: 'remote' }]);
      const html = provider._getBranchLabelsHtml(node);

      assert.ok(
        html.includes('codicon-git-branch'),
        'remote `origin/main` must use codicon-git-branch (same as local chips)'
      );
      assert.ok(
        !html.includes('codicon-cloud'),
        'remote `origin/main` must NOT use codicon-cloud (icon was unified with local)'
      );
      assert.ok(
        html.includes('branch-label-remote'),
        'remote `origin/main` must use branch-label-remote (CSS still differentiates ref kind)'
      );
      assert.ok(
        html.includes('aria-label="Remote branch: origin/main"'),
        'remote `origin/main` must carry the "Remote branch:" aria-label (SR still hears the kind)'
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
      // Both chips now use the same codicon-git-branch icon.
      assert.strictEqual(
        (html.match(/codicon-git-branch/g) || []).length,
        2,
        'two git-branch icons (one per chip; local and remote share the icon)'
      );
      assert.strictEqual(
        (html.match(/codicon-cloud/g) || []).length,
        0,
        'no cloud icons (was previously the remote icon; unified to git-branch)'
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
      // Option C: chips are a neutral badge with foreground text; the branch
      // color rides on the icon (inline). No hardcoded green fill, no white-on-fill.
      assert.ok(
        !html.includes('background: #499C54'),
        'the old hardcoded local-green background must be gone'
      );
      assert.ok(
        /\.branch-label-local\s*,\s*\.branch-label-remote\s*\{[^}]*background:\s*var\(--vscode-badge-background/i.test(
          html
        ),
        'Local/remote chips must use a neutral badge background'
      );
      assert.ok(
        /\.branch-label-local\s*,\s*\.branch-label-remote\s*\{[^}]*color:\s*var\(--vscode-foreground/i.test(
          html
        ),
        'Local/remote chips must use the theme foreground text'
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
      // Remote chips also take their background inline from the branch color;
      // there is no hardcoded violet.
      assert.ok(
        !/background:\s*#9876AA/i.test(html),
        'the old hardcoded remote-violet background must be gone (color is inline now)'
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

      // Both classes share the same sizing/spacing properties. Font size now
      // follows the editor font (var(--vscode-font-size)) so chips scale with it.
      assert.ok(
        /\.branch-label-local\s*,\s*\.branch-label-remote\s*\{[^}]*font-size:\s*var\(--vscode-font-size\)/.test(
          html
        ),
        'branch labels should use var(--vscode-font-size)'
      );
      assert.ok(html.includes('padding: 1px 5px'), 'Should include padding 1px 5px');
      assert.ok(html.includes('border-radius: 3px'), 'Should include border-radius 3px');
      assert.ok(html.includes('margin-left: 4px'), 'Should include margin-left 4px');
    });

    it('collapsed chip is clickable (cursor:pointer) and the #ref-popup overlay is rendered', () => {
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

      // The collapsed chip is now a click target, not a help cursor.
      assert.ok(
        /\.branch-label-collapsed[\s\S]*?cursor:\s*pointer/.test(html),
        'collapsed chip must use cursor:pointer (clickable popup affordance)'
      );
      assert.ok(
        !/\.branch-label-collapsed[\s\S]*?cursor:\s*help/.test(html),
        'the dead-end cursor:help must be gone'
      );
      // The popup overlay element ships in the panel markup.
      assert.ok(
        html.includes('id="ref-popup"'),
        'the #ref-popup overlay element must be rendered for the collapsed-chip popup'
      );
    });
  });

  describe('webview document acquires the VS Code API once', () => {
    function mockWebview(): Webview {
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
     * Count inline `acquireVsCodeApi(` call sites in the assembled document.
     * All tool-window client code now ships as the external `gitToolWindow.js`
     * bundle, so the document itself must carry ZERO inline acquire — a non-zero
     * count means an inline `<script>` (a sibling that would double-acquire and
     * throw) crept back into the provider's HTML assembly. Comments are stripped
     * first (URL-safe, so the `https://` in the CSP is not read as a comment).
     */
    function inlineAcquireCount(documentHtml: string): number {
      const code = documentHtml
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      return (code.match(/acquireVsCodeApi\s*\(/g) ?? []).length;
    }

    it('log-active document carries no inline acquireVsCodeApi (client is the bundle)', () => {
      setMockConfigValue('intellig', 'useTabbedGitToolWindow', true);
      const html = provider._getThreePanelHtmlContent(mockWebview(), []);
      assert.strictEqual(
        inlineAcquireCount(html),
        0,
        'the log-active document must ship its client code as the external bundle only'
      );
    });

    it('history-active document carries no inline acquireVsCodeApi (client is the bundle)', async () => {
      setMockConfigValue('intellig', 'useTabbedGitToolWindow', true);
      await (
        provider as unknown as { _tabRouter: { setActiveTab: (t: string) => Promise<void> } }
      )._tabRouter.setActiveTab('history');
      const html = provider._getThreePanelHtmlContent(mockWebview(), []);
      assert.strictEqual(
        inlineAcquireCount(html),
        0,
        'the history-active document must ship its client code as the external bundle only'
      );
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
        onDidFetch: () => ({ dispose: () => {} }),
        getRepositories: () => repos,
      } as unknown as IGitService;
      return { service, fire: (r: IRepository) => emitter.fire(r) };
    }

    /**
     * Seed a parsed-remote cache entry for `repo` as-if `_getSelectedRepoRemote`
     * had run against it. Local to this suite (not on the production class)
     * per docs/testing.md section 3. Writes directly to `_parsedRemoteCache` — the
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

// ---------------------------------------------------------------------------
// GPG signature column (G5) — _getGraphPanelHtml integration via provider
// ---------------------------------------------------------------------------

/**
 * Build a minimal ICommit-shaped object with an optional gpgStatus field.
 * Used in the GPG column tests to call provider.updateLogState + _getGraphPanelHtml.
 */
function makeGpgCommit(
  gpgStatus?: string
): Parameters<typeof GitToolWindowProvider.prototype.updateLogState>[0][0] {
  return {
    hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    shortHash: 'aaaaaaa',
    message: 'test commit',
    author: { name: 'Alice', email: 'alice@example.com' },
    committer: { name: 'Alice', email: 'alice@example.com' },
    parents: [],
    authorDate: new Date('2024-01-01T12:00:00Z'),
    commitDate: new Date('2024-01-01T12:00:00Z'),
    gpgStatus,
  } as Parameters<typeof GitToolWindowProvider.prototype.updateLogState>[0][0];
}

describe('GPG signature column (G5) — _getGraphPanelHtml', () => {
  let gpgProvider: GitToolWindowProvider;

  beforeEach(() => {
    gpgProvider = new GitToolWindowProvider(Uri.file('/test/extension'));
    gpgProvider.setHasRepository(true);
  });

  afterEach(() => {
    gpgProvider.dispose();
    // Reset the intellig.log.showGpgColumn mock value so tests don't bleed.
    setMockConfigValue('intellig', 'log.showGpgColumn', undefined);
  });

  it('does NOT render a GPG cell when showGpgColumn setting is false (the default)', () => {
    setMockConfigValue('intellig', 'log.showGpgColumn', false);
    gpgProvider.updateLogState([makeGpgCommit('G')]);
    const html = gpgProvider._getGraphPanelHtml(gpgProvider.getExtendedLogState().commitNodes);
    assert.ok(
      !html.includes('log-gpg-status'),
      'GPG cell must be absent when intellig.log.showGpgColumn is false'
    );
  });

  it('renders a GPG cell with "✓" when showGpgColumn is true and gpgStatus is "G"', () => {
    setMockConfigValue('intellig', 'log.showGpgColumn', true);
    gpgProvider.updateLogState([makeGpgCommit('G')]);
    const html = gpgProvider._getGraphPanelHtml(gpgProvider.getExtendedLogState().commitNodes);
    assert.ok(
      html.includes('log-gpg-status'),
      'GPG cell must be present when intellig.log.showGpgColumn is true'
    );
    assert.ok(html.includes('log-gpg-valid'), 'GPG valid CSS class must be present for status "G"');
    assert.ok(html.includes('✓'), 'GPG cell must render "✓" for a valid signature');
  });
});

describe('pushUpToCommit — commit context menu wiring (Gap B)', () => {
  let p: GitToolWindowProvider;
  beforeEach(() => {
    p = new GitToolWindowProvider(Uri.file('/test/extension'));
  });
  afterEach(() => {
    p.dispose();
  });

  it('commit-context-menu HTML includes a "Push All up to Here…" item with data-action="pushUpToCommit"', () => {
    const html = p._getCommitContextMenuHtml();
    assert.ok(
      /data-action="pushUpToCommit"/.test(html),
      'Commit context menu must include a pushUpToCommit action item'
    );
    assert.ok(
      /Push All up to Here/i.test(html),
      'Item label must say "Push All up to Here" (IntelliJ Git.PushUpToCommit)'
    );
  });

  it('commitContextMenu webview message with action pushUpToCommit fires onDidRequestLogContextAction', (done) => {
    // Seed a commit node so the staleness check in _handleCommitContextMenu passes.
    const hash = 'aabbccddeeff1122aabbccddeeff1122aabbccdd';
    (
      p as unknown as {
        _extendedLogState: {
          commitNodes: Array<{ commit: { hash: string; message: string; parents: string[] } }>;
        };
      }
    )._extendedLogState.commitNodes = [{ commit: { hash, message: 'test commit', parents: [] } }];

    const disposable = p.onDidRequestLogContextAction((event) => {
      disposable.dispose();
      assert.strictEqual(event.action, 'pushUpToCommit', 'action must be pushUpToCommit');
      assert.deepStrictEqual(event.commitHashes, [hash]);
      done();
    });

    (p as unknown as { _handleWebviewMessage: (msg: unknown) => void })._handleWebviewMessage({
      type: 'commitContextMenu',
      action: 'pushUpToCommit',
      commitHashes: [hash],
    });
  });
});

describe('goToParent/goToChild — commit context menu wiring (G9)', () => {
  let p: GitToolWindowProvider;
  beforeEach(() => {
    p = new GitToolWindowProvider(Uri.file('/test/extension'));
  });
  afterEach(() => {
    p.dispose();
  });

  it('commit-context-menu HTML includes a "Go to Parent" item with data-action="goToParent"', () => {
    const html = p._getCommitContextMenuHtml();
    assert.ok(
      /data-action="goToParent"/.test(html),
      'Commit context menu must include a goToParent action item'
    );
    assert.ok(/[Gg]o to [Pp]arent/.test(html), 'Item label must say "Go to Parent"');
  });

  it('commit-context-menu HTML includes a "Go to Child" item with data-action="goToChild"', () => {
    const html = p._getCommitContextMenuHtml();
    assert.ok(
      /data-action="goToChild"/.test(html),
      'Commit context menu must include a goToChild action item'
    );
    assert.ok(/[Gg]o to [Cc]hild/.test(html), 'Item label must say "Go to Child"');
  });

  it('goToParent and goToChild are rendered and gated single-only (hidden at N>=2)', () => {
    const html = p._getCommitContextMenuHtml();
    assert.ok(html.includes('data-action="goToParent"'), 'goToParent item must be present');
    assert.ok(html.includes('data-action="goToChild"'), 'goToChild item must be present');
    assert.strictEqual(computeMenuVisibility(2).goToParent, false, 'goToParent hidden in multi');
    assert.strictEqual(computeMenuVisibility(2).goToChild, false, 'goToChild hidden in multi');
  });
});

describe('_isShowAllRootsEnabled (G8) — now derives from the repository scope', () => {
  let p: GitToolWindowProvider;

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

  function twoRepos(): Parameters<GitToolWindowProvider['setAvailableRepositories']>[0] {
    return [
      createMockRepository('/workspace/a'),
      createMockRepository('/workspace/b'),
    ] as Parameters<GitToolWindowProvider['setAvailableRepositories']>[0];
  }

  beforeEach(() => {
    p = new GitToolWindowProvider(Uri.file('/test/extension'));
    // Reset the config value between tests so settings don't bleed.
    setMockConfigValue('intellig', 'log.showAllRoots', undefined);
  });

  afterEach(() => {
    p.dispose();
    setMockConfigValue('intellig', 'log.showAllRoots', undefined);
  });

  it('seeds the scope to all when showAllRoots config is true and >1 repo exists', () => {
    setMockConfigValue('intellig', 'log.showAllRoots', true);
    p.setAvailableRepositories(twoRepos());
    const enabled = (
      p as unknown as { _isShowAllRootsEnabled(): boolean }
    )._isShowAllRootsEnabled();
    assert.strictEqual(enabled, true, 'config-seeded all scope must report all-roots enabled');
  });

  it('seeds the scope to all by DEFAULT (config unset) when >1 repo exists', () => {
    // Default flipped to true so the graph matches the branch tree, which is
    // always 'all' by default. Config unset → the `.get(..., true)` default.
    setMockConfigValue('intellig', 'log.showAllRoots', undefined);
    p.setAvailableRepositories(twoRepos());
    const enabled = (
      p as unknown as { _isShowAllRootsEnabled(): boolean }
    )._isShowAllRootsEnabled();
    assert.strictEqual(
      enabled,
      true,
      'default (unset) scope must be the merged all-roots view in a multi-repo workspace'
    );
  });

  it('seeds the scope to a specific repo when showAllRoots config is EXPLICITLY false', () => {
    setMockConfigValue('intellig', 'log.showAllRoots', false);
    p.setAvailableRepositories(twoRepos());
    const enabled = (
      p as unknown as { _isShowAllRootsEnabled(): boolean }
    )._isShowAllRootsEnabled();
    assert.strictEqual(
      enabled,
      false,
      'explicit config-off must scope to a single repo, not the merged view'
    );
  });

  it('promotes to the merged all-roots default when a SECOND repo arrives later (incremental discovery)', () => {
    // Repro for the multi-repo discovery race: GitService loads workspace
    // folders one at a time, so the FIRST setAvailableRepositories call can
    // carry a single repo. The default must not lock to single-repo just
    // because only one was known at first paint — once the rest arrive the
    // merged view is still the right default (no explicit user choice yet).
    setMockConfigValue('intellig', 'log.showAllRoots', undefined);
    const surface = p as unknown as { _isShowAllRootsEnabled(): boolean };

    p.setAvailableRepositories([createMockRepository('/workspace/a')] as Parameters<
      GitToolWindowProvider['setAvailableRepositories']
    >[0]);
    assert.strictEqual(
      surface._isShowAllRootsEnabled(),
      false,
      'a single discovered repo is not a merged view'
    );

    p.setAvailableRepositories(twoRepos());
    assert.strictEqual(
      surface._isShowAllRootsEnabled(),
      true,
      'once a second repo is discovered the default becomes the merged all-roots view'
    );
  });

  it('does NOT override an explicit single-repo choice when more repos arrive later', () => {
    setMockConfigValue('intellig', 'log.showAllRoots', undefined);
    const surface = p as unknown as {
      _handleRepositorySelection(selection: number | 'all'): void;
      _isShowAllRootsEnabled(): boolean;
    };

    p.setAvailableRepositories(twoRepos());
    surface._handleRepositorySelection(1); // user explicitly picks a single repo
    assert.strictEqual(surface._isShowAllRootsEnabled(), false, 'explicit single choice');

    // A third repo is discovered — the explicit choice must survive.
    p.setAvailableRepositories([
      createMockRepository('/workspace/a'),
      createMockRepository('/workspace/b'),
      createMockRepository('/workspace/c'),
    ] as Parameters<GitToolWindowProvider['setAvailableRepositories']>[0]);
    assert.strictEqual(
      surface._isShowAllRootsEnabled(),
      false,
      'a later discovery must not clobber the user’s explicit single-repo choice'
    );
  });

  it('tracks the runtime scope: selecting "all" enables, selecting a repo disables — regardless of config', () => {
    // Config stays false; the selector becomes the runtime source of truth.
    setMockConfigValue('intellig', 'log.showAllRoots', false);
    p.setAvailableRepositories(twoRepos());
    const surface = p as unknown as {
      _handleRepositorySelection(selection: number | 'all'): void;
      _isShowAllRootsEnabled(): boolean;
    };

    surface._handleRepositorySelection('all');
    assert.strictEqual(
      surface._isShowAllRootsEnabled(),
      true,
      'picking All enables the merged view'
    );

    surface._handleRepositorySelection(1);
    assert.strictEqual(
      surface._isShowAllRootsEnabled(),
      false,
      'picking a specific repo disables the merged view'
    );
  });
});
