/**
 * Property 8: Sanitizer non-leakage.
 *
 *
 * Two sister contracts the Logger sanitizer must uphold:
 *
 * **Credentialed URL non-leakage.** For every
 *   input `s` that contains a credentialed HTTP(S) URL, the output
 *   of `sanitizeRecord(s)` SHALL NOT contain the matched user or
 *   password substring. The credential infix (`<user>:<password>@`)
 *   is exactly what an attacker would search a copied bug report
 *   for; if any field of a `LogRecord` survives the sanitizer with
 *   the infix intact, the redaction has failed.
 *
 * **Home-path non-leakage.** For every input
 *   `s` that contains a home-directory prefix in any of the four
 *   shapes pinned by ADR-005 — `/Users/<name>/`, `/home/<name>/`,
 *   `C:\Users\<name>\`, `C:/Users/<name>/` — the output of
 *   `sanitizeRecord(s)` SHALL NOT contain the username substring
 *   captured by the corresponding regex.
 *
 * The Logger funnels every emission through `sanitizeRecord`
 * and recurses into context-tree leaves, so the non-leakage property MUST hold across
 * `message`, `error.message`, `error.stack`, `correlationId`, and
 * every reachable string leaf in `context`. The sanitizer also lifts
 * the `error` field from the Logger's API into the same scrub seam,
 * so this test exercises both the dedicated `error` field and
 * `context`-embedded strings.
 *
 * ### Strategy
 *
 * Reuses the sentinel-token approach from
 * `loggerSanitizerInTestMode.property.test.ts` (file-level comment
 * there explains the discipline):
 *
 * 1. Generate **sentinel tokens** that exclude every char the
 *    sanitizer regexes treat as a delimiter (whitespace, `/`, `\`,
 *    `:`, `@`, quote, paren/bracket, `<`, `>`, `~`) AND the literal
 *    `redacted`. That keeps the token surviving in input form and
 *    uniquely identifiable in the output: any post-sanitization
 *    appearance of the user/password/username token (or its
 *    surrounding marker) proves a leak.
 * 2. Embed the sentinels in `LogRecord` shapes carrying the
 *    redaction triggers across **every relevant field** —
 *    `message`, `context` leaves (top-level, nested, and inside
 *    arrays), `error.message`, `error.stack`, and `correlationId`.
 * The sanitizer's recursive walker must
 *    redact every reachable leaf, so we walk the sanitized record
 *    via {@link collectStringLeaves} and assert the sentinel does
 *    not appear in the concatenated leaves buffer.
 * 3. Drive the production `sanitizeRecord` directly (no Logger
 *    layer, no sinks) so this test isolates the sanitizer's
 *    contract from the Logger's threshold, render, and sink
 *    machinery — those are owned by other property tests.
 *
 * ### What this test does NOT cover
 *
 * - Sanitizer determinism / idempotence — owned by Property 9
 *   (`loggerSanitizerDeterminism.property.test.ts`).
 * - Sanitizer behaviour under `NODE_ENV='test'` — owned by
 *   Property 4.7 / `loggerSanitizerInTestMode.property.test.ts`.
 * - End-to-end Logger emission and rendering — owned by
 *   Property 1 / Property 7 (`loggerRecord.*`, `loggerRenderRoundTrip.*`).
 *
 * ### No mocks
 *
 * The sanitizer is a pure function over a `LogRecord`. The test
 * imports `sanitizeRecord` directly and never registers a sink or
 * loads the Logger. `import '../setup'` is included for parity
 * with the sibling property tests, in case any transitive import
 * pulls in the mock `vscode` module.
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import { sanitizeRecord } from '../../utils/logger/sanitize';
import type { JsonValue, LogLevel, LogRecord } from '../../utils/logger/sinks/types';

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Walk a sanitized `LogRecord` and concatenate every string-valued
 * leaf into one buffer. The non-leakage assertion is "does the
 * sentinel appear *anywhere* in the rendered record" — collecting
 * leaves into a single string is the simplest, most failure-mode-
 * agnostic way to make that check. Mirrors the sanitizer's own
 * recursion: `message`, `correlationId`, `error.message`,
 * `error.stack`, plus a recursive walk of `context`.
 *
 * Duplicated from `loggerSanitizerInTestMode.property.test.ts`
 * deliberately: lifting the helper into a shared utility would
 * couple two property tests that pin distinct contracts (test-mode
 * redaction vs non-leakage) and make the duplication invisible to
 * a reviewer reading either file in isolation. The helper is small,
 * pure, and trivially regression-tested by the assertions in both
 * files.
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
  if (isJsonArray(value)) {
    for (const item of value) {
      walkJson(item, out);
    }
    return;
  }
  // Plain object branch — Object.keys returns own enumerable string
  // keys, mirroring the sanitizer's own walker.
  for (const key of Object.keys(value)) {
    walkJson((value as { readonly [k: string]: JsonValue | undefined })[key], out);
  }
}

/**
 * Narrowing guard for the array arm of `JsonValue`. `Array.isArray`
 * narrows to `any[]` rather than `readonly JsonValue[]`, which would
 * otherwise leak `any` into the recursive `walkJson` call and trip
 * `@typescript-eslint/no-unsafe-argument`. Re-stating the narrowing
 * here keeps the walker fully typed without a cast.
 */
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/**
 * Run `sanitizeRecord` and unwrap the success branch. The sanitizer
 * may return a sentinel `ok: false` result if the walk throws on
 * the input; those inputs are out of scope for this property (see
 * file-level comment) and the test fails loudly so they surface in
 * shrunk counterexamples rather than silently skewing the
 * assertions.
 */
