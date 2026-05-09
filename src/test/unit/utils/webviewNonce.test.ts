/**
 * Unit tests for the shared {@link generateNonce} helper
 * (src/utils/webviewNonce.ts).
 *
 * Covers the TL-12 contract:
 * - Uses `crypto.randomBytes` (via fixed 16-byte → base64url length of 22).
 * - Only emits characters from the base64url alphabet (`A-Z a-z 0-9 - _`).
 * - 100 nonces are all distinct (smoke for the CSPRNG — stronger guarantees
 *   than Math.random-based nonces).
 *
 * The helper is the single source of truth for BaseWebviewPanel,
 * CommitToolWindow, and GitToolWindowProvider — if its shape changes, every
 * webview's CSP meta tag must stay compatible.
 */

import * as assert from 'assert';
import { generateNonce } from '../../../utils/webviewNonce';

describe('generateNonce (shared webview helper)', () => {
  const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
  const EXPECTED_LENGTH = 22; // 16 bytes → base64url (no padding) = 22 chars

  it('always returns a 22-character string', () => {
    for (let i = 0; i < 100; i++) {
      const nonce = generateNonce();
      assert.strictEqual(
        nonce.length,
        EXPECTED_LENGTH,
        `nonce "${nonce}" should be exactly ${EXPECTED_LENGTH} chars (got ${nonce.length})`
      );
    }
  });

  it('only emits characters from the base64url alphabet (A-Z a-z 0-9 - _)', () => {
    for (let i = 0; i < 100; i++) {
      const nonce = generateNonce();
      assert.ok(
        BASE64URL_PATTERN.test(nonce),
        `nonce "${nonce}" should match /^[A-Za-z0-9_-]+$/`
      );
    }
  });

  it('never emits base64 padding (=) or standard-alphabet chars (+ /)', () => {
    for (let i = 0; i < 100; i++) {
      const nonce = generateNonce();
      assert.ok(!nonce.includes('='), `nonce must be unpadded (got "${nonce}")`);
      assert.ok(!nonce.includes('+'), `nonce must be URL-safe (got "${nonce}")`);
      assert.ok(!nonce.includes('/'), `nonce must be URL-safe (got "${nonce}")`);
    }
  });

  it('produces 100 distinct nonces across a tight loop (CSPRNG collision smoke test)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(generateNonce());
    }
    assert.strictEqual(
      seen.size,
      100,
      `all 100 nonces should be unique (got ${seen.size} distinct)`
    );
  });

  it('returns a string (narrowing smoke test)', () => {
    const nonce = generateNonce();
    assert.strictEqual(typeof nonce, 'string');
  });
});
