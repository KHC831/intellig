/**
 * Regression: `git fetch --porcelain` parsing must NOT drop fast-forward refs.
 *
 * The porcelain line shape is `<flag> <old-object-id> <new-object-id> <ref>`,
 * where `<flag>` is a SINGLE character. For the most common case — an ordinary
 * fast-forward of a remote-tracking branch — the flag is a literal SPACE. The
 * old parser `trim()`-ed the whole line first, removing the space flag column,
 * so a fast-forward split into 3 parts and was skipped by the `< 4` guard. The
 * result: `updatedRefs` (and the `behind` count derived from it) silently
 * omitted every plain fetch — the parser was wrong on its primary input, and no
 * test fed a realistic porcelain body (every fetch test used empty stdout).
 *
 * Fix: parse the fixed columns with the flag preserved (it may be a space).
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository, IFetchResult } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

// Distinct 40-hex object ids (SHA-1 length); content is irrelevant, only shape.
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const NEW2 = 'c'.repeat(40);
const ZERO = '0'.repeat(40);

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [{ name: 'origin' }],
    submodules: [],
  };
}

function installGitService(stdout: string, stderr = ''): GitService {
  const gitService = new GitService();
  const gitCli = {
    onCommandExecuted: (): { dispose: () => void } => ({ dispose: (): void => {} }),
    exec: async () => ({ exitCode: 0, stdout, stderr, combined: `${stdout}${stderr}` }),
    invalidateCache: (): void => {},
  };
  (gitService as unknown as { _gitCli: unknown })._gitCli = gitCli;
  return gitService;
}

async function fetchResult(stdout: string, stderr = ''): Promise<IFetchResult> {
  const gitService = installGitService(stdout, stderr);
  const result = await gitService.fetch(makeRepo(), 'origin');
  assert.ok(result.isOk(), 'fetch should resolve Ok');
  return result._unsafeUnwrap();
}

describe('RemoteOps fetch-porcelain parser', () => {
  it('counts a space-flag fast-forward ref update (the common fetch case)', async () => {
    // Flag is a single space → the line begins with two spaces (the %c flag
    // plus the field separator). The old `trim()`-first parser dropped this.
    const stdout = `  ${OLD} ${NEW} refs/remotes/origin/main\n`;
    const result = await fetchResult(stdout);

    assert.deepStrictEqual(
      result.updatedRefs,
      [{ ref: 'refs/remotes/origin/main', oldSha: OLD, newSha: NEW }],
      'a fast-forward must be reported as an updated ref'
    );
    assert.strictEqual(result.behind, 1, 'behind count must include the fast-forward');
  });

  it('parses mixed flag columns (fast-forward, forced, new) and skips up-to-date', async () => {
    const stdout = [
      `  ${OLD} ${NEW} refs/remotes/origin/main`, // fast-forward (space flag)
      `+ ${OLD} ${NEW2} refs/remotes/origin/rebased`, // forced update
      `* ${ZERO} ${NEW} refs/remotes/origin/feature`, // new ref (old is all-zero)
      `= ${OLD} ${OLD} refs/remotes/origin/stable`, // up-to-date → not an update
      '',
    ].join('\n');
    const result = await fetchResult(stdout);

    assert.deepStrictEqual(
      result.updatedRefs.map((u) => u.ref).sort(),
      ['refs/remotes/origin/feature', 'refs/remotes/origin/main', 'refs/remotes/origin/rebased'],
      'every changed ref counts; the up-to-date ref does not'
    );
    assert.strictEqual(result.behind, 3, 'behind count excludes the up-to-date ref');
  });

  it('tolerates CRLF line endings without misreading the flag column', async () => {
    const stdout = `  ${OLD} ${NEW} refs/remotes/origin/main\r\n`;
    const result = await fetchResult(stdout);

    assert.deepStrictEqual(result.updatedRefs, [
      { ref: 'refs/remotes/origin/main', oldSha: OLD, newSha: NEW },
    ]);
  });

  it('reports an empty fetch (no updated refs) without inventing entries', async () => {
    const result = await fetchResult('');
    assert.deepStrictEqual(result.updatedRefs, []);
    assert.strictEqual(result.behind, 0);
  });
});
