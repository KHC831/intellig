/**
 * Undock behavior: the provider retargets its single follower webview from
 * the sidebar view to an editor-tab WebviewPanel and back. One instance,
 * one live follower at a time (ADR-009 stays intact).
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import { createLogPanelSerializer } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';
import { wireInitialDataLoad } from '../../../src/registration/registerViews';
import { Uri } from '../../mocks/vscode';
import * as vscodeMock from '../../mocks/vscode';
import { mkCommit } from '../../support/printModelTestKit';

/** The shared mock panel's webview, plus the test hooks the mock exposes. */
interface HookedWebview {
  html: string;
  readonly htmlWrites?: number;
  _posted: unknown[];
  cspSource: string;
  postMessage: (message: unknown) => Promise<boolean>;
  onDidReceiveMessage: (listener: (e: unknown) => void) => { dispose: () => void };
  asWebviewUri: (resource: unknown) => unknown;
}

/** The shared mock panel (window.createWebviewPanel) with its test hooks. */
interface HookedPanel {
  webview: HookedWebview;
  visible: boolean;
  viewType: string;
  reveal: (column?: unknown) => void;
  dispose: () => void;
  onDidDispose: (listener: () => void) => { dispose: () => void };
  _revealCallCount: number;
  _disposeCallCount: number;
  _fireMessage: (message: unknown) => void;
  _fireViewState: (visible?: boolean) => void;
}

/** Sidebar-view double backed by a shared mock panel's webview + emitter. */
interface MockSidebarView {
  webview: HookedWebview;
  visible: boolean;
  onDidChangeVisibility: (listener: () => void) => { dispose: () => void };
  onDidDispose: (listener: () => void) => { dispose: () => void };
  fireMessage: (message: unknown) => void;
  fireVisibilityChange: () => void;
}

/**
 * Wrap a webview's `html` in a write-counting accessor. Used only where a test
 * asserts how many times the document is (re)assigned.
 */
function installHtmlCounter(webview: HookedWebview): void {
  let html = webview.html;
  let writes = 0;
  Object.defineProperty(webview, 'html', {
    configurable: true,
    get: () => html,
    set: (value: string) => {
      html = value;
      writes += 1;
    },
  });
  Object.defineProperty(webview, 'htmlWrites', {
    configurable: true,
    get: () => writes,
  });
}

/** An editor-tab panel from the shared vscode mock, optionally write-counting. */
function makePanel(count = false): HookedPanel {
  const panel = vscodeMock.window.createWebviewPanel(
    'intellig.gitLogPanel',
    'Git Log',
    vscodeMock.ViewColumn.Active
  ) as unknown as HookedPanel;
  if (count) {
    installHtmlCounter(panel.webview);
  }
  return panel;
}

/**
 * A sidebar WebviewView double. The mock has no view factory, so we borrow a
 * shared panel's webview (giving `_posted` + the message emitter for free) and
 * add the view-only surface (visibility, dispose).
 */
function makeView(count = false): MockSidebarView {
  const backing = vscodeMock.window.createWebviewPanel(
    'intellig.gitToolWindow',
    'Git',
    vscodeMock.ViewColumn.Active
  ) as unknown as HookedPanel;
  if (count) {
    installHtmlCounter(backing.webview);
  }
  let visibilityListener: (() => void) | undefined;
  return {
    webview: backing.webview,
    visible: true,
    onDidChangeVisibility(listener: () => void) {
      visibilityListener = listener;
      return { dispose: () => {} };
    },
    onDidDispose: (_listener: () => void) => ({ dispose: () => {} }),
    fireMessage: backing._fireMessage,
    fireVisibilityChange() {
      visibilityListener?.();
    },
  };
}

type ResolveArgs = Parameters<GitToolWindowProvider['resolveWebviewView']>;

function resolveViewInto(provider: GitToolWindowProvider, view: MockSidebarView): void {
  provider.resolveWebviewView(
    view as unknown as ResolveArgs[0],
    {} as ResolveArgs[1],
    { isCancellationRequested: false } as ResolveArgs[2]
  );
}

