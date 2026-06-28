/**
 * R4-1: Failed binary revert must propagate to failedPaths.
 *
 * revertBinaryShelfFile previously returned void and the binary branch of
 * revertShelvedChanges never checked the result — a failed checkout/unlink was
 * silently dropped, making the shelve appear fully successful even when the
 * binary change was still live in the working tree.
 *
 * After the fix revertBinaryShelfFile returns boolean (false on failure) and
 * revertShelvedChanges pushes the path to failedPaths when it returns false,
 * mirroring the text-file branches.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createShelfService } from '../../../src/shelf/ShelfService';
import { GitCli } from '../../../src/git-core/gitCli';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { IShelfFile } from '../../../src/shelf/interfaces/IShelfService';
import { Uri } from '../../mocks/vscode';

interface RevertSurface {
  revertBinaryShelfFile(repo: IRepository, file: IShelfFile): Promise<boolean>;
  revertShelvedChanges(
    repo: IRepository,
    shelfFiles: IShelfFile[],
    selectedHunks?: undefined
  ): Promise<string[]>;
}

function makeBinaryFile(p: string, status: 'added' | 'modified' | 'deleted'): IShelfFile {
  return { path: p, diff: '', isBinary: true, binaryStatus: status };
}

describe('ShelfService — binary revert failure propagates to failedPaths (R4-1)', () => {
  let repoPath: string;
  let gitCli: GitCli;
  let surface: RevertSurface;
  let repo: IRepository;

  beforeEach(async () => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-r4-1-'));
    gitCli = new GitCli();
    await gitCli.exec(['init'], { cwd: repoPath });
    await gitCli.exec(['config', 'user.email', 't@t.io'], { cwd: repoPath });
    await gitCli.exec(['config', 'user.name', 'T'], { cwd: repoPath });
    await gitCli.exec(['config', 'commit.gpgsign', 'false'], { cwd: repoPath });

    const svc = createShelfService(gitCli);
    surface = svc as unknown as RevertSurface;
    repo = {
      rootUri: Uri.file(repoPath),
      state: 'idle',
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
  });

  afterEach(() => {
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('revertBinaryShelfFile returns false when checkout fails (modified file not in HEAD)', async () => {
    // Stage a binary file but never commit it — `git checkout HEAD -- <file>`
    // will return non-zero because there is no HEAD blob for it.
    fs.writeFileSync(path.join(repoPath, 'staged.bin'), Buffer.from([0, 1, 2]));
    await gitCli.exec(['add', 'staged.bin'], { cwd: repoPath });

    const ok = await surface.revertBinaryShelfFile(repo, makeBinaryFile('staged.bin', 'modified'));
    assert.strictEqual(ok, false, 'checkout failure must return false');
  });

  it('revertBinaryShelfFile returns false when added-file unlink finds a symlink', async () => {
    // Create a symlink at the path — unlinkRegularFile throws for non-regular paths.
    const target = path.join(repoPath, 'real.bin');
    const link = path.join(repoPath, 'link.bin');
    fs.writeFileSync(target, Buffer.from([0]));
    fs.symlinkSync(target, link);

    const ok = await surface.revertBinaryShelfFile(repo, makeBinaryFile('link.bin', 'added'));
    assert.strictEqual(ok, false, 'symlink unlink refusal must return false');
  });

  it('revertShelvedChanges adds path to failedPaths when binary revert fails', async () => {
    // staged.bin not in HEAD → checkout fails → path appears in failedPaths.
    fs.writeFileSync(path.join(repoPath, 'staged.bin'), Buffer.from([0, 1, 2]));
    await gitCli.exec(['add', 'staged.bin'], { cwd: repoPath });

    const failed = await surface.revertShelvedChanges(repo, [
      makeBinaryFile('staged.bin', 'modified'),
    ]);
    assert.ok(
      failed.includes('staged.bin'),
      `expected 'staged.bin' in failedPaths; got ${JSON.stringify(failed)}`
    );
  });

  it('revertShelvedChanges does NOT add path when binary revert succeeds', async () => {
    // Commit a binary file, then verify that reverting it succeeds (no failedPaths).
    fs.writeFileSync(path.join(repoPath, 'ok.bin'), Buffer.from([10, 20, 30]));
    await gitCli.exec(['add', 'ok.bin'], { cwd: repoPath });
    await gitCli.exec(['commit', '-m', 'add ok.bin'], { cwd: repoPath });

    // Modify the working-tree copy so we have something to revert.
    fs.writeFileSync(path.join(repoPath, 'ok.bin'), Buffer.from([99]));

    const failed = await surface.revertShelvedChanges(repo, [makeBinaryFile('ok.bin', 'modified')]);
    assert.deepStrictEqual(failed, [], 'successful revert must produce empty failedPaths');
  });
});
