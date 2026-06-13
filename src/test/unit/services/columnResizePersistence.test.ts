/**
 * Unit tests for resizable-log-column flow in GitToolWindowProvider.
 *
 * The Git log rows render three columns: a flexible title column plus two
 * fixed-width metadata columns (author, date) the user can drag-to-resize.
 * These tests pin the provider-side contract:
 * - columnResize message handling and persistence via saveColumnWidths
 * - Loading persisted column widths on construction via loadColumnWidths
 * - Default widths [120, 145] when no workspace state is provided
 * - getColumnWidths() returning current state
 * - Graph-panel markup carries a column header with drag handles and the
 *   per-column widths published as CSS custom properties so rows + header
 *   stay aligned and a re-render rehydrates the dragged widths.
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../ui-shell/GitToolWindowProvider';
import { ICommitNode } from '../../../git-core/commitGraph';
import { ICommit } from '../../../git-core/interfaces/IGitService';
import { Uri, Memento } from '../../mocks/vscode';

/** Access the private message-routing entry point the same way the routing
 * suite does — the column flow is dispatched through this switch. */
type MessageHandler = { _handleWebviewMessage: (msg: unknown) => void };
function dispatch(provider: GitToolWindowProvider, msg: unknown): void {
  (provider as unknown as MessageHandler)._handleWebviewMessage(msg);
}

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

function makeCommit(overrides: Partial<ICommit> = {}): ICommit {
  return {
    hash: 'abc1234567890abcdef1234567890abcdef123456',
    shortHash: 'abc1234',
    message: 'Fix bug in authentication module',
    author: { name: 'Alice', email: 'alice@example.com' },
    committer: { name: 'Alice', email: 'alice@example.com' },
    parents: ['def5678901234567890abcdef1234567890abcdef'],
    authorDate: new Date('2024-01-01T12:00:00Z'),
    commitDate: new Date('2024-01-01T12:00:00Z'),
    ...overrides,
  };
}

function makeCommitNode(): ICommitNode {
  return {
    commit: makeCommit(),
    graphColumn: 0,
    graphLines: [{ fromColumn: 0, toColumn: 0, color: '#4CAF50', type: 'commit' as const }],
    branches: [],
    tags: [],
  } as ICommitNode;
}

describe('GitToolWindowProvider - Resizable Log Columns', () => {
  let extensionUri: Uri;

  beforeEach(() => {
    extensionUri = Uri.file('/test/extension');
  });

  describe('Construction — loading persisted column widths', () => {
    it('defaults to [120, 145] when no workspace state is provided', () => {
      const provider = new GitToolWindowProvider(extensionUri);
      assert.deepStrictEqual(provider.getColumnWidths(), [120, 145]);
      provider.dispose();
    });

    it('defaults to [120, 145] when workspace state has no stored widths', () => {
      const provider = new GitToolWindowProvider(extensionUri, createMockMemento());
      assert.deepStrictEqual(provider.getColumnWidths(), [120, 145]);
      provider.dispose();
    });

    it('loads persisted column widths from workspace state', () => {
      const state = createMockMemento();
      void state.update('intellig.columnWidths', [160, 180]);
      const provider = new GitToolWindowProvider(extensionUri, state);
      assert.deepStrictEqual(provider.getColumnWidths(), [160, 180]);
      provider.dispose();
    });
  });

  describe('columnResize message handling', () => {
    it('updates column widths and persists them', () => {
      const state = createMockMemento();
      const provider = new GitToolWindowProvider(extensionUri, state);

      dispatch(provider, { type: 'columnResize', widths: [170, 200] });

      assert.deepStrictEqual(provider.getColumnWidths(), [170, 200]);
      assert.deepStrictEqual(state.get('intellig.columnWidths'), [170, 200]);
      provider.dispose();
    });

    it('clamps a column dragged below the minimum (never collapses to 0)', () => {
      const provider = new GitToolWindowProvider(extensionUri, createMockMemento());

      dispatch(provider, { type: 'columnResize', widths: [0, 145] });

      const widths = provider.getColumnWidths();
      assert.ok(widths[0] >= 40, `author column should be clamped to a min, got ${widths[0]}`);
      provider.dispose();
    });

    it('ignores a columnResize message without widths', () => {
      const provider = new GitToolWindowProvider(extensionUri, createMockMemento());

      dispatch(provider, { type: 'columnResize' });

      assert.deepStrictEqual(provider.getColumnWidths(), [120, 145], 'should remain at defaults');
      provider.dispose();
    });
  });

  describe('Graph panel markup', () => {
    it('renders a column header with author and date drag handles', () => {
      const provider = new GitToolWindowProvider(extensionUri);
      const html = provider._getGraphPanelHtml([makeCommitNode()]);

      assert.ok(html.includes('log-column-header'), 'should render a column header row');
      assert.ok(
        html.includes('data-column-resize="author"'),
        'should render a drag handle that resizes the author column'
      );
      assert.ok(
        html.includes('data-column-resize="date"'),
        'should render a drag handle that resizes the date column'
      );
      provider.dispose();
    });

    it('publishes the current column widths as CSS custom properties on the panel', () => {
      const state = createMockMemento();
      void state.update('intellig.columnWidths', [160, 180]);
      const provider = new GitToolWindowProvider(extensionUri, state);
      const html = provider._getGraphPanelHtml([makeCommitNode()]);

      assert.ok(
        html.includes('--col-author-width: 160px'),
        `should publish author width var; got: ${html.slice(0, 400)}`
      );
      assert.ok(html.includes('--col-date-width: 180px'), 'should publish date width var');
      provider.dispose();
    });
  });
});
