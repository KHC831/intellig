/**
 * DOM helpers shared by the Commit tool window's webview modules: element
 * creation, attribute setting, and attribute-selector escaping.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

export function setAttrs<T extends Element>(
  node: T,
  attrs: Record<string, string | number | boolean | null | undefined>
): T {
  for (const k in attrs) {
    const v = attrs[k];
    if (v !== null && v !== undefined) {
      node.setAttribute(k, String(v));
    }
  }
  return node;
}

// Escape a value before splicing it into an attribute selector
// ([data-path="<path>"]). Prefers the native CSS.escape (present in the
// Chromium webview), falls back to a minimal escaper under test DOMs that lack
// the CSS global. A filename may legally contain a backslash on POSIX, which a
// quote-only escape would leave as an invalid selector that throws.
export function cssEscapeAttr(value: string): string {
  const s = String(value);
  const cssGlobal = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (cssGlobal && typeof cssGlobal.escape === 'function') {
    return cssGlobal.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
}
