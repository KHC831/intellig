import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadMergeStageContents } from '../../../src/conflicts/merge-window/mergeStages';
import { GitCli } from '../../../src/git-core/gitCli';

/** GitCli test double: routes ls-files/cat-file calls to canned outputs. */
function fakeGitCli(
  lsFilesOut: string,
  blobs: Record<string, string>
): { cli: GitCli; commands: string[][] } {
  const commands: string[][] = [];
  const cli = {
    exec: (args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      commands.push(args);
      if (args[0] === 'ls-files') {
        return Promise.resolve({ stdout: lsFilesOut, stderr: '', exitCode: 0 });
      }
      if (args[0] === 'cat-file') {
        const sha = args[2];
        const blob = blobs[sha];
        if (blob === undefined) {
          return Promise.resolve({ stdout: '', stderr: 'not found', exitCode: 128 });
        }
        return Promise.resolve({ stdout: blob, stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: `unexpected: ${args[0]}`, exitCode: 1 });
    },
  } as unknown as GitCli;
  return { cli, commands };
}

const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const SHA3 = '3'.repeat(40);

function lsFilesRecord(stage: number, sha: string, path: string): string {
  return `100644 ${sha} ${stage}\t${path}\0`;
}

describe('merge window stage loading', () => {
  it('loads all three stage blobs', async () => {
    const lsOut =
      lsFilesRecord(1, SHA1, 'a.txt') +
      lsFilesRecord(2, SHA2, 'a.txt') +
      lsFilesRecord(3, SHA3, 'a.txt');
    const { cli } = fakeGitCli(lsOut, { [SHA1]: 'base', [SHA2]: 'ours', [SHA3]: 'theirs' });

    const contents = await loadMergeStageContents(cli, '/repo', 'a.txt');
    assert.ok(contents);
    assert.deepStrictEqual(contents, { base: 'base', ours: 'ours', theirs: 'theirs' });
  });

  it('treats a missing stage as empty content', async () => {
    // Delete/modify conflict: theirs deleted the file (no stage 3).
    const lsOut = lsFilesRecord(1, SHA1, 'a.txt') + lsFilesRecord(2, SHA2, 'a.txt');
    const { cli } = fakeGitCli(lsOut, { [SHA1]: 'base', [SHA2]: 'ours' });

    const contents = await loadMergeStageContents(cli, '/repo', 'a.txt');
    assert.ok(contents);
    assert.deepStrictEqual(contents, { base: 'base', ours: 'ours', theirs: '' });
  });

  it('falls back to the conflict-marked working file when the base stage is missing', async () => {
    // add/add conflict: no stage 1. IntelliJ's loadMergeData uses the local
    // conflict-marked file as the base then; so do we — in memory, without
    // writing a synthetic stage into the index.
    const lsOut = lsFilesRecord(2, SHA2, 'a.txt') + lsFilesRecord(3, SHA3, 'a.txt');
    const { cli } = fakeGitCli(lsOut, { [SHA2]: 'ours', [SHA3]: 'theirs' });

    const tmpBase = path.join(process.cwd(), 'workspace-notes', 'tmp');
    fs.mkdirSync(tmpBase, { recursive: true });
    const root = fs.mkdtempSync(path.join(tmpBase, 'merge-stages-'));
    const marked = '<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n';
    try {
      fs.writeFileSync(path.join(root, 'a.txt'), marked);
      const contents = await loadMergeStageContents(cli, root, 'a.txt');
      assert.ok(contents);
      assert.deepStrictEqual(contents, { base: marked, ours: 'ours', theirs: 'theirs' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('base falls back to empty when the working file is unreadable too', async () => {
    const lsOut = lsFilesRecord(2, SHA2, 'a.txt') + lsFilesRecord(3, SHA3, 'a.txt');
    const { cli } = fakeGitCli(lsOut, { [SHA2]: 'ours', [SHA3]: 'theirs' });
    const contents = await loadMergeStageContents(
      cli,
      path.join(os.tmpdir(), 'intellig-nonexistent-root'),
      'a.txt'
    );
    assert.ok(contents);
    assert.deepStrictEqual(contents, { base: '', ours: 'ours', theirs: 'theirs' });
  });

  it('returns undefined when the path has no unmerged entry', async () => {
    const { cli } = fakeGitCli('', {});
    const contents = await loadMergeStageContents(cli, '/repo', 'clean.txt');
    assert.strictEqual(contents, undefined);
  });

  it('fails when a present stage blob cannot be read', async () => {
    const lsOut = lsFilesRecord(2, SHA2, 'a.txt');
    const { cli } = fakeGitCli(lsOut, {});
    await assert.rejects(() => loadMergeStageContents(cli, '/repo', 'a.txt'));
  });
});
