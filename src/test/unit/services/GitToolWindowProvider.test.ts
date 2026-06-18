/**
 * Unit tests for GitToolWindowProvider
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../ui-shell/GitToolWindowProvider';
import { EventEmitter, Uri, Webview, setMockConfigValue } from '../../mocks/vscode';
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

  describe('_getLogFilterBarHtml (#5 filter-bar UI)', () => {
    it('emits the filter bar with the five wired inputs', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(html.includes('id="log-filter-bar"'), 'has filter bar container');
      assert.ok(html.includes('id="filter-search"'), 'has search input');
      assert.ok(html.includes('id="filter-author"'), 'has author input');
      assert.ok(html.includes('id="filter-path"'), 'has path input');
      assert.ok(html.includes('id="filter-since"'), 'has since input');
      assert.ok(html.includes('id="filter-until"'), 'has until input');
    });

    it('emits regex (.*) and match-case (Aa) toggle buttons next to the search input', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(html.includes('id="filter-search-regex"'), 'has regex toggle');
      assert.ok(html.includes('id="filter-search-case"'), 'has match-case toggle');
      assert.ok(html.includes('data-action="toggleSearchRegex"'), 'regex toggle wired');
      assert.ok(html.includes('data-action="toggleSearchCase"'), 'match-case toggle wired');
      // The toggles sit after the search input (same group).
      assert.ok(
        html.indexOf('id="filter-search"') < html.indexOf('id="filter-search-regex"'),
        'search input precedes the regex toggle'
      );
    });

    it('marks the toggles inactive (aria-pressed=false) when no filter is set', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(
        /id="filter-search-regex"[^>]*aria-pressed="false"/.test(html),
        'regex toggle starts unpressed'
      );
      assert.ok(
        /id="filter-search-case"[^>]*aria-pressed="false"/.test(html),
        'match-case toggle starts unpressed'
      );
    });

    it('reflects searchRegex/searchCaseSensitive filter state in aria-pressed + active class', () => {
      provider.setLogFilter({
        searchText: 'token',
        searchRegex: true,
        searchCaseSensitive: true,
      });
      const html = provider._getLogFilterBarHtml();
      assert.ok(
        /id="filter-search-regex"[^>]*aria-pressed="true"/.test(html),
        'regex toggle pressed when searchRegex is set'
      );
      assert.ok(
        /id="filter-search-case"[^>]*aria-pressed="true"/.test(html),
        'match-case toggle pressed when searchCaseSensitive is set'
      );
      assert.ok(html.includes('class="log-filter-toggle-btn active"'), 'active class applied');
    });

    it('wires Apply/Clear via data-action (CSP blocks inline onclick)', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(html.includes('data-action="applyLogFilter"'), 'apply uses data-action');
      assert.ok(html.includes('data-action="clearLogFilter"'), 'clear uses data-action');
      assert.ok(!/onclick=/i.test(html), 'no inline onclick handlers');
      assert.ok(!/onkeyup=|onkeydown=/i.test(html), 'no inline key handlers');
    });

    it('is hidden until toggled open', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(/id="log-filter-bar"[^>]*\shidden/.test(html), 'filter bar starts hidden');
    });

    it('rehydrates the inputs from an active filter so a re-render keeps the values', () => {
      provider.setLogFilter({ author: 'Jane Smith', searchText: 'refactor', path: 'src/' });
      const html = provider._getLogFilterBarHtml();
      assert.ok(html.includes('value="Jane Smith"'), 'author value rehydrated');
      assert.ok(html.includes('value="refactor"'), 'search value rehydrated');
      assert.ok(html.includes('value="src/"'), 'path value rehydrated');
    });

    it('escapes filter values to prevent attribute-injection', () => {
      provider.setLogFilter({ searchText: '"><img src=x>' });
      const html = provider._getLogFilterBarHtml();
      assert.ok(!html.includes('"><img src=x>'), 'raw injection payload not present');
      assert.ok(html.includes('&quot;&gt;&lt;img'), 'value is HTML-escaped');
    });

    it('emits a toolbar toggle button wired to toggleLogFilters', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(html.includes('data-action="toggleLogFilters"'), 'toggle button present');
    });

    it('emits a datalist-backed branch input first (IntelliJ branch-primary order)', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(html.includes('id="filter-branch"'), 'has branch input');
      assert.ok(html.includes('list="filter-branch-options"'), 'branch input wired to datalist');
      assert.ok(html.includes('id="filter-branch-options"'), 'branch datalist present');
      // Branch comes before Author in the filter row.
      assert.ok(
        html.indexOf('id="filter-branch"') < html.indexOf('id="filter-author"'),
        'branch field precedes author field'
      );
    });

    it('backs the author input with a datalist for ref-aware autocomplete', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(html.includes('list="filter-author-options"'), 'author input wired to datalist');
      assert.ok(html.includes('id="filter-author-options"'), 'author datalist present');
    });

    it('rehydrates the branch input from an active filter', () => {
      provider.setLogFilter({ branch: 'feature/x' });
      const html = provider._getLogFilterBarHtml();
      assert.ok(html.includes('value="feature/x"'), 'branch value rehydrated');
    });

    it('emits a No Merges toggle (IntelliJ vcs.log.filter.no.merges)', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(html.includes('id="filter-no-merges"'), 'has no-merges checkbox');
      assert.ok(html.includes('No Merges'), 'has No Merges label');
    });

    it('rehydrates the No Merges toggle from an active filter', () => {
      provider.setLogFilter({ noMerges: true });
      const html = provider._getLogFilterBarHtml();
      assert.ok(/id="filter-no-merges"[^>]*\schecked/.test(html), 'no-merges box checked');
    });

    it('emits a First Parent toggle (IntelliJ graph.options.first.parent)', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(html.includes('id="filter-first-parent"'), 'has first-parent checkbox');
      assert.ok(html.includes('First Parent'), 'has First Parent label');
    });

    it('emits a Simplify Merges toggle (IntelliJ graph options chooser)', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(html.includes('id="filter-simplify-merges"'), 'has simplify-merges checkbox');
      assert.ok(html.includes('Simplify Merges'), 'has Simplify Merges label');
    });

    it('emits min/max parent-count inputs (IntelliJ ParentFilterModel)', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(html.includes('id="filter-min-parents"'), 'has min-parents input');
      assert.ok(html.includes('id="filter-max-parents"'), 'has max-parents input');
    });

    it('hints range notation (A..B) in the branch input placeholder', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(
        /id="filter-branch"[^>]*placeholder="[^"]*A\.\.B/.test(html),
        'branch placeholder hints A..B range'
      );
    });
  });

  describe('_handleApplyLogFilter — No Merges mapping', () => {
    function applyFilter(p: GitToolWindowProvider, filter: unknown): void {
      (p as unknown as { _handleWebviewMessage: (msg: unknown) => void })._handleWebviewMessage({
        type: 'applyLogFilter',
        filter,
      });
    }

    it('maps noMerges:true through to the requested ILogFilter', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.ok(filter, 'a filter is requested');
        assert.strictEqual(filter?.noMerges, true);
        done();
      });
      applyFilter(provider, { noMerges: true });
    });

    it('treats noMerges:true alone as a non-empty filter', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.notStrictEqual(filter, undefined, 'noMerges-only must not collapse to undefined');
        done();
      });
      applyFilter(provider, {
        searchText: '',
        author: '',
        path: '',
        since: null,
        until: null,
        noMerges: true,
      });
    });

    it('maps a branch value through to the requested ILogFilter', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.ok(filter, 'a filter is requested');
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
        noMerges: false,
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

    it('maps firstParent/simplifyMerges flags through to the requested ILogFilter', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.strictEqual(filter?.firstParent, true);
        assert.strictEqual(filter?.simplifyMerges, true);
        done();
      });
      applyFilter(provider, { firstParent: true, simplifyMerges: true });
    });

    it('maps min/max parent counts through to the requested ILogFilter', (done) => {
      const disposable = provider.onDidRequestLogFilter((filter) => {
        disposable.dispose();
        assert.strictEqual(filter?.minParents, 1);
        assert.strictEqual(filter?.maxParents, 2);
        done();
      });
      applyFilter(provider, { minParents: 1, maxParents: 2 });
    });
  });

  describe('Cherry-compare with (G4 manual cherry-compare base ref)', () => {
    function applyFilter(p: GitToolWindowProvider, filter: unknown): void {
      (p as unknown as { _handleWebviewMessage: (msg: unknown) => void })._handleWebviewMessage({
        type: 'applyLogFilter',
        filter,
      });
    }

    it('renders a "filter-cherry-compare" input in the filter bar', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(html.includes('id="filter-cherry-compare"'), 'has cherry-compare input');
    });

    it('backs the cherry-compare input with the shared branch datalist', () => {
      const html = provider._getLogFilterBarHtml();
      assert.ok(
        /id="filter-cherry-compare"[^>]*list="filter-branch-options"/.test(html),
        'cherry-compare input reuses filter-branch-options datalist'
      );
    });

    it('rehydrates the cherry-compare input value from manualCherryCompareRef state', () => {
      (
        provider as unknown as { _extendedLogState: { manualCherryCompareRef?: string } }
      )._extendedLogState.manualCherryCompareRef = 'feature/x';
      const html = provider._getLogFilterBarHtml();
      assert.ok(
        /id="filter-cherry-compare"[^>]*value="feature\/x"/.test(html),
        'cherry-compare value rehydrated'
      );
    });

    it('fires onDidRequestCherryCompareRef with the ref when applyLogFilter carries cherryCompareRef', (done) => {
      const disposable = provider.onDidRequestCherryCompareRef((ref) => {
        disposable.dispose();
        assert.strictEqual(ref, 'main', 'override ref forwarded');
        done();
      });
      applyFilter(provider, { cherryCompareRef: 'main' });
    });

    it('fires onDidRequestCherryCompareRef with undefined when cherryCompareRef is empty', (done) => {
      const disposable = provider.onDidRequestCherryCompareRef((ref) => {
        disposable.dispose();
        assert.strictEqual(ref, undefined, 'empty ref reverts to auto-upstream');
        done();
      });
      applyFilter(provider, { cherryCompareRef: '' });
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

    it('renders an "All Repositories" option only when more than one repository exists', () => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      const html = provider._getRepositorySelectorHtml();
      assert.ok(html.includes('value="all"'), 'multi-repo selector must offer the all option');
      assert.ok(
        html.includes('All Repositories'),
        'the all option must carry a human-readable label'
      );
    });

    it('marks the "All Repositories" option as selected when the scope is all', () => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      // Drive scope to all explicitly (config seeding is off in this suite).
      (
        provider as unknown as { _handleRepositorySelection(selection: number | 'all'): void }
      )._handleRepositorySelection('all');

      const html = provider._getRepositorySelectorHtml();
      assert.ok(
        html.includes('value="all" selected'),
        'the all option must be selected when scope is all'
      );
      assert.ok(
        !html.includes('value="0" selected'),
        'no concrete repo option should be selected when scope is all'
      );
    });

    it('does NOT mark the all option selected when a specific repo is the scope', () => {
      const repos = [
        createMockRepository('/workspace/repo-a'),
        createMockRepository('/workspace/repo-b'),
      ];
      provider.setAvailableRepositories(
        repos as Parameters<typeof provider.setAvailableRepositories>[0]
      );

      (
        provider as unknown as { _handleRepositorySelection(selection: number | 'all'): void }
      )._handleRepositorySelection(1);

      const html = provider._getRepositorySelectorHtml();
      assert.ok(
        !html.includes('value="all" selected'),
        'the all option must not be selected when a specific repo is scoped'
      );
      assert.ok(html.includes('value="1" selected'), 'the chosen repo option must be selected');
    });
  });

  describe('repository scope state', () => {
    it('exposes isAllReposSelected() reflecting the current scope', () => {
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

      // Config-off default → specific repo scope.
      assert.strictEqual(surface.isAllReposSelected(), false);

      surface._handleRepositorySelection('all');
      assert.strictEqual(surface.isAllReposSelected(), true);

      surface._handleRepositorySelection(0);
      assert.strictEqual(surface.isAllReposSelected(), false);
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
      // Config-off default → specific-repo scope (not 'all').
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
    });
  });

  describe('scriptBuilder routes the all sentinel', () => {
    it('handles value === "all" before the numeric finite guard and posts the all sentinel', () => {
      const inlineScript = (
        provider as unknown as { _getInlineScript: () => string }
      )._getInlineScript();

      // Scope the ordering check to the repository-selector handler tokens so
      // it can't be satisfied by an unrelated earlier Number() elsewhere.
      const allBranchIdx = inlineScript.indexOf("target.value === 'all'");
      const numberGuardIdx = inlineScript.indexOf('Number(target.value)');
      assert.ok(allBranchIdx >= 0, 'inline script must branch on the all sentinel');
      assert.ok(numberGuardIdx >= 0, 'inline script must still parse numeric indices');
      assert.ok(
        allBranchIdx < numberGuardIdx,
        'the all branch must be handled BEFORE Number(target.value) drops it as NaN'
      );
      assert.ok(
        inlineScript.includes("repositoryIndex: 'all'"),
        'inline script must post the all sentinel as repositoryIndex'
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
      // A literal '|' was the old join/split delimiter. The collapsed-ref
      // attribute must carry it as JSON so the popup handler parses it as a
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
      // Local chip = hardcoded IntelliJ green (#499C54), white foreground —
      // pixel-faithful parity, NOT theme-adaptive. The earlier
      // var(--vscode-badge-background) token rendered as the theme's grey/blue
      // badge rather than green, so each ref kind now sets its own hardcoded
      // IntelliJ colour (local green / remote violet / current yellow).
      assert.ok(
        html.includes('background: #499C54'),
        'Local label background must be the hardcoded IntelliJ green #499C54'
      );
      assert.ok(
        /\.branch-label-local\s*\{[^}]*color:\s*white/i.test(html),
        'Local label foreground must be white for legibility on the green fill'
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
      // Remote chip is the hardcoded IntelliJ violet (#9876AA) —
      // pixel-faithful parity, deliberately NOT theme-adaptive (issue #10
      // decision A). The standalone hex is sanctioned via the
      // themeTokenCompleteness audit allowlist.
      assert.ok(
        /\.branch-label-remote\s*\{[^}]*background:\s*#9876AA/i.test(html),
        'Remote label must use the IntelliJ violet #9876AA background'
      );
      // The earlier theme-blue fallbacks no longer apply to the remote
      // chip (it left the badge-* family for the brand violet).
      assert.ok(
        !/\.branch-label-remote\s*\{[^}]*#1a3a5c/i.test(html),
        'Remote label must no longer carry the #1a3a5c theme fallback'
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

  it('commit-context-menu HTML includes a "Push up to here" item with data-action="pushUpToCommit"', () => {
    const html = p._getCommitContextMenuHtml();
    assert.ok(
      /data-action="pushUpToCommit"/.test(html),
      'Commit context menu must include a pushUpToCommit action item'
    );
    assert.ok(/[Pp]ush up to here/i.test(html), 'Item label must say "Push up to here"');
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

  it('goToParent and goToChild items carry data-multi-action="single-only"', () => {
    const html = p._getCommitContextMenuHtml();
    // Extract the goToParent item block to check it carries single-only.
    const parentIdx = html.indexOf('data-action="goToParent"');
    assert.ok(parentIdx !== -1, 'goToParent item must be present');
    const parentBlock = html.substring(Math.max(0, parentIdx - 200), parentIdx + 100);
    assert.ok(
      parentBlock.includes('data-multi-action="single-only"'),
      'goToParent must carry data-multi-action="single-only"'
    );

    const childIdx = html.indexOf('data-action="goToChild"');
    assert.ok(childIdx !== -1, 'goToChild item must be present');
    const childBlock = html.substring(Math.max(0, childIdx - 200), childIdx + 100);
    assert.ok(
      childBlock.includes('data-multi-action="single-only"'),
      'goToChild must carry data-multi-action="single-only"'
    );
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

  it('seeds the scope to a specific repo when showAllRoots config is false (the default)', () => {
    setMockConfigValue('intellig', 'log.showAllRoots', false);
    p.setAvailableRepositories(twoRepos());
    const enabled = (
      p as unknown as { _isShowAllRootsEnabled(): boolean }
    )._isShowAllRootsEnabled();
    assert.strictEqual(
      enabled,
      false,
      'config-off default must scope to a single repo, not the merged view'
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
