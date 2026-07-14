/**
 * Webview client-script tests for the NewBranch and Reset dialogs.
 *
 * Both extend BaseWebviewPanel, ship an empty `#root`, and build their form via
 * document.createElement in a nonce'd inline script. We run the real scripts
 * under jsdom and assert they load, build the controls, wire a button, and
 * tolerate messages — the renderer-only regression class no other lane sees.
 *
 * Files exercised: NewBranchDialog.ts, ResetDialog.ts.
 */

import '../../setup';
import * as assert from 'assert';
import { NewBranchDialog } from '../../../src/branches/NewBranchDialog';
import { ResetDialog } from '../../../src/ui-shell/ResetDialog';
import { createMockGitService, attachedRepo } from '../../mocks/mockGitService';
import { runWebviewScript, IWebviewHarness } from '../../helpers/webviewHarness';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import { extractWebviewScript } from '../../helpers/webviewHtml';
import { makeExtensionContext, panelHtml } from '../../helpers/mockWebviewContext';

const GARBAGE_MESSAGES: unknown[] = [
  { type: 'totally-unknown-message' },
  { type: undefined },
  { foo: 'bar' },
  {},
];

describe('webview: branch + reset dialog scripts (jsdom)', () => {
  let h: IWebviewHarness | IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  describe('NewBranchDialog', () => {
    function html(): string {
      const repo = attachedRepo();
      const dialog = new NewBranchDialog(makeExtensionContext(), {
        repo,
        gitService: createMockGitService(repo),
        defaultName: 'feature/x',
      });
      return panelHtml(dialog);
    }

    function boot(): IWebviewEntryHarness {
      return bootWebviewEntry('branches/webview/main', {
        bodyHtml: extractWebviewScript(html()).bodyHtml,
      });
    }

    it('loads without throwing and builds the branch-name input + create button', () => {
      h = boot();
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      assert.ok(h.document.getElementById('branch-name'), 'branch-name input built');
      assert.ok(h.document.getElementById('create-btn'), 'create button built');
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

  describe('ResetDialog', () => {
    function html(): string {
      const repo = attachedRepo();
      const dialog = new ResetDialog(makeExtensionContext(), {
        repo,
        target: { hash: 'a'.repeat(40), subject: 'Initial commit' },
        currentBranch: 'main',
        protectedBranches: [],
        gitService: createMockGitService(repo),
      });
      return panelHtml(dialog);
    }

    it('loads without throwing and builds the reset-mode radios + reset button', () => {
      const { script, bodyHtml } = extractWebviewScript(html());
      h = runWebviewScript(script, { bodyHtml });
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      assert.ok(h.document.querySelector('input[name="reset-mode"]'), 'reset-mode radios built');
      assert.ok(h.document.getElementById('reset-btn'), 'reset button built');
    });

    it('posts cancel when the cancel button is clicked', () => {
      const { script, bodyHtml } = extractWebviewScript(html());
      h = runWebviewScript(script, { bodyHtml });
      h.document.getElementById('cancel-btn')?.click();
      assert.deepEqual(h.posted.at(-1), { type: 'cancel' });
    });

    it('tolerates garbage messages without throwing', () => {
      const { script, bodyHtml } = extractWebviewScript(html());
      h = runWebviewScript(script, { bodyHtml });
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
