import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ChangelistService, createChangelistService } from '../../../services/ChangelistService';
import { IRepository } from '../../../services/interfaces/IGitService';
import { IChangelist } from '../../../services/interfaces/IChangelistService';
import { GitCli } from '../../../utils/gitCli';
import { Uri } from '../../mocks/vscode';

/**
 * Unit tests for ChangelistService.
 * Tests the changelist functionality for organizing uncommitted changes.
 *
 * Requirements: 2.2, 2.3, 2.4, 2.5
 */
describe('ChangelistService', () => {
  let changelistService: ChangelistService;
  let testRepoPath: string;
  let mockRepo: IRepository;
  let gitCli: GitCli;

  /**
   * Set up a test Git repository before each test.
   */
  beforeEach(async () => {
    // Create a temporary directory for the test repository
    testRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'changelist-test-'));

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

    // Create the changelist service
    changelistService = createChangelistService();
  });

  /**
   * Clean up after each test.
   */
  afterEach(() => {
    changelistService.dispose();

    // Clean up the test repository
    try {
      fs.rmSync(testRepoPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('getChangelists()', () => {
    it('should return default changelist when no changelists exist', () => {
      const changelists = changelistService.getChangelists(mockRepo);

      assert.strictEqual(changelists.length, 1, 'Should have one changelist');
      assert.strictEqual(changelists[0].name, 'Default Changelist', 'Should be default changelist');
      assert.strictEqual(changelists[0].isDefault, true, 'Should be marked as default');
      assert.strictEqual(changelists[0].id, 'default', 'Should have default ID');
    });

    it('should return all changelists including default', () => {
      // Create some changelists
      changelistService.createChangelist(mockRepo, 'Feature A');
      changelistService.createChangelist(mockRepo, 'Feature B');

      const changelists = changelistService.getChangelists(mockRepo);

      assert.strictEqual(changelists.length, 3, 'Should have three changelists');

      const names = changelists.map((cl) => cl.name);
      assert.ok(names.includes('Default Changelist'), 'Should include default');
      assert.ok(names.includes('Feature A'), 'Should include Feature A');
      assert.ok(names.includes('Feature B'), 'Should include Feature B');
    });

    it('should cache changelists', () => {
      // First call
      const changelists1 = changelistService.getChangelists(mockRepo);

      // Second call should return cached result
      const changelists2 = changelistService.getChangelists(mockRepo);

      assert.strictEqual(changelists1, changelists2, 'Should return same cached array');
    });
  });

  describe('getDefaultChangelist()', () => {
    /**
     * Requirement 2.2: Default changelist always exists
     */
    it('should always return a default changelist', () => {
      const defaultChangelist = changelistService.getDefaultChangelist(mockRepo);

      assert.ok(defaultChangelist, 'Default changelist should exist');
      assert.strictEqual(defaultChangelist.isDefault, true, 'Should be marked as default');
      assert.strictEqual(defaultChangelist.name, 'Default Changelist', 'Should have correct name');
    });

    it('should return the same default changelist on multiple calls', () => {
      const default1 = changelistService.getDefaultChangelist(mockRepo);
      const default2 = changelistService.getDefaultChangelist(mockRepo);

      assert.strictEqual(default1.id, default2.id, 'Should have same ID');
    });
  });

  describe('createChangelist()', () => {
    /**
     * Requirement 2.3: Create custom changelists with names
     */
    it('should create a new changelist with the given name', () => {
      const changelist = changelistService.createChangelist(mockRepo, 'My Feature');

      assert.ok(changelist.id, 'Changelist should have an ID');
      assert.strictEqual(changelist.name, 'My Feature', 'Should have correct name');
      assert.strictEqual(changelist.isDefault, false, 'Should not be default');
      assert.deepStrictEqual(changelist.files, [], 'Should have no files');
    });

    it('should add changelist to the list', () => {
      changelistService.createChangelist(mockRepo, 'New Changelist');

      const changelists = changelistService.getChangelists(mockRepo);
      const names = changelists.map((cl) => cl.name);

      assert.ok(names.includes('New Changelist'), 'Should include new changelist');
    });

    it('should throw error for empty name', () => {
      assert.throws(
        () => changelistService.createChangelist(mockRepo, ''),
        /Changelist name cannot be empty/
      );
    });

    it('should throw error for whitespace-only name', () => {
      assert.throws(
        () => changelistService.createChangelist(mockRepo, '   '),
        /Changelist name cannot be empty/
      );
    });

    it('should trim whitespace from name', () => {
      const changelist = changelistService.createChangelist(mockRepo, '  Trimmed Name  ');

      assert.strictEqual(changelist.name, 'Trimmed Name', 'Name should be trimmed');
    });

    it('should throw error for duplicate name', () => {
      changelistService.createChangelist(mockRepo, 'Duplicate');

      assert.throws(
        () => changelistService.createChangelist(mockRepo, 'Duplicate'),
        /already exists/
      );
    });

    it('should generate unique IDs for each changelist', () => {
      const cl1 = changelistService.createChangelist(mockRepo, 'First');
      const cl2 = changelistService.createChangelist(mockRepo, 'Second');

      assert.notStrictEqual(cl1.id, cl2.id, 'IDs should be unique');
    });
  });

  describe('deleteChangelist()', () => {
    /**
     * Requirement 2.5: Delete changelists (files move to default)
     */
    it('should delete a changelist', () => {
      const changelist = changelistService.createChangelist(mockRepo, 'To Delete');

      changelistService.deleteChangelist(mockRepo, changelist.id);

      const changelists = changelistService.getChangelists(mockRepo);
      const ids = changelists.map((cl) => cl.id);

      assert.ok(!ids.includes(changelist.id), 'Changelist should be deleted');
    });

    it('should move files to default changelist when deleting', () => {
      // Create a changelist with files
      const changelist = changelistService.createChangelist(mockRepo, 'With Files');
      changelistService.moveToChangelist(mockRepo, ['file1.txt', 'file2.txt'], changelist.id);

      // Delete the changelist
      changelistService.deleteChangelist(mockRepo, changelist.id);

      // Check that files are in default changelist
      const defaultChangelist = changelistService.getDefaultChangelist(mockRepo);
      const filePaths = defaultChangelist.files.map((f) => f.path);

      assert.ok(filePaths.includes('file1.txt'), 'file1.txt should be in default');
      assert.ok(filePaths.includes('file2.txt'), 'file2.txt should be in default');
    });

    it('should throw error when deleting default changelist', () => {
      assert.throws(
        () => changelistService.deleteChangelist(mockRepo, 'default'),
        /Cannot delete the default changelist/
      );
    });

    it('should throw error for non-existent changelist', () => {
      assert.throws(
        () => changelistService.deleteChangelist(mockRepo, 'non-existent'),
        /Changelist not found/
      );
    });
  });

  describe('renameChangelist()', () => {
    it('should rename a changelist', () => {
      const changelist = changelistService.createChangelist(mockRepo, 'Original Name');

      changelistService.renameChangelist(mockRepo, changelist.id, 'New Name');

      const changelists = changelistService.getChangelists(mockRepo);
      const renamed = changelists.find((cl) => cl.id === changelist.id);

      assert.strictEqual(renamed?.name, 'New Name', 'Name should be updated');
    });

    it('should throw error for empty name', () => {
      const changelist = changelistService.createChangelist(mockRepo, 'To Rename');

      assert.throws(
        () => changelistService.renameChangelist(mockRepo, changelist.id, ''),
        /Changelist name cannot be empty/
      );
    });

    it('should throw error for duplicate name', () => {
      changelistService.createChangelist(mockRepo, 'Existing');
      const changelist = changelistService.createChangelist(mockRepo, 'To Rename');

      assert.throws(
        () => changelistService.renameChangelist(mockRepo, changelist.id, 'Existing'),
        /already exists/
      );
    });

    it('should throw error for non-existent changelist', () => {
      assert.throws(
        () => changelistService.renameChangelist(mockRepo, 'non-existent', 'New Name'),
        /Changelist not found/
      );
    });

    it('should allow renaming to same name', () => {
      const changelist = changelistService.createChangelist(mockRepo, 'Same Name');

      // Should not throw
      changelistService.renameChangelist(mockRepo, changelist.id, 'Same Name');

      const changelists = changelistService.getChangelists(mockRepo);
      const renamed = changelists.find((cl) => cl.id === changelist.id);

      assert.strictEqual(renamed?.name, 'Same Name', 'Name should remain the same');
    });
  });

  describe('moveToChangelist()', () => {
    /**
     * Requirement 2.4: Move files between changelists
     */
    it('should move files to a changelist', () => {
      const changelist = changelistService.createChangelist(mockRepo, 'Target');

      changelistService.moveToChangelist(mockRepo, ['file1.txt', 'file2.txt'], changelist.id);

      const changelists = changelistService.getChangelists(mockRepo);
      const target = changelists.find((cl) => cl.id === changelist.id);
      const filePaths = target?.files.map((f) => f.path);

      assert.ok(filePaths?.includes('file1.txt'), 'file1.txt should be in target');
      assert.ok(filePaths?.includes('file2.txt'), 'file2.txt should be in target');
    });

    it('should remove files from other changelists when moving', () => {
      const source = changelistService.createChangelist(mockRepo, 'Source');
      const target = changelistService.createChangelist(mockRepo, 'Target');

      // Add file to source
      changelistService.moveToChangelist(mockRepo, ['file.txt'], source.id);

      // Move to target
      changelistService.moveToChangelist(mockRepo, ['file.txt'], target.id);

      const changelists = changelistService.getChangelists(mockRepo);
      const sourceChangelist = changelists.find((cl) => cl.id === source.id);
      const targetChangelist = changelists.find((cl) => cl.id === target.id);

      assert.strictEqual(sourceChangelist?.files.length, 0, 'Source should have no files');
      assert.strictEqual(targetChangelist?.files.length, 1, 'Target should have one file');
    });

    it('should handle moving to default changelist', () => {
      const changelist = changelistService.createChangelist(mockRepo, 'Source');
      changelistService.moveToChangelist(mockRepo, ['file.txt'], changelist.id);

      // Move to default
      changelistService.moveToChangelist(mockRepo, ['file.txt'], 'default');

      const defaultChangelist = changelistService.getDefaultChangelist(mockRepo);
      const filePaths = defaultChangelist.files.map((f) => f.path);

      assert.ok(filePaths.includes('file.txt'), 'File should be in default');
    });

    it('should throw error for non-existent changelist', () => {
      assert.throws(
        () => changelistService.moveToChangelist(mockRepo, ['file.txt'], 'non-existent'),
        /Changelist not found/
      );
    });

    it('should handle empty file array', () => {
      const changelist = changelistService.createChangelist(mockRepo, 'Target');

      // Should not throw
      changelistService.moveToChangelist(mockRepo, [], changelist.id);

      const changelists = changelistService.getChangelists(mockRepo);
      const target = changelists.find((cl) => cl.id === changelist.id);

      assert.strictEqual(target?.files.length, 0, 'Should have no files');
    });

    it('should not duplicate files when moving to same changelist', () => {
      const changelist = changelistService.createChangelist(mockRepo, 'Target');

      changelistService.moveToChangelist(mockRepo, ['file.txt'], changelist.id);
      changelistService.moveToChangelist(mockRepo, ['file.txt'], changelist.id);

      const changelists = changelistService.getChangelists(mockRepo);
      const target = changelists.find((cl) => cl.id === changelist.id);

      assert.strictEqual(target?.files.length, 1, 'Should have only one file');
    });
  });

  describe('persistence', () => {
    it('should persist changelists across service instances', () => {
      // Create changelist with first service instance
      changelistService.createChangelist(mockRepo, 'Persistent');

      // Create a new service instance
      const newService = createChangelistService();

      try {
        // Get changelists from new instance
        const changelists = newService.getChangelists(mockRepo);
        const names = changelists.map((cl) => cl.name);

        assert.ok(names.includes('Persistent'), 'Changelist should be persisted');
      } finally {
        newService.dispose();
      }
    });

    it('should persist file assignments', () => {
      const changelist = changelistService.createChangelist(mockRepo, 'With Files');
      changelistService.moveToChangelist(mockRepo, ['file1.txt', 'file2.txt'], changelist.id);

      // Create a new service instance
      const newService = createChangelistService();

      try {
        const changelists = newService.getChangelists(mockRepo);
        const withFiles = changelists.find((cl) => cl.name === 'With Files');
        const filePaths = withFiles?.files.map((f) => f.path);

        assert.ok(filePaths?.includes('file1.txt'), 'file1.txt should be persisted');
        assert.ok(filePaths?.includes('file2.txt'), 'file2.txt should be persisted');
      } finally {
        newService.dispose();
      }
    });

    it('should store changelist data in .git directory', () => {
      changelistService.createChangelist(mockRepo, 'Storage Test');

      // Check that storage file exists
      const storagePath = path.join(testRepoPath, '.git', 'intellij-git-changelists.json');
      assert.ok(fs.existsSync(storagePath), 'Storage file should exist');

      // Verify storage content
      const content = fs.readFileSync(storagePath, 'utf8');
      const storage = JSON.parse(content) as {
        version: number;
        changelists: { name: string }[];
      };

      assert.strictEqual(storage.version, 1, 'Storage version should be 1');
      const names = storage.changelists.map((cl) => cl.name);
      assert.ok(names.includes('Storage Test'), 'Should include created changelist');
    });
  });

  describe('onDidChangeChangelists event', () => {
    it('should fire event when creating changelist', () => {
      let eventFired = false;
      let eventChangelists: IChangelist[] = [];

      const disposable = changelistService.onDidChangeChangelists((changelists) => {
        eventFired = true;
        eventChangelists = changelists;
      });

      try {
        changelistService.createChangelist(mockRepo, 'Event Test');

        assert.ok(eventFired, 'Event should be fired');
        assert.ok(eventChangelists.length > 0, 'Event should include changelists');
      } finally {
        disposable.dispose();
      }
    });

    it('should fire event when deleting changelist', () => {
      const changelist = changelistService.createChangelist(mockRepo, 'To Delete');

      let eventFired = false;
      let eventChangelists: IChangelist[] = [];

      const disposable = changelistService.onDidChangeChangelists((changelists) => {
        eventFired = true;
        eventChangelists = changelists;
      });

      try {
        changelistService.deleteChangelist(mockRepo, changelist.id);

        assert.ok(eventFired, 'Event should be fired');
        const ids = eventChangelists.map((cl) => cl.id);
        assert.ok(!ids.includes(changelist.id), 'Deleted changelist should not be in event');
      } finally {
        disposable.dispose();
      }
    });

    it('should fire event when renaming changelist', () => {
      const changelist = changelistService.createChangelist(mockRepo, 'Original');

      let eventFired = false;

      const disposable = changelistService.onDidChangeChangelists(() => {
        eventFired = true;
      });

      try {
        changelistService.renameChangelist(mockRepo, changelist.id, 'Renamed');

        assert.ok(eventFired, 'Event should be fired');
      } finally {
        disposable.dispose();
      }
    });

    it('should fire event when moving files', () => {
      const changelist = changelistService.createChangelist(mockRepo, 'Target');

      let eventFired = false;

      const disposable = changelistService.onDidChangeChangelists(() => {
        eventFired = true;
      });

      try {
        changelistService.moveToChangelist(mockRepo, ['file.txt'], changelist.id);

        assert.ok(eventFired, 'Event should be fired');
      } finally {
        disposable.dispose();
      }
    });
  });

  describe('file belongs to exactly one changelist', () => {
    /**
     * Property: A file should always belong to exactly one changelist
     */
    it('should ensure file is in only one changelist after move', () => {
      const cl1 = changelistService.createChangelist(mockRepo, 'CL1');
      const cl2 = changelistService.createChangelist(mockRepo, 'CL2');

      // Add file to cl1
      changelistService.moveToChangelist(mockRepo, ['file.txt'], cl1.id);

      // Move to cl2
      changelistService.moveToChangelist(mockRepo, ['file.txt'], cl2.id);

      // Count how many changelists contain the file
      const changelists = changelistService.getChangelists(mockRepo);
      let count = 0;
      for (const cl of changelists) {
        if (cl.files.some((f) => f.path === 'file.txt')) {
          count++;
        }
      }

      assert.strictEqual(count, 1, 'File should be in exactly one changelist');
    });
  });
});
