/**
 * Unit tests for `readInProgressOperation`.
 *
 * Exercises every shape the helper must read off `.git/`:
 *   - merge (`MERGE_HEAD` only) → kind `'merging'`, no target
 *   - rebase via `rebase-merge/` (interactive rebase) → kind `'rebasing'`,
 *     target stripped of the `refs/heads/` prefix
 *   - rebase via `rebase-apply/` (legacy `git am`-style rebase) → kind
 *     `'rebasing'`, target stripped of the `refs/heads/` prefix
 *   - cherry-pick (`CHERRY_PICK_HEAD` containing a 40-char SHA) → kind
 *     `'cherry-picking'`, `targetSha` set to the abbreviated form returned
 *     by the injected `shortenSha` callback
 *   - revert (`REVERT_HEAD` containing a 40-char SHA) → kind `'reverting'`,
 *     `targetSha` set to the abbreviated form
 *   - idle (none of the above markers present) → `undefined`
 *
 * No real git CLI is invoked; the `shortenSha` callback is stubbed to
 * return the first 7 chars of any SHA passed in. All filesystem state is
 * in a tmpdir-scoped fake `.git/` directory.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readInProgressOperation } from '../../../git-core/gitInProgress';

const FAKE_SHORTEN = async (sha: string): Promise<string> => sha.substring(0, 7);

describe('readInProgressOperation', () => {
  let tmpDir: string;
  let gitDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-inprogress-'));
    gitDir = path.join(tmpDir, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('returns undefined for a clean .git/ (no in-progress markers)', async () => {
    const result = await readInProgressOperation(gitDir, FAKE_SHORTEN);
    assert.strictEqual(result, undefined);
  });

  it('classifies merge — MERGE_HEAD only, no target name', async () => {
    fs.writeFileSync(
      path.join(gitDir, 'MERGE_HEAD'),
      '0123456789012345678901234567890123456789\n',
      'utf8'
    );
    const result = await readInProgressOperation(gitDir, FAKE_SHORTEN);
    assert.ok(result, 'expected an in-progress operation result');
    assert.strictEqual(result.kind, 'merging');
    // Target name is unknown for merge unless the caller has more context.
    assert.strictEqual(result.target, undefined);
  });

  it('classifies rebase via rebase-merge/ (interactive) — strips refs/heads/ from head-name', async () => {
    const rebaseDir = path.join(gitDir, 'rebase-merge');
    fs.mkdirSync(rebaseDir, { recursive: true });
    fs.writeFileSync(path.join(rebaseDir, 'head-name'), 'refs/heads/feature/foo\n', 'utf8');
    fs.writeFileSync(
      path.join(rebaseDir, 'onto'),
      'mainshaXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\n',
      'utf8'
    );

    const result = await readInProgressOperation(gitDir, FAKE_SHORTEN);
    assert.ok(result);
    assert.strictEqual(result.kind, 'rebasing');
    assert.strictEqual(result.target, 'feature/foo');
  });

  it('classifies rebase via rebase-apply/ (legacy am-style) — strips refs/heads/ from head-name', async () => {
    const rebaseDir = path.join(gitDir, 'rebase-apply');
    fs.mkdirSync(rebaseDir, { recursive: true });
    fs.writeFileSync(path.join(rebaseDir, 'head-name'), 'refs/heads/main\n', 'utf8');

    const result = await readInProgressOperation(gitDir, FAKE_SHORTEN);
    assert.ok(result);
    assert.strictEqual(result.kind, 'rebasing');
    assert.strictEqual(result.target, 'main');
  });

  it('classifies cherry-pick — CHERRY_PICK_HEAD, abbreviates SHA via callback', async () => {
    fs.writeFileSync(
      path.join(gitDir, 'CHERRY_PICK_HEAD'),
      'abc1234567890123456789012345678901234567\n',
      'utf8'
    );
    const result = await readInProgressOperation(gitDir, FAKE_SHORTEN);
    assert.ok(result);
    assert.strictEqual(result.kind, 'cherry-picking');
    assert.strictEqual(result.targetSha, 'abc1234');
    assert.strictEqual(result.target, 'abc1234');
  });

  it('classifies revert — REVERT_HEAD, abbreviates SHA via callback', async () => {
    fs.writeFileSync(
      path.join(gitDir, 'REVERT_HEAD'),
      'abc1234567890123456789012345678901234567\n',
      'utf8'
    );
    const result = await readInProgressOperation(gitDir, FAKE_SHORTEN);
    assert.ok(result);
    assert.strictEqual(result.kind, 'reverting');
    assert.strictEqual(result.targetSha, 'abc1234');
    assert.strictEqual(result.target, 'abc1234');
  });

  it('prefers rebase over merge when both rebase-merge/ and MERGE_HEAD exist', async () => {
    // rebase-merge can legitimately leave a MERGE_HEAD around between
    // `git rebase --continue` resolutions; the rebase classification wins.
    const rebaseDir = path.join(gitDir, 'rebase-merge');
    fs.mkdirSync(rebaseDir, { recursive: true });
    fs.writeFileSync(path.join(rebaseDir, 'head-name'), 'refs/heads/topic\n', 'utf8');
    fs.writeFileSync(
      path.join(gitDir, 'MERGE_HEAD'),
      '0123456789012345678901234567890123456789\n',
      'utf8'
    );

    const result = await readInProgressOperation(gitDir, FAKE_SHORTEN);
    assert.ok(result);
    assert.strictEqual(result.kind, 'rebasing');
    assert.strictEqual(result.target, 'topic');
  });

  it('returns undefined if gitDir does not exist', async () => {
    const missing = path.join(tmpDir, 'no-such-dir');
    const result = await readInProgressOperation(missing, FAKE_SHORTEN);
    assert.strictEqual(result, undefined);
  });

  it('does not call shortenSha for merge/rebase paths (only cherry-pick + revert)', async () => {
    const rebaseDir = path.join(gitDir, 'rebase-merge');
    fs.mkdirSync(rebaseDir, { recursive: true });
    fs.writeFileSync(path.join(rebaseDir, 'head-name'), 'refs/heads/foo\n', 'utf8');

    let calls = 0;
    const trackedShorten = async (sha: string): Promise<string> => {
      calls++;
      return sha.substring(0, 7);
    };
    await readInProgressOperation(gitDir, trackedShorten);
    assert.strictEqual(calls, 0);
  });

  // Git can leave both CHERRY_PICK_HEAD and REVERT_HEAD around if the
  // user aborts a revert mid-flight and starts a cherry-pick before the
  // marker files are cleaned up (a real, if rare, sequence on older git
  // releases). The reader's documented order is rebase-* > cherry-pick >
  // revert > merge, so cherry-pick must win when both SHA markers exist.
  it('precedence: cherry-pick wins when both CHERRY_PICK_HEAD and REVERT_HEAD exist', async () => {
    fs.writeFileSync(
      path.join(gitDir, 'CHERRY_PICK_HEAD'),
      'cafe567890123456789012345678901234abcdef\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(gitDir, 'REVERT_HEAD'),
      '0000000000000000000000000000000000000000\n',
      'utf8'
    );
    const result = await readInProgressOperation(gitDir, FAKE_SHORTEN);
    assert.ok(result, 'expected an in-progress operation result');
    assert.strictEqual(result.kind, 'cherry-picking');
    assert.strictEqual(result.targetSha, 'cafe567');
  });

  // A malformed CHERRY_PICK_HEAD (path/expression chars, truncated SHA,
  // embedded non-hex chars) downgrades to verb-only. Defends
  // `git rev-parse --short` against attacker-controlled marker contents
  // that would otherwise pass `buildGitArgs`'s leading-dash guard.
  it('malformed CHERRY_PICK_HEAD content downgrades to verb-only', async () => {
    let shortenCalls = 0;
    const trackedShorten = async (sha: string): Promise<string> => {
      shortenCalls++;
      return sha.substring(0, 7);
    };

    const malformed = [
      '../../etc/passwd', // path traversal
      '$(rm -rf /)', // shell injection shape
      'abc', // too short
      'g'.repeat(40), // wrong charset
      'abcdef0123456789abcdef0123456789abcdefXX', // mostly-hex
      'abcdef0123456789abcdef0123456789abcdef', // 39 chars
      'abcdef0123456789abcdef0123456789abcdef000', // 41 chars
    ];

    for (const bad of malformed) {
      fs.writeFileSync(path.join(gitDir, 'CHERRY_PICK_HEAD'), `${bad}\n`, 'utf8');
      const result = await readInProgressOperation(gitDir, trackedShorten);
      assert.ok(result, `expected verb-only result for malformed input ${JSON.stringify(bad)}`);
      assert.strictEqual(
        result.kind,
        'cherry-picking',
        `expected verb to remain "cherry-picking" for malformed ${JSON.stringify(bad)}`
      );
      assert.strictEqual(
        result.targetSha,
        undefined,
        `expected no targetSha for malformed input ${JSON.stringify(bad)}`
      );
      assert.strictEqual(
        result.target,
        undefined,
        `expected no target for malformed input ${JSON.stringify(bad)}`
      );
    }
    assert.strictEqual(
      shortenCalls,
      0,
      'shortenSha must NOT be called when the marker SHA is invalid'
    );
  });

  it('embedded newline in rebase-merge/head-name is stripped', async () => {
    const rebaseDir = path.join(gitDir, 'rebase-merge');
    fs.mkdirSync(rebaseDir, { recursive: true });
    fs.writeFileSync(path.join(rebaseDir, 'head-name'), 'refs/heads/foo\nbar\n', 'utf8');
    const result = await readInProgressOperation(gitDir, FAKE_SHORTEN);
    assert.ok(result);
    assert.strictEqual(result.kind, 'rebasing');
    assert.strictEqual(result.target, 'foo');
    assert.ok(!result.target?.includes('\n'));
    assert.ok(!result.target?.includes('bar'));
  });

  it('embedded carriage return in rebase-merge/head-name is stripped', async () => {
    const rebaseDir = path.join(gitDir, 'rebase-merge');
    fs.mkdirSync(rebaseDir, { recursive: true });
    fs.writeFileSync(path.join(rebaseDir, 'head-name'), 'refs/heads/topic\rstuff\n', 'utf8');
    const result = await readInProgressOperation(gitDir, FAKE_SHORTEN);
    assert.ok(result);
    assert.strictEqual(result.kind, 'rebasing');
    assert.strictEqual(result.target, 'topic');
    assert.ok(!result.target?.includes('\r'));
  });
});