describe('GitToolWindowProvider undock to editor panel', () => {
  const extensionUri = Uri.file('/test/extension');
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  function resolveSidebar(count = false): MockSidebarView {
    const view = makeView(count);
    resolveViewInto(provider, view);
    return view;
  }

  it('routes posts to the panel while attached', () => {
    const view = resolveSidebar();
    const panel = makePanel();
    provider.attachPanel(panel as never);

    view.webview._posted.length = 0;
    panel.webview._posted.length = 0;
    provider.postToWebview({ type: 'commitsLoaded' });

    assert.strictEqual(panel.webview._posted.length, 1);
    assert.deepStrictEqual(panel.webview._posted[0], { type: 'commitsLoaded' });
    assert.strictEqual(view.webview._posted.length, 0);
  });

  it('renders the full document into the panel and a placeholder into the sidebar', () => {
    const view = resolveSidebar();
    const panel = makePanel();
    provider.attachPanel(panel as never);

    assert.ok(panel.webview.html.startsWith('<!DOCTYPE html>'));
    assert.ok(view.webview.html.startsWith('<!DOCTYPE html>'));
    assert.ok(
      view.webview.html.includes('editor tab'),
      `sidebar should show the undocked placeholder, got: ${view.webview.html.slice(0, 200)}`
    );
    assert.ok(
      !panel.webview.html.includes('editor tab'),
      'panel must carry the real document, not the placeholder'
    );
  });

  it('restores the sidebar as render and post target when the panel is disposed', () => {
    const view = resolveSidebar();
    const panel = makePanel();
    provider.attachPanel(panel as never);
    panel.dispose();

    assert.ok(
      !view.webview.html.includes('editor tab'),
      'sidebar must re-render the real document after dock-back'
    );

    view.webview._posted.length = 0;
    provider.postToWebview({ type: 'commitsLoaded' });
    assert.strictEqual(view.webview._posted.length, 1);
  });

  it('handles messages arriving from the panel webview', () => {
    resolveSidebar();
    const panel = makePanel();
    provider.attachPanel(panel as never);
    let grouping: string | undefined;
    (provider as unknown as { setDetailsGroupBy: (g: string) => void }).setDetailsGroupBy = (g) => {
      grouping = g;
    };

    panel._fireMessage({ type: 'setDetailsGroupBy', groupBy: 'flat' });

    assert.strictEqual(grouping, 'flat', 'a panel message reaches the host handler');
  });

  it('is attachable without the sidebar ever resolving', () => {
    const panel = makePanel();
    provider.attachPanel(panel as never);

    assert.strictEqual(provider.hasView(), true);
    assert.ok(panel.webview.html.startsWith('<!DOCTYPE html>'));

    panel.webview._posted.length = 0;
    provider.postToWebview({ type: 'commitsLoaded' });
    assert.strictEqual(panel.webview._posted.length, 1);
  });

  it('reveals the existing panel instead of stacking a second one', () => {
    resolveSidebar();
    const panel = makePanel();
    provider.attachPanel(panel as never);

    // openInEditor returns the already-attached panel rather than creating a
    // second one, and reveals it.
    assert.strictEqual(provider.openInEditor() as unknown, panel);
    assert.ok(panel._revealCallCount >= 1, 'the existing panel is revealed, not stacked');
  });

  it('reveals the panel when the sidebar placeholder button is clicked', () => {
    const view = resolveSidebar();
    const panel = makePanel();
    provider.attachPanel(panel as never);

    view.fireMessage({ type: 'focusUndockedPanel' });
    assert.strictEqual(panel._revealCallCount, 1);
  });

  it('reports no panel after dispose of the provider', () => {
    resolveSidebar();
    const panel = makePanel();
    provider.attachPanel(panel as never);
    provider.dispose();

    assert.ok(panel._disposeCallCount > 0, 'provider dispose must close the undocked panel');
    assert.strictEqual(provider.openInEditor(), undefined);
  });

  // Review-fix sub-invariants. Share the fixture above; a counting sidebar is
  // just `resolveSidebar(true)`.
  it('fires onDidRequestInitialData when a panel attaches', (done) => {
    const panel = makePanel();
    const disposable = provider.onDidRequestInitialData(() => {
      disposable.dispose();
      done();
    });
    provider.attachPanel(panel as never);
  });

  it('does not rebuild the panel when the sidebar merely becomes visible', () => {
    const view = resolveSidebar(true);
    const panel = makePanel(true);
    provider.attachPanel(panel as never);

    const panelWritesAfterAttach = panel.webview.htmlWrites;
    view.fireVisibilityChange();

    assert.strictEqual(
      panel.webview.htmlWrites,
      panelWritesAfterAttach,
      'sidebar visibility change must not reload the undocked panel document'
    );
  });

  it('writes the sidebar placeholder once, not on every render', () => {
    const view = resolveSidebar(true);
    const panel = makePanel(true);
    provider.attachPanel(panel as never);

    const sidebarWritesAfterAttach = view.webview.htmlWrites;
    provider.refresh();
    provider.refresh();

    assert.strictEqual(
      view.webview.htmlWrites,
      sidebarWritesAfterAttach,
      'renders while undocked must not reassign the static placeholder'
    );
    assert.ok(view.webview.html.includes('editor tab'));
  });

  it('re-renders the placeholder into a re-resolved sidebar while undocked', () => {
    resolveSidebar(true);
    const panel = makePanel(true);
    provider.attachPanel(panel as never);

    const secondView = resolveSidebar(true);
    assert.ok(
      secondView.webview.html.includes('editor tab'),
      're-resolved sidebar must receive the placeholder document'
    );
  });

  it('rebuilds the panel document on a direct render while undocked', () => {
    resolveSidebar(true);
    const panel = makePanel(true);
    provider.attachPanel(panel as never);

    const before = panel.webview.htmlWrites;
    (provider as unknown as { _render(): void })._render();

    assert.ok(
      (panel.webview.htmlWrites ?? 0) > (before ?? 0),
      'a direct _render while undocked must rebuild the panel document'
    );
  });

  it('does not rebuild a hidden undocked panel on git events, then rebuilds once on reveal', () => {
    resolveSidebar(true);
    const panel = makePanel(true);
    provider.attachPanel(panel as never);

    // Panel moves to the background; retainContextWhenHidden keeps it alive.
    panel._fireViewState(false);
    const writesWhileHidden = panel.webview.htmlWrites ?? 0;
    provider.refresh();
    provider.refresh();
    assert.strictEqual(
      panel.webview.htmlWrites ?? 0,
      writesWhileHidden,
      'a hidden panel must not rebuild its document on git events'
    );

    // Becoming visible flushes exactly one rebuild for the pending changes.
    panel._fireViewState(true);
    assert.strictEqual(
      panel.webview.htmlWrites ?? 0,
      writesWhileHidden + 1,
      'revealing a dirtied panel rebuilds its document exactly once'
    );
  });

  it('re-posts the menu enable state after flushing a deferred panel render on reveal', () => {
    resolveSidebar(true);
    const panel = makePanel(true);
    provider.attachPanel(panel as never);

    // Hide the panel, then a git event dirties it (deferred rebuild pending).
    panel._fireViewState(false);
    provider.refresh();
    panel.webview._posted.length = 0;

    // Reveal: the flush rebuilds the document (resetting the webview's cached
    // message-only state), so it MUST be followed by a fresh menu-state post —
    // otherwise the rebuilt menu keeps its enable-everything fallback.
    panel._fireViewState(true);

    const menuPosts = panel.webview._posted.filter(
      (m) => (m as { type?: string }).type === 'updateMenuEnableState'
    );
    assert.ok(
      menuPosts.length >= 1,
      'reveal flush must re-post the menu enable state onto the rebuilt document'
    );
  });

  it('requests initial data once when a cold panel attach and sidebar resolve both fire', () => {
    let fired = 0;
    const disposable = provider.onDidRequestInitialData(() => {
      fired += 1;
    });
    // Window reload: the restored panel attaches AND the sidebar resolves, both
    // cold. The coalesced loader must be asked to fetch only once.
    provider.attachPanel(makePanel() as never);
    resolveSidebar();
    disposable.dispose();

    assert.strictEqual(fired, 1, 'attach + cold resolve must request initial data exactly once');
  });

  it('re-requests initial data after a failed cold load (latch clears on rejection)', async () => {
    let loads = 0;
    const loader = (): Promise<void> => {
      loads += 1;
      return Promise.reject(new Error('load failed'));
    };
    const sub = wireInitialDataLoad(provider, loader);

    // First cold resolve fires initial data → loader rejects → latch must clear.
    resolveSidebar();
    await new Promise((r) => setTimeout(r, 0));

    // A second cold resolve must fire initial data AGAIN (latch was not wedged).
    resolveSidebar();
    await new Promise((r) => setTimeout(r, 0));

    sub.dispose();
    assert.strictEqual(loads, 2, 'a failed cold load must not wedge the initial-data latch');
  });

  it('guards messages from the panel like the sidebar path', () => {
    const panel = makePanel();
    provider.attachPanel(panel as never);

    (provider as unknown as { _handleWebviewMessage: (m: unknown) => void })._handleWebviewMessage =
      () => {
        throw new Error('handler exploded');
      };

    assert.doesNotThrow(() => {
      panel._fireMessage({ type: 'refresh' });
    });
  });

  it('disposes the replaced panel when a new one attaches', () => {
    const first = makePanel();
    const second = makePanel();
    provider.attachPanel(first as never);
    provider.attachPanel(second as never);

    assert.ok(first._disposeCallCount > 0, 'the replaced panel must be closed, not orphaned');

    second.webview._posted.length = 0;
    provider.postToWebview({ type: 'commitsLoaded' });
    assert.strictEqual(second.webview._posted.length, 1);
  });

  it('openInEditor creates one panel and reveals it on re-invocation', () => {
    const first = provider.openInEditor();
    assert.ok(first, 'openInEditor must create a panel');
    const second = provider.openInEditor();

    assert.strictEqual(second, first, 'a second invocation must reuse the existing panel');
    assert.strictEqual(
      (first as unknown as HookedPanel)._revealCallCount,
      1,
      're-invocation reveals the existing panel'
    );
  });

  it('serializer revival reattaches a restored panel', async () => {
    const panel = makePanel(true);
    const serializer = createLogPanelSerializer(() => provider);
    await serializer.deserializeWebviewPanel(panel as never, undefined);

    assert.strictEqual(provider.openInEditor() as unknown, panel);
    assert.ok(panel.webview.html.startsWith('<!DOCTYPE html>'));
  });

  it('does not refetch when undocking an already-loaded log', () => {
    provider.updateLogState([mkCommit('a'.repeat(40))]);

    let fired = 0;
    const disposable = provider.onDidRequestInitialData(() => {
      fired += 1;
    });
    provider.attachPanel(makePanel() as never);
    disposable.dispose();

    assert.strictEqual(fired, 0, 'a warm undock must render existing state, not reload it');
  });

  it('does not refetch initial data when a warm sidebar re-resolves while undocked', () => {
    // Warm the follower (page 1 loaded) and undock it, then simulate the
    // sidebar collapse/expand re-resolve. A re-resolve must NOT re-request
    // initial data: loadAllPanelData would replace commitNodes with page 1
    // and silently drop the user's loaded-more pages.
    provider.updateLogState([mkCommit('a'.repeat(40))]);
    resolveSidebar(true);
    provider.attachPanel(makePanel() as never);

    let fired = 0;
    const disposable = provider.onDidRequestInitialData(() => {
      fired += 1;
    });
    resolveSidebar(true);
    disposable.dispose();

    assert.strictEqual(
      fired,
      0,
      'a warm sidebar re-resolve must not reload page 1 over loaded-more pages'
    );
  });

  it('does not rebuild the panel when the sidebar re-resolves', () => {
    resolveSidebar(true);
    const panel = makePanel(true);
    provider.attachPanel(panel as never);

    const panelWrites = panel.webview.htmlWrites;
    const secondView = resolveSidebar(true);

    assert.strictEqual(
      panel.webview.htmlWrites,
      panelWrites,
      'a sidebar lifecycle event must not reload the undocked panel document'
    );
    assert.ok(secondView.webview.html.includes('editor tab'));
  });

  it('revealLogHost reveals the panel while undocked', async () => {
    const panel = makePanel();
    provider.attachPanel(panel as never);

    await provider.revealLogHost();
    assert.strictEqual(panel._revealCallCount, 1);
  });

  it('revealLogHost focuses the sidebar view when docked', async () => {
    const executed: string[] = [];
    const original = vscodeMock.commands.executeCommand;
    vscodeMock.commands.executeCommand = (async (command: string) => {
      executed.push(command);
      return undefined;
    }) as typeof vscodeMock.commands.executeCommand;
    try {
      await provider.revealLogHost();
    } finally {
      vscodeMock.commands.executeCommand = original;
    }

    assert.deepStrictEqual(executed, ['intellig.toolWindow.focus']);
  });

  it('closes the offered panel when attaching to a disposed provider', () => {
    provider.dispose();
    const panel = makePanel();
    provider.attachPanel(panel as never);

    assert.ok(panel._disposeCallCount > 0, 'a refused panel must be closed, not left blank');
    assert.strictEqual(provider.openInEditor(), undefined);
  });

  it('openInEditor on a disposed provider creates nothing', () => {
    provider.dispose();
    assert.strictEqual(provider.openInEditor(), undefined);
  });
});
