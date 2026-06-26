/**
 * L-SH5 — re-applying a shelved binary DELETION must not silently destroy a
 * file the user recreated at that path after shelving.
 *
 * restoreBinaryShelfFile('deleted') unlinks the path. The guard only deletes
 * when the on-disk file is the PRISTINE HEAD version (a clean re-apply of the
 * deletion), determined by comparing the HEAD blob hash to the working file's
 * hash. It is FAIL-CLOSED: a positive match is the only case that deletes; a
 * differing file, an untracked recreation (no HEAD blob), or any hash error
 * preserves the file and reports a conflict (return false).
 *
 * Uses a REAL temp git repo so the rev-parse / hash-object comparison runs
 * against actual git plumbing.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ShelfService, createShelfService } from '../../../src/shelf/ShelfService';
import { GitCli } from '../../../src/git-core/gitCli';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { IShelfFile } from '../../../src/shelf/interfaces/IShelfService';
import { Uri } from '../../mocks/vscode';

interface RestoreSurface {
  restoreBinaryShelfFile(repo: IRepository, file: IShelfFile): Promise<boolean>;
}

const deletedEntry = (p: string): IShelfFile => ({
  path: p,
  diff: '',
  isBinary: true,
  binaryStatus: 'deleted',
});

describe('ShelfService — binary deletion-unshelve preserves recreated files (L-SH5)', () => {
  let repoPath: string;
  let gitCli: GitCli;
  let svc: ShelfService;
  let surface: RestoreSurface;
  let repo: IRepository;

  beforeEach(async () => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-sh5-'));
    gitCli = new GitCli();
    await gitCli.exec(['init'], { cwd: repoPath });
    await gitCli.exec(['config', 'user.email', 't@t.io'], { cwd: repoPath });
    await gitCli.exec(['config', 'user.name', 'T'], { cwd: repoPath });
    await gitCli.exec(['config', 'commit.gpgsign', 'false'], { cwd: repoPath });
    // Commit a binary file so HEAD has a blob for it.
    fs.writeFileSync(path.join(repoPath, 'img.bin'), Buffer.from([0, 1, 2, 3, 255]));
    await gitCli.exec(['add', '.'], { cwd: repoPath });
    await gitCli.exec(['commit', '-m', 'add img.bin'], { cwd: repoPath });

    svc = createShelfService(gitCli);
    surface = svc as unknown as RestoreSurface;
    repo = {
      rootUri: Uri.file(repoPath),
      state: 'idle',
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
  });

  afterEach(() => {
    svc.dispose();
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('deletes when the on-disk file is the pristine HEAD version (clean re-apply)', async () => {
    // img.bin on disk is exactly the committed blob → re-applying the deletion
    // is safe.
    const ok = await surface.restoreBinaryShelfFile(repo, deletedEntry('img.bin'));
    assert.strictEqual(ok, true, 'pristine file → deletion re-applies');
    assert.ok(!fs.existsSync(path.join(repoPath, 'img.bin')), 'pristine file is deleted');
  });

  it('PRESERVES a tracked file recreated with different content (reports conflict)', async () => {
    // User recreated img.bin with NEW bytes after shelving the deletion.
    const abs = path.join(repoPath, 'img.bin');
    fs.writeFileSync(abs, Buffer.from([9, 9, 9, 9]));
    const ok = await surface.restoreBinaryShelfFile(repo, deletedEntry('img.bin'));
    assert.strictEqual(ok, false, 'modified content → refuse + conflict');
    assert.ok(fs.existsSync(abs), 'the recreated file must NOT be deleted');
    assert.deepStrictEqual(
      [...fs.readFileSync(abs)],
      [9, 9, 9, 9],
      'new content is preserved intact'
    );
  });

  it('PRESERVES an untracked file recreated at a path with no HEAD blob', async () => {
    // newfile.bin was never in HEAD (rev-parse HEAD:newfile.bin fails) but the
    // user created one on disk. Fail-closed: no baseline to match → preserve.
    const abs = path.join(repoPath, 'newfile.bin');
    fs.writeFileSync(abs, Buffer.from([7, 7]));
    const ok = await surface.restoreBinaryShelfFile(repo, deletedEntry('newfile.bin'));
    assert.strictEqual(ok, false, 'no HEAD blob → refuse + conflict');
    assert.ok(fs.existsSync(abs), 'the untracked file must NOT be deleted');
  });

  it('succeeds as a no-op when the path is already absent (normal deletion case)', async () => {
    fs.rmSync(path.join(repoPath, 'img.bin'));
    const ok = await surface.restoreBinaryShelfFile(repo, deletedEntry('img.bin'));
    assert.strictEqual(ok, true, 'absent file → unlink no-ops, clean re-apply');
  });
});
