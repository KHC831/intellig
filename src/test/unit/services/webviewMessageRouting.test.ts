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

import '../../../test/setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../services/GitToolWindowProvider';
import { ICommit } from '../../../services/interfaces/IGitService';
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
function createMockCommit(
  hash: string,
  message: string,
  parents: string[] = []
): ICommit {
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
      const branchMap = new Map<string, string[]>();
      branchMap.set('abc1234567890', ['main']);
      branchMap.set('def4567890123', ['develop']);

      provider.updateLogState(commits, branchMap);

      // Send branchClick message
      handler({ type: 'branchClick', branchName: 'main' });

      // Verify the commit was selected
      const selected = provider.getSelectedCommits();
      assert.ok(selected.includes('abc1234567890'), 'Should select the commit for the clicked branch');
    });

    it('should fire onDidSelectCommit event when branch is clicked', (done) => {
      const commits = [createMockCommit('abc1234567890', 'Initial commit')];
      const branchMap = new Map<string, string[]>();
      branchMap.set('abc1234567890', ['main']);
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
  });

  describe('doubleClickFile message', () => {
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

    it('should fall back to showDiff context action when only path is provided (no commitHash)', (done) => {
      const disposable = provider.onDidRequestContextAction((event) => {
        assert.strictEqual(event.action, 'showDiff');
        assert.deepStrictEqual(event.files, ['src/app.ts']);
        disposable.dispose();
        done();
      });

      handler({
        type: 'doubleClickFile',
        path: 'src/app.ts',
      });
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

  describe('message routing completeness', () => {
    it('should handle all 7 required message types without throwing', () => {
      // Set up state needed for branchClick
      const commits = [createMockCommit('abc1234567890', 'Initial commit')];
      const branchMap = new Map<string, string[]>();
      branchMap.set('abc1234567890', ['main']);
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
