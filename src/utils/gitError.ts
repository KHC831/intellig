/**
 * Git error-message sanitization utilities.
 *
 * Motivation (senior review LOW finding): `git` often embeds credentials in
 * remote URLs that appear in stderr — e.g.
 *
 *   remote: Support for password authentication was removed…
 *   fatal: unable to access 'https://x-access-token:ghp_abc123@github.com/owner/repo.git/': …
 *
 * When that stderr is surfaced via `vscode.window.showErrorMessage` /
 * `showWarningMessage` / per-row banners, the token lands in the user's
 * notification history and screen recordings. This module provides a pure
 * helper that redacts the `user:token@host` portion before the message is
 * rendered.
 *
 * Kept tiny and dependency-free so every git-adjacent surface can use it.
 */

/**
 * Match the `<user>:<password>@` infix inside http/https URLs. The password
 * portion can contain almost anything except `@` (git percent-encodes the
 * rest). We do NOT require a following path segment so query-string-only
 * URLs (`https://u:p@host?query`) match too.
 *
 * Groups:
 *   [1] scheme (`http` | `https`)
 *   [2] user portion (any chars except `:` and `@`)
 */
const CREDENTIAL_URL_REGEX = /\b(https?):\/\/([^\s:/@]+):[^@\s]*@/gi;

/**
 * Scrub credentials embedded in URLs in a git stderr/error string.
 *
 * Replaces `https://user:password@host…` with `https://<redacted>@host…`
 * (scheme preserved, host and path preserved, user+password redacted).
 *
 * Non-URL content is passed through unchanged. Multiple URLs in one message
 * are each scrubbed independently.
 *
 * @param message the raw git stderr/error string
 * @returns a sanitized copy safe to show in a toast or log
 */
export function sanitizeGitError(message: string): string {
  if (!message) {
    return message;
  }
  return message.replace(CREDENTIAL_URL_REGEX, '$1://<redacted>@');
}
