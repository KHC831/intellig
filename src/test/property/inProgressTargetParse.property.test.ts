/**
 * Property test for the in-progress target parsing chain.
 *
 * Invariants verified:
 *   1. The `target` field of the returned `IInProgressOperation` NEVER
 *      starts with `refs/heads/` (stripping is unconditional).
 *   2. The `target` field NEVER contains a newline character (the reader
 *      consumes the first line of head-name; whitespace is trimmed).
 *   3. The `target` field NEVER surfaces a parenthesized pseudo-ref like
 *      `(no branch, rebasing main)` — these are git's transient labels for
 *      the rebase paused state and would create misleading status-bar text
 *      such as "Rebasing onto (no branch, rebasing main)".
 *
 * Property domain: arbitrary head-name file contents (any unicode string,
 * with or without the `refs/heads/` prefix, with whitespace, newlines, and
 * parenthesized variants). Each generated input is written to a real
 * tmpdir-scoped `.git/rebase-merge/head-name` file and run through
 * `readInProgressOperation`.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readInProgressOperation } from '../../git-core/gitInProgress';

const FAKE_SHORTEN = async (sha: string): Promise<string> => sha.substring(0, 7);

describe('in-progress target parse properties', () => {
  /**
   * Generator that builds a head-name file blob biased toward control
   * characters that have historically leaked through `stripRefsHeads`.
   * Mixes:
   *
   *   - happy-path branch names (`refs/heads/feature/foo`, `topic`)
   *   - garbage prefixed/embedded with `\n`, `\r\n`, `\t`
   *   - parenthesized pseudo-refs (already filtered)
   *   - bare unicode strings via `fc.fullUnicodeString`
   *
   * `fc.string` produces ZERO `\n` or `\r` in 5000 runs, so the
   * generator must explicitly inject control characters to exercise
   * the strip path.
   */
  const headNameInput = fc.oneof(
    fc.fullUnicodeString({ maxLength: 80 }),
    fc.constantFrom(
      'refs/heads/foo\nbar',
      'refs/heads/foo\r\nbar',
      'refs/heads/foo\nrefs/heads/bar',
      '\nrefs/heads/foo',
      'refs/heads/foo\n\nbaz',
      'feature\tfoo',
      'foo\rbar',
      'refs/heads/topic\n(no branch)\n',
      '(no branch)\nrefs/heads/main',
      ''
    ),
    fc
      .tuple(fc.fullUnicodeString({ maxLength: 30 }), fc.fullUnicodeString({ maxLength: 30 }))
      .map(([a, b]) => `${a}\n${b}`)
  );

  it('Property: target never starts with refs/heads/', async () => {
    await fc.assert(
      fc.asyncProperty(headNameInput, async (rawHeadName) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-prop-'));
        try {
          const gitDir = path.join(tmpDir, '.git');
          const rebaseDir = path.join(gitDir, 'rebase-merge');
          fs.mkdirSync(rebaseDir, { recursive: true });
          fs.writeFileSync(path.join(rebaseDir, 'head-name'), rawHeadName, 'utf8');

          const result = await readInProgressOperation(gitDir, FAKE_SHORTEN);
          if (result?.target !== undefined) {
            assert.ok(
              !result.target.startsWith('refs/heads/'),
              `target leaked refs/heads/ prefix from input ${JSON.stringify(rawHeadName)}: ${JSON.stringify(result.target)}`
            );
          }
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 }
    );
  });

  it('Property: target never contains a newline', async () => {
    await fc.assert(
      fc.asyncProperty(headNameInput, async (rawHeadName) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-prop-'));
        try {
          const gitDir = path.join(tmpDir, '.git');
          const rebaseDir = path.join(gitDir, 'rebase-merge');
          fs.mkdirSync(rebaseDir, { recursive: true });
          fs.writeFileSync(path.join(rebaseDir, 'head-name'), rawHeadName, 'utf8');

          const result = await readInProgressOperation(gitDir, FAKE_SHORTEN);
          if (result?.target !== undefined) {
            assert.ok(
              !result.target.includes('\n'),
              `target contained newline from input ${JSON.stringify(rawHeadName)}: ${JSON.stringify(result.target)}`
            );
            assert.ok(
              !result.target.includes('\r'),
              `target contained carriage return from input ${JSON.stringify(rawHeadName)}: ${JSON.stringify(result.target)}`
            );
          }
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 }
    );
  });

  it('Property: target never surfaces a parenthesized pseudo-ref', async () => {
    // Pseudo-refs git emits during transient states. The reader filters
    // every (...) shape; these are the canonical examples.
    const pseudoRefs = fc.constantFrom(
      '(no branch)',
      '(no branch, rebasing main)',
      '(no branch, rebasing feature/foo)',
      '(no branch, bisect started on main)',
      '(no branch, cherry-pick of abc1234)',
      '(HEAD detached at 5eed84b)'
    );

    await fc.assert(
      fc.asyncProperty(pseudoRefs, async (pseudo) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-prop-'));
        try {
          const gitDir = path.join(tmpDir, '.git');
          const rebaseDir = path.join(gitDir, 'rebase-merge');
          fs.mkdirSync(rebaseDir, { recursive: true });
          fs.writeFileSync(path.join(rebaseDir, 'head-name'), `${pseudo}\n`, 'utf8');
          fs.writeFileSync(path.join(rebaseDir, 'onto'), `${pseudo}\n`, 'utf8');

          const result = await readInProgressOperation(gitDir, FAKE_SHORTEN);
          assert.ok(result, 'expected rebase result for non-empty markers');
          assert.strictEqual(result.kind, 'rebasing');
          if (result.target !== undefined) {
            assert.ok(
              !(result.target.startsWith('(') && result.target.endsWith(')')),
              `target leaked pseudo-ref: "${result.target}"`
            );
          }
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 }
    );
  });

  it('Property: SHA marker target is always abbreviated to 7 chars', async () => {
    const sha40 = fc.hexaString({ minLength: 40, maxLength: 40 });

    await fc.assert(
      fc.asyncProperty(sha40, async (sha) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-prop-'));
        try {
          const gitDir = path.join(tmpDir, '.git');
          fs.mkdirSync(gitDir, { recursive: true });
          fs.writeFileSync(path.join(gitDir, 'CHERRY_PICK_HEAD'), `${sha}\n`, 'utf8');

          const result = await readInProgressOperation(gitDir, FAKE_SHORTEN);
          assert.ok(result);
          assert.strictEqual(result.kind, 'cherry-picking');
          assert.strictEqual(result.target, sha.substring(0, 7));
          assert.strictEqual(result.targetSha, sha.substring(0, 7));
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 }
    );
  });
});
