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

    function html(): string {
      const repo = attachedRepo();
      const dialog = new ResolveConflictsDialog(
        makeExtensionContext(),
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
      return panelHtml(dialog);
    }

    function boot(): IWebviewEntryHarness {
      return bootWebviewEntry('conflicts/webview/resolveConflictsDialog', {
        bodyHtml: extractWebviewScript(html()).bodyHtml,
      });
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
