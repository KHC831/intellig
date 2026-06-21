/**
 * unit tests for the `renderCommitMessageHtml` helper.
 *
 * Covers:
 *  - Recognised refs (`#42`, `GH-101`, `PROJ-7`) become `<a href>` tags.
 *  - Non-refs like `abc#42` are not wrapped.
 *  - The call-back escape function is used for every text chunk so the
 *    output is safe to interpolate into a webview.
 *  - When `remote` is `undefined` the function falls back to escape-only.
 */

import '../../setup';
import * as assert from 'assert';
import { renderCommitMessageHtml } from '../../../src/utils/commitMessageHtml';
import { parseRemoteUrl } from '../../../src/utils/remoteUrl';

/** Mirror the GitToolWindowProvider._escapeHtml implementation for parity. */
function escapeHtml(text: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
}

describe('renderCommitMessageHtml', () => {
  const githubRemote = parseRemoteUrl('https://github.com/acme/widgets.git');
  assert.ok(githubRemote, 'precondition: github remote parses');

  it('wraps a #42 hash reference in an anchor tag', () => {
    const html = renderCommitMessageHtml('fix: close #42', githubRemote, escapeHtml);
    assert.ok(html.includes('<a class="commit-issue-link"'), `expected anchor tag; got: ${html}`);
    assert.ok(
      html.includes('https://github.com/acme/widgets/issues/42'),
      `expected provider URL in anchor; got: ${html}`
    );
    assert.ok(html.includes('>#42</a>'), `expected raw text preserved; got: ${html}`);
  });

  it('wraps a GH-99 reference in an anchor tag', () => {
    const html = renderCommitMessageHtml('merge: GH-99', githubRemote, escapeHtml);
    assert.ok(
      html.includes('https://github.com/acme/widgets/issues/99'),
      `expected GH-99 URL; got: ${html}`
    );
    assert.ok(html.includes('>GH-99</a>'), `expected raw text preserved; got: ${html}`);
  });

  it('wraps a JIRA-style PROJECT-123 reference in an anchor tag', () => {
    const html = renderCommitMessageHtml('PROJECT-123: cleanup', githubRemote, escapeHtml);
    assert.ok(
      html.includes('>PROJECT-123</a>'),
      `expected anchor wraps full JIRA id; got: ${html}`
    );
  });

  it('does NOT wrap `abc#42` (not a real reference)', () => {
    const html = renderCommitMessageHtml('see commit abc#42', githubRemote, escapeHtml);
    assert.ok(!html.includes('<a'), `expected no anchor tags for non-ref text; got: ${html}`);
    // Text content is preserved (escaped).
    assert.strictEqual(html, 'see commit abc#42');
  });

  it('escapes surrounding text as HTML', () => {
    const html = renderCommitMessageHtml('fix <img> bug #42 & more', githubRemote, escapeHtml);
    assert.ok(html.includes('&lt;img&gt;'), `expected <img> escaped; got: ${html}`);
    assert.ok(html.includes('&amp;'), `expected & escaped; got: ${html}`);
    assert.ok(
      html.includes('<a class="commit-issue-link"'),
      `expected anchor for #42; got: ${html}`
    );
  });

  it('falls back to escape-only when remote is undefined', () => {
    const html = renderCommitMessageHtml('fix #42', undefined, escapeHtml);
    assert.ok(!html.includes('<a'), `no anchor tags when remote is undefined; got: ${html}`);
    assert.strictEqual(html, 'fix #42');
  });

  it('returns empty string for empty input', () => {
    assert.strictEqual(renderCommitMessageHtml('', githubRemote, escapeHtml), '');
  });

  it('handles multiple refs in one message', () => {
    const html = renderCommitMessageHtml('merge #1 and #2 per PROJ-7', githubRemote, escapeHtml);
    const anchorCount = (html.match(/<a class="commit-issue-link"/g) ?? []).length;
    assert.strictEqual(anchorCount, 3, `expected 3 anchors; got ${anchorCount} in: ${html}`);
  });

  it('emits plain escaped text when the provider is unknown', () => {
    const unknownRemote = parseRemoteUrl('https://example.org/group/repo.git');
    assert.ok(unknownRemote, 'precondition: URL still parses to a bare struct');
    const html = renderCommitMessageHtml('closes #42', unknownRemote, escapeHtml);
    // `issueUrl` returns undefined for unknown providers, so the ref stays
    // as plain escaped text rather than an anchor.
    assert.ok(!html.includes('<a'), `no anchor for unknown provider; got: ${html}`);
    assert.strictEqual(html, 'closes #42');
  });
});
