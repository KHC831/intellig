import { randomBytes } from 'node:crypto';

/**
 * Generate a CSP nonce backed by `crypto.randomBytes`. Uses the base64url
 * alphabet (`A-Z a-z 0-9 - _`) so the result is URL-safe and CSP-safe
 * without padding. 16 random bytes → 22 encoded characters, which exceeds
 * the 128-bit recommendation for CSP nonces.
 *
 * Shared helper used by every IntelliG webview that needs a CSP nonce:
 * - {@link BaseWebviewPanel._getNonce}
 * - `CommitToolWindow` (local-changes + shelf HTML renderers)
 * - `GitToolWindowProvider` (log / details / branches panes)
 *
 * Replaces the former `Math.random()`-based implementations so every
 * webview nonce is cryptographically random instead of predictable. Kept
 * deliberately tiny and dependency-free so every call site can import
 * directly from `node:crypto` via this one entry point.
 */
export function generateNonce(): string {
  return randomBytes(16).toString('base64url');
}
