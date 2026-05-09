/**
 * Unit tests for `sanitizeGitError` (src/utils/gitError.ts).
 *
 * Covers the senior-review LOW finding on credential leakage in error toasts.
 * The helper must strip `user:token@host` patterns from git stderr while
 * leaving ordinary error text intact.
 */

import * as assert from 'assert';
import { sanitizeGitError } from '../../../utils/gitError';

describe('sanitizeGitError', () => {
  it('passes clean messages through unchanged', () => {
    const clean = "fatal: not a git repository (or any parent up to mount point /)";
    assert.strictEqual(sanitizeGitError(clean), clean);
  });

  it('returns the empty string for empty input', () => {
    assert.strictEqual(sanitizeGitError(''), '');
  });

  it('redacts PAT-in-URL (https://x-access-token:ghp_…@github.com/…)', () => {
    const raw = "fatal: unable to access 'https://x-access-token:ghp_ABC123xyz@github.com/owner/repo.git/': ";
    const scrubbed = sanitizeGitError(raw);
    assert.ok(!scrubbed.includes('ghp_ABC123xyz'), 'token must be redacted');
    assert.ok(!scrubbed.includes('x-access-token'), 'user must be redacted');
    assert.ok(scrubbed.includes('<redacted>@github.com'), 'host is preserved after redaction');
    assert.ok(scrubbed.includes('https://'), 'scheme preserved');
  });

  it('redacts multiple URLs in a single message', () => {
    const raw =
      "remote failed at https://alice:secret1@host-a.example/repo.git and " +
      "fallback https://bob:secret2@host-b.example/repo.git";
    const scrubbed = sanitizeGitError(raw);
    assert.ok(!scrubbed.includes('secret1'));
    assert.ok(!scrubbed.includes('secret2'));
    assert.ok(!scrubbed.includes('alice'));
    assert.ok(!scrubbed.includes('bob'));
    // Both hosts remain.
    assert.ok(scrubbed.includes('<redacted>@host-a.example'));
    assert.ok(scrubbed.includes('<redacted>@host-b.example'));
  });

  it('handles http (not only https) URLs', () => {
    const raw = "fatal: access error http://user:pw@example.com/repo.git";
    const scrubbed = sanitizeGitError(raw);
    assert.ok(scrubbed.includes('http://<redacted>@example.com'));
    assert.ok(!scrubbed.includes('pw'));
  });

  it('handles passwords containing colons', () => {
    // Git percent-encodes `:` in real URLs, but stderr can echo raw PATs
    // from user `.gitconfig`. The regex stops at `@` so colons inside the
    // password must still be stripped.
    const raw = "fatal: access https://user:abc:def:ghi@host.example/repo.git failed";
    const scrubbed = sanitizeGitError(raw);
    assert.ok(!scrubbed.includes('abc:def:ghi'));
    assert.ok(scrubbed.includes('<redacted>@host.example'));
  });

  it('handles URLs with query strings', () => {
    const raw = "fatal: access https://u:p@host.example/path?refs=main&deep=true";
    const scrubbed = sanitizeGitError(raw);
    assert.ok(scrubbed.includes('<redacted>@host.example/path?refs=main&deep=true'));
    assert.ok(!scrubbed.includes(':p@'));
  });

  it('leaves URLs without embedded credentials alone', () => {
    const raw = "fatal: unable to access 'https://github.com/owner/repo.git/': 404 Not Found";
    assert.strictEqual(sanitizeGitError(raw), raw);
  });

  it('leaves `ssh://user@host/…` alone (no password portion to leak)', () => {
    // `ssh://git@github.com/owner/repo.git` has a user but no `:password`.
    // We intentionally don't scrub plain `user@host` — that's a public
    // identifier, not a secret, and usernames are often meaningful.
    const raw = "ssh://git@github.com/owner/repo.git";
    assert.strictEqual(sanitizeGitError(raw), raw);
  });
});
