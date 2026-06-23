/**
 * Security regression tests for ShelfService binary restore/revert.
 *
 * The shelf store (`.git/intellig-shelf.json`) is attacker-deliverable: a
 * repository zip or shared drive can carry a crafted `.git/` whose shelf
 * entries name paths that escape the repository root. A path-traversal
 * `file.path` (`../../evil.txt`) or an absolute path must NOT cause any raw
 * `fs` write/delete/mkdir outside the repository — that would be an arbitrary
 * file write (code-exec vector) or delete.
 *
 * The repository root is nested several levels inside a sandbox dir so that a
 * traversal escape still resolves INSIDE the sandbox (cleaned up afterwards),
 * letting each spec assert "the escaped target was never touched" without ever
 * writing to a real location outside the test tree.
 */

import * as assert from 'assert';
import { okAsync } from 'neverthrow';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ShelfService } from '../../../src/shelf/ShelfService';
import { IShelfFile } from '../../../src/shelf/interfaces/IShelfService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { GitCli } from '../../../src/git-core/gitCli';
import { Uri } from '../../mocks/vscode';

/** Test seam onto the private binary restore/revert helpers under audit. */
interface ShelfSecuritySurface {
  restoreBinaryShelfFile(repo: IRepository, file: IShelfFile): boolean;
  revertBinaryShelfFile(repo: IRepository, file: IShelfFile): Promise<void>;
}

/** Inert GitCli stub — these specs never exercise the git path. */
function createStubGitCli(): GitCli {
  return {
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', combined: '' }),
    getRepositoryRoot: (p: string) => okAsync(p),
    onCommandExecuted: () => ({ dispose: () => {} }),
    dispose() {},
  } as unknown as GitCli;
}

