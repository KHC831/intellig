/**
 * Webview client-script tests for the Push and Apply-Patch dialogs.
 *
 * Both extend BaseWebviewPanel, ship an empty `#root`, and build their UI via
 * document.createElement in a nonce'd inline script. We run the real scripts
 * under jsdom and assert they load, build their controls, wire a button, and
 * tolerate messages — the renderer-only regression class no other lane sees.
 *
 * Files exercised: PushDialog.ts, ApplyPatchDialog.ts.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { PushDialog } from '../../../src/sync/PushDialog';
import { ApplyPatchDialog } from '../../../src/patches/ApplyPatchDialog';
import type { IPatchService } from '../../../src/patches/interfaces/IPatchService';
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

describe('webview: sync + patch dialog scripts (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  describe('PushDialog', () => {
    function html(): string {
      const repo = attachedRepo();
      const dialog = new PushDialog(makeExtensionContext(), {
        repos: [repo],
        gitService: createMockGitService(repo),
        protectedBranches: [],
      });
      return panelHtml(dialog);
    }

    function boot(): IWebviewEntryHarness {
      return bootWebviewEntry('sync/webview/pushDialog', {
        bodyHtml: extractWebviewScript(html()).bodyHtml,
      });
    }

    it('loads without throwing and builds the push + cancel buttons', () => {
      h = boot();
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      assert.ok(h.document.getElementById('push-btn'), 'push button built');
      assert.ok(h.document.getElementById('cancel-btn'), 'cancel button built');
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

  describe('ApplyPatchDialog', () => {
    function html(): string {
      const dialog = new ApplyPatchDialog(makeExtensionContext(), {
        repo: { rootUri: vscode.Uri.file('/repo') } as never,
        patchService: {} as IPatchService,
        initialPatchPath: '/tmp/fix.patch',
      });
      return panelHtml(dialog);
    }

    function boot(): IWebviewEntryHarness {
      return bootWebviewEntry('patches/webview/applyPatchDialog', {
        bodyHtml: extractWebviewScript(html()).bodyHtml,
      });
    }

    it('loads without throwing and builds the patch inputs + action buttons', () => {
      h = boot();
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      assert.ok(h.document.getElementById('patchPath'), 'patch-path input built');
      assert.ok(h.document.getElementById('applyBtn'), 'apply button built');
    });

    it('posts cancel when the cancel button is clicked', () => {
      h = boot();
      h.document.getElementById('cancelBtn')?.click();
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
});
