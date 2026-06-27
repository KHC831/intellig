/**
 * Headless harness for testing a webview's CLIENT-side script.
 *
 * IntelliG's webviews build their DOM in the browser context via createElement
 * (the string→DOM migration) and talk to the extension through
 * `acquireVsCodeApi().postMessage`. Those scripts run in the webview renderer,
 * NOT the extension host, so a thrown error there is invisible to every other
 * test layer and to the output channel — it only shows up when a human opens
 * the panel. This harness runs the script under jsdom with a mock
 * `acquireVsCodeApi`, captures posts and script errors, and lets the test feed
 * `postMessage` events, so that whole class becomes assertable in CI.
 *
 * Limitation: jsdom does NOT lay out or paint, so this verifies DOM STRUCTURE
 * and message wiring, not pixels. Visual/layout regressions still need the
 * screenshot lane.
 */

import { JSDOM, VirtualConsole } from 'jsdom';

export interface IWebviewHarness {
  readonly window: JSDOM['window'];
  readonly document: Document;
  /** Messages the script sent to the extension via `vscode.postMessage`. */
  readonly posted: unknown[];
  /** Script errors surfaced during load or message handling (jsdomError). */
  readonly errors: Error[];
  /** Deliver an extension→webview message (`window.message` event). */
  post(message: unknown): void;
  /** The persisted webview state (`vscode.setState`), as the script last left it. */
  readState(): unknown;
  /** Dispose the jsdom window. */
  dispose(): void;
}

export interface IRunWebviewScriptOptions {
  /**
   * Static body HTML the script expects to find (skeleton elements it
   * queries). Most IntelliG scripts build everything themselves, so this is
   * usually a single mount point or empty.
   */
  bodyHtml?: string;
  /**
   * Seed `vscode.getState()` before the script runs — mirrors a reload where
   * VS Code rehydrates the previous webview state (e.g. a remembered open
   * filter popup that should reopen on init).
   */
  initialState?: unknown;
}

/**
 * Run a webview client script in jsdom and return handles for assertions.
 *
 * `acquireVsCodeApi` is defined before the script parses (via `beforeParse`),
 * matching the real load order, and memoised the way the webviews expect.
 */
export function runWebviewScript(
  script: string,
  options: IRunWebviewScriptOptions = {}
): IWebviewHarness {
  const posted: unknown[] = [];
  const errors: Error[] = [];
  let state: unknown = options.initialState;

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err: Error) => {
    errors.push(err);
  });

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

  const html =
    `<!DOCTYPE html><html><head></head><body>` +
    `${options.bodyHtml ?? ''}` +
    `<script>${script}</script>` +
    `</body></html>`;

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      // The webviews call a bare `acquireVsCodeApi()`; some memoise it on
      // `window.__intelligVscodeApi`. Provide both shapes.
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => api;
    },
  });

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
      dom.window.close();
    },
  };
}
