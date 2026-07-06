/**
 * Data-integrity guard for ShelfService.shelve under a capped git diff.
 *
 * shelve() captures `git diff HEAD -- <file>` as the shelf entry's stored
 * patch, saves it, THEN reverts the working tree (checkout HEAD). If the diff
 * capture hit the output cap, the stored patch is a truncated prefix — and the
 * subsequent revert destroys the original working-tree content. Unshelve would
 * then apply a corrupt patch over already-lost content: unrecoverable loss.
 *
 * The fix fails the shelve for that file BEFORE anything is stored or reverted,
 * so the working tree is genuinely untouched.
 *
 * RED evidence (pre-fix): shelve completed, stored the truncated diff, and
 * reverted the file — the working tree lost its change and getShelfItems held a
 * corrupt entry.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { createShelfService, ShelfService } from '../../../src/shelf/ShelfService';
import { GitCli } from '../../../src/git-core/gitCli';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { IShelveSelection } from '../../../src/shelf/interfaces/IShelfService';
import { Uri } from '../../mocks/vscode';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TMP_ROOT = path.join(REPO_ROOT, 'workspace-notes', 'tmp');

describe('ShelfService.shelve — fail closed on a truncated diff capture', () => {
  let repoPath: string;
  let setupCli: GitCli;
  let shelfService: ShelfService;
  let repo: IRepository;

  // A big change so `git diff HEAD -- file` far exceeds the tiny cap below,
  // while the short setup / --numstat outputs stay under it.
  const bigContent = Array.from({ length: 2000 }, (_, i) => `line ${i} changed`).join('\n') + '\n';
  const testFile = 'big.txt';

  beforeEach(async () => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    repoPath = fs.mkdtempSync(path.join(TMP_ROOT, 'shelf-trunc-'));
    setupCli = new GitCli(); // normal cap — setup is unaffected
    await setupCli.exec(['init'], { cwd: repoPath });
    await setupCli.exec(['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    await setupCli.exec(['config', 'user.name', 'Test User'], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, testFile), 'seed\n');
    await setupCli.exec(['add', '.'], { cwd: repoPath });
    await setupCli.exec(['commit', '-m', 'seed'], { cwd: repoPath });
    // Introduce the large working-tree change to be shelved.
    fs.writeFileSync(path.join(repoPath, testFile), bigContent);

    // The service under test uses a GitCli with a tiny per-stream cap, so the
    // diff capture reports truncated=true (the numstat binary pre-check output
    // stays well under 400 chars and is unaffected).
    const cappedCli = new GitCli('git', undefined, 400);
    shelfService = createShelfService(cappedCli);
    repo = { rootUri: Uri.file(repoPath), state: 'idle', remotes: [] } as unknown as IRepository;
  });

  afterEach(() => {
    shelfService.dispose();
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it('aborts naming the file, stores nothing, and leaves the working tree untouched', async () => {
    const selection: IShelveSelection = { files: [testFile] };

    await assert.rejects(
      () => shelfService.shelve(repo, 'my shelf', selection),
      (e: unknown) =>
        e instanceof Error && /big\.txt/.test(e.message) && /capture limit/i.test(e.message),
      'shelve must reject naming the file when its diff is truncated'
    );

    // Nothing persisted.
    assert.strictEqual(
      shelfService.getShelfItems(repo).length,
      0,
      'no shelf entry may be stored when the capture was truncated'
    );

    // Working tree untouched — the change is still there (NOT reverted to HEAD).
    assert.strictEqual(
      fs.readFileSync(path.join(repoPath, testFile), 'utf8'),
      bigContent,
      'the working-tree change must survive an aborted shelve'
    );
  });
});
