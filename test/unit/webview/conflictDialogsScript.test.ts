/**
 * Webview client-script tests for the Merge and Resolve-Conflicts dialogs.
 *
 * Both extend BaseWebviewPanel, ship an empty `#root`, and build their UI via
 * document.createElement in a nonce'd inline script. We run the real scripts
 * under jsdom and assert they load, build their controls, and tolerate
 * extension→webview messages — including the per-row status update the
 * Resolve-Conflicts script handles — which no extension-host / e2e lane sees.
 *
 * Files exercised: MergeDialog.ts, ResolveConflictsDialog.ts.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { MergeDialog } from '../../../src/conflicts/MergeDialog';
import { ResolveConflictsDialog } from '../../../src/conflicts/ResolveConflictsDialog';
import type {
  IConflictOpContext,
  IConflictResolutionService,
} from '../../../src/conflicts/interfaces/IConflictResolutionService';
import type { IMergeView } from '../../../src/conflicts/interfaces/IMergeView';
import { createMockGitService, attachedRepo } from '../../mocks/mockGitService';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import { extractWebviewScript } from '../../helpers/webviewHtml';
import { makeExtensionContext, panelHtml } from '../../helpers/mockWebviewContext';

const GARBAGE_MESSAGES: unknown[] = [
  { type: 'totally-unknown-message' },
  { type: undefined },
  { foo: 'bar' },
  {},
];

function stubMergeView(): IMergeView {
  const emitter = new vscode.EventEmitter<string>();
  return {
    onDidResolve: emitter.event,
    dispose: (): void => emitter.dispose(),
  } as unknown as IMergeView;
}

describe('webview: conflict dialog scripts (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  describe('MergeDialog', () => {
    function html(): string {
      const repo = attachedRepo();
      const dialog = new MergeDialog(makeExtensionContext(), {
        repo,
        sourceBranch: 'feature/x',
        gitService: createMockGitService(repo),
      });
      return panelHtml(dialog);
    }

    function boot(): IWebviewEntryHarness {
      return bootWebviewEntry('conflicts/webview/main', {
        bodyHtml: extractWebviewScript(html()).bodyHtml,
      });
    }

    it('loads without throwing and builds the strategy flag controls', () => {
      h = boot();
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      assert.ok(h.document.getElementById('flag-ffOnly'), 'ff-only flag built');
      assert.ok(h.document.getElementById('flag-squash'), 'squash flag built');
    });

    it('tolerates garbage messages without throwing', () => {
      h = boot();
      for (const msg of GARBAGE_MESSAGES) {
        h.post(msg);
      }
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
    });
  });

  describe('ResolveConflictsDialog', () => {
    const opContext: IConflictOpContext = {
      operation: 'merge',
      target: 'feature/x',
      canAbort: true,
      canContinue: true,
    };

    function makeDialog(context = makeExtensionContext()): ResolveConflictsDialog {
      const repo = attachedRepo();
      return new ResolveConflictsDialog(
        context,
        repo,
        [
          { path: 'src/a.ts', resolved: false },
          { path: 'src/b.ts', resolved: true },
        ],
        opContext,
        {} as IConflictResolutionService,
        stubMergeView(),
        createMockGitService(repo)
      );
    }

    function html(dialog = makeDialog()): string {
      return panelHtml(dialog);
    }

    function boot(bodyHtml = extractWebviewScript(html()).bodyHtml): IWebviewEntryHarness {
      return bootWebviewEntry('conflicts/webview/resolveConflictsDialog', { bodyHtml });
    }

    it('loads without throwing and builds a row per conflicted file', () => {
      h = boot();
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      assert.strictEqual(
        h.document.querySelectorAll('[data-row-path]').length,
        2,
        'a row is built per conflicted file'
      );
    });

    it('offers a group-by-directory toggle that groups rows under headers', () => {
      h = boot();
      const toggle = h.document.getElementById('group-by-dir') as HTMLInputElement;
      assert.ok(toggle, 'the toggle exists');
      assert.strictEqual(toggle.checked, false, 'flat by default');

      toggle.checked = true;
      toggle.dispatchEvent(new h.window.Event('change', { bubbles: true }));

      const headers = Array.from(h.document.querySelectorAll('.dir-header')).map(
        (n) => n.textContent
      );
      assert.deepStrictEqual(headers, ['src'], 'one header for the shared directory');
      const names = Array.from(h.document.querySelectorAll('[data-row-path] .file-path')).map(
        (n) => n.textContent
      );
      assert.deepStrictEqual(names, ['a.ts', 'b.ts'], 'grouped rows show basenames');
      assert.deepStrictEqual(
        h.posted.filter((m) => (m as { type?: string }).type === 'setGroupByDirectory'),
        [{ type: 'setGroupByDirectory', value: true }],
        'the preference round-trips to the host for persistence'
      );

      toggle.checked = false;
      toggle.dispatchEvent(new h.window.Event('change', { bubbles: true }));
      const flat = Array.from(h.document.querySelectorAll('[data-row-path] .file-path')).map(
        (n) => n.textContent
      );
      assert.deepStrictEqual(flat, ['src/a.ts', 'src/b.ts'], 'toggling off restores full paths');
    });

    it('boots grouped when the persisted preference says so', async () => {
      const context = makeExtensionContext();
      await context.globalState.update('intellig.resolveConflictsDialog.groupByDirectory', true);
      h = boot(extractWebviewScript(html(makeDialog(context))).bodyHtml);

      assert.strictEqual(
        (h.document.getElementById('group-by-dir') as HTMLInputElement).checked,
        true
      );
      assert.strictEqual(h.document.querySelectorAll('.dir-header').length, 1);
    });

    it('the host persists the group-by-directory preference', async () => {
      const context = makeExtensionContext();
      class DialogProbe extends ResolveConflictsDialog {
        deliver(message: unknown): Promise<void> {
          return this._onMessage(message);
        }
      }
      const repo = attachedRepo();
      const dialog = new DialogProbe(
        context,
        repo,
        [{ path: 'src/a.ts', resolved: false }],
        opContext,
        {} as IConflictResolutionService,
        stubMergeView(),
        createMockGitService(repo)
      );
      await dialog.deliver({ type: 'setGroupByDirectory', value: true });
      assert.deepStrictEqual(
        context.globalState.get('intellig.resolveConflictsDialog.groupByDirectory'),
        { v: 1, data: true }
      );
      dialog.dispose();
    });

    it('an unresolved status patch restores the row actions', () => {
      h = boot();
      // b.ts boots resolved. Unresolving it (an unstash/unshelve reversal, a
      // failed accept) must give the row its actions back, not leave it
      // labelled "resolved" and permanently unactionable.
      h.post({ type: 'updateFileStatus', path: 'src/b.ts', status: 'unresolved' });

      const row = h.document.querySelector('[data-row-path="src/b.ts"]') as HTMLElement;
      assert.strictEqual(row.querySelector('.resolved-label'), null, 'the resolved label must go');
      assert.deepStrictEqual(
        Array.from(row.querySelectorAll('button')).map((b) => b.getAttribute('data-action')),
        ['acceptYours', 'acceptTheirs', 'openMergeView']
      );
      assert.strictEqual(
        (h.document.querySelector('[data-action="continue"]') as HTMLElement).hasAttribute(
          'disabled'
        ),
        true,
        'an unresolved file must re-disable Continue'
      );
    });

    it('keeps the bulk row in step with what is still unresolved', () => {
      h = boot();
      const bulk = (): HTMLElement | null => h.document.querySelector('.bulk-actions');
      assert.ok(bulk(), 'a.ts is unresolved, so the bulk row is offered');

      h.post({ type: 'updateFileStatus', path: 'src/a.ts', status: 'resolved' });
      assert.strictEqual(
        bulk() === null || (bulk() as HTMLElement).hidden,
        true,
        'nothing is unresolved, so Accept-All must not be offered'
      );

      h.post({ type: 'updateFileStatus', path: 'src/a.ts', status: 'unresolved' });
      assert.strictEqual(
        bulk() !== null && !(bulk() as HTMLElement).hidden,
        true,
        'the bulk row returns when something is unresolved again'
      );
    });

    it('keeps focus on the row when a status patch rebuilds its buttons', () => {
      h = boot();
      // Keyboard-navigate to a row's Merge… button and resolve from there; the
      // host then pushes updateFileStatus, which rebuilds .file-actions and
      // destroys the focused button.
      const btn = h.document.querySelector(
        '[data-row-path="src/a.ts"] [data-action="openMergeView"]'
      ) as HTMLElement;
      btn.focus();
      assert.strictEqual(h.document.activeElement, btn);

      h.post({ type: 'updateFileStatus', path: 'src/a.ts', status: 'resolved' });

      const active = h.document.activeElement;
      assert.strictEqual(
        active?.getAttribute('data-row-path'),
        'src/a.ts',
        'focus must land back on the row, not fall to <body>'
      );
    });

    it('keeps keyboard focus on the same row across a re-render', () => {
      h = boot();
      const row = h.document.querySelector('[data-row-path="src/b.ts"]') as HTMLElement;
      row.focus();
      assert.strictEqual(h.document.activeElement, row);

      // Toggling grouping replaces every row element.
      const toggle = h.document.getElementById('group-by-dir') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new h.window.Event('change', { bubbles: true }));

      const active = h.document.activeElement;
      assert.strictEqual(
        active?.getAttribute('data-row-path'),
        'src/b.ts',
        'focus must land on the same file, not fall to <body>'
      );
    });

    it('double-clicking an unresolved row asks the host to open the merge view', () => {
      h = boot();
      const row = h.document.querySelector('[data-row-path="src/a.ts"]') as HTMLElement;
      row.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));
      assert.deepStrictEqual(
        h.posted.filter((m) => (m as { type?: string }).type === 'openMergeView'),
        [{ type: 'openMergeView', path: 'src/a.ts' }]
      );
    });

    it('rows are keyboard-reachable: arrows move focus, Enter opens the merge view', () => {
      h = boot();
      const rows = Array.from(h.document.querySelectorAll<HTMLElement>('[data-row-path]'));
      assert.ok(
        rows.every((r) => r.getAttribute('tabindex') === '0'),
        'every row is focusable'
      );

      rows[0].focus();
      rows[0].dispatchEvent(
        new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
      );
      assert.strictEqual(h.document.activeElement, rows[1], 'ArrowDown moves to the next row');
      rows[1].dispatchEvent(
        new h.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })
      );
      assert.strictEqual(h.document.activeElement, rows[0], 'ArrowUp moves back');

      rows[0].dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      assert.deepStrictEqual(
        h.posted.filter((m) => (m as { type?: string }).type === 'openMergeView'),
        [{ type: 'openMergeView', path: 'src/a.ts' }],
        'Enter merges the focused row'
      );
    });

    it('Enter on an in-row button fires only that button', () => {
      // The browser already turns Enter on a focused button into a click; the
      // roving handler must not ALSO resolve the row and fire a second action.
      h = boot();
      const row = h.document.querySelector('[data-row-path="src/a.ts"]') as HTMLElement;
      const button = row.querySelector('button') as HTMLElement;
      assert.ok(button, 'the row carries in-row action buttons');

      button.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      assert.deepStrictEqual(
        h.posted.filter((m) => (m as { type?: string }).type === 'openMergeView'),
        [],
        'the roving handler ignores keys aimed at an interactive control'
      );
    });

    it('Enter on a resolved row does nothing', () => {
      h = boot();
      const resolved = h.document.querySelector('[data-row-path="src/b.ts"]') as HTMLElement;
      resolved.dispatchEvent(
        new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
      assert.ok(
        !h.posted.some((m) => (m as { type?: string }).type === 'openMergeView'),
        'a resolved file has nothing to merge'
      );
    });

    it('applies a fileResolved status update without throwing', () => {
      h = boot();
      h.post({ type: 'fileResolved', path: 'src/a.ts' });
      for (const msg of GARBAGE_MESSAGES) {
        h.post(msg);
      }
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
    });
  });
});
