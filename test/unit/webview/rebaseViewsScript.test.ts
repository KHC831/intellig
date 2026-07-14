/**
 * Webview client-script tests for the rebase webviews.
 *
 * RebaseDialog (BaseWebviewPanel) ships an empty `#root`; RebaseEditor and
 * RebaseProgressView expose `_getScript()` over their own `#rebase-root` /
 * `#progress-root` skeletons. Each script builds its UI via
 * document.createElement. We run the real scripts under jsdom and assert they
 * load, build their controls, and tolerate messages — the renderer-only
 * regression class no extension-host / e2e lane can see.
 *
 * Files exercised: RebaseDialog.ts, RebaseEditor.ts, RebaseProgressView.ts.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { RebaseDialog } from '../../../src/rebase/RebaseDialog';
import { RebaseEditor } from '../../../src/rebase/RebaseEditor';
import { RebaseProgressView } from '../../../src/rebase/RebaseProgressView';
import type {
  IRebaseService,
  IRebaseSession,
} from '../../../src/git-core/interfaces/IRebaseService';
import { createMockGitService, attachedRepo } from '../../mocks/mockGitService';
import { Uri } from '../../mocks/vscode';
import { runWebviewScript, IWebviewHarness } from '../../helpers/webviewHarness';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import { extractWebviewScript } from '../../helpers/webviewHtml';
import { initIslandHtml } from '../../../src/utils/webviewInit';
import { makeExtensionContext, panelHtml } from '../../helpers/mockWebviewContext';

const GARBAGE_MESSAGES: unknown[] = [
  { type: 'totally-unknown-message' },
  { type: undefined },
  { foo: 'bar' },
  {},
];

function stubRebaseService(): IRebaseService {
  const emitter = new vscode.EventEmitter<IRebaseSession | undefined>();
  return {
    onDidChangeRebaseSession: emitter.event,
    dispose: (): void => emitter.dispose(),
  } as unknown as IRebaseService;
}

describe('webview: rebase view scripts (jsdom)', () => {
  let h: IWebviewHarness | IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  describe('RebaseDialog', () => {
    function html(): string {
      const repo = attachedRepo();
      const dialog = new RebaseDialog(makeExtensionContext(), {
        repo,
        onto: 'main',
        branchChoices: ['main', 'develop'],
        gitService: createMockGitService(repo),
        createRebaseEditor: () => new RebaseEditor(Uri.file('/tmp/ext'), stubRebaseService()),
      });
      return panelHtml(dialog);
    }

    function boot(): IWebviewEntryHarness {
      return bootWebviewEntry('rebase/webview/rebaseDialog', {
        bodyHtml: extractWebviewScript(html()).bodyHtml,
      });
    }

    it('loads without throwing and builds the onto select + rebase/cancel buttons', () => {
      h = boot();
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      assert.ok(h.document.getElementById('onto-select'), 'onto select built');
      assert.ok(h.document.getElementById('rebase-btn'), 'rebase button built');
    });

    it('posts cancel when the cancel button is clicked', () => {
      h = boot();
      h.document.getElementById('cancel-btn')?.click();
      assert.deepEqual(h.posted.at(-1), { type: 'cancel' });
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

  describe('RebaseEditor', () => {
    function script(): string {
      const editor = new RebaseEditor(Uri.file('/tmp/ext'), stubRebaseService());
      return (editor as unknown as { _getScript(): string })._getScript();
    }

    it('loads against the #rebase-root skeleton without throwing and builds the footer', () => {
      h = runWebviewScript(script(), {
        bodyHtml: '<div class="rebase-editor" id="rebase-root"></div>',
      });
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      assert.ok(h.document.querySelector('button[data-action="cancel"]'), 'cancel button built');
    });

    it('tolerates garbage messages without throwing', () => {
      h = runWebviewScript(script(), {
        bodyHtml: '<div class="rebase-editor" id="rebase-root"></div>',
      });
      for (const msg of GARBAGE_MESSAGES) {
        h.post(msg);
      }
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
    });
  });

  describe('RebaseProgressView', () => {
    function boot(): IWebviewEntryHarness {
      const view = new RebaseProgressView(Uri.file('/tmp/ext'), stubRebaseService());
      const init = (view as unknown as { _getInit(): unknown })._getInit();
      const bodyHtml =
        '<div class="rebase-progress" id="progress-root"></div>' + initIslandHtml(init);
      return bootWebviewEntry('rebase/webview/rebaseProgressView', { bodyHtml });
    }

    it('loads against the #progress-root skeleton without throwing', () => {
      h = boot();
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
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
});