function sanitizeOrFail(record: LogRecord): LogRecord {
  const result = sanitizeRecord(record);
  assert.strictEqual(
    result.ok,
    true,
    'sanitizer unexpectedly returned the ok:false sentinel for an input ' +
      'this property test does not cover (no throwing getters expected)'
  );
  return (result as { readonly ok: true; readonly record: LogRecord }).record;
}

// ── Arbitraries ────────────────────────────────────────────────────────

/**
 * Fixed marker prepended to every sentinel token.
 *
 * The marker is chosen so it can NEVER appear in the fixed
 * scaffolding vocabulary this test embeds — the path tails
 * (`Documents`, `projects`, `intellig`, `repo`, `file`, `ts`),
 * message words (`cloning`, `outer`, `multi`, `shape`, `error`,
 * `fatal`, `access`), stack labels (`GitClient`, `fetchWithCreds`,
 * `fnA`/`fnB`/`fnC`), the URL host (`example.com/repo.git`), and the
 * redaction markers (`<redacted>`, `~/`, `~\`). Because the marker is
 * an uppercase-letter + digit run that no scaffolding word matches, a
 * marker-prefixed sentinel can only appear in the sanitized `leaves`
 * buffer if the sanitizer actually failed to redact it — never as a
 * substring collision with fixed text.
 *
 * Regression that motivated this (flaked ~1 run in 40k): the bare
 * username `"ment"` is a substring of the fixed word `"Documents"` in
 * a sibling Windows path on the SAME record, so the secondary
 * `!leaves.includes(username)` check fired even though the home
 * prefix was correctly redacted to `~/`. Prefixing the sentinel makes
 * every `leaves.includes(token)` assertion a SOUND leak detector
 * (token present iff the sanitizer leaked it) without weakening any
 * of the bare-username / credential checks.
 */
const SENTINEL_MARKER = 'Zq7x';

