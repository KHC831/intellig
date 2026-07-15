/**
 * Versioned, validate-on-load slots over the webview VS Code API's
 * `getState()/setState()` — the webview-side sibling of the host's
 * `persistedState` seam (Phase 3 section 3d shape). A slot stores a `{ v, data }`
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

/**
 * True only for our own `{ v:number, data }` envelope — strict so a legacy bare
 * value (a raw number/string/object the pre-envelope inline scripts wrote) is
 * never mistaken for one and falls to the back-compat path below.
 */
function isStateEnvelope(v: unknown): v is IStateEnvelope {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).v === 'number' &&
    'data' in (v as Record<string, unknown>)
  );
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
  const stored = (all as Record<string, unknown>)[slot.key];
  if (stored === undefined) {
    return undefined;
  }
  if (isStateEnvelope(stored)) {
    if (stored.v !== slot.version) {
      return undefined; // shape changed → drop
    }
    return slot.validate(stored.data);
  }
  // Legacy bare value (pre-envelope inline scripts wrote the raw value directly
  // onto the state object) — validate as the current version so an existing
  // scroll/popup slot survives the upgrade instead of resetting to default.
  return slot.validate(stored);
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
