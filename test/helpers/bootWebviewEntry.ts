/**
 * Boot a real bundled webview TS entry under jsdom (the Phase-5 successor to
 * {@link runWebviewScript}). Where the old harness eval'd a host-emitted script
 * STRING, this `require()`s the actual `src/<panel>/webview/main.ts` module the
 * bundle ships — so the test drives the same code the user runs, and the entry's
 * `import`s of the `*.protocol.ts` union make any wire drift a compile error.
 *
 * The entry reads its initial state from an in-DOM island (a `data-*` attribute
 * the host serializes into the body), so `bodyHtml` seeds the pre-boot DOM the
 * same way the host's `_getBodyHtml()` does; `post()` delivers host→webview
 * messages after boot. Mirrors `mergeWindowScript.test.ts`'s bootMergeWindow,
 * minus the Monaco stub (plain panels self-boot).
 *
 * Limitation (unchanged from the string harness): jsdom does not lay out or
 * paint — this asserts DOM STRUCTURE + message wiring, not pixels.
 */

import { JSDOM, VirtualConsole } from 'jsdom';
import * as path from 'path';

export interface IWebviewEntryHarness {
  readonly window: JSDOM['window'];
  readonly document: Document;
  /** Messages the entry sent to the host via `vscode.postMessage`. */
  readonly posted: unknown[];
  /** Errors surfaced during boot or message handling (jsdomError). */
  readonly errors: Error[];
  /** Deliver a host→webview message (`window.message` event). */
  post(message: unknown): void;
  /** The persisted webview state (`vscode.setState`), as the entry last left it. */
  readState(): unknown;
  /** Dispose the jsdom window and restore globals. */
  dispose(): void;
}

export interface IBootWebviewEntryOptions {
  /** Pre-boot body HTML (the host body incl. any `data-*` init island). */
  bodyHtml?: string;
  /** Seed `vscode.getState()` before boot (a reload with rehydrated state). */
  initialState?: unknown;
  /**
   * Run against the jsdom window AFTER globals are installed but BEFORE the
   * entry boots — mirrors `runWebviewScript`'s `beforeParse`. For pre-boot
   * instrumentation (e.g. wrapping `addEventListener` to count registrations).
   */
  beforeBoot?: (window: JSDOM['window']) => void;
}

/**
 * @param moduleFromSrc entry path relative to `src/`, e.g. `shelf/webview/main`.
 */
export function bootWebviewEntry(
  moduleFromSrc: string,
  options: IBootWebviewEntryOptions = {}
): IWebviewEntryHarness {
  const posted: unknown[] = [];
  const errors: Error[] = [];
  let state: unknown = options.initialState;

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err: Error) => {
    errors.push(err);
  });

  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body>${options.bodyHtml ?? ''}</body></html>`,
    { virtualConsole }
  );

  const api = {
    postMessage: (message: unknown): void => {
      posted.push(message);
    },
    getState: (): unknown => state,
    setState: (next: unknown): unknown => {
      state = next;
      return next;
    },
  };

  const g = global as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    MutationObserver: g.MutationObserver,
    acquireVsCodeApi: g.acquireVsCodeApi,
    Element: g.Element,
    Node: g.Node,
    HTMLElement: g.HTMLElement,
    requestAnimationFrame: g.requestAnimationFrame,
    navigator: g.navigator,
    CSS: g.CSS,
  };
  g.window = dom.window;
  g.document = dom.window.document;
  // `navigator` is a read-only getter on the Node global; redefine it so the
  // entry's `navigator.clipboard.*` reads the jsdom navigator a test can stub.
  Object.defineProperty(g, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });
  g.MutationObserver = dom.window.MutationObserver;
  // jsdom ships no `CSS` object, but the Chromium webview does and entries use
  // CSS.escape to build attribute selectors. Without it those code paths throw
  // here and nowhere else, which hides real bugs behind a green suite.
  g.CSS = dom.window.CSS ?? {
    escape: (value: string): string => value.replace(/[^\w-]/g, (ch) => '\\' + ch),
  };
  // The browser exposes the DOM constructors as globals; mirror them so an
  // entry's realm-sensitive `instanceof Element` / `instanceof Node` checks
  // match the jsdom nodes the test dispatches (the module runs in Node's realm
  // via require, not inside the jsdom window).
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  g.HTMLElement = dom.window.HTMLElement;
  g.acquireVsCodeApi = (): unknown => api;

  if (options.beforeBoot) {
    options.beforeBoot(dom.window);
  }

  // Mirror `requestAnimationFrame` to the global realm AFTER beforeBoot, so a
  // test that installs a capturing rAF on the jsdom window is visible to the
  // entry (which reads the bare global). jsdom omits it by default, so absent a
  // capture this stays undefined and the entry's `typeof` guard skips the retry.
  g.requestAnimationFrame = dom.window.requestAnimationFrame;

  // The entry self-boots on load; a cache-busted require re-runs it against the
  // globals + init island just seeded (matching how the bundle boots in the page).
  const modulePath = path.join(__dirname, '..', '..', 'src', moduleFromSrc);
  delete require.cache[require.resolve(modulePath)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(modulePath);

  return {
    window: dom.window,
    document: dom.window.document,
    posted,
    errors,
    post(message: unknown): void {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));
    },
    readState(): unknown {
      return state;
    },
    dispose(): void {
      g.window = saved.window;
      g.document = saved.document;
      g.MutationObserver = saved.MutationObserver;
      g.acquireVsCodeApi = saved.acquireVsCodeApi;
      g.CSS = saved.CSS;
      g.Element = saved.Element;
      g.Node = saved.Node;
      g.HTMLElement = saved.HTMLElement;
      g.requestAnimationFrame = saved.requestAnimationFrame;
      Object.defineProperty(g, 'navigator', {
        value: saved.navigator,
        configurable: true,
        writable: true,
      });
      dom.window.close();
    },
  };
}
