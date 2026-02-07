import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ShelfService, createShelfService } from '../../../services/ShelfService';
import { IRepository } from '../../../services/interfaces/IGitService';
import { IShelveSelection, IShelfItem } from '../../../services/interfaces/IShelfService';
import { GitCli } from '../../../utils/gitCli';
import { Uri } from '../../mocks/vscode';

/**
 * Unit tests for ShelfService.
 * Tests the shelf functionality for saving and restoring changes.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
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
      const storagePath = path.join(testRepoPath, '.git', 'intellij-git-shelf.json');
      assert.ok(fs.existsSync(storagePath), 'Storage file should exist');

      // Verify storage content
      const content = fs.readFileSync(storagePath, 'utf8');
      const storage = JSON.parse(content) as { version: number; items: { name: string }[] };

      assert.strictEqual(storage.version, 1, 'Storage version should be 1');
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
});
