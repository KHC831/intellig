/**
 * Webview client-script test for the full Git tool-window document assembled by
 * GitToolWindowProvider.
 *
 * `_getThreePanelHtmlContent` composes the graph/details panels, the codicon
 * font CSS, the three-panel styles, and the concatenated inline scripts
 * (initial-details island + buildInlineScript + divider-drag + column-resize).
 * Running that whole composite under jsdom catches a renderer regression in the
 * assembled document — wiring that the isolated buildInlineScript test cannot
 * see — which no extension-host / e2e lane exercises.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitToolWindowProvider } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';
import type { ICommitNode } from '../../../src/git-core/commitGraph';
import { Uri } from '../../mocks/vscode';
import { runWebviewScript, IWebviewHarness } from '../../helpers/webviewHarness';
import { extractWebviewScript } from '../../helpers/webviewHtml';

const GARBAGE_MESSAGES: unknown[] = [
  { type: 'totally-unknown-message' },
  { type: undefined },
  { foo: 'bar' },
  {},
];

function mockWebview(): vscode.Webview {
  return {
    cspSource: 'vscode-webview://mock',
    asWebviewUri: (uri: Uri): Uri => uri,
  } as unknown as vscode.Webview;
}

function fullHtml(): string {
  const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  // `_getThreePanelHtmlContent` is the public (testability) entry point that
  // produces the complete `<!DOCTYPE html>` document. Empty commitNodes render
  // the loaded-but-empty graph — enough to exercise the inline script wiring.
  return provider._getThreePanelHtmlContent(mockWebview(), [] as ICommitNode[]);
}

function fullHtmlWithRepos(paths: string[]): string {
  const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  provider.setAvailableRepositories(
    paths.map((p) => ({
      rootUri: Uri.file(p),
      state: 'idle' as const,
      remotes: [],
      submodules: [],
    })) as Parameters<typeof provider.setAvailableRepositories>[0]
  );
  // Pin the merged "all" scope so every repo checkbox starts checked, making the
  // uncheck-one assertion independent of the test config's showAllRoots default.
  (
    provider as unknown as { _handleRepositorySelection(s: number | 'all'): void }
  )._handleRepositorySelection('all');
  return provider._getThreePanelHtmlContent(mockWebview(), [] as ICommitNode[]);
}

describe('webview: Git tool-window full document (jsdom)', () => {
  let h: IWebviewHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('loads the composed inline scripts without throwing and builds the panels', () => {
    const { script, bodyHtml } = extractWebviewScript(fullHtml());
    h = runWebviewScript(script, { bodyHtml });
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
    assert.ok(h.document.getElementById('graph-panel'), 'graph panel present');
    assert.ok(h.document.getElementById('details-panel'), 'details panel present');
  });

  it('graphTotalsUpdate updates the load-count attributes without rebuilding the panel', () => {
    const { script, bodyHtml } = extractWebviewScript(fullHtml());
    h = runWebviewScript(script, { bodyHtml });
    const panel = h.document.querySelector('.graph-panel');
    assert.ok(panel, 'graph panel present');
    h.post({ type: 'graphTotalsUpdate', loaded: 100, total: 5000 });
    assert.strictEqual(
      panel.getAttribute('data-total-available'),
      '5000',
      'late total re-enables load-more by updating the attribute the scroll handler reads'
    );
    assert.strictEqual(panel.getAttribute('data-loaded-count'), '100');
    // Same panel element — a lightweight attribute update, not a rebuild.
    assert.strictEqual(h.document.querySelector('.graph-panel'), panel, 'panel not replaced');
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
  });

  it('posts a selectRepositories subset when a repo checkbox is unchecked', () => {
    const { script, bodyHtml } = extractWebviewScript(
      fullHtmlWithRepos(['/work/repo-a', '/work/repo-b', '/work/repo-c'])
    );
    h = runWebviewScript(script, { bodyHtml });

    const list = h.document.getElementById('filter-repo-list');
    assert.ok(list, 'repo checkbox list present in a multi-root workspace');
    const boxes = Array.from(list.querySelectorAll<HTMLInputElement>('input[data-repo-root]'));
    assert.strictEqual(boxes.length, 3, 'a checkbox per repo');
    // Default scope is all → every box checked. Uncheck repo-b and fire change.
    const repoB = boxes.find((b) => b.getAttribute('data-repo-root') === '/work/repo-b')!;
    repoB.checked = false;
    repoB.dispatchEvent(new h.window.Event('change', { bubbles: true }));

    const last = h.posted.filter(
      (m): m is { type: string; roots: string[] } =>
        !!m && (m as { type?: string }).type === 'selectRepositories'
    );
    assert.strictEqual(last.length, 1, 'exactly one selectRepositories post');
    // `roots` is a jsdom-realm array; copy into a Node array so deepStrictEqual
    // compares contents (cross-realm prototypes otherwise never match).
    assert.deepStrictEqual(
      Array.from(last[0].roots).sort(),
      ['/work/repo-a', '/work/repo-c'],
      'posts only the still-checked roots'
    );
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
  });

  it('unchecking every repo posts an empty set and labels the button "None"', () => {
    const { script, bodyHtml } = extractWebviewScript(
      fullHtmlWithRepos(['/work/repo-a', '/work/repo-b'])
    );
    h = runWebviewScript(script, { bodyHtml });

    const list = h.document.getElementById('filter-repo-list')!;
    const boxes = Array.from(list.querySelectorAll<HTMLInputElement>('input[data-repo-root]'));
    for (const box of boxes) {
      box.checked = false;
      box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    }

    const repoPosts = h.posted.filter(
      (m): m is { type: string; roots: string[] } =>
        !!m && (m as { type?: string }).type === 'selectRepositories'
    );
    assert.deepStrictEqual(
      Array.from(repoPosts[repoPosts.length - 1].roots),
      [],
      'last post carries no roots (show none)'
    );
    // The button reads "None", and the All-repositories box does not re-check.
    assert.strictEqual(h.document.getElementById('filter-repo-value')!.textContent, 'None');
    const allBox = list.querySelector<HTMLInputElement>('input[data-action="toggleAllRepos"]')!;
    assert.strictEqual(allBox.checked, false, '"All repositories" stays unchecked');
  });

  it('remembers an open repo popup so a graph-reloading pick keeps it open', () => {
    const { script, bodyHtml } = extractWebviewScript(
      fullHtmlWithRepos(['/work/repo-a', '/work/repo-b'])
    );
    h = runWebviewScript(script, { bodyHtml });

    // Open the Repository popup the way a click does.
    const btn = h.document.querySelector<HTMLElement>(
      '[data-action="toggleFilterPopup"][data-popup="repo"]'
    );
    assert.ok(btn, 'Repository popup button present');
    btn.dispatchEvent(new h.window.Event('click', { bubbles: true }));

    // The open popup is persisted so it can be restored after a re-render.
    assert.strictEqual(
      (h.readState() as { openFilterPopup?: string }).openFilterPopup,
      'repo',
      'open repo popup is remembered in webview state'
    );
  });

  it('reopens the remembered popup on init (after a re-render) without throwing', () => {
    const { script, bodyHtml } = extractWebviewScript(
      fullHtmlWithRepos(['/work/repo-a', '/work/repo-b'])
    );
    // Simulate the post-pick reload: VS Code rehydrates state with the popup open.
    h = runWebviewScript(script, { bodyHtml, initialState: { openFilterPopup: 'repo' } });

    const popup = h.document.getElementById('filter-popup-repo');
    assert.ok(popup, 'repo popup present');
    assert.strictEqual(popup.hidden, false, 'remembered popup is reopened on init');
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
  });

  it('tolerates representative and garbage extension→webview messages', () => {
    const { script, bodyHtml } = extractWebviewScript(fullHtml());
    h = runWebviewScript(script, { bodyHtml });
    h.post({ type: 'update', commits: [], branches: [], tags: [] });
    h.post({ type: 'selectGraphRow', commitHash: 'abc' });
    h.post({ type: 'scrollToCommit', commitHash: 'abc' });
    for (const msg of GARBAGE_MESSAGES) {
      h.post(msg);
    }
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
  });
});
