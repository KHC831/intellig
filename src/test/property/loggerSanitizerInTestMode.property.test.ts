/**
 * Task 4.12 — property test for sanitizer redaction under test mode.
 *
 * Pins Requirement 4.7: "WHERE the test suite is running (NODE_ENV is
 * `'test'` or the `MOCHA_WORKER_ID` environment variable is set), THE
 * Log_Sanitizer SHALL still apply redaction; tests assert against
 * sanitized output."
 *
 * The risk this property guards against is a future maintainer adding
 * a `if (process.env.NODE_ENV === 'test') return value;` early-out to
 * `sanitizeRecord` (or to `sanitizeGitError` underneath) — typically a
 * mis-aimed attempt to "make tests easier to debug" by surfacing raw
 * paths/credentials. Such an early-out would silently break the
 * §4.1–§4.4 redaction guarantees for every property test that asserts
 * the sanitizer removed a secret. The contract this file pins is:
 *
 *   sanitizeRecord(R, NODE_ENV='test', MOCHA_WORKER_ID='1') === sanitizeRecord(R)
 *
 * i.e. the env vars Mocha sets while running the test suite have NO
 * effect on the sanitizer's output. We assert this by constructing
 * `LogRecord`s whose fields carry sentinel "secret" substrings — a
 * credentialed URL token and a home-directory username — running them
 * through `sanitizeRecord` with the test-mode env vars defensively
 * set, and asserting the sentinels do not appear anywhere in the
 * sanitized output.
 *
 * **Validates: Requirement 4.7**
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import { sanitizeRecord } from '../../utils/logger/sanitize';
import type { JsonValue, LogLevel, LogRecord } from '../../utils/logger/sinks/types';

/**
 * Walk a sanitized `LogRecord` and concatenate every string-valued
 * leaf into one buffer. The non-leakage assertion is "does the
 * sentinel appear *anywhere* in the rendered record" — collecting
 * leaves into a single string is the simplest, most failure-mode-
 * agnostic way to make that check. The walker mirrors the sanitizer's
 * own recursion: `message`, `correlationId`, `error.message`,
 * `error.stack`, plus a recursive walk of `context`.
 */
function collectStringLeaves(record: LogRecord): string {
  const buf: string[] = [];
  buf.push(record.message);
  if (record.correlationId !== undefined) {
    buf.push(record.correlationId);
  }
  if (record.error !== undefined) {
    buf.push(record.error.message);
    if (record.error.stack !== undefined) {
      buf.push(record.error.stack);
    }
  }
  if (record.context !== undefined) {
    walkJson(record.context, buf);
  }
  return buf.join('\n');
}

function walkJson(value: JsonValue | undefined, out: string[]): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkJson(item, out);
    }
    return;
  }
  // Plain object branch.
  for (const key of Object.keys(value)) {
    walkJson(
      (value as { readonly [k: string]: JsonValue | undefined })[key],
      out
    );
  }
}

/**
 * Generate a non-empty token suitable for embedding as a credential
 * URL user/password segment OR as a home-directory username. Excludes
 * every char the sanitizer's regexes treat as a delimiter
 * (whitespace, `/`, `\`, `:`, `@`, single/double quotes,
 * paren/bracket) so the regex matches the substring we generated
 * rather than a partial fragment. Also excludes `<`, `>`, `~`, and
 * the literal substring `redacted` so the post-redaction marker
 * `<redacted>` and the `~/` home-prefix replacement can't be confused
 * for a leaked sentinel during the assertion.
 */
