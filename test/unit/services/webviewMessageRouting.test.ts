/**
 * Unit tests for _handleWebviewMessage() routing in GitToolWindowProvider.
 *
 * Verifies that all message types from the 2-panel layout are properly
 * routed to the correct handler methods and fire the expected events.
 *
 * Message types tested:
 * - branchClick
 * - selectCommit
 * - toggleCommitSelection
 * - commitContextMenu
 * - doubleClickFile
 * - panelResize
 * - loadMoreCommits
 */

import '../../setup';
import { readGtwWebviewSource } from '../../helpers/gtwWebviewSource';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import { ICommit } from '../../../src/git-core/interfaces/IGitService';
import { Uri, Memento } from '../../mocks/vscode';

/**
 * Helper to access the private _handleWebviewMessage method for testing.
 */
type MessageHandler = { _handleWebviewMessage: (msg: unknown) => void };

/**
 * Creates a mock VS Code Memento (workspace state) for testing.
 */
function createMockMemento(): Memento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      if (store.has(key)) {
        return store.get(key) as T;
      }
      return defaultValue;
    },
    update(key: string, value: unknown): Promise<void> {
      store.set(key, value);
      return Promise.resolve();
    },
    keys(): readonly string[] {
      return Array.from(store.keys());
    },
  } as Memento;
}

/**
 * Helper to create a mock commit for testing.
 */
function createMockCommit(hash: string, message: string, parents: string[] = []): ICommit {
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message,
    author: { name: 'Test Author', email: 'test@example.com' },
    committer: { name: 'Test Author', email: 'test@example.com' },
    parents,
    authorDate: new Date('2024-01-01'),
    commitDate: new Date('2024-01-01'),
  };
}

