/**
 * Webview client-script test for the full Git tool-window document assembled by
 * GitToolWindowProvider.
 *
 * `_getThreePanelHtmlContent` composes the graph/details panels, the codicon
 * font CSS, the three-panel styles, the `#intellig-init` details island, and the
 * external bundle `<script>` tag. This boots the real bundled entry over that
 * assembled body, catching a renderer regression in the composed document —
 * wiring that the isolated entry test cannot see — which no extension-host / e2e
 * lane exercises.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitToolWindowProvider } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';
import type { ICommitNode } from '../../../src/git-core/commitGraph';
import { Uri } from '../../mocks/vscode';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';

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

/** Inner HTML of the assembled document's `<body>` (island + panels + tags). */
function bodyOf(html: string): string {
  const match = /<body>([\s\S]*)<\/body>/.exec(html);
  assert.ok(match, 'assembled document has a <body>');
  return match[1];
}

function fullHtml(): string {
  const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  // `_getThreePanelHtmlContent` is the public (testability) entry point that
  // produces the complete `<!DOCTYPE html>` document. Empty commitNodes render
  // the loaded-but-empty graph — enough to exercise the client wiring.
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
  provider.repoScope.handleRepositorySelection('all');
  return provider._getThreePanelHtmlContent(mockWebview(), [] as ICommitNode[]);
}

