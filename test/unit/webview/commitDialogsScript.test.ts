/**
 * Webview client-script tests for the commit-flow dialogs.
 *
 * CommitDialog and SquashMessageDialog ship an empty root + a nonce'd inline
 * script that builds the body via document.createElement from a JSON init
 * island. We run the real scripts under jsdom and assert they load, build the
 * root, and tolerate messages — the renderer-only regression class no
 * extension-host / e2e lane can see.
 *
 * Files exercised: CommitDialog.ts, SquashMessageDialog.ts.
 */

import '../../setup';
import * as assert from 'assert';
import { CommitDialog } from '../../../src/commits/CommitDialog';
import { SquashMessageDialog } from '../../../src/commits/SquashMessageDialog';
import { CommitMessageDialog } from '../../../src/commits/CommitMessageDialog';
import type { IGitService } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
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

describe('webview: commit-flow dialog scripts (jsdom)', () => {
  let h: IWebviewHarness | IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  describe('CommitDialog', () => {
    function script(): string {
      const dialog = new CommitDialog(Uri.file('/tmp/ext'), {} as IGitService);
      return (dialog as unknown as { _getScript(): string })._getScript();
    }

    it('loads without throwing and builds the message + files sections', () => {
      h = runWebviewScript(script(), {
        bodyHtml: '<div class="commit-dialog" id="root"></div>',
      });
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      assert.ok(h.document.getElementById('commit-message'), 'message textarea built');
      assert.ok(h.document.querySelector('.files-section'), 'files section built');
    });

    it('tolerates representative and garbage messages without throwing', () => {
      h = runWebviewScript(script(), {
        bodyHtml: '<div class="commit-dialog" id="root"></div>',
      });
      h.post({ type: 'update', files: [] });
      for (const msg of GARBAGE_MESSAGES) {
        h.post(msg);
      }
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
    });
  });

  describe('SquashMessageDialog', () => {
    function html(): string {
      const dialog = new SquashMessageDialog(makeExtensionContext(), {
        seedMessage: 'pick a\npick b',
        commitCount: 2,
      });
      // `_render()` builds the full document (constructor defers it to prompt()).
      (dialog as unknown as { _render(): void })._render();
      return panelHtml(dialog);
    }

    function boot(): IWebviewEntryHarness {
      return bootWebviewEntry('commits/webview/commitMessageDialog', {
        bodyHtml: extractWebviewScript(html()).bodyHtml,
      });
    }

    it('loads without throwing and builds the message textarea seeded with the squash message', () => {
      h = boot();
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      const textarea = h.document.querySelector<HTMLTextAreaElement>('textarea');
      assert.ok(textarea, 'textarea built');
      assert.ok(textarea.value.includes('pick a'), 'textarea seeded with squash message');
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

  describe('CommitMessageDialog (reword preset — the base that owns the script)', () => {
    function html(): string {
      const dialog = new CommitMessageDialog(makeExtensionContext(), {
        seedMessage: 'subject\n\nbody line',
        viewType: 'intellig.editMessageDialog',
        title: 'Edit Commit Message',
        heading: 'Edit commit message',
        submitLabel: 'Update Message',
        submitVerb: 'save',
      });
      (dialog as unknown as { _render(): void })._render();
      return panelHtml(dialog);
    }

    function boot(): IWebviewEntryHarness {
      return bootWebviewEntry('commits/webview/commitMessageDialog', {
        bodyHtml: extractWebviewScript(html()).bodyHtml,
      });
    }

    it('builds the textarea seeded with the multi-line message and a save-labelled submit', () => {
      h = boot();
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      const textarea = h.document.querySelector<HTMLTextAreaElement>('textarea');
      assert.ok(textarea, 'textarea built');
      assert.ok(textarea.value.includes('body line'), 'textarea seeded with the multi-line body');
      const submit = h.document.querySelector('#submit-btn');
      assert.strictEqual(submit?.textContent, 'Update Message', 'submit carries the preset label');
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
