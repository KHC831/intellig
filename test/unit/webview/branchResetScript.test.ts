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
  let h: IWebviewEntryHarness;

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
    function html(protectedBranches: string[] = []): string {
      const repo = attachedRepo();
      const dialog = new ResetDialog(makeExtensionContext(), {
        repo,
        target: { hash: 'a'.repeat(40), subject: 'Initial commit' },
        currentBranch: 'main',
        protectedBranches,
        gitService: createMockGitService(repo),
      });
      return panelHtml(dialog);
    }

    function boot(protectedBranches: string[] = []): IWebviewEntryHarness {
      return bootWebviewEntry('ui-shell/webview/resetDialog', {
        bodyHtml: extractWebviewScript(html(protectedBranches)).bodyHtml,
      });
    }

    it('loads without throwing and builds the reset-mode radios + reset button', () => {
      h = boot();
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      assert.ok(h.document.querySelector('input[name="reset-mode"]'), 'reset-mode radios built');
      assert.ok(h.document.getElementById('reset-btn'), 'reset button built');
    });

    it('posts cancel when the cancel button is clicked', () => {
      h = boot();
      h.document.getElementById('cancel-btn')?.click();
      assert.deepEqual(h.posted.at(-1), { type: 'cancel' });
    });

    // The harness builds the dialog with `protectedBranches: []`, so all four
    // radios are enabled and selectable; the entry must post whichever mode is
    // checked. (The protected-branch disabling of Hard/Keep is a host concern,
    // covered in resetDialog.test.ts.)
    for (const mode of ['soft', 'mixed', 'hard', 'keep'] as const) {
      it(`posts reset with mode '${mode}' when the Reset button is clicked`, () => {
        h = boot();
        const radio = h.document.querySelector<HTMLInputElement>(
          `input[name="reset-mode"][value="${mode}"]`
        );
        assert.ok(radio, `${mode} radio present`);
        radio.checked = true;
        h.document.getElementById('reset-btn')?.click();
        assert.deepEqual(h.posted.at(-1), { type: 'reset', mode });
      });
    }

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

    it('on a protected branch, disables Hard/Keep and carries the tooltip on those rows', () => {
      h = boot(['main']);
      const rowFor = (mode: string): HTMLLabelElement | null =>
        h.document.querySelector<HTMLLabelElement>(`label.mode[data-mode="${mode}"]`);
      const inputFor = (mode: string): HTMLInputElement | null =>
        h.document.querySelector<HTMLInputElement>(`input[name="reset-mode"][value="${mode}"]`);

      for (const mode of ['hard', 'keep']) {
        assert.strictEqual(inputFor(mode)?.disabled, true, `${mode} radio disabled`);
        assert.match(
          rowFor(mode)?.getAttribute('title') ?? '',
          /protected branch/i,
          `${mode} row carries the protected-branch tooltip`
        );
      }
      for (const mode of ['soft', 'mixed']) {
        assert.strictEqual(inputFor(mode)?.disabled, false, `${mode} radio enabled`);
        assert.strictEqual(rowFor(mode)?.getAttribute('title'), null, `${mode} row has no tooltip`);
      }
    });
  });
});