describe('webview: Git tool-window full document (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('a date preset click applies the text the box SHOWS, not an older query', () => {
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setLogFilter({ searchText: 'fix' } as unknown as Parameters<
      typeof provider.setLogFilter
    >[0]);
    h = bootWebviewEntry(ENTRY, {
      bodyHtml: bodyOf(provider._getThreePanelHtmlContent(mockWebview(), [] as ICommitNode[])),
    });
    const input = h.document.getElementById('filter-search') as HTMLInputElement;
    input.value = 'fix par'; // half-typed, never committed
    input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    const preset = h.document.querySelector<HTMLElement>(
      '[data-action="pickDateFilter"][data-range="24h"]'
    );
    assert.ok(preset, 'the 24h preset exists');
    preset.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    const applies = h.posted.filter(
      (m): m is { type: string; filter: { searchText: string } } =>
        !!m && (m as { type?: string }).type === 'applyLogFilter'
    );
    const last = applies[applies.length - 1];
    // Every filter gesture applies what the user can see in the box. Sending
    // the older committed query instead would filter by something the UI does
    // not show, and leave the box displaying a query that was never applied.
    assert.strictEqual(
      last.filter.searchText,
      'fix par',
      'the preset applies the visible search text'
    );
  });

  it('typing in the search box posts the draft so the host can preserve it', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) });
    const input = h.document.getElementById('filter-search') as HTMLInputElement;
    input.value = 'par';
    input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    assert.ok(
      h.posted.some(
        (m) =>
          (m as { type?: string; text?: string }).type === 'logSearchDraft' &&
          (m as { text?: string }).text === 'par'
      ),
      `draft posted: ${JSON.stringify(h.posted)}`
    );
  });

  it('Enter in the search box commits the draft into the applied filter', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) });
    const input = h.document.getElementById('filter-search') as HTMLInputElement;
    input.value = 'committed now';
    input.dispatchEvent(
      new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    const applies = h.posted.filter(
      (m): m is { type: string; filter: { searchText: string } } =>
        !!m && (m as { type?: string }).type === 'applyLogFilter'
    );
    assert.strictEqual(applies[applies.length - 1]?.filter.searchText, 'committed now');
  });

  it('the 24h date preset posts an exact timestamp, not a calendar-day boundary', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) });
    const preset = h.document.querySelector<HTMLElement>(
      '[data-action="pickDateFilter"][data-range="24h"]'
    )!;
    preset.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    const applies = h.posted.filter(
      (m): m is { type: string; filter: { since: string | null } } =>
        !!m && (m as { type?: string }).type === 'applyLogFilter'
    );
    const since = applies[applies.length - 1]?.filter.since;
    assert.ok(since, 'preset posts a since value');
    const drift = Math.abs(Date.now() - 24 * 3600 * 1000 - Date.parse(since));
    assert.ok(drift < 60_000, `"Last 24 Hours" means exactly 24h ago, got drift ${drift}ms`);
  });

  it('the date preset travels with the filter so the host can name it', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) });
    const preset = h.document.querySelector<HTMLElement>(
      '[data-action="pickDateFilter"][data-range="7d"]'
    )!;
    preset.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    const applies = h.posted.filter(
      (m): m is { type: string; filter: { datePreset: string | null } } =>
        !!m && (m as { type?: string }).type === 'applyLogFilter'
    );
    assert.strictEqual(applies[applies.length - 1]?.filter.datePreset, '7d');
  });

  it('an explicit custom range clears the preset', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) });
    const preset = h.document.querySelector<HTMLElement>(
      '[data-action="pickDateFilter"][data-range="7d"]'
    )!;
    preset.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

    const box = h.document.getElementById('filter-after-enabled') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    h.document
      .querySelector<HTMLElement>('[data-action="applyDateCustom"]')!
      .dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

    const applies = h.posted.filter(
      (m): m is { type: string; filter: { datePreset: string | null } } =>
        !!m && (m as { type?: string }).type === 'applyLogFilter'
    );
    assert.strictEqual(applies[applies.length - 1]?.filter.datePreset, null);
  });

  it('checking a custom date bound seeds today instead of an empty field', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) });
    const box = h.document.getElementById('filter-after-enabled') as HTMLInputElement;
    const dateInput = h.document.getElementById('filter-after-date') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    assert.strictEqual(dateInput.disabled, false, 'checking enables the input');
    assert.ok(dateInput.value.length > 0, 'the input seeds with today, not empty');
  });

  it('Apply with a checked bound and empty date is rejected instead of silently clearing', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) });
    const box = h.document.getElementById('filter-after-enabled') as HTMLInputElement;
    const dateInput = h.document.getElementById('filter-after-date') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    dateInput.value = ''; // user cleared it after checking
    const before = h.posted.filter(
      (m) => (m as { type?: string }).type === 'applyLogFilter'
    ).length;
    const apply = h.document.querySelector<HTMLElement>('[data-action="applyDateCustom"]')!;
    apply.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    const after = h.posted.filter((m) => (m as { type?: string }).type === 'applyLogFilter').length;
    assert.strictEqual(after, before, 'an invalid custom range must not apply/clear the filter');
  });

  it('clicking the filter-row Jump button posts a jumpToCommitRequest', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) });
    const btn = h.document.querySelector<HTMLElement>('[data-action="jumpToCommit"]');
    assert.ok(btn, 'the Jump button renders in the filter row');
    btn.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    assert.ok(
      h.posted.some((m) => (m as { type?: string }).type === 'jumpToCommitRequest'),
      `jump request posted: ${JSON.stringify(h.posted)}`
    );
  });

  it('user popup: checking two author checkboxes posts an authors[] selection', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) });
    h.post({
      type: 'authorOptionsReady',
      authors: ['Jane <j@x.com>', 'Bob <b@x.com>', 'Zed <z@x.com>'],
    });
    const boxes = Array.from(
      h.document.querySelectorAll<HTMLInputElement>(
        '#filter-author-list input[type="checkbox"][data-author]'
      )
    );
    assert.strictEqual(boxes.length, 3, 'each author renders as a checkbox (multi-select)');
    const check = (name: string): void => {
      const box = boxes.find((b) => b.getAttribute('data-author') === name)!;
      box.checked = true;
      box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    };
    check('Jane <j@x.com>');
    check('Bob <b@x.com>');
    const applies = h.posted.filter(
      (m): m is { type: string; filter: { authors?: string[] } } =>
        !!m && (m as { type?: string }).type === 'applyLogFilter'
    );
    assert.deepStrictEqual(
      applies[applies.length - 1]?.filter.authors,
      ['Jane <j@x.com>', 'Bob <b@x.com>'],
      'multi-select posts every checked author'
    );
  });

  it('user popup: author rows carry the shared tree-row classes so long names ellipsize', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) });
    h.post({ type: 'authorOptionsReady', authors: ['A Very Long Name <verylong@example.com>'] });

    const row = h.document.querySelector('#filter-author-list label[class*="tree-row"]');

    assert.ok(row, 'the author row reuses .log-filter-tree-row like the branch tree');
    assert.ok(
      row?.querySelector('.log-filter-tree-leaf'),
      'the author name sits in a .log-filter-tree-leaf span (bare text nodes cannot ellipsize)'
    );
  });

  it('loads the composed document without throwing and builds the panels', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) });
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
    assert.ok(h.document.getElementById('graph-panel'), 'graph panel present');
    assert.ok(h.document.getElementById('details-panel'), 'details panel present');
  });

  it('graphTotalsUpdate updates the load-count attributes without rebuilding the panel', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) });
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
    h = bootWebviewEntry(ENTRY, {
      bodyHtml: bodyOf(fullHtmlWithRepos(['/work/repo-a', '/work/repo-b', '/work/repo-c'])),
    });

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

  it('branch tri-state: all renders all-checked; unchecking the master posts branchesNone', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) }); // no filter → ALL
    h.post({
      type: 'logFilterOptionsReady',
      branchGroups: { local: ['main', 'dev'], remotes: [] },
    });

    const list = h.document.getElementById('filter-branch-list')!;
    const master = list.querySelector<HTMLInputElement>('input[data-action="toggleAllBranches"]')!;
    const leaves = Array.from(list.querySelectorAll<HTMLInputElement>('input[data-branch]'));
    assert.strictEqual(master.checked, true, 'all → master checked');
    assert.ok(leaves.length === 2 && leaves.every((l) => l.checked), 'all leaves checked');

    // Uncheck the master → none.
    master.checked = false;
    master.dispatchEvent(new h.window.Event('change', { bubbles: true }));

    const applies = h.posted.filter(
      (m): m is { type: string; filter: { branches: string[]; branchesNone: boolean } } =>
        !!m && (m as { type?: string }).type === 'applyLogFilter'
    );
    const last = applies[applies.length - 1];
    assert.deepStrictEqual(Array.from(last.filter.branches), [], 'none posts no branch refs');
    assert.strictEqual(last.filter.branchesNone, true, 'none posts branchesNone');
    assert.ok(
      leaves.every((l) => !l.checked),
      'unchecking the master clears every leaf'
    );
  });

  it('branch tri-state: unchecking one leaf posts the remaining refs as a subset', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) });
    h.post({
      type: 'logFilterOptionsReady',
      branchGroups: { local: ['main', 'dev', 'release'], remotes: [] },
    });
    const list = h.document.getElementById('filter-branch-list')!;
    const leaves = Array.from(list.querySelectorAll<HTMLInputElement>('input[data-branch]'));
    const dev = leaves.find((l) => l.getAttribute('data-branch') === 'dev')!;
    dev.checked = false;
    dev.dispatchEvent(new h.window.Event('change', { bubbles: true }));

    const applies = h.posted.filter(
      (m): m is { type: string; filter: { branches: string[]; branchesNone: boolean } } =>
        !!m && (m as { type?: string }).type === 'applyLogFilter'
    );
    const last = applies[applies.length - 1];
    assert.deepStrictEqual(
      Array.from(last.filter.branches).sort(),
      ['main', 'release'],
      'subset posts the still-checked refs (the complement of the unchecked one)'
    );
    assert.strictEqual(last.filter.branchesNone, false);
  });

  it('prunes a branch subset to the branches still visible after a repo-scope change', () => {
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setLogFilter({ branches: ['main', 'feature/gone'] } as unknown as Parameters<
      typeof provider.setLogFilter
    >[0]);
    h = bootWebviewEntry(ENTRY, {
      bodyHtml: bodyOf(provider._getThreePanelHtmlContent(mockWebview(), [] as ICommitNode[])),
    });
    // The new scope's branch list no longer has feature/gone (and adds dev).
    h.post({
      type: 'logFilterOptionsReady',
      branchGroups: { local: ['main', 'dev'], remotes: [] },
    });

    const list = h.document.getElementById('filter-branch-list')!;
    const leaves = Array.from(list.querySelectorAll<HTMLInputElement>('input[data-branch]'));
    const byRef = (r: string) => leaves.find((l) => l.getAttribute('data-branch') === r)!;
    assert.strictEqual(byRef('main').checked, true, 'surviving selected branch stays checked');
    assert.strictEqual(byRef('dev').checked, false, 'a newly-visible branch is not auto-selected');
    const bridge = (h.window as unknown as { __intelligFilter: { branchState(): string } })
      .__intelligFilter;
    assert.strictEqual(bridge.branchState(), 'subset', 'still a subset (main), gone ref dropped');
  });

  it('reverts a branch subset to ALL when the scope change removes every selected branch', () => {
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setLogFilter({ branches: ['feature/gone'] } as unknown as Parameters<
      typeof provider.setLogFilter
    >[0]);
    h = bootWebviewEntry(ENTRY, {
      bodyHtml: bodyOf(provider._getThreePanelHtmlContent(mockWebview(), [] as ICommitNode[])),
    });
    h.post({
      type: 'logFilterOptionsReady',
      branchGroups: { local: ['main', 'dev'], remotes: [] },
    });

    const bridge = (h.window as unknown as { __intelligFilter: { branchState(): string } })
      .__intelligFilter;
    assert.strictEqual(bridge.branchState(), 'all', 'an emptied subset reverts to all, not none');
    const leaves = Array.from(
      h.document.querySelectorAll<HTMLInputElement>('#filter-branch-list input[data-branch]')
    );
    assert.ok(
      leaves.every((l) => l.checked),
      'all visible branches checked after the revert'
    );
  });

  it('re-seeds the branch multi-select from data-f-branches after a re-render', () => {
    // Regression: a branch pick reloads the graph and re-templates the row. The
    // checked set must survive — it round-trips through data-f-branches, not the
    // single data-f-branch — or the reopened tree shows nothing selected.
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setLogFilter({ branches: ['feature/login', 'main'] } as unknown as Parameters<
      typeof provider.setLogFilter
    >[0]);
    h = bootWebviewEntry(ENTRY, {
      bodyHtml: bodyOf(provider._getThreePanelHtmlContent(mockWebview(), [] as ICommitNode[])),
    });

    const bridge = (
      h.window as unknown as {
        __intelligFilter?: { isBranchChecked(n: string): boolean; anyBranchSelected(): boolean };
      }
    ).__intelligFilter;
    assert.ok(bridge, '__intelligFilter bridge present');
    assert.strictEqual(
      bridge.isBranchChecked('feature/login'),
      true,
      'feature/login stays checked'
    );
    assert.strictEqual(bridge.isBranchChecked('main'), true, 'main stays checked');
    assert.strictEqual(bridge.isBranchChecked('other'), false);
    assert.strictEqual(bridge.anyBranchSelected(), true);

    // The button label reflects the multi-select, not "All".
    assert.strictEqual(h.document.getElementById('filter-branch-value')!.textContent, '2 branches');
  });

  it('unchecking every repo posts an empty set and labels the button "None"', () => {
    h = bootWebviewEntry(ENTRY, {
      bodyHtml: bodyOf(fullHtmlWithRepos(['/work/repo-a', '/work/repo-b'])),
    });

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
    h = bootWebviewEntry(ENTRY, {
      bodyHtml: bodyOf(fullHtmlWithRepos(['/work/repo-a', '/work/repo-b'])),
    });

    // Open the Repository popup the way a click does.
    const btn = h.document.querySelector<HTMLElement>(
      '[data-action="toggleFilterPopup"][data-popup="repo"]'
    );
    assert.ok(btn, 'Repository popup button present');
    btn.dispatchEvent(new h.window.Event('click', { bubbles: true }));

    // The open popup is persisted (versioned slot) so it can be restored after a re-render.
    assert.strictEqual(
      (h.readState() as { openFilterPopup?: { data?: string } }).openFilterPopup?.data,
      'repo',
      'open repo popup is remembered in webview state'
    );
  });

  it('reopens the remembered popup on init (after a re-render) without throwing', () => {
    // Simulate the post-pick reload: VS Code rehydrates state with the popup open.
    h = bootWebviewEntry(ENTRY, {
      bodyHtml: bodyOf(fullHtmlWithRepos(['/work/repo-a', '/work/repo-b'])),
      initialState: { openFilterPopup: { v: 1, data: 'repo' } },
    });

    const popup = h.document.getElementById('filter-popup-repo');
    assert.ok(popup, 'repo popup present');
    assert.strictEqual(popup.hidden, false, 'remembered popup is reopened on init');
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      []
    );
  });

  it('closes open popups and the context menu when the webview loses focus', () => {
    h = bootWebviewEntry(ENTRY, {
      bodyHtml: bodyOf(fullHtmlWithRepos(['/work/repo-a', '/work/repo-b'])),
    });

    const btn = h.document.querySelector<HTMLElement>(
      '[data-action="toggleFilterPopup"][data-popup="repo"]'
    );
    assert.ok(btn, 'Repository popup button present');
    btn.dispatchEvent(new h.window.Event('click', { bubbles: true }));
    const popup = h.document.getElementById('filter-popup-repo');
    assert.ok(popup, 'repo popup present');
    assert.strictEqual(popup.hidden, false, 'popup open before focus loss');

    const menu = h.document.getElementById('commit-context-menu');
    assert.ok(menu, 'context menu element present');
    menu.hidden = false;

    // A click OUTSIDE the webview never reaches this document — the iframe
    // only sees focus loss. Blur must dismiss like an outside click.
    h.window.dispatchEvent(new h.window.Event('blur'));

    assert.strictEqual(popup.hidden, true, 'popup must close on webview blur');
    assert.strictEqual(menu.hidden, true, 'context menu must close on webview blur');
    assert.ok(
      (h.readState() as { openFilterPopup?: { data?: string | null } }).openFilterPopup?.data !==
        'repo',
      'the remembered-open key must clear so a re-render does not resurrect the popup'
    );
  });

  it('tolerates representative and garbage extension→webview messages', () => {
    h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(fullHtml()) });
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