const sentinelTokenArb: fc.Arbitrary<string> = fc
  .string({ minLength: 4, maxLength: 24 })
  .filter(
    (s) =>
      s.length >= 4 &&
      // Exclude every regex delimiter and the post-redaction markers
      // so the sentinel survives in input form and is uniquely
      // identifiable in the output.
      !/[\s/\\:@'"()[\]<>~]/.test(s) &&
      !s.toLowerCase().includes('redacted')
  );

/**
 * Build a credentialed HTTPS URL fragment: `https://<user>:<password>@host/path`.
 * Returns the URL plus the user and password substrings so the test
 * can assert each one is absent from the sanitized output.
 */
const credentialUrlArb = fc
  .tuple(sentinelTokenArb, sentinelTokenArb)
  .map(([user, password]) => ({
    user,
    password,
    url: `https://${user}:${password}@example.com/repo.git`,
  }));

/**
 * Build a POSIX home-path fragment with a sentinel username:
 * ` /Users/<name>/path` or ` /home/<name>/path`. The leading space is
 * required because the sanitizer's POSIX regex is left-anchored to a
 * delimiter.
 */
const posixHomePathArb = fc
  .tuple(sentinelTokenArb, fc.constantFrom<'Users' | 'home'>('Users', 'home'))
  .map(([username, prefix]) => ({
    username,
    path: ` /${prefix}/${username}/projects/intellig/file.ts`,
  }));

/**
 * Build a Windows home-path fragment (backslash form) with a sentinel
 * username: ` C:\Users\<name>\path`.
 */
const windowsBackslashHomePathArb = fc.tuple(sentinelTokenArb).map(([username]) => ({
  username,
  path: ` C:\\Users\\${username}\\Documents\\repo\\file.ts`,
}));

/**
 * Build a Windows home-path fragment (forward-slash form) with a
 * sentinel username: ` C:/Users/<name>/path`.
 */
const windowsForwardSlashHomePathArb = fc.tuple(sentinelTokenArb).map(([username]) => ({
  username,
  path: ` C:/Users/${username}/Documents/repo/file.ts`,
}));

const levelArb: fc.Arbitrary<LogLevel> = fc.constantFrom<LogLevel>(
  'trace',
  'debug',
  'info',
  'warn',
  'error'
);

/**
 * Defensively force the env vars into the documented test-mode shape
 * before each property run. Mocha typically sets `NODE_ENV='test'`
 * and `MOCHA_WORKER_ID` already, but we set them explicitly so the
 * test pins the contract regardless of how it's invoked
 * (`npm run test:property`, `npm run test:property:stress`, ad-hoc
 * `mocha` runs from a non-Mocha env).
 */
function withTestModeEnv<T>(fn: () => T): T {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalMochaWorkerId = process.env.MOCHA_WORKER_ID;
  process.env.NODE_ENV = 'test';
  process.env.MOCHA_WORKER_ID = '1';
  try {
    return fn();
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalMochaWorkerId === undefined) {
      delete process.env.MOCHA_WORKER_ID;
    } else {
      process.env.MOCHA_WORKER_ID = originalMochaWorkerId;
    }
  }
}

