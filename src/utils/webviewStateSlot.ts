/**
 * Versioned, validate-on-load slots over the webview VS Code API's
 * `getState()/setState()` — the webview-side sibling of the host's
 * `persistedState` seam (Phase 3 §3d shape). A slot stores a `{ v, data }`
 * envelope under its `key` in the webview's single state object; a load whose
 * stored version differs or whose data fails `validate` returns `undefined`
 * (default), so yesterday's writer can't feed today's reader a stale shape.
 *
 * DOM-free AND vscode-free by construction (takes the tiny state API as a param)
 * so it compiles under tsconfig.webview.json and is reusable by every panel.
 */

/** The subset of the webview VS Code API handle this helper needs. */
export interface IWebviewStateApi {
  getState(): unknown;
  setState(value: unknown): void;
}

/** A named, versioned, validated slot in the webview's persisted state. */
export interface IWebviewStateSlot<T> {
  /** Key under the single webview state object. */
  key: string;
  /** Bump to invalidate every previously-stored value of this slot. */
  version: number;
  /** Return the typed value when `raw` is the expected shape, else `undefined`. */
  validate(raw: unknown): T | undefined;
}

interface IStateEnvelope {
  v: number;
  data: unknown;
}

/** Read + validate a slot; `undefined` on absent / version-mismatch / invalid. */
export function loadWebviewState<T>(
  api: IWebviewStateApi,
  slot: IWebviewStateSlot<T>
): T | undefined {
  const all = api.getState();
  if (typeof all !== 'object' || all === null) {
    return undefined;
  }
  const env = (all as Record<string, unknown>)[slot.key];
  if (typeof env !== 'object' || env === null) {
    return undefined;
  }
  const { v, data } = env as IStateEnvelope;
  if (v !== slot.version) {
    return undefined;
  }
  return slot.validate(data);
}

/** Write a slot's value under a versioned envelope, preserving other slots. */
export function saveWebviewState<T>(
  api: IWebviewStateApi,
  slot: IWebviewStateSlot<T>,
  value: T
): void {
  const all = api.getState();
  const base = typeof all === 'object' && all !== null ? (all as Record<string, unknown>) : {};
  api.setState({ ...base, [slot.key]: { v: slot.version, data: value } });
}
