import '../../setup';
import * as assert from 'assert';
import { escapeHtml } from '../../../src/utils/escapeHtml';

describe('escapeHtml', () => {
  it('returns the input unchanged when it contains no special characters', () => {
    assert.strictEqual(escapeHtml('hello world'), 'hello world');
  });

  it('escapes ampersands', () => {
    assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
  });

  it('escapes less-than signs', () => {
    assert.strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
  });

  it('escapes double quotes', () => {
    assert.strictEqual(escapeHtml('"value"'), '&quot;value&quot;');
  });

  it('escapes single quotes', () => {
    assert.strictEqual(escapeHtml("it's"), 'it&#39;s');
  });

  it('handles all five special characters in one string', () => {
    assert.strictEqual(
      escapeHtml(`<div class="a" data-x='b'>foo & bar</div>`),
      '&lt;div class=&quot;a&quot; data-x=&#39;b&#39;&gt;foo &amp; bar&lt;/div&gt;'
    );
  });

  it('returns an empty string for empty input', () => {
    assert.strictEqual(escapeHtml(''), '');
  });

  it('escapes ampersand first so existing entities are not double-escaped', () => {
    // '&amp;' must NOT become '&amp;amp;' — each char is visited once.
    assert.strictEqual(escapeHtml('&amp;'), '&amp;amp;');
  });

  it('degrades non-string input instead of aborting a webview render', () => {
    // The TS signature promises a string, but a loosely-typed runtime path
    // (JSON off a message boundary) can slip through — a throw here blanks a
    // whole webview, which is worse than rendering the coerced value.
    assert.strictEqual(escapeHtml(undefined as unknown as string), '');
    assert.strictEqual(escapeHtml(null as unknown as string), '');
    assert.strictEqual(escapeHtml(42 as unknown as string), '42');
  });
});
