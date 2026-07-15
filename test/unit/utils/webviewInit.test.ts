/**
 * Spec for src/utils/webviewInit.ts — the host/entry init-island seam.
 *
 * Pins: attribute-safe escaping of the JSON payload, host→entry round-trip,
 * parseInitIsland's missing-payload guard, and that a payload which serializes
 * to `undefined` (a bare `undefined`, a function) degrades to `null` rather than
 * throwing a TypeError at render time.
 */
import * as assert from 'assert';
import { initIslandHtml, parseInitIsland, INIT_ELEMENT_ID } from '../../../src/utils/webviewInit';

/** Extract the (still-escaped) data-init attribute value from the island html. */
function dataInitAttr(html: string): string {
  const m = html.match(/data-init="([^"]*)"/);
  assert.ok(m, `expected a data-init attribute in: ${html}`);
  return m[1];
}

/** Reverse initIslandHtml's attribute escaping to recover the raw JSON string. */
function unescapeAttr(escaped: string): string {
  return escaped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

describe('webviewInit', () => {
  it('round-trips a payload through the escaped island attribute', () => {
    const init = { a: 1, s: 'hello', nested: { xs: [1, 2, 3] } };
    const html = initIslandHtml(init);
    assert.ok(html.includes(`id="${INIT_ELEMENT_ID}"`));
    const raw = unescapeAttr(dataInitAttr(html));
    assert.deepStrictEqual(parseInitIsland<typeof init>(raw), init);
  });

  it('escapes attribute-breaking and markup characters', () => {
    const html = initIslandHtml({ evil: '"><script>alert(1)</script>' });
    const attr = dataInitAttr(html);
    // No raw quote/angle-bracket may survive inside the attribute value.
    assert.ok(!attr.includes('"'), 'double-quote must be escaped');
    assert.ok(!attr.includes('<'), 'less-than must be escaped');
    assert.ok(!attr.includes('>'), 'greater-than must be escaped');
    // …and the payload still round-trips.
    assert.deepStrictEqual(parseInitIsland(unescapeAttr(attr)), {
      evil: '"><script>alert(1)</script>',
    });
  });

  it('parseInitIsland throws on a missing/empty payload', () => {
    assert.throws(() => parseInitIsland(null));
    assert.throws(() => parseInitIsland(undefined));
    assert.throws(() => parseInitIsland(''));
  });

  it('degrades an undefined-serializing payload to null instead of throwing', () => {
    // JSON.stringify(undefined) === undefined; the old code then called
    // .replace on it and threw a TypeError at render time.
    assert.doesNotThrow(() => initIslandHtml(undefined));
    const html = initIslandHtml(undefined);
    assert.strictEqual(parseInitIsland(unescapeAttr(dataInitAttr(html))), null);
  });
});
