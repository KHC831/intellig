/**
 * GPG signature status parsing from `git log %G?` (G5 parity with IntelliJ GPG column).
 *
 * Git emits a single character per commit via %G? in the log format string:
 *   G = good (valid) signature
 *   B = bad signature
 *   U = good signature, unknown validity
 *   X = good signature, expired key
 *   Y = good signature, expired key at signing time
 *   R = good signature, revoked key
 *   E = cannot check (missing key)
 *   N = no signature
 */

import '../../setup';
import * as assert from 'assert';
import { parseLog, getLogFormat } from '../../../src/git-core/gitParser';

/**
 * Build a zero-delimited `git log` stdout blob from individual field arrays.
 * Uses the same separator (`\x1f`) and record delimiter (`\0`) as the
 * production `getLogFormat()` + `getLog()` pipeline.
 */
function buildLogStdout(fields: {
  hash?: string;
  shortHash?: string;
  authorName?: string;
  authorEmail?: string;
  authorDate?: string;
  committerName?: string;
  committerEmail?: string;
  commitDate?: string;
  parents?: string;
  subject?: string;
  gpgStatus?: string;
}): string {
  const sep = '\x1f';
  const {
    hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    shortHash = 'aaaaaaa',
    authorName = 'Alice',
    authorEmail = 'alice@example.com',
    authorDate = '2024-01-01T12:00:00+00:00',
    committerName = 'Alice',
    committerEmail = 'alice@example.com',
    commitDate = '2024-01-01T12:00:00+00:00',
    parents = '',
    subject = 'test commit',
    gpgStatus,
  } = fields;

  const gpgField = gpgStatus !== undefined ? `${sep}${gpgStatus}` : '';
  return (
    `${hash}${sep}${shortHash}${sep}${authorName}${sep}${authorEmail}${sep}${authorDate}${sep}` +
    `${committerName}${sep}${committerEmail}${sep}${commitDate}${sep}${parents}${sep}${subject}${gpgField}\0`
  );
}

describe('getLogFormat — includes %G? field', () => {
  it('format string contains the %G? GPG-status placeholder', () => {
    const fmt = getLogFormat();
    assert.ok(fmt.includes('%G?'), `getLogFormat() must include %%G? but got: ${fmt}`);
  });
});

describe('parseLog — gpgStatus field (G5)', () => {
  it('parses gpgStatus: "G" (valid signature) from log output', () => {
    const stdout = buildLogStdout({ gpgStatus: 'G' });
    const commits = parseLog(stdout);
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(
      (commits[0] as { gpgStatus?: string }).gpgStatus,
      'G',
      'gpgStatus must be "G" for a valid signature'
    );
  });

  it('parses gpgStatus: "B" (bad signature) from log output', () => {
    const stdout = buildLogStdout({ gpgStatus: 'B' });
    const commits = parseLog(stdout);
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(
      (commits[0] as { gpgStatus?: string }).gpgStatus,
      'B',
      'gpgStatus must be "B" for a bad signature'
    );
  });

  it('parses gpgStatus: "N" (no signature) from log output', () => {
    const stdout = buildLogStdout({ gpgStatus: 'N' });
    const commits = parseLog(stdout);
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(
      (commits[0] as { gpgStatus?: string }).gpgStatus,
      'N',
      'gpgStatus must be "N" for an unsigned commit'
    );
  });

  it('leaves gpgStatus undefined when the field is absent (old format output)', () => {
    // Build log output WITHOUT the GPG field — simulates git binary
    // older than the field addition, or a caller that passes the old format.
    const sep = '\x1f';
    const stdout =
      `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${sep}aaaaaaa${sep}Alice${sep}alice@example.com${sep}` +
      `2024-01-01T12:00:00+00:00${sep}Alice${sep}alice@example.com${sep}2024-01-01T12:00:00+00:00${sep}` +
      `${sep}legacy commit\0`;
    const commits = parseLog(stdout);
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(
      (commits[0] as { gpgStatus?: string }).gpgStatus,
      undefined,
      'gpgStatus must be undefined when the GPG field is absent'
    );
  });
});
