/**
 * FU-1 — render a commit message as HTML with issue/PR references converted
 * to clickable links into the hosting provider's web UI.
 *
 * Keeps the HTML-escape pass and the link-wrap pass separate so the output
 * is always safe to drop into a webview. The linking pass operates on the
 * already-escaped text and only inserts `<a>` tags for references the
 * provider understands (via {@link commitUrl} / {@link issueUrl} from
 * `./hostingLinks`).
 *
 * Contract:
 *  - `escapeHtml` is injected so callers can reuse their existing helper.
 *  - When `remote` is `undefined` (e.g. `parseRemoteUrl` failed), the text
 *    is returned escape-only. No links.
 *  - When the `intellig.commitMessageIssueLinks` feature-flag is off,
 *    callers should skip this function entirely and use plain
 *    `escapeHtml(message)`.
 */

import { findIssueReferences, issueUrl } from './hostingLinks';
import type { IRemoteUrl } from './remoteUrl';

/**
 * Escape a string so it is safe to interpolate into an HTML attribute value.
 * Used for the `href` of the inserted `<a>` tags — the URL itself is built
 * by `issueUrl` and should already be safe, but defensive escaping keeps
 * the webview CSP happy.
 */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render `message` as HTML with issue/PR references wrapped in anchor tags.
 *
 * Two-pass strategy:
 *  1. Find all issue references in the raw message (so we have their
 *     source indices before any HTML-escaping happens).
 *  2. Walk the message, HTML-escaping each chunk, and for every reference
 *     emit `<a class="commit-issue-link" href="…" title="Open …">…</a>`.
 *
 * @param message - raw commit subject/body
 * @param remote - parsed remote URL (or `undefined` if no parseable remote)
 * @param escapeHtml - caller's HTML-escape helper (matches existing style)
 * @returns HTML string; safe to interpolate into a `<pre>` or `<span>`
 */
export function renderCommitMessageHtml(
  message: string,
  remote: IRemoteUrl | undefined,
  escapeHtml: (text: string) => string
): string {
  if (!message) return '';

  const refs = findIssueReferences(message);
  if (refs.length === 0 || !remote) {
    return escapeHtml(message);
  }

  // Build an URL for each ref (or `undefined` if the provider doesn't support it).
  const out: string[] = [];
  let cursor = 0;
  for (const ref of refs) {
    // Escape the chunk before this reference.
    if (ref.start > cursor) {
      out.push(escapeHtml(message.substring(cursor, ref.start)));
    }
    const url = issueUrl(remote, ref.id);
    const rawText = message.substring(ref.start, ref.end);
    if (url) {
      const safeHref = escapeHtmlAttr(url);
      const safeText = escapeHtml(rawText);
      const safeTitle = escapeHtmlAttr(`Open ${rawText} on ${remote.host}`);
      out.push(
        `<a class="commit-issue-link" href="${safeHref}" title="${safeTitle}">${safeText}</a>`
      );
    } else {
      // Provider can't build an issue URL — emit as plain escaped text.
      out.push(escapeHtml(rawText));
    }
    cursor = ref.end;
  }
  // Tail after the last reference.
  if (cursor < message.length) {
    out.push(escapeHtml(message.substring(cursor)));
  }
  return out.join('');
}
