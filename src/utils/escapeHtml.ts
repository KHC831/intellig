/**
 * Shared HTML-escaping utility.
 *
 * Single source of truth for escaping user-controlled strings before they are
 * interpolated into HTML attribute values or text content. Replaces the ~13
 * identical local copies that were scattered across the codebase.
 *
 * Uses a single-pass map lookup (one `.replace` call) rather than five chained
 * calls so each character is visited once.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape HTML special characters in {@param text} so it is safe to interpolate
 * as text content or an attribute value.
 *
 * Escapes: `&` `<` `>` `"` `'`
 *
 * Tolerates non-string input at runtime (null/undefined → '', anything else
 * coerced) even though the signature promises a string: a loosely-typed value
 * off a webview message boundary must degrade in place, not throw and blank
 * the whole render.
 */
export function escapeHtml(text: string): string {
  if (typeof text !== 'string') {
    return text === null || text === undefined ? '' : escapeHtml(String(text));
  }
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}
