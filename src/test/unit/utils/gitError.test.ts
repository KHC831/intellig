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
    const clean = 'fatal: not a git repository (or any parent up to mount point /)';
    assert.strictEqual(sanitizeGitError(clean), clean);
  });

  it('returns the empty string for empty input', () => {
    assert.strictEqual(sanitizeGitError(''), '');
  });

  it('redacts PAT-in-URL (https://x-access-token:ghp_…@github.com/…)', () => {
    const raw =
      "fatal: unable to access 'https://x-access-token:ghp_ABC123xyz@github.com/owner/repo.git/': ";
    const scrubbed = sanitizeGitError(raw);
    assert.ok(!scrubbed.includes('ghp_ABC123xyz'), 'token must be redacted');
    assert.ok(!scrubbed.includes('x-access-token'), 'user must be redacted');
    assert.ok(scrubbed.includes('<redacted>@github.com'), 'host is preserved after redaction');
    assert.ok(scrubbed.includes('https://'), 'scheme preserved');
  });

  it('redacts multiple URLs in a single message', () => {
    const raw =
      'remote failed at https://alice:secret1@host-a.example/repo.git and ' +
      'fallback https://bob:secret2@host-b.example/repo.git';
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
    const raw = 'fatal: access error http://user:pw@example.com/repo.git';
    const scrubbed = sanitizeGitError(raw);
    assert.ok(scrubbed.includes('http://<redacted>@example.com'));
    assert.ok(!scrubbed.includes('pw'));
  });

  it('handles passwords containing colons', () => {
    // Git percent-encodes `:` in real URLs, but stderr can echo raw PATs
    // from user `.gitconfig`. The regex stops at `@` so colons inside the
    // password must still be stripped.
    const raw = 'fatal: access https://user:abc:def:ghi@host.example/repo.git failed';
    const scrubbed = sanitizeGitError(raw);
    assert.ok(!scrubbed.includes('abc:def:ghi'));
    assert.ok(scrubbed.includes('<redacted>@host.example'));
  });

  it('handles URLs with query strings', () => {
    const raw = 'fatal: access https://u:p@host.example/path?refs=main&deep=true';
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
    const raw = 'ssh://git@github.com/owner/repo.git';
    assert.strictEqual(sanitizeGitError(raw), raw);
  });

  // Senior-wave4 LOW #4 — home-dir path stripping. fs errnos leak
  // `/Users/<name>/…` and `/home/<name>/…` into toasts, structured
  // errors, logs, and screen recordings.
  describe('home-dir path stripping', () => {
    it('replaces /Users/<name>/ with ~/ in macOS fs errnos', () => {
      const raw =
        "ENOENT: no such file or directory, open '/Users/alice/Documents/secret-project/README.md'";
      const scrubbed = sanitizeGitError(raw);
      assert.ok(!scrubbed.includes('/Users/alice/'), 'absolute macOS home path must be redacted');
      assert.ok(!scrubbed.includes('alice'), 'username must be redacted');
      assert.ok(
        scrubbed.includes('~/Documents/secret-project/README.md'),
        'relative suffix preserved'
      );
    });

    it('replaces /home/<name>/ with ~/ in Linux fs errnos', () => {
      const raw = "EACCES: permission denied, open '/home/bob/projects/intellig/.git/index'";
      const scrubbed = sanitizeGitError(raw);
      assert.ok(!scrubbed.includes('/home/bob/'), 'absolute linux home path must be redacted');
      assert.ok(!scrubbed.includes('bob'), 'username must be redacted');
      assert.ok(scrubbed.includes('~/projects/intellig/.git/index'));
    });

    it('replaces C:\\Users\\<name>\\ with ~\\ in Windows fs errnos', () => {
      const raw = "ENOENT: no such file or directory, open 'C:\\Users\\carol\\project\\file.ts'";
      const scrubbed = sanitizeGitError(raw);
      assert.ok(
        !scrubbed.includes('C:\\Users\\carol\\'),
        'absolute windows home path must be redacted'
      );
      assert.ok(!scrubbed.includes('carol'), 'username must be redacted');
      assert.ok(scrubbed.includes('~\\project\\file.ts'));
    });

    it('redacts all occurrences when multiple home paths appear in one message', () => {
      const raw = "ENOENT: '/Users/alice/src/a.ts' and '/Users/alice/backup/a.ts' both missing";
      const scrubbed = sanitizeGitError(raw);
      assert.ok(!scrubbed.includes('/Users/alice/'));
      // Two independent `~/` replacements, not merged.
      assert.ok(scrubbed.includes('~/src/a.ts'));
      assert.ok(scrubbed.includes('~/backup/a.ts'));
    });

    it('leaves /usr/, /opt/, /var/ alone (not home dirs, not PII)', () => {
      const raw =
        'ENOENT: no such file or directory, open /usr/local/bin/git — also checked /opt/homebrew/bin and /var/folders/tmp';
      assert.strictEqual(sanitizeGitError(raw), raw);
    });

    it('leaves /Users and /home alone when not followed by a username segment', () => {
      // Defensive: bare `/Users` or `/home` without a trailing
      // `<name>/` shouldn't match — the regex requires the slash after
      // the username.
      const raw = 'ls: cannot read /Users and /home directly';
      assert.strictEqual(sanitizeGitError(raw), raw);
    });

    it('composes with credential-URL scrubbing in the same message', () => {
      const raw =
        "ENOENT: open '/Users/alice/token.txt'; also fatal: https://x:ghp_XYZ@github.com/o/r";
      const scrubbed = sanitizeGitError(raw);
      assert.ok(!scrubbed.includes('/Users/alice/'));
      assert.ok(!scrubbed.includes('ghp_XYZ'));
      assert.ok(scrubbed.includes('~/token.txt'));
      assert.ok(scrubbed.includes('<redacted>@github.com'));
    });

    // Senior-wave4-r2 LOW #1 — regex must not over-match mid-path
    // occurrences of `Users`/`home` inside a legitimate repo tree. A
    // project literally named `/tmp/repo/Users/alice/data/…` or
    // `/srv/checkout/home/bob/…` is legal and has nothing to do with
    // a user's home directory; previously the regex rewrote both to
    // garbage (`/tmp/repo~/data/…`).
    describe('left-anchor: does NOT over-match embedded /Users/ or /home/', () => {
      it('leaves /repo/Users/alice/data/ alone (not preceded by a delimiter that signals root)', () => {
        const raw = "ENOENT: no such file or directory, open '/tmp/repo/Users/alice/data/file.txt'";
        const scrubbed = sanitizeGitError(raw);
        // The `/Users/alice/` segment sits inside a deeper path — the
        // `/repo/` prefix is the true mount point. Regex must not
        // rewrite it to `~/data/file.txt`.
        assert.ok(
          scrubbed.includes('/tmp/repo/Users/alice/data/file.txt'),
          `expected embedded path to be left alone, got: "${scrubbed}"`
        );
        assert.ok(!scrubbed.includes('/tmp/repo~/'), 'must not produce a half-redacted corruption');
      });

      it('leaves /srv/checkout/home/bob/ alone (mid-path /home/<name>/)', () => {
        const raw = "EACCES: '/srv/checkout/home/bob/project/.git/index'";
        const scrubbed = sanitizeGitError(raw);
        assert.ok(scrubbed.includes('/srv/checkout/home/bob/project/.git/index'));
        assert.ok(!scrubbed.includes('/srv/checkout~/'));
      });

      it('still strips an absolute path at the start of a message', () => {
        // Start-of-string anchor must still fire when the path is
        // emitted without a leading delimiter (common for node stack
        // traces where the path is the first token on a line).
        const raw = '/Users/dave/projects/foo/bar.ts: unexpected token';
        const scrubbed = sanitizeGitError(raw);
        assert.ok(
          scrubbed.startsWith('~/projects/foo/bar.ts'),
          `start-of-string match should still fire, got: "${scrubbed}"`
        );
        assert.ok(!scrubbed.includes('/Users/dave/'));
      });

      it('strips path preceded by a paren or bracket (stack-trace form)', () => {
        const raw = '  at Object.<anonymous> (/Users/eve/project/src/index.js:1:23)';
        const scrubbed = sanitizeGitError(raw);
        assert.ok(scrubbed.includes('(~/project/src/index.js:1:23)'));
        assert.ok(!scrubbed.includes('/Users/eve/'));
      });
    });

    // Senior-wave4-r2 OBS #1 — VS Code frequently normalises Windows
    // paths to forward slashes (URI-derived strings, stderr from git
    // compiled with forward-slash support, etc.). The backslash-only
    // regex left `C:/Users/<name>/` matching the POSIX pass's middle
    // segment, producing `C:~/x.ts` — awkward partial redaction.
    describe('Windows forward-slash variant', () => {
      it('replaces C:/Users/<name>/ with ~/ (drive letter consumed)', () => {
        const raw = "ENOENT: no such file or directory, open 'C:/Users/carol/x.ts'";
        const scrubbed = sanitizeGitError(raw);
        assert.ok(
          !scrubbed.includes('C:/Users/carol/'),
          `full prefix must be redacted, got: "${scrubbed}"`
        );
        assert.ok(!scrubbed.includes('C:~/'), 'drive letter must not survive');
        assert.ok(!scrubbed.includes('carol'), 'username must be redacted');
        assert.ok(scrubbed.includes('~/x.ts'), `expected clean suffix, got: "${scrubbed}"`);
      });

      it('is case-insensitive on drive letter and Users segment', () => {
        const raw = "ENOENT: open 'd:/users/dave/project/file.go'";
        const scrubbed = sanitizeGitError(raw);
        assert.ok(!scrubbed.includes('d:/users/dave/'));
        assert.ok(scrubbed.includes('~/project/file.go'));
      });
    });

    // Senior-wave4-r3 LOW #1 — Windows regexes (both backslash and
    // forward-slash) previously lacked the left-anchor the POSIX regex
    // had, so any bigram `<letter>:` embedded inside a token would be
    // mis-matched as a drive-letter prefix and collapse the surrounding
    // characters. Example: `log:/Users/alice/x` greedily matched
    // `g:/Users/alice/` → `lo~/x`. Fix mirrors the POSIX anchor.
    describe('Windows left-anchor: does NOT over-match mid-token drive-letter bigrams', () => {
      it('leaves "log:/Users/alice/x" alone (g: inside log: is not a drive letter)', () => {
        const raw = 'log:/Users/alice/x';
        const scrubbed = sanitizeGitError(raw);
        assert.strictEqual(
          scrubbed,
          raw,
          `mid-token drive-letter bigram must not collapse; got: "${scrubbed}"`
        );
      });

      it('leaves "path:/Users/bob/foo" alone (h: is not a drive letter here)', () => {
        const raw = 'path:/Users/bob/foo';
        const scrubbed = sanitizeGitError(raw);
        assert.strictEqual(
          scrubbed,
          raw,
          `mid-token drive-letter bigram must not collapse; got: "${scrubbed}"`
        );
      });

      it('leaves "url:/Users/alice/token.txt" alone (l: is not a drive letter here)', () => {
        const raw = 'url:/Users/alice/token.txt';
        const scrubbed = sanitizeGitError(raw);
        assert.strictEqual(
          scrubbed,
          raw,
          `mid-token drive-letter bigram must not collapse; got: "${scrubbed}"`
        );
      });

      it('still strips "C:/Users/alice/x" when it starts the message (drive letter at SOS)', () => {
        // Sanity: the left-anchor must still fire on a drive letter
        // that sits at start-of-string. Without this, the R3 fix would
        // have broken the legitimate Windows forward-slash case.
        const raw = 'C:/Users/alice/x.ts';
        const scrubbed = sanitizeGitError(raw);
        assert.ok(
          scrubbed.startsWith('~/x.ts'),
          `start-of-string drive letter should still strip; got: "${scrubbed}"`
        );
      });

      it('still strips backslash Windows path preceded by a quote', () => {
        // Sanity: the existing delimiter-prefixed Windows case still works.
        const raw = "ENOENT: 'C:\\Users\\alice\\project\\file.ts'";
        const scrubbed = sanitizeGitError(raw);
        assert.ok(!scrubbed.includes('C:\\Users\\alice\\'));
        assert.ok(scrubbed.includes('~\\project\\file.ts'));
      });
    });
  });
});
