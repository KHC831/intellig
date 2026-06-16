/**
 * Unit tests for `sanitizeGitError` (src/utils/gitError.ts).
 *
 * Covers the senior-review LOW finding on credential leakage in error toasts.
 * The helper must strip `user:token@host` patterns from git stderr while
 * leaving ordinary error text intact.
 */

import * as assert from 'assert';
import {
  sanitizeGitError,
  formatActionFailureToast,
  worktreeConflictMessage,
} from '../../../git-core/gitError';

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

  // Credential scrubbing must cover ANY URL scheme, not just http/https.
  // git embeds `user:password@` in ssh/git/ftp/custom-scheme remotes too,
  // and all of those route through sanitizeGitError before hitting a toast.
  describe('non-http(s) scheme credential scrubbing', () => {
    it('redacts credentials in an ssh:// URL', () => {
      const raw = 'fatal: unable to access ssh://alice:secret@host/repo';
      const scrubbed = sanitizeGitError(raw);
      assert.ok(!scrubbed.includes('secret'), 'password must be redacted');
      assert.ok(!scrubbed.includes('alice'), 'user must be redacted');
      assert.ok(scrubbed.includes('ssh://<redacted>@host/repo'), 'scheme + host preserved');
    });

    it('redacts credentials in a git:// URL', () => {
      const raw = 'fatal: access git://bob:pw@h/r failed';
      const scrubbed = sanitizeGitError(raw);
      assert.ok(!scrubbed.includes('pw'), 'password must be redacted');
      assert.ok(!scrubbed.includes('bob'), 'user must be redacted');
      assert.ok(scrubbed.includes('git://<redacted>@h/r'), 'scheme + host preserved');
    });

    it('redacts credentials in an ftp:// URL', () => {
      const raw = 'ftp://u:p@host';
      const scrubbed = sanitizeGitError(raw);
      assert.ok(!scrubbed.includes(':p@'), 'password must be redacted');
      assert.strictEqual(scrubbed, 'ftp://<redacted>@host');
    });

    it('redacts credentials in a compound (`+`-bearing) scheme like https+git://', () => {
      const raw = 'https+git://carol:tok@host/repo';
      const scrubbed = sanitizeGitError(raw);
      assert.ok(!scrubbed.includes('tok'), 'password must be redacted');
      assert.ok(!scrubbed.includes('carol'), 'user must be redacted');
      assert.ok(scrubbed.includes('https+git://<redacted>@host/repo'), 'compound scheme preserved');
    });

    it('captures the FULL scheme (no partial-scheme corruption) for `xssh://`', () => {
      // Guard against the regex treating `xssh` as scheme `ssh` and leaving a
      // dangling `xs` — the word-boundary anchor must consume the whole token.
      const raw = 'xssh://u:p@host';
      const scrubbed = sanitizeGitError(raw);
      assert.ok(!scrubbed.includes(':p@'), 'password must be redacted');
      assert.strictEqual(scrubbed, 'xssh://<redacted>@host');
    });
  });

  it('leaves SCP-form `git@github.com:org/repo.git` UNCHANGED (no password in URL)', () => {
    // SCP-style remotes carry no `://` and no `:password@`, so there is
    // nothing to redact — the colon separates host from path, not user
    // from password. Over-redacting would corrupt the remote name.
    const raw = "fatal: could not read from remote 'git@github.com:org/repo.git'";
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
        // that sits at start-of-string. Without this, the fix would
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

// follow-up. Senior-wave9 found 18 reachable command
// handlers in extension.ts that bypass the structural guard's allowlist
// regex by inlining the err-derived ternary directly into the toast
// template:
//
//     `Failed to revert file: ${error instanceof Error ? error.message : 'Unknown error'}`
//
// The guard's `\$\{VAR\}` rule requires the body to be a single name;
// ternary expressions silently slip through. Sanitizing each catch
// block via a hoist would require touching 18 closures and importing
// `sanitizeGitError` everywhere; we extract a shared helper instead.
//
// `formatActionFailureToast(prefix, error)` is the single seam every
// catch block calls. It MUST:
//   1. Accept the action prefix as plain text (rendered verbatim).
//   2. Coerce Error / non-Error / string to a message string with the
// `'Unknown error'` fallback the codebase has used since.
//   3. Run the message through `sanitizeGitError` before returning.
//   4. Format as `${prefix}: ${sanitized}` so it drops directly into
//      a `showErrorMessage(...)` call without further interpolation.
//
// These specs pin (1)-(4) explicitly so future drift in any of them
// breaks a behavioural test, not just the structural guard.
describe('formatActionFailureToast — Wave 9 R4 helper for inline-ternary sites', () => {
  it('returns "<prefix>: Unknown error" for non-Error inputs', () => {
    // Coerces unknown shapes to the standard fallback so the toast
    // remains intelligible even when an exotic value is thrown.
    const result = formatActionFailureToast('Failed to revert file', 'string-thrown');
    assert.strictEqual(result, 'Failed to revert file: Unknown error');
  });

  it('extracts and sanitizes Error.message — credentialed URL', () => {
    const RAW = "fatal: unable to access 'https://x:ghp_TOKEN_XYZ@github.com/owner/repo.git/'";
    const result = formatActionFailureToast('Failed to revert file', new Error(RAW));
    assert.ok(!result.includes('ghp_TOKEN_XYZ'), `token must be redacted; got: "${result}"`);
    assert.ok(!result.includes('x:ghp_'), `user:token portion must be redacted; got: "${result}"`);
    assert.ok(result.includes('<redacted>@github.com'));
    assert.ok(result.startsWith('Failed to revert file: '));
  });

  it('extracts and sanitizes Error.message — POSIX home path', () => {
    const result = formatActionFailureToast(
      'Failed to open merge view',
      new Error("ENOENT: no such file or directory, open '/Users/alice/project/conflict.ts'")
    );
    assert.ok(!result.includes('/Users/alice/'), 'home path must be redacted');
    assert.ok(!result.includes('alice'), 'username must be redacted');
    assert.ok(result.includes('~/project/conflict.ts'));
    assert.ok(result.startsWith('Failed to open merge view: '));
  });

  it('passes a clean message through unchanged after the prefix', () => {
    const result = formatActionFailureToast('Failed to merge', new Error('not a fast-forward'));
    assert.strictEqual(result, 'Failed to merge: not a fast-forward');
  });

  it('handles an Error subclass with a populated message', () => {
    class GitError extends Error {
      constructor() {
        super('exit code 128');
      }
    }
    const result = formatActionFailureToast('Push failed', new GitError());
    assert.strictEqual(result, 'Push failed: exit code 128');
  });
});

describe('worktreeConflictMessage — translate git worktree-conflict fatal into actionable text', () => {
  it('returns an actionable message for "is already used by worktree at <path>"', () => {
    const raw = "fatal: 'feature' is already used by worktree at '/repos/proj-feature'";
    const msg = worktreeConflictMessage(raw);
    assert.ok(msg, 'should detect the worktree-conflict error');
    // Must NOT be the raw fatal dump.
    assert.ok(!msg.includes('fatal:'), `must not surface the raw fatal; got: "${msg}"`);
    // Must name the worktree path so the user can find it.
    assert.ok(msg.includes('/repos/proj-feature'), `should name the worktree path; got: "${msg}"`);
    // Must communicate "checked out in another worktree".
    assert.ok(
      /another worktree|other worktree/i.test(msg),
      `should mention another worktree; got: "${msg}"`
    );
  });

  it('matches the alternative "already checked out at <path>" phrasing', () => {
    const raw = "fatal: 'main' is already checked out at '/repos/main-wt'";
    const msg = worktreeConflictMessage(raw);
    assert.ok(msg, 'should detect the "already checked out at" variant');
    assert.ok(msg.includes('/repos/main-wt'), `should name the path; got: "${msg}"`);
  });

  it('sanitizes a leaked home path inside the worktree path', () => {
    const raw = "fatal: 'dev' is already used by worktree at '/Users/alice/code/proj-dev'";
    const msg = worktreeConflictMessage(raw);
    assert.ok(msg, 'should detect the conflict');
    assert.ok(!msg.includes('/Users/alice'), `home path must be redacted; got: "${msg}"`);
    assert.ok(msg.includes('~/code/proj-dev'), `should keep sanitized tail; got: "${msg}"`);
  });

  it('returns undefined for unrelated checkout failures (bad ref)', () => {
    assert.strictEqual(
      worktreeConflictMessage('fatal: invalid reference: nonexistent-branch'),
      undefined
    );
  });

  it('returns undefined for the "would be overwritten" dirty-tree failure', () => {
    assert.strictEqual(
      worktreeConflictMessage(
        'error: Your local changes to the following files would be overwritten by checkout'
      ),
      undefined
    );
  });

  it('returns undefined for empty input', () => {
    assert.strictEqual(worktreeConflictMessage(''), undefined);
  });

  it('returns undefined when a message merely contains "is already checked out" without the refusal shape', () => {
    // The bare substring can appear in unrelated text (a branch description,
    // a status line). Only the real refusal shape — `is already checked out
    // at '<path>'` or an explicit worktree mention — should translate.
    assert.strictEqual(
      worktreeConflictMessage('note: this topic branch is already checked out somewhere by me'),
      undefined
    );
  });

  it('detects the worktree refusal when "checked out" is paired with an explicit worktree mention', () => {
    const raw = "fatal: 'main' is already checked out in a linked worktree at '/repos/main-wt'";
    const msg = worktreeConflictMessage(raw);
    assert.ok(msg, 'should detect the conflict via the worktree mention');
    assert.ok(msg.includes('/repos/main-wt'), `should name the path; got: "${msg}"`);
  });

  it('still detects the conflict when the path cannot be parsed (no quoted path)', () => {
    // Defensive: if git changes its quoting, we still want the generic
    // actionable message rather than falling back to the raw fatal.
    const raw = 'fatal: branch is already used by worktree somewhere';
    const msg = worktreeConflictMessage(raw);
    assert.ok(msg, 'should still surface an actionable message without a parsed path');
    assert.ok(!msg.includes('fatal:'), `must not surface the raw fatal; got: "${msg}"`);
  });
});
