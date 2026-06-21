import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ShelfService, createShelfService } from '../../../src/shelf/ShelfService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { IShelveSelection, IShelfItem } from '../../../src/shelf/interfaces/IShelfService';
import { GitCli } from '../../../src/git-core/gitCli';
import { Uri } from '../../mocks/vscode';

/**
 * Unit tests for ShelfService.
 * Tests the shelf functionality for saving and restoring changes.
 */
describe('ShelfService', () => {
  let shelfService: ShelfService;
  let testRepoPath: string;
  let mockRepo: IRepository;
  let gitCli: GitCli;

  /**
   * Set up a test Git repository before each test.
   */
  beforeEach(async () => {
    // Create a temporary directory for the test repository
    testRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-test-'));

    // Initialize a Git repository
    gitCli = new GitCli();
    await gitCli.exec(['init'], { cwd: testRepoPath });
    await gitCli.exec(['config', 'user.email', 'test@example.com'], { cwd: testRepoPath });
    await gitCli.exec(['config', 'user.name', 'Test User'], { cwd: testRepoPath });

    // Create an initial commit
    const testFile = path.join(testRepoPath, 'test.txt');
    fs.writeFileSync(testFile, 'initial content\n');
    await gitCli.exec(['add', '.'], { cwd: testRepoPath });
    await gitCli.exec(['commit', '-m', 'Initial commit'], { cwd: testRepoPath });

    // Create the mock repository
    mockRepo = {
      rootUri: Uri.file(testRepoPath),
      state: 'idle',
      remotes: [],
      submodules: [],
    };

    // Create the shelf service
    shelfService = createShelfService(gitCli);
  });

  /**
   * Clean up after each test.
   */
  afterEach(() => {
    shelfService.dispose();

    // Clean up the test repository
    try {
      fs.rmSync(testRepoPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('shelve()', () => {
    it('should shelve changes with a name', async () => {
      // Modify the test file
      const testFile = path.join(testRepoPath, 'test.txt');
      fs.writeFileSync(testFile, 'modified content\n');

      // Shelve the changes
      const selection: IShelveSelection = {
        files: ['test.txt'],
      };

      const shelfItem = await shelfService.shelve(mockRepo, 'My Shelf', selection);

      // Verify the shelf item
      assert.ok(shelfItem.id, 'Shelf item should have an ID');
      assert.strictEqual(shelfItem.name, 'My Shelf', 'Shelf item should have the correct name');
      assert.ok(shelfItem.timestamp instanceof Date, 'Shelf item should have a timestamp');
      assert.strictEqual(shelfItem.files.length, 1, 'Shelf item should have one file');
      assert.strictEqual(shelfItem.files[0].path, 'test.txt', 'File path should be correct');
      assert.ok(shelfItem.files[0].diff.length > 0, 'File should have diff content');
    });

    it('should revert changes after shelving', async () => {
      // Modify the test file
      const testFile = path.join(testRepoPath, 'test.txt');
      fs.writeFileSync(testFile, 'modified content\n');

      // Shelve the changes
      const selection: IShelveSelection = {
        files: ['test.txt'],
      };

      await shelfService.shelve(mockRepo, 'My Shelf', selection);

      // Verify the file is reverted
      const content = fs.readFileSync(testFile, 'utf8');
      assert.strictEqual(content, 'initial content\n', 'File should be reverted to original');
    });

    it('should throw error when no changes selected', async () => {
      const selection: IShelveSelection = {};

      await assert.rejects(
        async () => shelfService.shelve(mockRepo, 'Empty Shelf', selection),
        /No changes selected to shelve/
      );
    });

    it('should throw error when selected files have no changes', async () => {
      // Don't modify any files
      const selection: IShelveSelection = {
        files: ['test.txt'],
      };

      await assert.rejects(
        async () => shelfService.shelve(mockRepo, 'No Changes', selection),
        /No changes found in selected files/
      );
    });

    it('should shelve multiple files', async () => {
      // Create and modify multiple files
      const file1 = path.join(testRepoPath, 'file1.txt');
      const file2 = path.join(testRepoPath, 'file2.txt');

      fs.writeFileSync(file1, 'file1 content\n');
      fs.writeFileSync(file2, 'file2 content\n');
      await gitCli.exec(['add', '.'], { cwd: testRepoPath });
      await gitCli.exec(['commit', '-m', 'Add files'], { cwd: testRepoPath });

      // Modify both files
      fs.writeFileSync(file1, 'file1 modified\n');
      fs.writeFileSync(file2, 'file2 modified\n');

      // Shelve both files
      const selection: IShelveSelection = {
        files: ['file1.txt', 'file2.txt'],
      };

      const shelfItem = await shelfService.shelve(mockRepo, 'Multiple Files', selection);

      assert.strictEqual(shelfItem.files.length, 2, 'Shelf item should have two files');
    });
  });

  describe('getShelfItems()', () => {
    it('should return empty array when no shelf items exist', () => {
      const items = shelfService.getShelfItems(mockRepo);
      assert.deepStrictEqual(items, [], 'Should return empty array');
    });

    it('should return all shelf items', async () => {
      // Create some shelf items
      const testFile = path.join(testRepoPath, 'test.txt');

      // First shelf
      fs.writeFileSync(testFile, 'change 1\n');
      await shelfService.shelve(mockRepo, 'Shelf 1', { files: ['test.txt'] });

      // Second shelf
      fs.writeFileSync(testFile, 'change 2\n');
      await shelfService.shelve(mockRepo, 'Shelf 2', { files: ['test.txt'] });

      // Get all items
      const items = shelfService.getShelfItems(mockRepo);

      assert.strictEqual(items.length, 2, 'Should have two shelf items');
      assert.strictEqual(items[0].name, 'Shelf 1', 'First item should be Shelf 1');
      assert.strictEqual(items[1].name, 'Shelf 2', 'Second item should be Shelf 2');
    });

    it('should return items with correct timestamps', async () => {
      const testFile = path.join(testRepoPath, 'test.txt');
      fs.writeFileSync(testFile, 'modified\n');

      const beforeShelve = new Date();
      await shelfService.shelve(mockRepo, 'Timed Shelf', { files: ['test.txt'] });
      const afterShelve = new Date();

      const items = shelfService.getShelfItems(mockRepo);
      assert.strictEqual(items.length, 1);

      const timestamp = items[0].timestamp;
      assert.ok(timestamp >= beforeShelve, 'Timestamp should be after shelve start');
      assert.ok(timestamp <= afterShelve, 'Timestamp should be before shelve end');
    });
  });

  describe('unshelve()', () => {
    it('should restore shelved changes', async () => {
      // Modify and shelve
      const testFile = path.join(testRepoPath, 'test.txt');
      fs.writeFileSync(testFile, 'modified content\n');

      const shelfItem = await shelfService.shelve(mockRepo, 'To Unshelve', { files: ['test.txt'] });

      // Verify file is reverted
      let content = fs.readFileSync(testFile, 'utf8');
      assert.strictEqual(content, 'initial content\n');

      // Unshelve
      const result = await shelfService.unshelve(mockRepo, shelfItem.id);

      assert.ok(result.success, 'Unshelve should succeed');
      assert.strictEqual(result.conflicts, undefined, 'Should have no conflicts');

      // Verify changes are restored
      content = fs.readFileSync(testFile, 'utf8');
      assert.strictEqual(content, 'modified content\n', 'Changes should be restored');
    });

    it('should remove shelf item after unshelving by default', async () => {
      const testFile = path.join(testRepoPath, 'test.txt');
      fs.writeFileSync(testFile, 'modified\n');

      const shelfItem = await shelfService.shelve(mockRepo, 'To Remove', { files: ['test.txt'] });

      // Verify item exists
      let items = shelfService.getShelfItems(mockRepo);
      assert.strictEqual(items.length, 1);

      // Unshelve
      await shelfService.unshelve(mockRepo, shelfItem.id);

      // Verify item is removed
      items = shelfService.getShelfItems(mockRepo);
      assert.strictEqual(items.length, 0, 'Shelf item should be removed');
    });

    it('should keep shelf item when removeFromShelf is false', async () => {
      const testFile = path.join(testRepoPath, 'test.txt');
      fs.writeFileSync(testFile, 'modified\n');

      const shelfItem = await shelfService.shelve(mockRepo, 'To Keep', { files: ['test.txt'] });

      // Unshelve with keep option
      await shelfService.unshelve(mockRepo, shelfItem.id, { removeFromShelf: false });

      // Verify item still exists
      const items = shelfService.getShelfItems(mockRepo);
      assert.strictEqual(items.length, 1, 'Shelf item should still exist');
    });

    it('should throw error for non-existent shelf item', async () => {
      await assert.rejects(
        async () => shelfService.unshelve(mockRepo, 'non-existent-id'),
        /Shelf item not found/
      );
    });
  });

  describe('unshelve() target changelist routing', () => {
    // Records the calls a ShelfService makes into the changelist mechanism so
    // we can assert applied files are routed to the chosen changelist. Mirrors
    // IntelliJ's ShelveChangesManager.unshelveChangeList passing a
    // targetChangeList to PatchApplier (platform/vcs-impl/.../shelf).
    interface IMoveCall {
      files: string[];
      changelistId: string;
    }

    function makeChangelistStub(moves: IMoveCall[]) {
      return {
        moveToChangelist(_repo: IRepository, files: string[], changelistId: string): void {
          moves.push({ files: [...files], changelistId });
        },
      };
    }

    it('routes cleanly-applied files to the target changelist', async () => {
      const moves: IMoveCall[] = [];
      const svc = createShelfService(gitCli, undefined, makeChangelistStub(moves));

      const testFile = path.join(testRepoPath, 'test.txt');
      fs.writeFileSync(testFile, 'modified content\n');
      const shelfItem = await svc.shelve(mockRepo, 'Routed', { files: ['test.txt'] });

      const result = await svc.unshelve(mockRepo, shelfItem.id, {
        targetChangelist: 'cl-feature',
      });

      assert.ok(result.success, 'Unshelve should succeed');
      assert.strictEqual(moves.length, 1, 'Should reassign applied files once');
      assert.deepStrictEqual(moves[0].files, ['test.txt']);
      assert.strictEqual(moves[0].changelistId, 'cl-feature');

      svc.dispose();
    });

    it('does not reassign when no target changelist is given (default active)', async () => {
      const moves: IMoveCall[] = [];
      const svc = createShelfService(gitCli, undefined, makeChangelistStub(moves));

      const testFile = path.join(testRepoPath, 'test.txt');
      fs.writeFileSync(testFile, 'modified content\n');
      const shelfItem = await svc.shelve(mockRepo, 'Default', { files: ['test.txt'] });

      const result = await svc.unshelve(mockRepo, shelfItem.id);

      assert.ok(result.success, 'Unshelve should succeed');
      assert.strictEqual(moves.length, 0, 'Default unshelve leaves files in the active changelist');

      svc.dispose();
    });
  });

  describe('unshelve() per-file (partial)', () => {
    /**
     * Commit two extra tracked files, modify both, and shelve them as a
     * single entry. Returns the shelf id plus the two file paths.
     */
    async function shelveTwoFiles(): Promise<{ id: string; aPath: string; bPath: string }> {
      const aPath = path.join(testRepoPath, 'a.txt');
      const bPath = path.join(testRepoPath, 'b.txt');
      fs.writeFileSync(aPath, 'a base\n');
      fs.writeFileSync(bPath, 'b base\n');
      await gitCli.exec(['add', '.'], { cwd: testRepoPath });
      await gitCli.exec(['commit', '-m', 'add a and b'], { cwd: testRepoPath });

      fs.writeFileSync(aPath, 'a modified\n');
      fs.writeFileSync(bPath, 'b modified\n');
      const item = await shelfService.shelve(mockRepo, 'two files', {
        files: ['a.txt', 'b.txt'],
      });
      return { id: item.id, aPath, bPath };
    }

    it('applies only the selected file and leaves the unselected file in the working tree untouched', async () => {
      const { id, aPath, bPath } = await shelveTwoFiles();

      await shelfService.unshelve(mockRepo, id, { files: ['a.txt'] });

      assert.strictEqual(fs.readFileSync(aPath, 'utf8'), 'a modified\n', 'selected file restored');
      assert.strictEqual(
        fs.readFileSync(bPath, 'utf8'),
        'b base\n',
        'unselected file stays reverted (still shelved)'
      );
    });

    it('keeps the unselected file shelved and drops the applied file from the entry by default', async () => {
      const { id } = await shelveTwoFiles();

      await shelfService.unshelve(mockRepo, id, { files: ['a.txt'] });

      const items = shelfService.getShelfItems(mockRepo);
      assert.strictEqual(items.length, 1, 'entry survives because a file remains shelved');
      const remaining = items[0].files.map((f) => f.path);
      assert.deepStrictEqual(remaining, ['b.txt'], 'only the unselected file remains shelved');
    });

    it('keeps every file shelved when removeFromShelf is false', async () => {
      const { id } = await shelveTwoFiles();

      await shelfService.unshelve(mockRepo, id, { files: ['a.txt'], removeFromShelf: false });

      const items = shelfService.getShelfItems(mockRepo);
      assert.strictEqual(items.length, 1);
      const remaining = items[0].files.map((f) => f.path).sort();
      assert.deepStrictEqual(remaining, ['a.txt', 'b.txt'], 'entry intact when keeping a copy');
    });

    it('deletes the entry when the selected files are every file in the entry', async () => {
      const { id } = await shelveTwoFiles();

      await shelfService.unshelve(mockRepo, id, { files: ['a.txt', 'b.txt'] });

      const items = shelfService.getShelfItems(mockRepo);
      assert.strictEqual(items.length, 0, 'entry removed once nothing is left shelved');
    });

    it('throws when the file selection matches no file in the entry', async () => {
      const { id } = await shelveTwoFiles();

      await assert.rejects(
        async () => shelfService.unshelve(mockRepo, id, { files: ['nope.txt'] }),
        /No matching files/
      );
    });
  });

  describe('deleteShelfItem()', () => {
    it('should delete a shelf item', async () => {
      const testFile = path.join(testRepoPath, 'test.txt');
      fs.writeFileSync(testFile, 'modified\n');

      const shelfItem = await shelfService.shelve(mockRepo, 'To Delete', { files: ['test.txt'] });

      // Verify item exists
      let items = shelfService.getShelfItems(mockRepo);
      assert.strictEqual(items.length, 1);

      // Delete the item
      shelfService.deleteShelfItem(mockRepo, shelfItem.id);

      // Verify item is deleted
      items = shelfService.getShelfItems(mockRepo);
      assert.strictEqual(items.length, 0, 'Shelf item should be deleted');
    });

    it('should throw error for non-existent shelf item', () => {
      assert.throws(
        () => shelfService.deleteShelfItem(mockRepo, 'non-existent-id'),
        /Shelf item not found/
      );
    });
  });

  describe('getShelfDiff()', () => {
    it('should return diffs for a shelf item', async () => {
      const testFile = path.join(testRepoPath, 'test.txt');
      fs.writeFileSync(testFile, 'modified content\n');

      const shelfItem = await shelfService.shelve(mockRepo, 'With Diff', { files: ['test.txt'] });

      const diffs = await shelfService.getShelfDiff(mockRepo, shelfItem.id);

      assert.ok(diffs.length > 0, 'Should have at least one diff');
      assert.strictEqual(diffs[0].path, 'test.txt', 'Diff should be for test.txt');
    });

    it('should throw error for non-existent shelf item', async () => {
      await assert.rejects(
        async () => shelfService.getShelfDiff(mockRepo, 'non-existent-id'),
        /Shelf item not found/
      );
    });
  });

  describe('persistence', () => {
    it('should persist shelf items across service instances', async () => {
      const testFile = path.join(testRepoPath, 'test.txt');
      fs.writeFileSync(testFile, 'modified\n');

      // Shelve with first service instance
      await shelfService.shelve(mockRepo, 'Persistent Shelf', { files: ['test.txt'] });

      // Create a new service instance
      const newService = createShelfService(gitCli);

      try {
        // Get items from new instance
        const items = newService.getShelfItems(mockRepo);

        assert.strictEqual(items.length, 1, 'Should have one shelf item');
        assert.strictEqual(items[0].name, 'Persistent Shelf', 'Name should be preserved');
      } finally {
        newService.dispose();
      }
    });

    it('should store shelf data in .git directory', async () => {
      const testFile = path.join(testRepoPath, 'test.txt');
      fs.writeFileSync(testFile, 'modified\n');

      await shelfService.shelve(mockRepo, 'Storage Test', { files: ['test.txt'] });

      // Check that storage file exists
      const storagePath = path.join(testRepoPath, '.git', 'intellig-shelf.json');
      assert.ok(fs.existsSync(storagePath), 'Storage file should exist');

      // Verify storage content
      const content = fs.readFileSync(storagePath, 'utf8');
      const storage = JSON.parse(content) as { version: number; items: { name: string }[] };

      // storage schema bumped to v2 (adds optional unshelvedAt).
      assert.strictEqual(storage.version, 2, 'Storage version should be 2');
      assert.strictEqual(storage.items.length, 1, 'Should have one item');
      assert.strictEqual(storage.items[0].name, 'Storage Test', 'Item name should match');
    });
  });

  describe('onDidChangeShelf event', () => {
    it('should fire event when shelving', async () => {
      const testFile = path.join(testRepoPath, 'test.txt');
      fs.writeFileSync(testFile, 'modified\n');

      let eventFired = false;
      let eventItems: IShelfItem[] = [];

      const disposable = shelfService.onDidChangeShelf((items) => {
        eventFired = true;
        eventItems = items;
      });

      try {
        await shelfService.shelve(mockRepo, 'Event Test', { files: ['test.txt'] });

        assert.ok(eventFired, 'Event should be fired');
        assert.strictEqual(eventItems.length, 1, 'Event should include the new item');
      } finally {
        disposable.dispose();
      }
    });

    it('should fire event when deleting', async () => {
      const testFile = path.join(testRepoPath, 'test.txt');
      fs.writeFileSync(testFile, 'modified\n');

      const shelfItem = await shelfService.shelve(mockRepo, 'To Delete', { files: ['test.txt'] });

      let eventFired = false;
      let eventItems: IShelfItem[] = [];

      const disposable = shelfService.onDidChangeShelf((items) => {
        eventFired = true;
        eventItems = items;
      });

      try {
        shelfService.deleteShelfItem(mockRepo, shelfItem.id);

        assert.ok(eventFired, 'Event should be fired');
        assert.strictEqual(eventItems.length, 0, 'Event should show empty items');
      } finally {
        disposable.dispose();
      }
    });
  });

  describe('binary files', () => {
    /**
     * Build a byte sequence that is NOT valid UTF-8 and contains NUL bytes,
     * so a lossy string round-trip (git stdout captured via `.toString()`)
     * would corrupt it. This pins that the shelf preserves raw bytes.
     */
    function makeBinaryBytes(): Buffer {
      const bytes: number[] = [];
      for (let i = 0; i < 256; i++) {
        bytes.push(i);
      }
      // Append known lone-continuation and lone-lead bytes plus extra NULs that
      // a UTF-8 decode would replace with U+FFFD.
      bytes.push(0x00, 0x80, 0xff, 0xfe, 0x00, 0xc0, 0xc1);
      return Buffer.from(bytes);
    }

    it('should mark a binary file entry isBinary', async () => {
      const binPath = path.join(testRepoPath, 'image.bin');
      const original = makeBinaryBytes();
      fs.writeFileSync(binPath, original);
      await gitCli.exec(['add', '.'], { cwd: testRepoPath });
      await gitCli.exec(['commit', '-m', 'Add binary'], { cwd: testRepoPath });

      // Mutate the binary content so it shows up as a modification.
      const modified = Buffer.concat([original, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
      fs.writeFileSync(binPath, modified);

      const shelfItem = await shelfService.shelve(mockRepo, 'Binary Shelf', {
        files: ['image.bin'],
      });

      assert.strictEqual(shelfItem.files.length, 1, 'Shelf item should have one file');
      assert.strictEqual(shelfItem.files[0].path, 'image.bin');
      assert.strictEqual(shelfItem.files[0].isBinary, true, 'Entry should be marked binary');
    });

    it('should round-trip a modified binary file byte-for-byte', async () => {
      const binPath = path.join(testRepoPath, 'image.bin');
      const original = makeBinaryBytes();
      fs.writeFileSync(binPath, original);
      await gitCli.exec(['add', '.'], { cwd: testRepoPath });
      await gitCli.exec(['commit', '-m', 'Add binary'], { cwd: testRepoPath });

      const modified = Buffer.concat([original, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
      fs.writeFileSync(binPath, modified);

      const shelfItem = await shelfService.shelve(mockRepo, 'Binary Shelf', {
        files: ['image.bin'],
      });

      // After shelving, the working tree must be back to the committed bytes.
      const reverted = fs.readFileSync(binPath);
      assert.ok(reverted.equals(original), 'Binary file should be reverted to committed bytes');

      const result = await shelfService.unshelve(mockRepo, shelfItem.id);
      assert.ok(result.success, 'Unshelve should succeed');
      assert.strictEqual(result.conflicts, undefined, 'Should have no conflicts');

      const restored = fs.readFileSync(binPath);
      assert.ok(restored.equals(modified), 'Restored binary must be byte-for-byte identical');
    });

    it('should round-trip an added binary file byte-for-byte', async () => {
      const binPath = path.join(testRepoPath, 'added.bin');
      const bytes = makeBinaryBytes();
      fs.writeFileSync(binPath, bytes);
      await gitCli.exec(['add', '--intent-to-add', 'added.bin'], { cwd: testRepoPath });

      const shelfItem = await shelfService.shelve(mockRepo, 'Added Binary', {
        files: ['added.bin'],
      });
      assert.strictEqual(shelfItem.files[0].isBinary, true, 'Added binary should be marked binary');

      // Shelving an added file removes it from the working tree.
      assert.ok(!fs.existsSync(binPath), 'Added binary should be removed after shelve');

      const result = await shelfService.unshelve(mockRepo, shelfItem.id);
      assert.ok(result.success, 'Unshelve should succeed');

      assert.ok(fs.existsSync(binPath), 'Added binary should be restored');
      const restored = fs.readFileSync(binPath);
      assert.ok(restored.equals(bytes), 'Restored added binary must be byte-for-byte identical');
    });

    it('should round-trip a deleted binary file', async () => {
      const binPath = path.join(testRepoPath, 'todelete.bin');
      const bytes = makeBinaryBytes();
      fs.writeFileSync(binPath, bytes);
      await gitCli.exec(['add', '.'], { cwd: testRepoPath });
      await gitCli.exec(['commit', '-m', 'Add binary to delete'], { cwd: testRepoPath });

      fs.rmSync(binPath);

      const shelfItem = await shelfService.shelve(mockRepo, 'Deleted Binary', {
        files: ['todelete.bin'],
      });
      assert.strictEqual(
        shelfItem.files[0].isBinary,
        true,
        'Deleted binary should be marked binary'
      );

      // Shelving a deletion restores the file to the working tree.
      assert.ok(fs.existsSync(binPath), 'Deleted binary should be restored after shelve');

      const result = await shelfService.unshelve(mockRepo, shelfItem.id);
      assert.ok(result.success, 'Unshelve should succeed');

      assert.ok(!fs.existsSync(binPath), 'Binary should be deleted again after unshelve');
    });
  });
});
