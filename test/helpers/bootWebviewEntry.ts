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
  };
  g.window = dom.window;
  g.document = dom.window.document;
  g.MutationObserver = dom.window.MutationObserver;
  g.acquireVsCodeApi = (): unknown => api;

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
      dom.window.close();
    },
  };
}