/**
 * Generate a non-empty token suitable for embedding as a credential
 * URL user/password segment OR as a home-directory username.
 *
 * Two layers:
 *  1. The random body excludes every char the sanitizer's regexes
 *     treat as a delimiter (whitespace, `/`, `\`, `:`, `@`, quotes,
 *     paren/bracket) plus `<`, `>`, `~` and the literal `redacted`,
 *     so the token survives in input form, stays a valid username /
 *     credential segment for all four path shapes, and can't be
 *     confused with the `<redacted>` / `~/` post-redaction markers.
 *  2. The {@link SENTINEL_MARKER} prefix guarantees the token can't
 *     collide with the test's fixed scaffolding vocabulary, so every
 *     `leaves.includes(token)` assertion is a sound leak detector.
 *
 * The marker is itself delimiter-free and `redacted`-free, so it does
 * NOT change which sanitizer branch fires: `/Users/Zq7x…/` is still a
 * POSIX home prefix, `Zq7x…:Zq7x…@` is still a credential infix, etc.
 */
const sentinelTokenArb: fc.Arbitrary<string> = fc
  .string({ minLength: 4, maxLength: 24 })
  .filter(
    (s) => s.length >= 4 && !/[\s/\\:@'"()[\]<>~]/.test(s) && !s.toLowerCase().includes('redacted')
  )
  .map((s) => `${SENTINEL_MARKER}${s}`);

/**
 * Build a credentialed HTTPS or HTTP URL fragment with sentinel
 * user + password. Returns the URL plus the user and password
 * substrings so the test can assert each substring is absent from
 * the sanitized output. Both `http` and `https` schemes are
 * exercised because the sanitizer's regex is case-insensitive over
 * the scheme — a future regression that narrowed the scheme set
 * would surface here.
 */
const credentialUrlArb = fc
  .tuple(sentinelTokenArb, sentinelTokenArb, fc.constantFrom<'http' | 'https'>('http', 'https'))
  .map(([user, password, scheme]) => ({
    user,
    password,
    scheme,
    url: `${scheme}://${user}:${password}@example.com/repo.git`,
  }));

/**
 * POSIX home-path fragment with a sentinel username:
 * ` /Users/<name>/path` or ` /home/<name>/path`. The leading space
 * is required because the sanitizer's POSIX regex is left-anchored
 * to a delimiter (start-of-string, whitespace, quote, paren, or
 * bracket).
 */
const posixHomePathArb = fc
  .tuple(sentinelTokenArb, fc.constantFrom<'Users' | 'home'>('Users', 'home'))
  .map(([username, prefix]) => ({
    username,
    prefix,
    path: ` /${prefix}/${username}/projects/intellig/file.ts`,
  }));

/**
 * Windows backslash home-path fragment: ` C:\Users\<name>\path`.
 * Drive letter pinned to `C` because the sanitizer treats the drive
 * letter as a captured-but-unused group; varying the drive would
 * not exercise additional sanitizer logic and would muddy the
 * assertion targets.
 */
const windowsBackslashHomePathArb = fc.tuple(sentinelTokenArb).map(([username]) => ({
  username,
  path: ` C:\\Users\\${username}\\Documents\\repo\\file.ts`,
}));

/**
 * Windows forward-slash home-path fragment:
 * ` C:/Users/<name>/path`. Same drive-letter pinning as above.
 */
const windowsForwardSlashHomePathArb = fc.tuple(sentinelTokenArb).map(([username]) => ({
  username,
  path: ` C:/Users/${username}/Documents/repo/file.ts`,
}));

/**
 * One of the five record-level severities. The sanitizer treats
 * `level` verbatim (it's a code-supplied literal, not user-derived
 * content), but varying the level keeps the property general.
 */
const levelArb: fc.Arbitrary<LogLevel> = fc.constantFrom<LogLevel>(
  'trace',
  'debug',
  'info',
  'warn',
  'error'
);

// ── Properties ─────────────────────────────────────────────────────────

describe('Property 8 — Sanitizer non-leakage', () => {
  // ── Credentialed URL non-leakage ──────────────────

  it('credentialed URL: user:password infix never survives sanitization in record.message', () => {
    fc.assert(
      fc.property(credentialUrlArb, levelArb, ({ user, password, url }, level) => {
        const record: LogRecord = {
          timestamp: '2026-05-12T14:03:11.482Z',
          level,
          component: 'NonLeakageTest',
          message: `cloning from ${url} failed`,
        };

        const sanitized = sanitizeOrFail(record);
        const leaves = collectStringLeaves(sanitized);

        // The exact substring the credential-URL regex matches —
        // its presence post-sanitization would prove the sanitizer
        // didn't run on the message field.
        assert.ok(
          !leaves.includes(`${user}:${password}`),
          `sanitized record must not contain the user:password infix '${user}:${password}'; leaves=${leaves}`
        );
        // The trailing `@` makes the infix unambiguous against
        // arbitrary `<token>:<token>` text the sentinel might
        // collide with. Pinning both forms is belt-and-braces.
        assert.ok(
          !leaves.includes(`${user}:${password}@`),
          `sanitized record must not contain the user:password@ infix '${user}:${password}@'; leaves=${leaves}`
        );
        // The user substring alone is also pinned — Requirement
        // 14.3 names "user OR password substring" individually.
        // The sanitizer collapses the entire `<user>:<password>@`
        // fragment to `<redacted>@`, so neither token survives.
        assert.ok(
          !leaves.includes(user),
          `sanitized record must not contain the user sentinel '${user}'; leaves=${leaves}`
        );
        assert.ok(
          !leaves.includes(password),
          `sanitized record must not contain the password sentinel '${password}'; leaves=${leaves}`
        );
      }),
      { numRuns: 200 }
    );
  });

  it('credentialed URL: redaction reaches every recursive context leaf and the error field', () => {
    fc.assert(
      fc.property(credentialUrlArb, ({ user, password, url }) => {
        // Place the credentialed URL in EVERY string-valued field
        // the sanitizer walks: top-
        // level message, top-level context value, nested context
        // value, array element inside context, correlationId,
        // error.message, and a stack frame line.
        const record: LogRecord = {
          timestamp: '2026-05-12T14:03:11.482Z',
          level: 'error',
          component: 'NonLeakageTest',
          message: `outer cloning ${url}`,
          context: {
            remote: url,
            nested: {
              stderr: `fatal: unable to access '${url}': error`,
              items: [`see ${url}`, url],
            },
          },
          // correlationId is sanitized too — a
          // future regression that injected a credential into the
          // ID would otherwise leak silently.
          correlationId: `cid-${url}`,
          error: {
            message: `clone failed for ${url}`,
            stack: [
              'Error: clone failed',
              `    at fetchWithCreds (${url})`,
              `    at GitClient.clone (${url})`,
            ].join('\n'),
          },
        };

        const sanitized = sanitizeOrFail(record);
        const leaves = collectStringLeaves(sanitized);

        const credInfix = `${user}:${password}`;
        assert.ok(
          !leaves.includes(credInfix),
          `user:password infix '${credInfix}' must not leak across any record field; leaves=${leaves}`
        );
        assert.ok(
          !leaves.includes(`${credInfix}@`),
          `user:password@ infix '${credInfix}@' must not leak across any record field; leaves=${leaves}`
        );
        assert.ok(
          !leaves.includes(user),
          `user sentinel '${user}' must not leak across any record field; leaves=${leaves}`
        );
        assert.ok(
          !leaves.includes(password),
          `password sentinel '${password}' must not leak across any record field; leaves=${leaves}`
        );
      }),
      { numRuns: 100 }
    );
  });

  // ── Home-path non-leakage ─────────────────────────

  it('POSIX home path /Users/<name>/ and /home/<name>/: username never survives sanitization', () => {
    fc.assert(
      fc.property(posixHomePathArb, levelArb, ({ username, prefix, path }, level) => {
        const record: LogRecord = {
          timestamp: '2026-05-12T14:03:11.482Z',
          level,
          component: 'NonLeakageTest',
          message: `ENOENT: no such file or directory, open${path}`,
        };

        const sanitized = sanitizeOrFail(record);
        const leaves = collectStringLeaves(sanitized);

        // The matched substring the POSIX home regex captures is
        // the `/Users/<name>/` or `/home/<name>/` prefix; its
        // presence post-sanitization would prove the sanitizer
        // skipped this field. names "the username
        // substring captured by the corresponding regex" — that's
        // the `<name>` segment between the literal prefix and the
        // following `/`.
        assert.ok(
          !leaves.includes(`/${prefix}/${username}/`),
          `sanitized record must not contain the POSIX /${prefix}/<name>/ prefix carrying username '${username}'; leaves=${leaves}`
        );
        // The bare username is also pinned — even if a future
        // sanitizer regression preserved the path shape but
        // re-emitted the username elsewhere in the field, it would
        // surface as a leak.
        assert.ok(
          !leaves.includes(username),
          `sanitized record must not contain the username sentinel '${username}'; leaves=${leaves}`
        );
      }),
      { numRuns: 200 }
    );
  });

  it('Windows backslash home path C:\\Users\\<name>\\: username never survives sanitization', () => {
    fc.assert(
      fc.property(windowsBackslashHomePathArb, levelArb, ({ username, path }, level) => {
        const record: LogRecord = {
          timestamp: '2026-05-12T14:03:11.482Z',
          level,
          component: 'NonLeakageTest',
          message: `failed to read${path}`,
        };

        const sanitized = sanitizeOrFail(record);
        const leaves = collectStringLeaves(sanitized);

        assert.ok(
          !leaves.includes(`\\Users\\${username}\\`),
          `sanitized record must not contain the Windows backslash \\Users\\<name>\\ prefix carrying username '${username}'; leaves=${leaves}`
        );
        // Pin the bare username separately so a future regression
        // that left the username dangling outside the matched
        // prefix would still surface as a leak.
        assert.ok(
          !leaves.includes(username),
          `sanitized record must not contain the username sentinel '${username}'; leaves=${leaves}`
        );
        // Pin the broader drive-letter prefix — its absence proves
        // the entire `[A-Za-z]:\Users\` fragment was collapsed,
        // not just the `\Users\<name>\` substring.
        assert.ok(
          !/[A-Za-z]:\\Users\\/.test(leaves),
          `sanitized record must not contain a Windows C:\\Users\\ prefix; leaves=${leaves}`
        );
      }),
      { numRuns: 200 }
    );
  });

  it('Windows forward-slash home path C:/Users/<name>/: username never survives sanitization', () => {
    fc.assert(
      fc.property(windowsForwardSlashHomePathArb, levelArb, ({ username, path }, level) => {
        const record: LogRecord = {
          timestamp: '2026-05-12T14:03:11.482Z',
          level,
          component: 'NonLeakageTest',
          message: `failed to read${path}`,
        };

        const sanitized = sanitizeOrFail(record);
        const leaves = collectStringLeaves(sanitized);

        assert.ok(
          !leaves.includes(`/Users/${username}/`),
          `sanitized record must not contain the Windows /Users/<name>/ prefix carrying username '${username}'; leaves=${leaves}`
        );
        assert.ok(
          !leaves.includes(username),
          `sanitized record must not contain the username sentinel '${username}'; leaves=${leaves}`
        );
        assert.ok(
          !/[A-Za-z]:\/Users\//.test(leaves),
          `sanitized record must not contain a Windows C:/Users/ prefix; leaves=${leaves}`
        );
      }),
      { numRuns: 200 }
    );
  });

  it('home path: redaction reaches every recursive context leaf and the error field across all four shapes', () => {
    fc.assert(
      fc.property(
        posixHomePathArb,
        windowsBackslashHomePathArb,
        windowsForwardSlashHomePathArb,
        (posix, winBack, winFwd) => {
          // Distribute the three home-path shapes (POSIX +
          // Windows-backslash + Windows-forward-slash) across
          // every reachable string field on a single record.
          // requires the recursive walker to scrub
          // every string leaf; this property pins that contract by
          // failing if ANY shape's username survives in ANY field.
          const record: LogRecord = {
            timestamp: '2026-05-12T14:03:11.482Z',
            level: 'warn',
            component: 'NonLeakageTest',
            message: `multi-shape leak surface: outer${posix.path}`,
            context: {
              top: posix.path,
              nested: {
                winBack: winBack.path,
                winFwd: winFwd.path,
                items: [posix.path, winBack.path, winFwd.path],
              },
            },
            error: {
              message: `multi-shape error${posix.path}`,
              stack: [
                'Error: multi-shape',
                `    at fnA (${posix.path.trim()})`,
                `    at fnB (${winBack.path.trim()})`,
                `    at fnC (${winFwd.path.trim()})`,
              ].join('\n'),
            },
          };

          const sanitized = sanitizeOrFail(record);
          const leaves = collectStringLeaves(sanitized);

          assert.ok(
            !leaves.includes(`/${posix.prefix}/${posix.username}/`),
            `POSIX home prefix carrying username '${posix.username}' must not leak across any record field; leaves=${leaves}`
          );
          assert.ok(
            !leaves.includes(posix.username),
            `POSIX username sentinel '${posix.username}' must not leak; leaves=${leaves}`
          );
          assert.ok(
            !leaves.includes(`\\Users\\${winBack.username}\\`),
            `Windows backslash home prefix carrying username '${winBack.username}' must not leak; leaves=${leaves}`
          );
          assert.ok(
            !leaves.includes(winBack.username),
            `Windows backslash username sentinel '${winBack.username}' must not leak; leaves=${leaves}`
          );
          assert.ok(
            !leaves.includes(`/Users/${winFwd.username}/`),
            `Windows forward-slash home prefix carrying username '${winFwd.username}' must not leak; leaves=${leaves}`
          );
          assert.ok(
            !leaves.includes(winFwd.username),
            `Windows forward-slash username sentinel '${winFwd.username}' must not leak; leaves=${leaves}`
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  // ── Combined: credentialed URL + home path on one record ─────────────

  it('combined: credentialed URL and home path scrubbed simultaneously across every field', () => {
    fc.assert(
      fc.property(credentialUrlArb, posixHomePathArb, (cred, posix) => {
        // Pin the contract that the sanitizer applies BOTH the
        // credential-URL pass and the home-path pass to the same
        // input — ADR-005 fixes the pass ordering and the design
        // explicitly delegates ordering to `sanitizeGitError`. A
        // regression that re-implemented one pass at the Logger
        // boundary (skipping the other) would be caught here.
        const record: LogRecord = {
          timestamp: '2026-05-12T14:03:11.482Z',
          level: 'error',
          component: 'NonLeakageTest',
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

        const sanitized = sanitizeOrFail(record);
        const leaves = collectStringLeaves(sanitized);

        // Credential infix must not appear anywhere.
        const credInfix = `${cred.user}:${cred.password}`;
        assert.ok(
          !leaves.includes(credInfix),
          `combined: user:password infix '${credInfix}' must not leak; leaves=${leaves}`
        );
        assert.ok(
          !leaves.includes(`${credInfix}@`),
          `combined: user:password@ infix '${credInfix}@' must not leak; leaves=${leaves}`
        );
        assert.ok(
          !leaves.includes(cred.user),
          `combined: user sentinel '${cred.user}' must not leak; leaves=${leaves}`
        );
        assert.ok(
          !leaves.includes(cred.password),
          `combined: password sentinel '${cred.password}' must not leak; leaves=${leaves}`
        );
        // Home-path username must not appear anywhere.
        assert.ok(
          !leaves.includes(`/${posix.prefix}/${posix.username}/`),
          `combined: POSIX home prefix carrying username '${posix.username}' must not leak; leaves=${leaves}`
        );
        assert.ok(
          !leaves.includes(posix.username),
          `combined: POSIX username sentinel '${posix.username}' must not leak; leaves=${leaves}`
        );
      }),
      { numRuns: 100 }
    );
  });
});
