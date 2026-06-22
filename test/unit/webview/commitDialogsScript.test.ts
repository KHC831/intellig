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
import type { IGitService } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
import { runWebviewScript, IWebviewHarness } from '../../helpers/webviewHarness';
import { extractWebviewScript } from '../../helpers/webviewHtml';
import { makeExtensionContext, panelHtml } from '../../helpers/mockWebviewContext';

const GARBAGE_MESSAGES: unknown[] = [
  { type: 'totally-unknown-message' },
  { type: undefined },
  { foo: 'bar' },
  {},
];

describe('webview: commit-flow dialog scripts (jsdom)', () => {
  let h: IWebviewHarness;

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

    it('loads without throwing and builds the message textarea seeded with the squash message', () => {
      const { script, bodyHtml } = extractWebviewScript(html());
      h = runWebviewScript(script, { bodyHtml });
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      const textarea = h.document.querySelector<HTMLTextAreaElement>('textarea');
      assert.ok(textarea, 'textarea built');
      assert.ok(textarea.value.includes('pick a'), 'textarea seeded with squash message');
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
