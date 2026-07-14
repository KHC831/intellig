/**
 * Runtime (jsdom) regression for the scroll persist/restore in the interactive
 * Rebase Editor bundled entry.
 *
 * The user's complaint: with many commits, picking an action for a commit near
 * the BOTTOM of the list snapped the list back to the TOP, forcing a re-scroll
 * each time. The cause is that every action change / reorder posts a message to
 * the host, which re-templates the whole webview (`webview.html = …`), tearing
 * down and rebuilding the DOM — resetting the commit list's scroll to the top.
 *
 * The fix mirrors the Git tool window: persist the commit-list scrollTop to
 * webview state on scroll, and on every full re-render restore it UNLESS the
 * render is the initial (navigational) one. The host stamps `preserveScroll` in
 * the init island: true on re-renders (action/reorder), false on the first
 * render of a fresh rebase (start at the top, drop any stale saved position).
 *
 * Post-Phase-5, the scroll state rides a WebviewStateSlot (versioned `{ v, data }`
 * envelope under `rebaseScroll`) instead of a raw `rebaseScrollTop` key — same
 * invariants, versioned storage. jsdom does no layout, so scrollTop is backed by
 * a recording accessor on the element prototype.
 */

import '../../setup';
import * as assert from 'assert';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import * as vscode from 'vscode';
import { RebaseEditor } from '../../../src/rebase/RebaseEditor';
import type {
  IRebaseService,
  IRebaseSession,
} from '../../../src/git-core/interfaces/IRebaseService';
import { initIslandHtml } from '../../../src/utils/webviewInit';
import { Uri } from '../../mocks/vscode';

/** The WebviewStateSlot envelope the scroll slot stores. */
interface ScrollEnvelope {
  v: number;
  data: unknown;
}
interface WebviewState {
  rebaseScroll?: ScrollEnvelope;
  [k: string]: unknown;
}

const ENTRY = path.join(__dirname, '..', '..', '..', 'src', 'rebase', 'webview', 'rebaseEditor');

function stubRebaseService(): IRebaseService {
  const emitter = new vscode.EventEmitter<IRebaseSession | undefined>();
  return {
    onDidChangeRebaseSession: emitter.event,
    dispose: (): void => emitter.dispose(),
  } as unknown as IRebaseService;
}

function islandFor(preserveScroll: boolean): string {
  const commits = Array.from({ length: 20 }, (_, i) => ({
    hash: String(i + 1).padStart(40, '0'),
    message: `commit ${i + 1}`,
    action: 'pick' as const,
  }));
  const editor = new RebaseEditor(Uri.file('/tmp/ext'), stubRebaseService());
  (editor as unknown as { _session: IRebaseSession })._session = {
    onto: 'main',
    originalBranch: 'feature',
    commits,
    currentStep: 0,
    status: 'planning',
  };
  const init = (editor as unknown as { _getInit(p?: boolean): unknown })._getInit(preserveScroll);
  return initIslandHtml(init);
}

/** Convenience: the slot value the tests seed / assert. */
function scroll(data: unknown): ScrollEnvelope {
  return { v: 1, data };
}

interface BootOptions {
  preserveScroll: boolean;
  initialState?: WebviewState;
  captureRaf?: boolean;
}

/**
 * Boot the real rebase-editor ENTRY in jsdom over its `#rebase-root` skeleton +
 * init island, with a recording `scrollTop` accessor on the element prototype
 * and a stubbed webview state. The build+restore runs at boot (module load).
 */
