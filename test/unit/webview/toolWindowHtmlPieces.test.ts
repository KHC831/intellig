/**
 * Webview client-script tests for the tabbed Git tool-window HTML pieces.
 *
 * These render the real body HTML from the pure string builders and run the
 * real inline behavior scripts under jsdom, asserting they load without
 * throwing, wire their DOM, and tolerate extension→webview messages. This is
 * the layer that catches a renderer-only regression (a createElement slip, a
 * null query) that no extension-host / e2e lane can see.
 *
 * Files exercised: commonHtml.ts (tabStripBehaviorScript), historyHtml.ts
 * (historyTabBehaviorScript), htmlBuilders.ts (buildNoRepositoryHtml inline
 * script), stylesBuilder.ts (buildInlineStyles — mounted as a stylesheet).
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  renderTabStrip,
  renderTabPanels,
  tabStripBehaviorScript,
} from '../../../src/git-core/gitToolWindow/html/commonHtml';
import {
  renderHistoryTabBody,
  historyTabBehaviorScript,
} from '../../../src/git-core/gitToolWindow/html/historyHtml';
import { buildNoRepositoryHtml } from '../../../src/git-core/gitToolWindow/provider/htmlBuilders';
import { buildInlineStyles } from '../../../src/git-core/gitToolWindow/provider/stylesBuilder';
import {
  createInitialHistoryTabState,
  type IHistoryTabState,
} from '../../../src/git-core/gitToolWindow/tabs/HistoryTab';
import type { ICommit } from '../../../src/git-core/interfaces/IGitService';
import { runWebviewScript, IWebviewHarness } from '../../helpers/webviewHarness';
import { extractWebviewScript } from '../../helpers/webviewHtml';

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

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  describe('commonHtml — tab strip behavior script', () => {
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
      h = runWebviewScript(tabStripBehaviorScript(), { bodyHtml });
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      assert.ok(h.document.querySelector('.intellig-tab-strip'), 'tab strip present');
    });

    it('posts tabChange when a tab button is clicked', () => {
      h = runWebviewScript(tabStripBehaviorScript(), { bodyHtml });
      const historyTab = h.document.querySelector<HTMLButtonElement>('[data-tab="history"]');
      assert.ok(historyTab, 'history tab button built');
      historyTab.click();
      assert.deepEqual(h.posted.at(-1), { type: 'tabChange', tab: 'history' });
    });

    it('tolerates unknown extension→webview messages without throwing', () => {
      h = runWebviewScript(tabStripBehaviorScript(), { bodyHtml });
      for (const msg of GARBAGE_MESSAGES) {
        h.post(msg);
      }
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
    });
  });

  describe('historyHtml — history tab behavior script', () => {
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
      h = runWebviewScript(historyTabBehaviorScript(), {
        bodyHtml: renderHistoryTabBody(loadedState()),
      });
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      assert.ok(h.document.querySelector('.history-commit-row'), 'a commit row is rendered');
    });

    it('posts history.selectRevision when a commit row is clicked', () => {
      h = runWebviewScript(historyTabBehaviorScript(), {
        bodyHtml: renderHistoryTabBody(loadedState()),
      });
      const row = h.document.querySelector<HTMLElement>('.history-commit-row');
      assert.ok(row, 'commit row built');
      row.click();
      assert.deepEqual(h.posted.at(-1), {
        type: 'history.selectRevision',
        rev: 'a'.repeat(40),
        additive: false,
      });
    });

    it('loads against the empty-state body and tolerates garbage messages', () => {
      h = runWebviewScript(historyTabBehaviorScript(), {
        bodyHtml: renderHistoryTabBody(),
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

  describe('htmlBuilders — no-repository inline script', () => {
    function noRepoHtml(): string {
      const ctx = {
        getNonce: () => 'test-nonce',
        getInlineStyles: () => buildInlineStyles(),
      } as unknown as Parameters<typeof buildNoRepositoryHtml>[0];
      const webview = { cspSource: 'vscode-webview://mock' } as unknown as vscode.Webview;
      return buildNoRepositoryHtml(ctx, webview);
    }

    it('loads without throwing and builds the init button', () => {
      const { script, bodyHtml } = extractWebviewScript(noRepoHtml());
      h = runWebviewScript(script, { bodyHtml });
      assert.deepStrictEqual(
        h.errors.map((e) => e.message),
        []
      );
      assert.ok(h.document.getElementById('init-repo-btn'), 'init-repo button present');
    });

    it('posts initRepository when the init button is clicked', () => {
      const { script, bodyHtml } = extractWebviewScript(noRepoHtml());
      h = runWebviewScript(script, { bodyHtml });
      h.document.getElementById('init-repo-btn')?.click();
      assert.deepEqual(h.posted.at(-1), { type: 'initRepository' });
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