describe('GitToolWindowProvider - Webview Message Routing (Req 5.1, 5.2)', () => {
  let provider: GitToolWindowProvider;
  let handler: (msg: unknown) => void;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    const memento = createMockMemento();
    provider = new GitToolWindowProvider(extensionUri, memento);
    handler = (provider as unknown as MessageHandler)._handleWebviewMessage.bind(provider);
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('branchClick message', () => {
    it('should select the commit associated with the clicked branch', () => {
      // Set up commits with a branch map
      const commits = [
        createMockCommit('abc1234567890', 'Initial commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ];
      const branchMap = new Map<string, { name: string; type: 'local' | 'remote' }[]>();
      branchMap.set('abc1234567890', [{ name: 'main', type: 'local' }]);
      branchMap.set('def4567890123', [{ name: 'develop', type: 'local' }]);

      provider.updateLogState(commits, branchMap);

      // Send branchClick message
      handler({ type: 'branchClick', branchName: 'main' });

      // Verify the commit was selected
      const selected = provider.getSelectedCommits();
      assert.ok(
        selected.includes('abc1234567890'),
        'Should select the commit for the clicked branch'
      );
    });

    it('should fire onDidSelectCommit event when branch is clicked', (done) => {
      const commits = [createMockCommit('abc1234567890', 'Initial commit')];
      const branchMap = new Map<string, { name: string; type: 'local' | 'remote' }[]>();
      branchMap.set('abc1234567890', [{ name: 'main', type: 'local' }]);
      provider.updateLogState(commits, branchMap);

      const disposable = provider.onDidSelectCommit((hash) => {
        assert.strictEqual(hash, 'abc1234567890');
        disposable.dispose();
        done();
      });

      handler({ type: 'branchClick', branchName: 'main' });
    });

    it('should ignore branchClick message without branchName', () => {
      // Should not throw
      assert.doesNotThrow(() => {
        handler({ type: 'branchClick' });
      });
    });
  });

  describe('selectCommit message', () => {
    it('should select the specified commit', () => {
      const commits = [
        createMockCommit('abc1234567890', 'First commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ];
      provider.updateLogState(commits);

      handler({ type: 'selectCommit', commitHash: 'abc1234567890' });

      const selected = provider.getSelectedCommits();
      assert.strictEqual(selected.length, 1);
      assert.ok(selected.includes('abc1234567890'));
    });

    it('should fire onDidSelectCommit event', (done) => {
      const commits = [createMockCommit('abc1234567890', 'First commit')];
      provider.updateLogState(commits);

      const disposable = provider.onDidSelectCommit((hash) => {
        assert.strictEqual(hash, 'abc1234567890');
        disposable.dispose();
        done();
      });

      handler({ type: 'selectCommit', commitHash: 'abc1234567890' });
    });

    it('should clear previous selection when selecting a new commit', () => {
      const commits = [
        createMockCommit('abc1234567890', 'First commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ];
      provider.updateLogState(commits);

      handler({ type: 'selectCommit', commitHash: 'abc1234567890' });
      handler({ type: 'selectCommit', commitHash: 'def4567890123' });

      const selected = provider.getSelectedCommits();
      assert.strictEqual(selected.length, 1);
      assert.ok(selected.includes('def4567890123'));
    });

    it('should ignore selectCommit message without commitHash', () => {
      assert.doesNotThrow(() => {
        handler({ type: 'selectCommit' });
      });
    });
  });

  describe('toggleCommitSelection message', () => {
    it('should add commit to selection', () => {
      const commits = [createMockCommit('abc1234567890', 'First commit')];
      provider.updateLogState(commits);

      handler({ type: 'toggleCommitSelection', commitHash: 'abc1234567890' });

      const selected = provider.getSelectedCommits();
      assert.ok(selected.includes('abc1234567890'));
    });

    it('should remove commit from selection when toggled again', () => {
      const commits = [createMockCommit('abc1234567890', 'First commit')];
      provider.updateLogState(commits);

      handler({ type: 'toggleCommitSelection', commitHash: 'abc1234567890' });
      handler({ type: 'toggleCommitSelection', commitHash: 'abc1234567890' });

      const selected = provider.getSelectedCommits();
      assert.strictEqual(selected.length, 0);
    });

    it('should support multi-select by toggling multiple commits', () => {
      const commits = [
        createMockCommit('abc1234567890', 'First commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ];
      provider.updateLogState(commits);

      handler({ type: 'toggleCommitSelection', commitHash: 'abc1234567890' });
      handler({ type: 'toggleCommitSelection', commitHash: 'def4567890123' });

      const selected = provider.getSelectedCommits();
      assert.strictEqual(selected.length, 2);
      assert.ok(selected.includes('abc1234567890'));
      assert.ok(selected.includes('def4567890123'));
    });

    it('should ignore toggleCommitSelection message without commitHash', () => {
      assert.doesNotThrow(() => {
        handler({ type: 'toggleCommitSelection' });
      });
    });
  });

  describe('commitContextMenu message', () => {
    // `_handleCommitContextMenu` now validates that
    // every commitHash in the message is present in the rendered
    // `commitNodes`. Pre-populate the commits these tests reference so
    // the validation is exercised positively rather than rejecting every
    // dispatch.
    beforeEach(() => {
      provider.updateLogState([
        createMockCommit('abc1234567890', 'First commit'),
        createMockCommit('def4567890123', 'Second commit', ['abc1234567890']),
      ]);
    });

    it('should fire onDidRequestLogContextAction event for cherry-pick', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'cherryPick');
        assert.deepStrictEqual(event.commitHashes, ['abc1234567890']);
        disposable.dispose();
        done();
      });

      handler({
        type: 'commitContextMenu',
        action: 'cherryPick',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire event for revert action', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'revert');
        assert.deepStrictEqual(event.commitHashes, ['def4567890123']);
        disposable.dispose();
        done();
      });

      handler({
        type: 'commitContextMenu',
        action: 'revert',
        commitHashes: ['def4567890123'],
      });
    });

    it('should fire event for copyHash action', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'copyHash');
        assert.deepStrictEqual(event.commitHashes, ['abc1234567890']);
        disposable.dispose();
        done();
      });

      handler({
        type: 'commitContextMenu',
        action: 'copyHash',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire event for createPatch action', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'createPatch');
        assert.deepStrictEqual(event.commitHashes, ['abc1234567890']);
        disposable.dispose();
        done();
      });

      handler({
        type: 'commitContextMenu',
        action: 'createPatch',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire event for checkoutRevision action', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'checkoutRevision');
        assert.deepStrictEqual(event.commitHashes, ['abc1234567890']);
        disposable.dispose();
        done();
      });

      handler({
        type: 'commitContextMenu',
        action: 'checkoutRevision',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire event for showRepoAtRevision action', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'showRepoAtRevision');
        assert.deepStrictEqual(event.commitHashes, ['abc1234567890']);
        disposable.dispose();
        done();
      });

      handler({
        type: 'commitContextMenu',
        action: 'showRepoAtRevision',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire event for compareWithLocal action', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'compareWithLocal');
        assert.deepStrictEqual(event.commitHashes, ['abc1234567890']);
        disposable.dispose();
        done();
      });

      handler({
        type: 'commitContextMenu',
        action: 'compareWithLocal',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire event for resetToHere action', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'resetToHere');
        assert.deepStrictEqual(event.commitHashes, ['abc1234567890']);
        disposable.dispose();
        done();
      });

      handler({
        type: 'commitContextMenu',
        action: 'resetToHere',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire event for undoCommit action', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'undoCommit');
        assert.deepStrictEqual(event.commitHashes, ['abc1234567890']);
        disposable.dispose();
        done();
      });

      handler({
        type: 'commitContextMenu',
        action: 'undoCommit',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire event for dropCommit action', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'dropCommit');
        assert.deepStrictEqual(event.commitHashes, ['abc1234567890']);
        disposable.dispose();
        done();
      });

      handler({
        type: 'commitContextMenu',
        action: 'dropCommit',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire event for editCommitMessage action', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'editCommitMessage');
        assert.deepStrictEqual(event.commitHashes, ['abc1234567890']);
        disposable.dispose();
        done();
      });

      handler({
        type: 'commitContextMenu',
        action: 'editCommitMessage',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire event for cherryPick action', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'cherryPick');
        assert.deepStrictEqual(event.commitHashes, ['abc1234567890']);
        disposable.dispose();
        done();
      });

      handler({
        type: 'commitContextMenu',
        action: 'cherryPick',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should fire event for interactiveRebase action', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'interactiveRebase');
        assert.deepStrictEqual(event.commitHashes, ['abc1234567890']);
        disposable.dispose();
        done();
      });

      handler({
        type: 'commitContextMenu',
        action: 'interactiveRebase',
        commitHashes: ['abc1234567890'],
      });
    });

    it('should support multi-commit context menu actions', (done) => {
      const disposable = provider.onDidRequestLogContextAction((event) => {
        assert.strictEqual(event.action, 'cherryPick');
        assert.strictEqual(event.commitHashes.length, 2);
        assert.ok(event.commitHashes.includes('abc1234567890'));
        assert.ok(event.commitHashes.includes('def4567890123'));
        disposable.dispose();
        done();
      });

      handler({
        type: 'commitContextMenu',
        action: 'cherryPick',
        commitHashes: ['abc1234567890', 'def4567890123'],
      });
    });

    it('should correctly route all 12 action types', () => {
      const allActions = [
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

      for (const action of allActions) {
        handler({
          type: 'commitContextMenu',
          action,
          commitHashes: ['abc1234567890'],
        });
      }

      assert.strictEqual(receivedActions.length, 12, 'All 12 action types should be routed');
      assert.deepStrictEqual(receivedActions, allActions, 'Actions should be routed in order');
      disposable.dispose();
    });

    it('should ignore commitContextMenu message without action', () => {
      let eventFired = false;
      const disposable = provider.onDidRequestLogContextAction(() => {
        eventFired = true;
      });

      handler({ type: 'commitContextMenu', commitHashes: ['abc1234567890'] });
      assert.strictEqual(eventFired, false);
      disposable.dispose();
    });

    it('should ignore commitContextMenu message without commitHashes', () => {
      let eventFired = false;
      const disposable = provider.onDidRequestLogContextAction(() => {
        eventFired = true;
      });

      handler({ type: 'commitContextMenu', action: 'cherryPick' });
      assert.strictEqual(eventFired, false);
      disposable.dispose();
    });

    it('does not throw and ignores a commitContextMenu message where commitHashes is not an array', () => {
      // A desynced webview may send commitHashes as a string or other non-array.
      // The handler must guard with Array.isArray rather than a truthy-check so
      // it does not reach array methods on a non-array and throw, aborting dispatch.
      let eventFired = false;
      const disposable = provider.onDidRequestLogContextAction(() => {
        eventFired = true;
      });

      assert.doesNotThrow(() => {
        handler({ type: 'commitContextMenu', action: 'cherryPick', commitHashes: 'abc1234567890' });
      });
      assert.strictEqual(
        eventFired,
        false,
        'non-array commitHashes must be ignored, not dispatched'
      );
      disposable.dispose();
    });
  });

  describe('doubleClickFile message', () => {
    // `_handleCommitFileDoubleClick` now drops a double-click whose commit hash
    // is no longer in the rendered `commitNodes` (stale-hash guard). Pre-populate
    // the referenced commit so the positive path fires.
    beforeEach(() => {
      provider.updateLogState([createMockCommit('abc1234567890', 'First commit')]);
    });

    it('should fire onDidRequestCommitDiff event with commit hash and file path', (done) => {
      const disposable = provider.onDidRequestCommitDiff((event) => {
        assert.strictEqual(event.commitHash, 'abc1234567890');
        assert.strictEqual(event.filePath, 'src/app.ts');
        disposable.dispose();
        done();
      });

      handler({
        type: 'doubleClickFile',
        commitHash: 'abc1234567890',
        path: 'src/app.ts',
      });
    });

    it('should handle file paths with special characters', (done) => {
      const disposable = provider.onDidRequestCommitDiff((event) => {
        assert.strictEqual(event.filePath, 'src/components/my-component.test.tsx');
        disposable.dispose();
        done();
      });

      handler({
        type: 'doubleClickFile',
        commitHash: 'abc1234567890',
        path: 'src/components/my-component.test.tsx',
      });
    });

    it('ignores a path-only doubleClickFile — the live emitter always sends commitHash', () => {
      // The dead `window.doubleClickFile(path)` (path-only) was removed, so the
      // host's old showDiff fallback is gone. A path-only message is now a no-op.
      let contextActionFired = false;
      let commitDiffFired = false;
      const d1 = provider.onDidRequestContextAction(() => {
        contextActionFired = true;
      });
      const d2 = provider.onDidRequestCommitDiff(() => {
        commitDiffFired = true;
      });

      assert.doesNotThrow(() => handler({ type: 'doubleClickFile', path: 'src/app.ts' }));

      assert.strictEqual(
        contextActionFired,
        false,
        'no showDiff fallback for the dead path-only shape'
      );
      assert.strictEqual(commitDiffFired, false, 'no commit diff without a commitHash');
      d1.dispose();
      d2.dispose();
    });
  });

  describe('panelResize message', () => {
    it('should update panel widths', () => {
      handler({ type: 'panelResize', widths: [55, 45] });

      const widths = provider.getPanelWidths();
      assert.deepStrictEqual(widths, [55, 45]);
    });

    it('should persist widths to workspace state', () => {
      handler({ type: 'panelResize', widths: [70, 30] });

      const widths = provider.getPanelWidths();
      assert.deepStrictEqual(widths, [70, 30]);
    });

    it('should ignore panelResize message without widths', () => {
      handler({ type: 'panelResize' });

      const widths = provider.getPanelWidths();
      assert.deepStrictEqual(widths, [60, 40], 'Should remain at defaults');
    });
  });

  describe('loadMoreCommits message', () => {
    it('should fire onDidRequestLoadMoreCommits event', (done) => {
      const disposable = provider.onDidRequestLoadMoreCommits(() => {
        disposable.dispose();
        done();
      });

      handler({ type: 'loadMoreCommits' });
    });

    it('should fire event each time loadMoreCommits is received', () => {
      let fireCount = 0;
      const disposable = provider.onDidRequestLoadMoreCommits(() => {
        fireCount++;
      });

      handler({ type: 'loadMoreCommits' });
      handler({ type: 'loadMoreCommits' });
      handler({ type: 'loadMoreCommits' });

      assert.strictEqual(fireCount, 3, 'Should fire event for each loadMoreCommits message');
      disposable.dispose();
    });
  });

  describe('unknown message type', () => {
    it('should not throw for unknown message types', () => {
      assert.doesNotThrow(() => {
        handler({ type: 'unknownMessageType' });
      });
    });
  });

  describe('client→host message exhaustiveness (W1, closed-set)', () => {
    // Both sides are derived from REAL code so neither can silently drift:
    //   emitted = every `type: '...'` the inline client script posts,
    //   handled = every `case '...':` in the provider's _handleWebviewMessage
    //             switch, plus the router-owned `tabChange`.
    // If a future change emits a message with no handler case (an orphan), the
    // subset assertion below reds.

    /** Extract the message types the client entry posts to the host. */
    function emittedMessageTypes(): Set<string> {
      const script = readGtwWebviewSource();
      const types = new Set<string>();
      const re = /type:\s*'([\w.]+)'/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(script)) !== null) {
        types.add(m[1]);
      }
      return types;
    }

    /** Extract the message types the provider's dispatch switch handles. */
    function handledMessageTypes(): Set<string> {
      const providerSrc = fs.readFileSync(
        path.resolve(__dirname, '../../../src/git-core/gitToolWindow/provider/messageHandlers.ts'),
        'utf8'
      );
      // Slice out just the _handleWebviewMessage switch body so unrelated
      // switches (e.g. keyboard `case 'ArrowLeft':`) don't pollute the set.
      const methodStart = providerSrc.indexOf(
        'dispatchLogMessage(ctx: IGtwControllerContext, message: IWebviewMessage)'
      );
      assert.notStrictEqual(methodStart, -1, 'sanity: dispatchLogMessage function found');
      const switchStart = providerSrc.indexOf('switch (msg.type)', methodStart);
      const defaultIdx = providerSrc.indexOf('default:', switchStart);
      assert.ok(
        switchStart !== -1 && defaultIdx !== -1 && defaultIdx > switchStart,
        'sanity: dispatch switch + default branch located'
      );
      const body = providerSrc.slice(switchStart, defaultIdx);

      const handled = new Set<string>();
      const re = /case\s+'([\w.]+)'\s*:/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        handled.add(m[1]);
      }
      // The tab router consumes `tabChange` before the switch runs.
      handled.add('tabChange');
      return handled;
    }

    it('parses a non-trivial set from both the client script and the host switch', () => {
      assert.ok(emittedMessageTypes().size >= 10, 'expected the client script to emit many types');
      assert.ok(handledMessageTypes().size >= 10, 'expected the host switch to handle many types');
    });

    it('every message TYPE the client script emits has a matching host handler case', () => {
      const emitted = emittedMessageTypes();
      const handled = handledMessageTypes();
      // Messages with a known `<tab>.` prefix are consumed by the tab router
      // (`_routeIfNonLog`) before the dispatch switch, so they have no `case`.
      const routerConsumed = /^(history|incoming|console|updateInfo)\./;
      const orphans = [...emitted].filter((t) => !handled.has(t) && !routerConsumed.test(t)).sort();
      assert.deepStrictEqual(
        orphans,
        [],
        `client emits message types with no host handler (orphans): ${orphans.join(', ')}`
      );
    });
  });

  describe('message routing completeness', () => {
    it('should handle all 7 required message types without throwing', () => {
      // Set up state needed for branchClick
      const commits = [createMockCommit('abc1234567890', 'Initial commit')];
      const branchMap = new Map<string, { name: string; type: 'local' | 'remote' }[]>();
      branchMap.set('abc1234567890', [{ name: 'main', type: 'local' }]);
      provider.updateLogState(commits, branchMap);

      const messages = [
        { type: 'branchClick', branchName: 'main' },
        { type: 'selectCommit', commitHash: 'abc1234567890' },
        { type: 'toggleCommitSelection', commitHash: 'abc1234567890' },
        { type: 'commitContextMenu', action: 'cherryPick', commitHashes: ['abc1234567890'] },
        { type: 'doubleClickFile', commitHash: 'abc1234567890', path: 'src/app.ts' },
        { type: 'panelResize', widths: [55, 45] },
        { type: 'loadMoreCommits' },
      ];

      for (const msg of messages) {
        assert.doesNotThrow(
          () => handler(msg),
          `Message type '${msg.type}' should be handled without throwing`
        );
      }
    });
  });
});
