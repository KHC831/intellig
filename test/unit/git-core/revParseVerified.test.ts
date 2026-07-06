/**
 * Real-git coverage for {@link revParseVerified}.
 *
 * A FLAGLESS `git rev-parse --end-of-options <rev>` ECHOES the literal
 * `--end-of-options` as its first stdout line (observed on git 2.50), so the
 * `stdout.trim()` idiom returned `"--end-of-options\n<sha>"` — a two-line
 * token that corrupts any downstream `<rev>^`-style argument. With `--verify`
 * rev-parse consumes the terminator and emits exactly one line; this helper
 * is the single sanctioned way to resolve one rev to one sha.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GitCli, revParseVerified } from '../../../src/git-core/gitCli';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TMP_ROOT = path.join(REPO_ROOT, 'workspace-notes', 'tmp');

describe('revParseVerified (real git)', () => {
  let repoPath: string;
  let gitCli: GitCli;
  let first: string;
  let second: string;

  async function git(...args: string[]): Promise<string> {
    const result = await gitCli.exec(args, { cwd: repoPath, throwOnError: true });
    return result.stdout.trim();
  }

  before(async () => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    repoPath = fs.mkdtempSync(path.join(TMP_ROOT, 'rev-parse-'));
    gitCli = new GitCli();
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await git('config', 'commit.gpgsign', 'false');
    await git('commit', '--allow-empty', '-m', 'first');
    first = await git('rev-parse', '--verify', 'HEAD');
    await git('commit', '--allow-empty', '-m', 'second');
    second = await git('rev-parse', '--verify', 'HEAD');
  });

  after(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('resolves a rev to exactly one clean sha line', async () => {
    const resolved = await revParseVerified(gitCli, repoPath, `${second}^`);
    assert.strictEqual(resolved, first, 'one full sha, no --end-of-options echo, no newline');
  });

  it('returns undefined for a rev that does not resolve (root parent)', async () => {
    const resolved = await revParseVerified(gitCli, repoPath, `${first}^`);
    assert.strictEqual(resolved, undefined);
  });

  it('never lets a hostile rev act as a flag', async () => {
    const resolved = await revParseVerified(gitCli, repoPath, '--upload-pack=evil');
    assert.strictEqual(resolved, undefined, 'treated as an unresolvable rev, not an option');
  });
});
