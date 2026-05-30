/**
 * Unit tests for panel resize persistence flow in GitToolWindowProvider.
 *
 * Tests cover:
 * - panelResize message handling and persistence via savePanelWidths
 * - Loading persisted widths on construction via loadPanelWidths
 * - Default widths when no workspace state is provided
 * - getPanelWidths() returning current state
 * - _getThreePanelHtmlContent() using persisted widths as defaults
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../ui-shell/GitToolWindowProvider';
import { Uri, Webview, Memento } from '../../mocks/vscode';

/**
 * Creates a mock VS Code Memento (workspace state) for testing.
 * Stores values in an in-memory Map.
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
 * Create a mock Webview object for testing.
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

describe('GitToolWindowProvider - Panel Resize Persistence (Req 1.3, 1.4)', () => {
  let extensionUri: Uri;

  beforeEach(() => {
    extensionUri = Uri.file('/test/extension');
  });

  describe('Constructor - Loading persisted widths', () => {
    it('should load default widths [60, 40] when no workspace state is provided', () => {
      const provider = new GitToolWindowProvider(extensionUri);
      const widths = provider.getPanelWidths();
      assert.deepStrictEqual(widths, [60, 40]);
      provider.dispose();
    });

    it('should load default widths [60, 40] when workspace state has no stored widths', () => {
      const memento = createMockMemento();
      const provider = new GitToolWindowProvider(extensionUri, memento);
      const widths = provider.getPanelWidths();
      assert.deepStrictEqual(widths, [60, 40]);
      provider.dispose();
    });

    it('should load persisted widths from workspace state', () => {
      const memento = createMockMemento();
      // Pre-populate the workspace state with custom widths
      void memento.update('intellig.panelWidths', [70, 30]);

      const provider = new GitToolWindowProvider(extensionUri, memento);
      const widths = provider.getPanelWidths();
      assert.deepStrictEqual(widths, [70, 30]);
      provider.dispose();
    });

    it('should fall back to defaults when workspace state has invalid widths', () => {
      const memento = createMockMemento();
      // Store invalid widths (don't sum to 100)
      void memento.update('intellig.panelWidths', [10, 10]);

      const provider = new GitToolWindowProvider(extensionUri, memento);
      const widths = provider.getPanelWidths();
      assert.deepStrictEqual(widths, [60, 40]);
      provider.dispose();
    });

    it('should fall back to defaults when workspace state has corrupted data', () => {
      const memento = createMockMemento();
      void memento.update('intellig.panelWidths', 'not-an-array');

      const provider = new GitToolWindowProvider(extensionUri, memento);
      const widths = provider.getPanelWidths();
      assert.deepStrictEqual(widths, [60, 40]);
      provider.dispose();
    });
  });

  describe('panelResize message handling', () => {
    it('should update internal panel widths when panelResize message is received', () => {
      const memento = createMockMemento();
      const provider = new GitToolWindowProvider(extensionUri, memento);

      (
        provider as unknown as { _handleWebviewMessage: (msg: unknown) => void }
      )._handleWebviewMessage({
        type: 'panelResize',
        widths: [55, 45],
      });

      const widths = provider.getPanelWidths();
      assert.deepStrictEqual(widths, [55, 45]);
      provider.dispose();
    });

    it('should persist widths to workspace state when panelResize message is received', () => {
      const memento = createMockMemento();
      const provider = new GitToolWindowProvider(extensionUri, memento);

      (
        provider as unknown as { _handleWebviewMessage: (msg: unknown) => void }
      )._handleWebviewMessage({
        type: 'panelResize',
        widths: [65, 35],
      });

      const stored = memento.get<[number, number]>('intellig.panelWidths');
      assert.deepStrictEqual(stored, [65, 35]);
      provider.dispose();
    });

    it('should not throw when panelResize is received without workspace state', () => {
      const provider = new GitToolWindowProvider(extensionUri);

      assert.doesNotThrow(() => {
        (
          provider as unknown as { _handleWebviewMessage: (msg: unknown) => void }
        )._handleWebviewMessage({
          type: 'panelResize',
          widths: [55, 45],
        });
      });

      const widths = provider.getPanelWidths();
      assert.deepStrictEqual(widths, [55, 45]);
      provider.dispose();
    });

    it('should ignore panelResize message without widths field', () => {
      const memento = createMockMemento();
      const provider = new GitToolWindowProvider(extensionUri, memento);

      (
        provider as unknown as { _handleWebviewMessage: (msg: unknown) => void }
      )._handleWebviewMessage({
        type: 'panelResize',
      });

      const widths = provider.getPanelWidths();
      assert.deepStrictEqual(widths, [60, 40]);
      provider.dispose();
    });

    it('should handle multiple consecutive panelResize messages', () => {
      const memento = createMockMemento();
      const provider = new GitToolWindowProvider(extensionUri, memento);
      const handler = (
        provider as unknown as { _handleWebviewMessage: (msg: unknown) => void }
      )._handleWebviewMessage.bind(provider);

      handler({ type: 'panelResize', widths: [55, 45] });
      handler({ type: 'panelResize', widths: [70, 30] });
      handler({ type: 'panelResize', widths: [50, 50] });

      const widths = provider.getPanelWidths();
      assert.deepStrictEqual(widths, [50, 50]);

      const stored = memento.get<[number, number]>('intellig.panelWidths');
      assert.deepStrictEqual(stored, [50, 50]);
      provider.dispose();
    });
  });

  describe('getPanelWidths()', () => {
    it('should return a copy of the panel widths (not the internal reference)', () => {
      const provider = new GitToolWindowProvider(extensionUri);
      const widths1 = provider.getPanelWidths();
      const widths2 = provider.getPanelWidths();

      assert.notStrictEqual(widths1, widths2, 'Should return different array instances');
      assert.deepStrictEqual(widths1, widths2, 'Should have same values');
      provider.dispose();
    });
  });

  describe('_getThreePanelHtmlContent() uses persisted widths', () => {
    it('should use persisted widths as default when no explicit widths are passed', () => {
      const memento = createMockMemento();
      void memento.update('intellig.panelWidths', [70, 30]);

      const provider = new GitToolWindowProvider(extensionUri, memento);
      const mockWebview = createMockWebview();

      const html = provider._getThreePanelHtmlContent(
        mockWebview as unknown as import('vscode').Webview,
        []
      );

      const graphPanelMatch = html.match(/id="graph-panel"[^>]*style="width: (\d+)%;"/);
      assert.ok(graphPanelMatch, 'Graph panel should have width style');
      assert.strictEqual(graphPanelMatch[1], '70', 'Graph panel should be 70%');

      const detailsPanelMatch = html.match(/id="details-panel"[^>]*style="width: (\d+)%;"/);
      assert.ok(detailsPanelMatch, 'Details panel should have width style');
      assert.strictEqual(detailsPanelMatch[1], '30', 'Details panel should be 30%');

      provider.dispose();
    });

    it('should use explicit widths when passed, overriding persisted widths', () => {
      const memento = createMockMemento();
      void memento.update('intellig.panelWidths', [70, 30]);

      const provider = new GitToolWindowProvider(extensionUri, memento);
      const mockWebview = createMockWebview();

      const html = provider._getThreePanelHtmlContent(
        mockWebview as unknown as import('vscode').Webview,
        [],
        undefined,
        [55, 45] // explicit widths
      );

      const graphPanelMatch = html.match(/id="graph-panel"[^>]*style="width: (\d+)%;"/);
      assert.ok(graphPanelMatch, 'Graph panel should have width style');
      assert.strictEqual(graphPanelMatch[1], '55', 'Graph panel should be 55%');

      const detailsPanelMatch = html.match(/id="details-panel"[^>]*style="width: (\d+)%;"/);
      assert.ok(detailsPanelMatch, 'Details panel should have width style');
      assert.strictEqual(detailsPanelMatch[1], '45', 'Details panel should be 45%');

      provider.dispose();
    });
  });

  describe('End-to-end persistence flow', () => {
    it('should persist widths from panelResize and load them in a new provider instance', () => {
      const memento = createMockMemento();

      const provider1 = new GitToolWindowProvider(extensionUri, memento);
      (
        provider1 as unknown as { _handleWebviewMessage: (msg: unknown) => void }
      )._handleWebviewMessage({
        type: 'panelResize',
        widths: [75, 25],
      });
      provider1.dispose();

      const provider2 = new GitToolWindowProvider(extensionUri, memento);
      const widths = provider2.getPanelWidths();
      assert.deepStrictEqual(widths, [75, 25]);
      provider2.dispose();
    });

    it('should persist widths and use them in HTML generation of a new provider', () => {
      const memento = createMockMemento();

      const provider1 = new GitToolWindowProvider(extensionUri, memento);
      (
        provider1 as unknown as { _handleWebviewMessage: (msg: unknown) => void }
      )._handleWebviewMessage({
        type: 'panelResize',
        widths: [55, 45],
      });
      provider1.dispose();

      const provider2 = new GitToolWindowProvider(extensionUri, memento);
      const mockWebview = createMockWebview();

      const html = provider2._getThreePanelHtmlContent(
        mockWebview as unknown as import('vscode').Webview,
        []
      );

      const graphPanelMatch = html.match(/id="graph-panel"[^>]*style="width: (\d+)%;"/);
      assert.ok(graphPanelMatch, 'Graph panel should have width style');
      assert.strictEqual(graphPanelMatch[1], '55', 'Graph panel should be 55%');

      const detailsPanelMatch = html.match(/id="details-panel"[^>]*style="width: (\d+)%;"/);
      assert.ok(detailsPanelMatch, 'Details panel should have width style');
      assert.strictEqual(detailsPanelMatch[1], '45', 'Details panel should be 45%');

      provider2.dispose();
    });
  });
});