function boot(opts: BootOptions): {
  window: JSDOM['window'];
  list: HTMLElement;
  getScrollTop: (el: Element) => number;
  state: WebviewState;
  flushRaf: () => void;
} {
  const dom = new JSDOM(
    `<!doctype html><html><body>` +
      `<div class="rebase-editor" id="rebase-root"></div>` +
      islandFor(opts.preserveScroll) +
      `</body></html>`
  );
  const window = dom.window;

  const store = new WeakMap<object, number>();
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTop', {
    get(): number {
      return store.get(this as object) ?? 0;
    },
    set(v: number): void {
      store.set(this as object, v);
    },
    configurable: true,
  });

  const state: WebviewState = { ...(opts.initialState ?? {}) };
  const api = {
    postMessage: (): void => {},
    getState: (): WebviewState => ({ ...state }),
    setState: (s: WebviewState): void => {
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, s);
    },
  };

  const g = global as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    acquireVsCodeApi: g.acquireVsCodeApi,
    requestAnimationFrame: g.requestAnimationFrame,
  };
  const rafCallbacks: Array<() => void> = [];
  g.window = window;
  g.document = window.document;
  g.acquireVsCodeApi = (): typeof api => api;
  g.requestAnimationFrame = opts.captureRaf
    ? (cb: () => void): number => rafCallbacks.push(cb)
    : undefined;

  delete require.cache[require.resolve(ENTRY)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(ENTRY);

  g.window = saved.window;
  g.document = saved.document;
  g.acquireVsCodeApi = saved.acquireVsCodeApi;
  g.requestAnimationFrame = saved.requestAnimationFrame;

  const list = window.document.getElementById('commit-list') as HTMLElement;
  return {
    window,
    list,
    getScrollTop: (el: Element) => store.get(el as object) ?? 0,
    state,
    flushRaf: () => rafCallbacks.splice(0).forEach((cb) => cb()),
  };
}

describe('Rebase Editor entry — scroll persist/restore (jsdom)', () => {
  it('persists the commit-list scrollTop to webview state on scroll (merging keys)', () => {
    const { window, list, state } = boot({
      preserveScroll: true,
      initialState: { unrelated: 'keep-me' },
    });

    list.scrollTop = 640;
    list.dispatchEvent(new window.Event('scroll'));

    assert.deepStrictEqual(state.rebaseScroll, scroll(640), 'scrollTop is saved to webview state');
    assert.strictEqual(state.unrelated, 'keep-me', 'existing state keys are preserved');
  });

  it('restores the saved scrollTop on a preserve render (action change / reorder)', () => {
    const { list, getScrollTop } = boot({
      preserveScroll: true,
      initialState: { rebaseScroll: scroll(512) },
    });
    assert.strictEqual(
      getScrollTop(list),
      512,
      'a re-render after an action change restores the position instead of jumping to top'
    );
  });

  it('does NOT restore on the initial render — starts at the top', () => {
    const { list, getScrollTop } = boot({
      preserveScroll: false,
      initialState: { rebaseScroll: scroll(512) },
    });
    assert.strictEqual(getScrollTop(list), 0, 'a fresh rebase starts at the top');
  });

  it('clears the stale saved position on the initial render', () => {
    const { state } = boot({
      preserveScroll: false,
      initialState: { rebaseScroll: scroll(512), unrelated: 'keep-me' },
    });
    assert.deepStrictEqual(
      state.rebaseScroll,
      scroll(0),
      'the initial render wipes the stale scroll'
    );
    assert.strictEqual(state.unrelated, 'keep-me', 'other state keys survive the reset');
  });

  it('re-applies the restore on the next animation frame so it survives first layout', () => {
    const { list, getScrollTop, flushRaf } = boot({
      preserveScroll: true,
      initialState: { rebaseScroll: scroll(333) },
      captureRaf: true,
    });
    assert.strictEqual(getScrollTop(list), 333, 'restore applies synchronously');

    list.scrollTop = 0; // simulate the webview clamping before layout
    flushRaf();
    assert.strictEqual(getScrollTop(list), 333, 'the rAF retry re-applies after layout settles');
  });

  it('does not restore a zero/absent saved position', () => {
    const { list, getScrollTop } = boot({ preserveScroll: true, initialState: {} });
    assert.strictEqual(getScrollTop(list), 0, 'no saved position → nothing to restore');
  });
});