describe('logger sanitizer — test-mode redaction (Requirement 4.7)', () => {
  it('redacts credentialed URLs from message even with NODE_ENV=test and MOCHA_WORKER_ID set', () => {
    withTestModeEnv(() => {
      fc.assert(
        fc.property(credentialUrlArb, levelArb, ({ user, password, url }, level) => {
          const record: LogRecord = {
            timestamp: '2026-05-12T14:03:11.482Z',
            level,
            component: 'TestModeSanitizer',
            message: `cloning from ${url} failed`,
          };

          const result = sanitizeRecord(record);
          assert.strictEqual(
            result.ok,
            true,
            'sanitizer must succeed on a credentialed URL input'
          );
          if (!result.ok) {
            return;
          }
          const leaves = collectStringLeaves(result.record);

          assert.ok(
            !leaves.includes(`${user}:${password}`),
            `sanitized record must not contain the user:password infix; leaves=${leaves}`
          );
          assert.ok(
            !leaves.includes(password),
            `sanitized record must not contain the password sentinel '${password}'; leaves=${leaves}`
          );
        }),
        { numRuns: 100 }
      );
    });
  });

  it('redacts POSIX home paths from message even with test-mode env vars set', () => {
    withTestModeEnv(() => {
      fc.assert(
        fc.property(posixHomePathArb, levelArb, ({ username, path }, level) => {
          const record: LogRecord = {
            timestamp: '2026-05-12T14:03:11.482Z',
            level,
            component: 'TestModeSanitizer',
            message: `ENOENT: no such file or directory, open${path}`,
          };

          const result = sanitizeRecord(record);
          assert.strictEqual(result.ok, true);
          if (!result.ok) {
            return;
          }
          const leaves = collectStringLeaves(result.record);

          assert.ok(
            !leaves.includes(`/Users/${username}/`),
            `sanitized record must not contain the POSIX /Users/<name>/ prefix; leaves=${leaves}`
          );
          assert.ok(
            !leaves.includes(`/home/${username}/`),
            `sanitized record must not contain the POSIX /home/<name>/ prefix; leaves=${leaves}`
          );
        }),
        { numRuns: 100 }
      );
    });
  });

  it('redacts Windows backslash home paths even with test-mode env vars set', () => {
    withTestModeEnv(() => {
      fc.assert(
        fc.property(windowsBackslashHomePathArb, levelArb, ({ username, path }, level) => {
          const record: LogRecord = {
            timestamp: '2026-05-12T14:03:11.482Z',
            level,
            component: 'TestModeSanitizer',
            message: `failed to read${path}`,
          };

          const result = sanitizeRecord(record);
          assert.strictEqual(result.ok, true);
          if (!result.ok) {
            return;
          }
          const leaves = collectStringLeaves(result.record);

          assert.ok(
            !/[A-Za-z]:\\Users\\/.test(leaves),
            `sanitized record must not contain a Windows C:\\Users\\ prefix; leaves=${leaves}`
          );
          assert.ok(
            !leaves.includes(`\\Users\\${username}`),
            `sanitized record must not contain the Windows backslash username segment; leaves=${leaves}`
          );
        }),
        { numRuns: 100 }
      );
    });
  });

  it('redacts Windows forward-slash home paths even with test-mode env vars set', () => {
    withTestModeEnv(() => {
      fc.assert(
        fc.property(windowsForwardSlashHomePathArb, levelArb, ({ username, path }, level) => {
          const record: LogRecord = {
            timestamp: '2026-05-12T14:03:11.482Z',
            level,
            component: 'TestModeSanitizer',
            message: `failed to read${path}`,
          };

          const result = sanitizeRecord(record);
          assert.strictEqual(result.ok, true);
          if (!result.ok) {
            return;
          }
          const leaves = collectStringLeaves(result.record);

          assert.ok(
            !/[A-Za-z]:\/Users\//.test(leaves),
            `sanitized record must not contain a Windows C:/Users/ prefix; leaves=${leaves}`
          );
          assert.ok(
            !leaves.includes(`/Users/${username}`),
            `sanitized record must not contain the Windows forward-slash username segment; leaves=${leaves}`
          );
        }),
        { numRuns: 100 }
      );
    });
  });

  it('redacts secrets across every field carrying a credentialed URL or home-path prefix', () => {
    withTestModeEnv(() => {
      fc.assert(
        fc.property(credentialUrlArb, posixHomePathArb, (cred, posix) => {
          // Place the credentialed URL and home-path in EVERY string-
          // valued field of the record so the test pins that the
          // sanitizer recurses into each one (Requirement 4.1, 4.2).
          // The sanitizer's contract is: when an input contains a
          // matched credentialed URL or home-path prefix, the matched
          // segment is removed; we therefore assert against the
          // matched segments themselves, not against any substring
          // that happens to share characters with them.
          const record: LogRecord = {
            timestamp: '2026-05-12T14:03:11.482Z',
            level: 'error',
            component: 'TestModeSanitizer',
            message: `outer cloning ${cred.url} from${posix.path}`,
            context: {
              remote: cred.url,
              cwd: posix.path.trim(),
              nested: {
                stderr: `fatal: unable to access '${cred.url}': error`,
                items: [`opened${posix.path}`, cred.url],
              },
            },
            error: {
              message: `clone failed for ${cred.url} (${posix.path.trim()})`,
              stack: [
                'Error: clone failed',
                `    at GitClient.clone (${posix.path.trim()}/src/gitCli.ts:42:13)`,
                `    at fetchWithCreds (${cred.url})`,
              ].join('\n'),
            },
          };

          const result = sanitizeRecord(record);
          assert.strictEqual(result.ok, true);
          if (!result.ok) {
            return;
          }
          const leaves = collectStringLeaves(result.record);

          // The user:password infix is the substring the credential-URL
          // regex matches; its presence post-sanitization would prove
          // the sanitizer was bypassed in some field.
          const credInfix = `${cred.user}:${cred.password}`;
          assert.ok(
            !leaves.includes(credInfix),
            `user:password infix '${credInfix}' must not leak across any record field; leaves=${leaves}`
          );
          assert.ok(
            !leaves.includes(`${credInfix}@`),
            `user:password@ infix '${credInfix}@' must not leak across any record field; leaves=${leaves}`
          );

          // Home-path: the matched substring is the
          // `/Users/<name>/` or `/home/<name>/` prefix. That prefix
          // must not appear in any field; presence would prove the
          // sanitizer skipped a field.
          assert.ok(
            !leaves.includes(`/Users/${posix.username}/`) &&
              !leaves.includes(`/home/${posix.username}/`),
            `home-path prefix carrying username '${posix.username}' must not leak; leaves=${leaves}`
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