describe('ShelfService — binary restore/revert path containment', () => {
  let svc: ShelfService;
  let surface: ShelfSecuritySurface;
  let repo: IRepository;
  let sandbox: string;
  let repoRoot: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-sec-'));
    // Nest the repo root two levels deep so `../../evil.txt` resolves back to
    // an escaped-but-sandboxed location we can inspect and clean up.
    repoRoot = path.join(sandbox, 'work', 'repo');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    svc = new ShelfService(createStubGitCli());
    surface = svc as unknown as ShelfSecuritySurface;
    repo = {
      rootUri: Uri.file(repoRoot),
      state: 'idle',
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
  });

  afterEach(() => {
    svc.dispose();
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // Reach the private restore/revert helpers directly — they are the security
  // boundary; the public unshelve path funnels every binary entry through them.
  function restore(file: IShelfFile): boolean {
    return surface.restoreBinaryShelfFile(repo, file);
  }
  async function revert(file: IShelfFile): Promise<void> {
    await surface.revertBinaryShelfFile(repo, file);
  }

  describe('restoreBinaryShelfFile', () => {
    it('refuses a relative traversal path and writes nothing outside the repo', () => {
      // `../../evil.txt` from <sandbox>/work/repo resolves to <sandbox>/evil.txt.
      const escaped = path.join(sandbox, 'evil.txt');
      const result = restore({
        path: '../../evil.txt',
        diff: '',
        isBinary: true,
        binaryStatus: 'added',
        binaryContent: Buffer.from('pwned').toString('base64'),
      });
      assert.strictEqual(result, false);
      assert.ok(!fs.existsSync(escaped), 'traversal target must not be written');
    });

    it('refuses an absolute path and writes nothing there', () => {
      const abs = path.join(sandbox, 'abs-target.txt');
      const result = restore({
        path: abs,
        diff: '',
        isBinary: true,
        binaryStatus: 'modified',
        binaryContent: Buffer.from('pwned').toString('base64'),
      });
      assert.strictEqual(result, false);
      assert.ok(!fs.existsSync(abs), 'absolute target must not be written');
    });

    it('refuses a traversal path on the deleted branch and deletes nothing', () => {
      const escaped = path.join(sandbox, 'keepme.txt');
      fs.writeFileSync(escaped, 'precious');
      const result = restore({
        path: '../../keepme.txt',
        diff: '',
        isBinary: true,
        binaryStatus: 'deleted',
      });
      assert.strictEqual(result, false);
      assert.ok(fs.existsSync(escaped), 'out-of-repo file must not be deleted');
    });

    it('still writes a legitimate in-repo binary file', () => {
      const target = path.join(repoRoot, 'assets', 'logo.png');
      const result = restore({
        path: 'assets/logo.png',
        diff: '',
        isBinary: true,
        binaryStatus: 'added',
        binaryContent: Buffer.from('realbytes').toString('base64'),
      });
      assert.strictEqual(result, true);
      assert.strictEqual(fs.readFileSync(target).toString(), 'realbytes');
    });

    it('still deletes a legitimate in-repo file on the deleted branch', () => {
      const target = path.join(repoRoot, 'gone.bin');
      fs.writeFileSync(target, 'bytes');
      const result = restore({
        path: 'gone.bin',
        diff: '',
        isBinary: true,
        binaryStatus: 'deleted',
      });
      assert.strictEqual(result, true);
      assert.ok(!fs.existsSync(target), 'in-repo file should be deleted');
    });
  });

  describe('symlink escape (in-repo symlink whose target leaves the repo)', () => {
    // The lexical guard confines `..` and absolute paths but a contained path
    // can route through an in-repo symlink that points OUTSIDE the repo. The
    // raw-fs write/delete would then follow the link and touch an out-of-repo
    // target. realpath hardening must reject these.
    let outside: string;

    beforeEach(() => {
      outside = path.join(sandbox, 'outside');
      fs.mkdirSync(outside, { recursive: true });
      // `<repo>/link` → `<sandbox>/outside`. A shelf entry naming `link/<x>`
      // is lexically inside the repo but physically escapes it.
      fs.symlinkSync(outside, path.join(repoRoot, 'link'), 'dir');
    });

    it('restore refuses to write through an in-repo symlink that escapes the repo', () => {
      const escaped = path.join(outside, 'evil.txt');
      const result = restore({
        path: 'link/evil.txt',
        diff: '',
        isBinary: true,
        binaryStatus: 'added',
        binaryContent: Buffer.from('pwned').toString('base64'),
      });
      assert.strictEqual(result, false);
      assert.ok(!fs.existsSync(escaped), 'must not write through the escaping symlink');
    });

    it('restore refuses to delete an out-of-repo file reached via an in-repo symlink', () => {
      const escaped = path.join(outside, 'keep.txt');
      fs.writeFileSync(escaped, 'precious');
      const result = restore({
        path: 'link/keep.txt',
        diff: '',
        isBinary: true,
        binaryStatus: 'deleted',
      });
      assert.strictEqual(result, false);
      assert.ok(fs.existsSync(escaped), 'must not delete through the escaping symlink');
    });

    it('revert refuses to delete an out-of-repo file reached via an in-repo symlink', async () => {
      const escaped = path.join(outside, 'keep2.txt');
      fs.writeFileSync(escaped, 'precious');
      await revert({
        path: 'link/keep2.txt',
        diff: '',
        isBinary: true,
        binaryStatus: 'added',
      });
      assert.ok(fs.existsSync(escaped), 'must not delete through the escaping symlink');
    });
  });

  describe('final-component symlink TOCTOU (O_NOFOLLOW / lstat hardening)', () => {
    // The realpath containment guard PASSES a final path component that is a
    // symlink whose target stays INSIDE the repo (realpath resolves in-repo).
    // A plain `writeFileSync`/`rmSync` would then follow that link and clobber
    // / unlink the wrong in-repo file — and the same window lets a component
    // swapped to a symlink between check and write be followed. The write must
    // refuse to follow a final-component symlink (O_NOFOLLOW), and the delete
    // must refuse a non-regular final component (lstat).

    it('restore does NOT write through a final-component symlink (in-repo target untouched)', () => {
      const secret = path.join(repoRoot, 'secret.bin');
      fs.writeFileSync(secret, 'original');
      // `<repo>/target.bin` → `<repo>/secret.bin`: lexically + realpath inside
      // the repo, so the containment guard passes; only O_NOFOLLOW stops it.
      fs.symlinkSync(secret, path.join(repoRoot, 'target.bin'), 'file');

      const result = restore({
        path: 'target.bin',
        diff: '',
        isBinary: true,
        binaryStatus: 'added',
        binaryContent: Buffer.from('pwned').toString('base64'),
      });

      assert.strictEqual(result, false, 'writing through a symlink must be refused');
      assert.strictEqual(
        fs.readFileSync(secret).toString(),
        'original',
        'the symlink target must not be written through'
      );
    });

    it('restore does NOT delete a final-component symlink on the deleted branch', () => {
      const secret = path.join(repoRoot, 'secret2.bin');
      fs.writeFileSync(secret, 'precious');
      const link = path.join(repoRoot, 'del.bin');
      fs.symlinkSync(secret, link, 'file');

      const result = restore({
        path: 'del.bin',
        diff: '',
        isBinary: true,
        binaryStatus: 'deleted',
      });

      assert.strictEqual(result, false, 'deleting a symlinked shelf path must be refused');
      assert.ok(
        fs.lstatSync(link).isSymbolicLink(),
        'the symlink itself must be left in place, not unlinked'
      );
      assert.ok(fs.existsSync(secret), 'the symlink target must survive');
    });

    it('revert does NOT delete a final-component symlink on the added branch', async () => {
      const secret = path.join(repoRoot, 'secret3.bin');
      fs.writeFileSync(secret, 'precious');
      const link = path.join(repoRoot, 'added-link.bin');
      fs.symlinkSync(secret, link, 'file');

      await revert({
        path: 'added-link.bin',
        diff: '',
        isBinary: true,
        binaryStatus: 'added',
      });

      assert.ok(
        fs.lstatSync(link).isSymbolicLink(),
        'the symlink itself must be left in place, not unlinked'
      );
      assert.ok(fs.existsSync(secret), 'the symlink target must survive');
    });
  });

  describe('revertBinaryShelfFile (added branch raw-fs delete)', () => {
    it('refuses a traversal path and deletes nothing outside the repo', async () => {
      const escaped = path.join(sandbox, 'keepme2.txt');
      fs.writeFileSync(escaped, 'precious');
      await revert({
        path: '../../keepme2.txt',
        diff: '',
        isBinary: true,
        binaryStatus: 'added',
      });
      assert.ok(fs.existsSync(escaped), 'out-of-repo file must not be deleted');
    });

    it('still deletes a legitimate in-repo added file', async () => {
      const target = path.join(repoRoot, 'added.bin');
      fs.writeFileSync(target, 'x');
      await revert({
        path: 'added.bin',
        diff: '',
        isBinary: true,
        binaryStatus: 'added',
      });
      assert.ok(!fs.existsSync(target), 'in-repo added file should be deleted');
    });
  });
});
