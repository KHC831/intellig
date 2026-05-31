/**
 * Git error-message sanitization utilities.
 *
 * Motivation: `git` often embeds credentials in
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
 * The helper also strips absolute home-dir
 * paths that leak through `fs` errnos (`ENOENT: no such file or directory,
 * open '/Users/alice/Documents/secret-project/README.md'`). Screen
 * recordings of demos and user-submitted bug reports otherwise leak the
 * user's real account name plus project-location hints. We rewrite
 * `/Users/<name>/` and `/home/<name>/` to `~/` across the whole message.
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
 * Match absolute home-dir prefixes on macOS (`/Users/<name>/`) and on
 * Linux (`/home/<name>/`). The username capture is any run of chars that
 * don't include a `/`, `\`, or whitespace — VS Code prints fs errnos as
 * single-quoted paths, so spaces in the middle of the path don't occur
 * inside the username segment.
 *
 * ### Left-anchor
 *
 * Group [1] captures a start-of-string OR one of the delimiters that
 * typically precede an absolute path in stderr/logs: whitespace, quote
 * (single/double), open-paren, open-bracket. Without this anchor the
 * regex happily rewrote `/repo/Users/alice/data/` → `/repo~/data/`, an
 * over-redaction that corrupted legitimate repo paths containing a
 * `Users` subdir. The `$1` in the replacement preserves whichever
 * delimiter matched so the surrounding message text stays intact.
 *
 * Deliberately NOT redacting:
 *   - `C:\\Users\\<name>\\` (Windows) — covered by the Windows-specific
 *     regexes below (both backslash + forward-slash shapes).
 *   - `/var/folders/…` (macOS tmpdir) — no PII; mkdtemp-path leakage is
 *     covered by the atomic-write helper's explicit `.tmp-` naming.
 *
 * Groups:
 *   [1] leading delimiter — preserved via `$1` in the replacement
 *   [2] username segment (captured so we could use it if we ever want to
 *       emit `~<name>` — currently unused, kept for symmetry)
 */
