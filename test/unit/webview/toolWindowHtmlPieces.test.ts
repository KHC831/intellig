/**
 * Webview client-script tests for the tabbed Git tool-window HTML pieces.
 *
 * These render the real body HTML from the pure string builders and run the
 * real inline behavior scripts under jsdom, asserting they load without
 * throwing, wire their DOM, and tolerate extension→webview messages. This is
 * the layer that catches a renderer-only regression (a createElement slip, a
 * null query) that no extension-host / e2e lane can see.
 *
 * The tab-strip switch and History-tab actions now ship in the bundled
 * `gitToolWindow.js` entry (booted here), so those blocks drive the real entry
 * over the rendered body. htmlBuilders.ts (buildNoRepositoryHtml inline script)
 * and stylesBuilder.ts (buildInlineStyles) still ship inline and run as before.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  renderTabStrip,
  renderTabPanels,
} from '../../../src/git-core/gitToolWindow/html/commonHtml';
import { renderHistoryTabBody } from '../../../src/git-core/gitToolWindow/html/historyHtml';
import { buildNoRepositoryHtml } from '../../../src/git-core/gitToolWindow/provider/htmlBuilders';
import { buildInlineStyles } from '../../../src/git-core/gitToolWindow/provider/stylesBuilder';
import {
  createInitialHistoryTabState,
  type IHistoryTabState,
} from '../../../src/git-core/gitToolWindow/tabs/HistoryTab';
import type { ICommit } from '../../../src/git-core/interfaces/IGitService';
import { runWebviewScript, IWebviewHarness } from '../../helpers/webviewHarness';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

const GTW_ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';

const GARBAGE_MESSAGES: unknown[] = [
  { type: 'totally-unknown-message' },
  { type: undefined },
  { foo: 'bar' },
  {},
];

function makeCommit(): ICommit {
  const date = new Date('2024-01-01T00:00:00Z');
  return {
    hash: 'a'.repeat(40),
    shortHash: 'aaaaaaa',
    message: 'Initial commit',
    author: { name: 'Ada', email: 'ada@example.com' },
    committer: { name: 'Ada', email: 'ada@example.com' },
    parents: [],
    authorDate: date,
    commitDate: date,
  };
}

describe('webview: git tool-window HTML pieces (jsdom)', () => {
  let h: IWebviewHarness;
  let entry: IWebviewEntryHarness | undefined;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
    if (entry) {
      entry.dispose();
      entry = undefined;
    }
  });

  describe('commonHtml — tab strip switch (bundled entry)', () => {
    const bodyHtml =
      renderTabStrip('log') +
      renderTabPanels({
        activeTab: 'log',
        logBodyHtml: '<div class="log-body"></div>',
        consoleBodyHtml: '',
        incomingBodyHtml: '',
        updateInfoBodyHtml: '',
        historyBodyHtml: '',
      });

    it('loads without throwing and builds the tab strip', () => {
      entry = bootWebviewEntry(GTW_ENTRY, { bodyHtml });
      assert.deepStrictEqual(
        entry.errors.map((e) => e.message),
        []
      );
      assert.ok(entry.document.querySelector('.intellig-tab-strip'), 'tab strip present');
    });

    it('posts tabChange when a tab button is clicked', () => {
      entry = bootWebviewEntry(GTW_ENTRY, { bodyHtml });
      const historyTab = entry.document.querySelector<HTMLButtonElement>('[data-tab="history"]');
      assert.ok(historyTab, 'history tab button built');
      historyTab.click();
      assert.deepEqual(entry.posted.at(-1), { type: 'tabChange', tab: 'history' });
    });

    it('tolerates unknown extension→webview messages without throwing', () => {
      entry = bootWebviewEntry(GTW_ENTRY, { bodyHtml });
      for (const msg of GARBAGE_MESSAGES) {
        entry.post(msg);
      }
      assert.deepStrictEqual(
        entry.errors.map((e) => e.message),
        []
      );
    });
  });

  describe('historyHtml — History tab actions (bundled entry)', () => {
    function loadedState(): IHistoryTabState {
      const commit = makeCommit();
      return {
        ...createInitialHistoryTabState(),
        filePath: 'src/foo.ts',
        commits: [commit],
        selectedCommit: commit.hash,
      };
    }

    it('loads against the rendered loaded-state body without throwing', () => {
      entry = bootWebviewEntry(GTW_ENTRY, { bodyHtml: renderHistoryTabBody(loadedState()) });
      assert.deepStrictEqual(
        entry.errors.map((e) => e.message),
        []
      );
      assert.ok(entry.document.querySelector('.history-commit-row'), 'a commit row is rendered');
    });

    it('posts history.selectRevision when a commit row is clicked', () => {
      entry = bootWebviewEntry(GTW_ENTRY, { bodyHtml: renderHistoryTabBody(loadedState()) });
      const row = entry.document.querySelector<HTMLElement>('.history-commit-row');
      assert.ok(row, 'commit row built');
      row.click();
      assert.deepEqual(entry.posted.at(-1), {
        type: 'history.selectRevision',
        rev: 'a'.repeat(40),
        additive: false,
      });
    });

    it('loads against the empty-state body and tolerates garbage messages', () => {
      entry = bootWebviewEntry(GTW_ENTRY, { bodyHtml: renderHistoryTabBody() });
      for (const msg of GARBAGE_MESSAGES) {
        entry.post(msg);
      }
      assert.deepStrictEqual(
        entry.errors.map((e) => e.message),
        []
      );
    });
  });

  describe('htmlBuilders — no-repository document (bundled entry)', () => {
    function noRepoHtml(): string {
      const ctx = {
        getNonce: () => 'test-nonce',
        getInlineStyles: () => buildInlineStyles(),
        getWebviewBundleUri: () => 'vscode-webview://mock/media/webview/gitToolWindow.js',
      } as unknown as Parameters<typeof buildNoRepositoryHtml>[0];
      const webview = { cspSource: 'vscode-webview://mock' } as unknown as vscode.Webview;
      return buildNoRepositoryHtml(ctx, webview);
    }

    /** Inner HTML of the assembled document's `<body>`. */
    function bodyOf(html: string): string {
      const match = /<body>([\s\S]*)<\/body>/.exec(html);
      return match ? match[1] : html;
    }

    it('loads without throwing and builds the init button', () => {
      entry = bootWebviewEntry(GTW_ENTRY, { bodyHtml: bodyOf(noRepoHtml()) });
      assert.deepStrictEqual(
        entry.errors.map((e) => e.message),
        []
      );
      assert.ok(entry.document.getElementById('init-repo-btn'), 'init-repo button present');
    });

    it('posts initRepository when the init button is clicked', () => {
      entry = bootWebviewEntry(GTW_ENTRY, { bodyHtml: bodyOf(noRepoHtml()) });
      entry.document.getElementById('init-repo-btn')?.click();
      assert.deepEqual(entry.posted.at(-1), { type: 'initRepository' });
    });
  });

  describe('stylesBuilder — inline styles mount as a stylesheet', () => {
    it('parses as CSS in jsdom without raising a script/parse error', () => {
      // stylesBuilder ships no behavior script, but its CSS is part of the
      // tool-window document. Mount it as a <style> and assert jsdom parses at
      // least one rule (a malformed string would parse to zero rules / throw).
      h = runWebviewScript('void 0;', { bodyHtml: `<style>${buildInlineStyles()}</style>` });
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      const sheet = h.document.styleSheets[0];
      assert.ok(sheet, 'a stylesheet is registered');
      assert.ok(sheet.cssRules.length > 0, 'buildInlineStyles produced parseable CSS rules');
    });
  });
});
