import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ShelfService, createShelfService } from '../../../shelf/ShelfService';
import { IRepository } from '../../../git-core/interfaces/IGitService';
import { IShelveSelection } from '../../../shelf/interfaces/IShelfService';
import { GitCli } from '../../../git-core/gitCli';
import { Uri } from '../../mocks/vscode';

/**
 * Unit tests for ShelfService.getShelvedFileContent — the shelf
 * "Compare with Local" left-hand side. Backed by a real on-disk git repo so
 * the base-revision read (`git show HEAD:<path>`) and patch round-trip are
 * exercised end to end.
 */
describe('ShelfService.getShelvedFileContent', () => {
  let shelfService: ShelfService;
  let testRepoPath: string;
  let mockRepo: IRepository;
  let gitCli: GitCli;

  beforeEach(async () => {
    testRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-diff-local-'));
    gitCli = new GitCli();
    await gitCli.exec(['init'], { cwd: testRepoPath });
    await gitCli.exec(['config', 'user.email', 'test@example.com'], { cwd: testRepoPath });
    await gitCli.exec(['config', 'user.name', 'Test User'], { cwd: testRepoPath });

    const testFile = path.join(testRepoPath, 'test.txt');
    fs.writeFileSync(testFile, 'line1\nline2\nline3\n');
    await gitCli.exec(['add', '.'], { cwd: testRepoPath });
    await gitCli.exec(['commit', '-m', 'Initial commit'], { cwd: testRepoPath });

    mockRepo = {
      rootUri: Uri.file(testRepoPath),
      state: 'idle',
      remotes: [],
      submodules: [],
    } as unknown as IRepository;

    shelfService = createShelfService(gitCli);
  });

  afterEach(() => {
    shelfService.dispose();
    try {
      fs.rmSync(testRepoPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it('returns the shelved (pre-revert) content of a modified file, not the reverted working tree', async () => {
    // Modify a committed file, then shelve it. shelve() reverts the working
    // tree back to the committed version, so the *shelved* content only lives
    // inside the stored patch — reconstructing it is the whole point.
    const testFile = path.join(testRepoPath, 'test.txt');
    fs.writeFileSync(testFile, 'line1\nline2-shelved\nline3\n');

    const selection: IShelveSelection = { files: ['test.txt'] };
    const item = await shelfService.shelve(mockRepo, 'My Shelf', selection);

    // Sanity: the working tree was reverted by shelve().
    assert.strictEqual(fs.readFileSync(testFile, 'utf8'), 'line1\nline2\nline3\n');

    const shelved = await shelfService.getShelvedFileContent(mockRepo, item.id, 'test.txt');

    assert.strictEqual(shelved, 'line1\nline2-shelved\nline3\n');
  });

  it('reconstructs an added file from an imported patch with no base revision', async () => {
    const patch = [
      'diff --git a/brand.txt b/brand.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/brand.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '',
    ].join('\n');

    const item = await shelfService.importPatch(mockRepo, {
      name: 'added',
      patchContent: patch,
    });

    const shelved = await shelfService.getShelvedFileContent(mockRepo, item.id, 'brand.txt');

    assert.strictEqual(shelved, 'hello\nworld\n');
  });

  it('rejects when the shelf item does not exist', async () => {
    await assert.rejects(
      () => shelfService.getShelvedFileContent(mockRepo, 'no-such-id', 'test.txt'),
      /Shelf item not found/
    );
  });

  it('rejects when the file is not part of the shelf item', async () => {
    const testFile = path.join(testRepoPath, 'test.txt');
    fs.writeFileSync(testFile, 'line1\nline2-shelved\nline3\n');
    const item = await shelfService.shelve(mockRepo, 'My Shelf', { files: ['test.txt'] });

    await assert.rejects(
      () => shelfService.getShelvedFileContent(mockRepo, item.id, 'absent.txt'),
      /File not found in shelf item/
    );
  });
});