const POSIX_HOME_PATH_REGEX = /(^|[\s'"([])\/(?:Users|home)\/([^/\s'"]+)\//g;

/**
 * Match Windows home-dir prefixes with **backslash** separators
 * (`C:\Users\<name>\`). Case-insensitive because the drive letter and
 * `Users` path segment both vary by locale and tool — git echoes paths
 * with mixed casing depending on how the stderr was generated.
 *
 * ### Left-anchor
 *
 * Symmetric to the POSIX left-anchor: group [1] captures start-of-string
 * or a delimiter (whitespace, quote, open-paren/bracket) so a bare
 * bigram like `log:C:\Users\alice\...` can't collapse through the `:C:`
 * infix. The forward-slash form had the same hazard with
 * `log:/Users/alice/x` → `lo~/x`; both Windows shapes now share the
 * POSIX anchor for symmetry.
 *
 * Groups:
 *   [1] leading delimiter — preserved via `$1` in the replacement
 *   [2] drive letter — captured but unused (currently discarded because
 *       `~\` is the target; kept in the regex for future extensibility
 *       if we ever want to preserve the drive)
 *   [3] username segment
 */
const WINDOWS_BACKSLASH_HOME_PATH_REGEX = /(^|[\s'"([])([A-Za-z]):\\Users\\([^\\/\s'"]+)\\/gi;

/**
 * Match Windows home-dir prefixes with **forward-slash** separators
 * (`C:/Users/<name>/`). VS Code frequently normalises Windows paths to
 * forward slashes in stderr + URI-derived error messages — without this
 * second regex the drive-letter prefix would escape the backslash-only
 * form and leave `C:~/x.ts` output after the POSIX pass ran. Runs BEFORE
 * the POSIX regex so it drops the `[A-Za-z]:` drive-letter; the POSIX
 * regex would otherwise find a second match inside the already-partially-
 * redacted string.
 *
 * ### Left-anchor
 *
 * Same left-anchor as the backslash variant. Without it,
 * `log:/Users/alice/x` gets matched on the trailing `g:/Users/alice/`
 * fragment (drive-letter regex greedily consumes the `g` as a single-
 * letter drive) and collapses to `lo~/x`.
 *
 * Groups:
 *   [1] leading delimiter — preserved via `$1` in the replacement
 *   [2] drive letter — captured but unused (see backslash variant)
 *   [3] username segment
 */
const WINDOWS_FORWARDSLASH_HOME_PATH_REGEX = /(^|[\s'"([])([A-Za-z]):\/Users\/([^/\s'"]+)\//gi;

/**
 * Scrub credentials and home-dir paths from a git stderr/error string.
 *
 * Replacements (applied in order — ordering matters; see per-regex JSDoc):
 *   1. `https://user:password@host…` → `https://<redacted>@host…`
 *   2. `C:\Users\<name>\` → `~\` (Windows backslash form)
 *   3. `C:/Users/<name>/` → `~/` (Windows forward-slash form — runs
 *      before the POSIX pass so the drive letter is consumed with the
 *      rest of the prefix)
 *   4. `/Users/<name>/` or `/home/<name>/` → `~/` (POSIX; left-anchored
 *      to start-of-string or a delimiter so `/repo/Users/alice/` is
 *      left alone)
 *
 * Non-matching content passes through unchanged. Multiple hits per message
 * are each scrubbed independently.
 *
 * @param message the raw git stderr/error string
 * @returns a sanitized copy safe to show in a toast, log, or structured
 *   error payload
 */
export function sanitizeGitError(message: string): string {
  if (!message) {
    return message;
  }
  return message
    .replace(CREDENTIAL_URL_REGEX, '$1://<redacted>@')
    .replace(WINDOWS_BACKSLASH_HOME_PATH_REGEX, '$1~\\')
    .replace(WINDOWS_FORWARDSLASH_HOME_PATH_REGEX, '$1~/')
    .replace(POSIX_HOME_PATH_REGEX, '$1~/');
}

/**
 * Format an action-failure toast body that's safe to drop directly
 * into `vscode.window.showErrorMessage(...)`.
 *
 * Some command handlers in `extension.ts` bypassed the structural
 * sanitisation guard by inlining the err-derived ternary directly
 * into the toast template:
 *
 * ```ts
 * void vscode.window.showErrorMessage(
 *   `Failed to revert file: ${error instanceof Error ? error.message : 'Unknown error'}`
 * );
 * ```
 *
 * The guard's `${VAR}` allowlist rule expects a single allowlisted
 * variable name; ternary expressions silently slipped through.
 * Hoisting each ternary into a local `const` would require touching
 * every closure and was deemed bug-prone (one missed site = leak).
 * Instead, every catch block calls this single seam:
 *
 * ```ts
 * void vscode.window.showErrorMessage(
 *   formatActionFailureToast('Failed to revert file', error)
 * );
 * ```
 *
 * The returned string is `${prefix}: ${sanitizeGitError(message)}`
 * with `'Unknown error'` substituted when the thrown value isn't
 * an `Error` instance. The swept sites in extension.ts plus
 * future inline-ternary callers all funnel through this helper, so
 * the structural guard's `.message` rule + the per-site specs in
 * `gitError.test.ts` provide
 * defense-in-depth.
 *
 * @param prefix — the user-facing action label (e.g. `'Failed to
 *   revert file'`). Rendered verbatim before `: `; not sanitised
 *   because it is hard-coded by the call site.
 * @param error — the thrown value. `Error` instances contribute
 *   `error.message`; everything else falls back to `'Unknown error'`.
 * @returns the formatted, sanitised toast body.
 */
export function formatActionFailureToast(prefix: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Unknown error';
  return `${prefix}: ${sanitizeGitError(raw)}`;
}
