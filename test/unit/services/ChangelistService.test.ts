import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  ChangelistService,
  createChangelistService,
} from '../../../src/changelists/ChangelistService';
import {
  IFileStatus,
  IGitService,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';
import { IChangelist } from '../../../src/changelists/interfaces/IChangelistService';
import { GitCli } from '../../../src/git-core/gitCli';
import { Uri } from '../../mocks/vscode';

/**
 * Minimal fake-timer shim.
 *
 * Replaces `setTimeout` / `clearTimeout` on `globalThis` with a deterministic
 * queue driven by {@link installFakeTimers}`.tick()`. Scoped to the current
 * test; the `uninstall()` call restores the real timers so other tests
 * aren't affected.
 *
 * This is intentionally tiny — we only need the debounced-reconcile path,
 * which uses `setTimeout(..., 300)` and `clearTimeout`. No interval, no
 * setImmediate, no Date.now() virtualisation. If the ChangelistService
 * debounce ever grows those dependencies, upgrade to `@sinonjs/fake-timers`
 * rather than extending this shim.
 */
interface IFakeTimerHandle {
  id: number;
  fireAt: number;
  callback: () => void;
}

function installFakeTimers(): {
  tick: (ms: number) => void;
  uninstall: () => void;
} {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let nextId = 1;
  const queue: IFakeTimerHandle[] = [];

  (globalThis as unknown as { setTimeout: (cb: () => void, ms: number) => unknown }).setTimeout = (
    cb: () => void,
    ms: number
  ): unknown => {
    const handle: IFakeTimerHandle = { id: nextId++, fireAt: now + (ms ?? 0), callback: cb };
    queue.push(handle);
    // Return a numeric-coerceable stand-in so code that stores the return
    // value works regardless of whether it treats it as number or object.
    return handle.id as unknown;
  };

  (globalThis as unknown as { clearTimeout: (h: unknown) => void }).clearTimeout = (
    h: unknown
  ): void => {
    const id = typeof h === 'number' ? h : (h as IFakeTimerHandle | undefined)?.id;
    if (id === undefined) {
      return;
    }
    const idx = queue.findIndex((q) => q.id === id);
    if (idx >= 0) {
      queue.splice(idx, 1);
    }
  };

  return {
    tick: (ms: number): void => {
      now += ms;
      // Fire all timers whose deadline has passed, in insertion order.
      for (;;) {
        const due = queue.findIndex((q) => q.fireAt <= now);
        if (due < 0) {
          break;
        }
        const [handle] = queue.splice(due, 1);
        handle.callback();
      }
    },
    uninstall: (): void => {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
      (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout =
        realClearTimeout;
      queue.length = 0;
    },
  };
}

/**
 * Flush the pending microtask queue. Needed between `tick()` and assertions
 * because the debounce callback launches an async reconcile; each `await`
 * inside that chain yields back to the microtask queue. Schedules a macrotask
 * via the real timer to guarantee all microtasks drain.
 */
async function flushMicrotasks(): Promise<void> {
  // Use `setImmediate` (Node) or a `Promise.resolve()` yield; both allow the
  // current run of microtasks to complete before our await resolves.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Minimal no-op stub used by the specs that don't exercise reconcile.
 *
 * ChangelistService now REQUIRES a GitService reference at construction
 * time (fix/changelist-gitservice-wiring) so reconcile is always live.
 * Specs that don't care about reconcile pass this stub:
 *   - `getStatus` always returns `[]` (nothing dirty → reconcile is a
 *     no-op but still runs; storage won't be mutated).
 *   - `onDidChangeRepository` accepts listeners but never fires, so the
 *     debounced `scheduleReconcile` path stays dormant unless a spec
 *     explicitly drives it.
 *
 * Returns a narrow `Pick<IGitService, ...>` rather than `unknown`: the
 * cast-through-unknown that previously hid typing holes was flagged as
 * a maintenance trap (B1, senior-retro). The call site now casts the
 * narrow type directly to `IGitService`, which documents the two members
 * we actually stub and surfaces a type error if `ChangelistService` ever
 * starts touching a new `IGitService` method without us updating the stub.
 */
type NoopGitService = Pick<IGitService, 'getStatus' | 'onDidChangeRepository'>;

function makeNoopGitServiceStub(): NoopGitService {
  return {
    // stub signature must match IGitService.getStatus; structural conformance only.
    getStatus: async (_repo) => [],
    onDidChangeRepository: (_listener: (repo: IRepository) => void) => ({
      dispose: (): void => {
        // no-op
      },
    }),
  };
}

/**
 * NOT suitable for `createChangelistService(...)` because the constructor
 * eagerly calls `onDidChangeRepository`, which would trip the throwing trap.
 * Use `makeNoopGitServiceStub()` for constructor-path tests; use this helper
 * only for tests that exercise methods WITHOUT going through the constructor
 * (e.g., static-helper tests or other services that take IGitService).
 *
 * Defense-in-depth stub: every property access throws.
 *
 * Use in specs where the method under test should NOT reach into
 * `gitService` at all. Any accidental invocation surfaces immediately
 * with the member name, rather than silently returning an empty result
 * and corrupting the test's observed state (the specific bug class B1
 * was coined to prevent). Prefer this over `makeNoopGitServiceStub`
 * whenever a test wants to prove `gitService` is untouched.
 *
 * Not a forced migration — existing no-op sites stay on the no-op stub.
 */
function makeThrowingGitServiceStub(): IGitService {
  return new Proxy({} as IGitService, {
    get(_target, prop): never {
      throw new Error(
        `ChangelistService.test stub: unexpected call to IGitService.${String(prop)}`
      );
    },
  });
}

/**
 * Unit tests for ChangelistService.
 * Tests the changelist functionality for organizing uncommitted changes.
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

    // Create the changelist service with the no-op stub — specs under
    // this `describe` don't assert on reconcile behavior, so the stub's
    // empty-status / no-fire semantics keep storage deterministic.
    changelistService = createChangelistService(makeNoopGitServiceStub() as IGitService);
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
      const newService = createChangelistService(makeNoopGitServiceStub() as IGitService);

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
      const newService = createChangelistService(makeNoopGitServiceStub() as IGitService);

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
      const storagePath = path.join(testRepoPath, '.git', 'intellig-changelists.json');
      assert.ok(fs.existsSync(storagePath), 'Storage file should exist');

      // Verify storage content
      const content = fs.readFileSync(storagePath, 'utf8');
      const storage = JSON.parse(content) as {
        version: number;
        changelists: { name: string }[];
      };

      assert.strictEqual(
        storage.version,
        2,
        'Storage version should be 2 after any write by the current service'
      );
      const names = storage.changelists.map((cl) => cl.name);
      assert.ok(names.includes('Storage Test'), 'Should include created changelist');
    });

    it('persists in the worktree git dir (not <root>/.git) when .git is a FILE — linked worktree', () => {
      // Linked-worktree shape: `<root>/.git` is a regular FILE pointing at the
      // real per-worktree gitdir. Hardcoding `<root>/.git/<file>` would write
      // inside a FILE and THROW (ENOTDIR). The resolver must follow the pointer
      // so save+load round-trips and stays isolated per worktree.
      const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'changelist-wt-'));
      const worktreeGitDir = path.join(wtRoot, 'gitdir-real');
      fs.mkdirSync(worktreeGitDir, { recursive: true });
      fs.writeFileSync(path.join(wtRoot, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');
      const wtRepo: IRepository = {
        rootUri: Uri.file(wtRoot),
        state: 'idle',
        remotes: [],
        submodules: [],
      };

      try {
        assert.doesNotThrow(
          () => changelistService.createChangelist(wtRepo, 'WT List'),
          'creating a changelist in a linked worktree must not throw'
        );

        const storagePath = path.join(worktreeGitDir, 'intellig-changelists.json');
        assert.ok(
          fs.existsSync(storagePath),
          'storage file should land in the resolved worktree git dir'
        );

        const names = changelistService.getChangelists(wtRepo).map((cl) => cl.name);
        assert.ok(names.includes('WT List'), 'created changelist should round-trip back');
      } finally {
        fs.rmSync(wtRoot, { recursive: true, force: true });
      }
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

  describe('storage schema migration (v1 → v2)', () => {
    const storagePathOf = (repoRoot: string): string =>
      path.join(repoRoot, '.git', 'intellig-changelists.json');

    it('reading v1 JSON fills description: "" on each record', () => {
      // Write a v1 file directly. No `description`, no `activeChangelistId`.
      const v1 = {
        version: 1,
        changelists: [
          { id: 'default', name: 'Default Changelist', isDefault: true, files: ['a.txt'] },
          { id: 'feature', name: 'Feature', isDefault: false, files: [] },
        ],
      };
      fs.writeFileSync(storagePathOf(testRepoPath), JSON.stringify(v1, null, 2), 'utf8');

      const changelists = changelistService.getChangelists(mockRepo);

      for (const cl of changelists) {
        assert.strictEqual(
          cl.description,
          '',
          `changelist ${cl.name} should have description: "" after v1 read`
        );
      }
      assert.strictEqual(changelists.length, 2);
    });

    it('reading v2 JSON preserves description verbatim', () => {
      const v2 = {
        version: 2,
        activeChangelistId: 'feature',
        changelists: [
          {
            id: 'default',
            name: 'Default Changelist',
            isDefault: true,
            description: '',
            files: [],
          },
          {
            id: 'feature',
            name: 'Feature',
            isDefault: false,
            description: 'adds blame perf',
            files: [],
          },
        ],
      };
      fs.writeFileSync(storagePathOf(testRepoPath), JSON.stringify(v2, null, 2), 'utf8');

      const changelists = changelistService.getChangelists(mockRepo);
      const feature = changelists.find((cl) => cl.id === 'feature');
      assert.ok(feature, 'Feature changelist should be present');
      assert.strictEqual(feature.description, 'adds blame perf');
    });

    it('lazily rewrites v1 file as v2 on next save', () => {
      const v1 = {
        version: 1,
        changelists: [{ id: 'default', name: 'Default Changelist', isDefault: true, files: [] }],
      };
      fs.writeFileSync(storagePathOf(testRepoPath), JSON.stringify(v1, null, 2), 'utf8');

      // Read — does NOT rewrite the file yet (lazy).
      changelistService.getChangelists(mockRepo);
      const afterRead = JSON.parse(fs.readFileSync(storagePathOf(testRepoPath), 'utf8')) as {
        version: number;
      };
      assert.strictEqual(afterRead.version, 1, 'read alone must not rewrite file');

      // Write path — creating a changelist triggers the first save.
      changelistService.createChangelist(mockRepo, 'Triggers migration');
      const afterWrite = JSON.parse(fs.readFileSync(storagePathOf(testRepoPath), 'utf8')) as {
        version: number;
        activeChangelistId?: string;
      };
      assert.strictEqual(afterWrite.version, 2, 'write must stamp v2');
      assert.strictEqual(typeof afterWrite.activeChangelistId, 'string');
    });
  });

  describe('setActiveChangelist() / getActiveChangelist()', () => {
    it('getActiveChangelist returns default when storage is empty', async () => {
      const active = await changelistService.getActiveChangelist(mockRepo);
      assert.strictEqual(active.id, 'default');
      assert.strictEqual(active.isDefault, true);
    });

    it('setActiveChangelist with valid id persists and is reflected', async () => {
      const cl = changelistService.createChangelist(mockRepo, 'Feature X');

      await changelistService.setActiveChangelist(mockRepo, cl.id);

      const active = await changelistService.getActiveChangelist(mockRepo);
      assert.strictEqual(active.id, cl.id);

      // Also visible across a fresh service instance (persistence check).
      const fresh = createChangelistService(makeNoopGitServiceStub() as IGitService);
      try {
        const active2 = await fresh.getActiveChangelist(mockRepo);
        assert.strictEqual(active2.id, cl.id);
      } finally {
        fresh.dispose();
      }
    });

    it('setActiveChangelist with unknown id throws', async () => {
      await assert.rejects(
        () => changelistService.setActiveChangelist(mockRepo, 'does-not-exist'),
        /Changelist not found/
      );
    });

    it('deleting the active changelist falls back to default as active', async () => {
      const cl = changelistService.createChangelist(mockRepo, 'To Delete');
      await changelistService.setActiveChangelist(mockRepo, cl.id);

      changelistService.deleteChangelist(mockRepo, cl.id);

      const active = await changelistService.getActiveChangelist(mockRepo);
      assert.strictEqual(active.id, 'default');
    });
  });

  describe('getChangelistForFile()', () => {
    it('returns the changelist id when the file is tracked', async () => {
      const cl = changelistService.createChangelist(mockRepo, 'Tracked');
      changelistService.moveToChangelist(mockRepo, ['src/foo.ts'], cl.id);

      const id = await changelistService.getChangelistForFile(mockRepo, 'src/foo.ts');
      assert.strictEqual(id, cl.id);
    });

    it('returns undefined for an unknown path', async () => {
      const id = await changelistService.getChangelistForFile(mockRepo, 'not/tracked.ts');
      assert.strictEqual(id, undefined);
    });
  });

  describe('reconcileWithGitStatus()', () => {
    /**
     * Build a minimal IGitService stub that returns the given statuses.
     * The stub exposes a trigger to fire `onDidChangeRepository` so we
     * can exercise the debounced hook as well.
     */
    function makeGitServiceStub(
      statusesByRepo: Map<string, { path: string }[]>,
      onStatusCalled?: (repoPath: string) => void
    ): {
      /**
       * Returned typed as the full `IGitService` (via a narrow
       * `NoopGitService`-style Pick cast at the boundary) so call sites can
       * hand it straight to `createChangelistService(...)` without each
       * test site repeating the `as unknown as IGitService` dance. Only
       * `getStatus` + `onDidChangeRepository` are actually implemented —
       * any other method access will throw `undefined is not a function`,
       * surfacing accidental production-code dependencies on new
       * `IGitService` members.
       */
      gitService: IGitService;
      fireRepoChange: (repo: IRepository) => void;
      statusCallCount: () => number;
    } {
      let callCount = 0;
      const repoChangeListeners: Array<(repo: IRepository) => void> = [];

      const gitService: Pick<IGitService, 'getStatus' | 'onDidChangeRepository'> = {
        // Only the subset used by ChangelistService + the test's trigger
        // is implemented; everything else throws if touched by accident.
        // IGitService.getStatus contract returns Promise<IFileStatus[]>;
        // ChangelistService only reads `.path`, so we widen the stubbed
        // literal shape back to the production type at the return boundary.
        getStatus: async (repo: IRepository) => {
          callCount++;
          if (onStatusCalled) {
            onStatusCalled(repo.rootUri.fsPath);
          }
          const rows = statusesByRepo.get(repo.rootUri.fsPath) ?? [];
          return rows.map((r) => ({
            path: r.path,
            indexStatus: ' ' as const,
            workTreeStatus: 'M' as const,
          }));
        },
        onDidChangeRepository: (listener: (repo: IRepository) => void) => {
          repoChangeListeners.push(listener);
          return {
            dispose: () => {
              const idx = repoChangeListeners.indexOf(listener);
              if (idx >= 0) {
                repoChangeListeners.splice(idx, 1);
              }
            },
          };
        },
      };

      return {
        gitService: gitService as IGitService,
        fireRepoChange: (repo: IRepository) => {
          for (const l of repoChangeListeners) {
            l(repo);
          }
        },
        statusCallCount: () => callCount,
      };
    }

    it('a renamed file keeps its changelist assignment (old path swapped for new)', async () => {
      // reconcile builds dirtyPaths from the NEW path; without a rename
      // migration the OLD path is pruned from its changelist and the NEW path
      // lands in Default, silently moving the file out of the user's list.
      const repoChangeListeners: Array<(repo: IRepository) => void> = [];
      let phase: 'before' | 'after' = 'before';
      const gitService = {
        getStatus: async () =>
          phase === 'before'
            ? [{ path: 'old.ts', indexStatus: ' ' as const, workTreeStatus: 'M' as const }]
            : [
                {
                  path: 'new.ts',
                  indexStatus: 'R' as const,
                  workTreeStatus: ' ' as const,
                  renamed: 'old.ts',
                },
              ],
        onDidChangeRepository: (listener: (repo: IRepository) => void) => {
          repoChangeListeners.push(listener);
          return { dispose: (): void => {} };
        },
      } as unknown as IGitService;

      const svc = createChangelistService(gitService);
      try {
        // Seed: old.ts is dirty and moved into a custom changelist.
        await svc.reconcileWithGitStatus(mockRepo);
        const custom = svc.createChangelist(mockRepo, 'Feature');
        svc.moveToChangelist(mockRepo, ['old.ts'], custom.id);

        // Now old.ts is renamed to new.ts.
        phase = 'after';
        await svc.reconcileWithGitStatus(mockRepo);

        const lists = svc.getChangelists(mockRepo);
        const feature = lists.find((c) => c.id === custom.id)!;
        const def = lists.find((c) => c.isDefault)!;
        assert.deepStrictEqual(
          feature.files.map((f) => f.path),
          ['new.ts'],
          'the renamed file must stay in its changelist under the new path'
        );
        assert.ok(
          !def.files.some((f) => f.path === 'new.ts'),
          'the renamed file must NOT leak into Default'
        );
      } finally {
        svc.dispose();
      }
    });

    it('empty storage + dirty files → all assigned to default changelist', async () => {
      const stub = makeGitServiceStub(
        new Map([[testRepoPath, [{ path: 'a.txt' }, { path: 'b.txt' }, { path: 'c.txt' }]]])
      );
      const svc = createChangelistService(stub.gitService);
      try {
        await svc.reconcileWithGitStatus(mockRepo);
        const def = svc.getDefaultChangelist(mockRepo);
        const paths = def.files.map((f) => f.path).sort();
        assert.deepStrictEqual(paths, ['a.txt', 'b.txt', 'c.txt']);
      } finally {
        svc.dispose();
      }
    });

    it('stale entries (path no longer dirty) are pruned', async () => {
      const stub = makeGitServiceStub(new Map([[testRepoPath, [{ path: 'fresh.txt' }]]]));
      const svc = createChangelistService(stub.gitService);
      try {
        // Seed storage with a file that will no longer be dirty after reconcile.
        // Touch storage first so the default changelist exists in the JSON.
        svc.getChangelists(mockRepo);
        svc.moveToChangelist(mockRepo, ['stale.txt'], 'default');

        await svc.reconcileWithGitStatus(mockRepo);
        const def = svc.getDefaultChangelist(mockRepo);
        const paths = def.files.map((f) => f.path);
        assert.ok(!paths.includes('stale.txt'), 'stale.txt should be pruned');
        assert.ok(paths.includes('fresh.txt'), 'fresh.txt should be added');
      } finally {
        svc.dispose();
      }
    });

    it('external `git add` does not change the changelist assignment', async () => {
      const feature = changelistService.createChangelist(mockRepo, 'Feature');
      changelistService.moveToChangelist(mockRepo, ['src/foo.ts'], feature.id);

      // Simulate: file is still dirty per git status (staging is orthogonal).
      const stub = makeGitServiceStub(new Map([[testRepoPath, [{ path: 'src/foo.ts' }]]]));
      const svc = createChangelistService(stub.gitService);
      try {
        await svc.reconcileWithGitStatus(mockRepo);

        const owner = await svc.getChangelistForFile(mockRepo, 'src/foo.ts');
        assert.strictEqual(owner, feature.id, 'assignment must survive reconcile');
      } finally {
        svc.dispose();
      }
    });

    it('external file rm → entry pruned from all changelists', async () => {
      const cl = changelistService.createChangelist(mockRepo, 'Feature');
      changelistService.moveToChangelist(mockRepo, ['will-be-gone.txt'], cl.id);

      const stub = makeGitServiceStub(new Map([[testRepoPath, []]]));
      const svc = createChangelistService(stub.gitService);
      try {
        await svc.reconcileWithGitStatus(mockRepo);

        const owner = await svc.getChangelistForFile(mockRepo, 'will-be-gone.txt');
        assert.strictEqual(owner, undefined);
      } finally {
        svc.dispose();
      }
    });

    it('file rename → new path goes to default, old path is pruned', async () => {
      const cl = changelistService.createChangelist(mockRepo, 'Feature');
      changelistService.moveToChangelist(mockRepo, ['old-name.txt'], cl.id);

      // Git status reports the renamed target path.
      const stub = makeGitServiceStub(new Map([[testRepoPath, [{ path: 'new-name.txt' }]]]));
      const svc = createChangelistService(stub.gitService);
      try {
        await svc.reconcileWithGitStatus(mockRepo);

        const oldOwner = await svc.getChangelistForFile(mockRepo, 'old-name.txt');
        const newOwner = await svc.getChangelistForFile(mockRepo, 'new-name.txt');
        assert.strictEqual(oldOwner, undefined, 'old path pruned');
        assert.strictEqual(newOwner, 'default', 'new path lands in default');
      } finally {
        svc.dispose();
      }
    });

    it('preserves path case exactly as reported by git (no normalization)', async () => {
      // Git on a case-sensitive checkout reports the exact casing; we
      // must not lower-case or otherwise normalize. On case-insensitive
      // filesystems (HFS+, NTFS) git still reports the tracked casing;
      // ChangelistService treats both as distinct strings.
      const stub = makeGitServiceStub(
        new Map([[testRepoPath, [{ path: 'Src/File.TS' }, { path: 'src/file.ts' }]]])
      );
      const svc = createChangelistService(stub.gitService);
      try {
        await svc.reconcileWithGitStatus(mockRepo);
        const def = svc.getDefaultChangelist(mockRepo);
        const paths = def.files.map((f) => f.path).sort();
        assert.deepStrictEqual(paths, ['Src/File.TS', 'src/file.ts']);
      } finally {
        svc.dispose();
      }
    });

    it('multi-repo isolation: reconcile on repo A does not touch repo B storage', async () => {
      // Build a second repo dir with its own .git folder.
      const repoBPath = fs.mkdtempSync(path.join(os.tmpdir(), 'changelist-test-b-'));
      fs.mkdirSync(path.join(repoBPath, '.git'));
      const repoB: IRepository = {
        rootUri: Uri.file(repoBPath),
        state: 'idle',
        remotes: [],
        submodules: [],
      };

      try {
        const statuses = new Map<string, { path: string }[]>([
          [testRepoPath, [{ path: 'only-in-a.txt' }]],
          [repoBPath, [{ path: 'only-in-b.txt' }]],
        ]);
        const stub = makeGitServiceStub(statuses);
        const svc = createChangelistService(stub.gitService);
        try {
          // Touch both repos so each has its own default changelist persisted.
          svc.getChangelists(mockRepo);
          svc.getChangelists(repoB);

          // Seed both repos with pre-existing entries.
          svc.moveToChangelist(mockRepo, ['only-in-a.txt'], 'default');
          svc.moveToChangelist(repoB, ['only-in-b.txt'], 'default');

          // Reconcile only repo A.
          await svc.reconcileWithGitStatus(mockRepo);

          const aDef = svc.getDefaultChangelist(mockRepo);
          const bDef = svc.getDefaultChangelist(repoB);

          assert.deepStrictEqual(
            aDef.files.map((f) => f.path),
            ['only-in-a.txt'],
            'repo A reconciled'
          );
          assert.deepStrictEqual(
            bDef.files.map((f) => f.path),
            ['only-in-b.txt'],
            'repo B untouched'
          );
        } finally {
          svc.dispose();
        }
      } finally {
        fs.rmSync(repoBPath, { recursive: true, force: true });
      }
    });

    it('corrupt JSON → graceful reset to empty storage', async () => {
      const storagePath = path.join(testRepoPath, '.git', 'intellig-changelists.json');
      fs.writeFileSync(storagePath, '{ not valid json', 'utf8');

      const stub = makeGitServiceStub(new Map([[testRepoPath, [{ path: 'rescued.txt' }]]]));
      const svc = createChangelistService(stub.gitService);
      try {
        // getChangelists should not throw — it absorbs the parse error.
        const before = svc.getChangelists(mockRepo);
        assert.ok(
          before.some((cl) => cl.isDefault),
          'default changelist exists after corrupt read'
        );

        await svc.reconcileWithGitStatus(mockRepo);
        const def = svc.getDefaultChangelist(mockRepo);
        assert.deepStrictEqual(
          def.files.map((f) => f.path),
          ['rescued.txt']
        );
      } finally {
        svc.dispose();
      }
    });

    it('concurrent reconcile calls coalesce into a single in-flight run', async () => {
      let calls = 0;
      const stub = makeGitServiceStub(new Map([[testRepoPath, [{ path: 'x.txt' }]]]), () => {
        calls++;
      });
      const svc = createChangelistService(stub.gitService);
      try {
        const [a, b, c] = [
          svc.reconcileWithGitStatus(mockRepo),
          svc.reconcileWithGitStatus(mockRepo),
          svc.reconcileWithGitStatus(mockRepo),
        ];
        await Promise.all([a, b, c]);
        assert.strictEqual(calls, 1, 'only one getStatus call for three concurrent reconciles');
      } finally {
        svc.dispose();
      }
    });

    it('onDidChangeRepository triggers debounced reconcile', async () => {
      // Use a local fake-timer shim instead of waiting out the real
      // 300 ms debounce. Drops test time from ~400 ms to <5 ms and makes
      // the assertion deterministic regardless of event-loop scheduling.
      const fake = installFakeTimers();
      try {
        const stub = makeGitServiceStub(new Map([[testRepoPath, [{ path: 'debounced.txt' }]]]));
        const svc = createChangelistService(stub.gitService);
        try {
          // Fire several times in quick succession; debounce should collapse.
          stub.fireRepoChange(mockRepo);
          stub.fireRepoChange(mockRepo);
          stub.fireRepoChange(mockRepo);

          // No reconcile until the debounce elapses.
          assert.strictEqual(stub.statusCallCount(), 0, 'no reconcile before timer fires');

          // Advance past the 300 ms debounce window.
          fake.tick(300);

          // The timer callback kicks off the async reconcile; flush the
          // microtask queue so the awaits inside reconcileWithGitStatus
          // complete before we assert. Two flushes cover the
          // `loadChangelistStorage`-then-`getStatus` chain.
          await flushMicrotasks();
          await flushMicrotasks();

          assert.strictEqual(
            stub.statusCallCount(),
            1,
            'debounce should coalesce bursty events to one reconcile'
          );
          const def = svc.getDefaultChangelist(mockRepo);
          assert.ok(def.files.some((f) => f.path === 'debounced.txt'));
        } finally {
          svc.dispose();
        }
      } finally {
        fake.uninstall();
      }
    });

    it('a status-only flip (unstaged→staged) with no membership change fires onDidChangeChangelists', async () => {
      // A file already tracked in a changelist is `git add`-ed externally: its
      // changelist MEMBERSHIP does not change, only its index status flips
      // ' ' → 'M'. The Commit tool window's sole external-change refresh is
      // this event, so reconcile must fire it when the status overlay changes.
      let rows: IFileStatus[] = [
        { path: 'src/foo.ts', indexStatus: ' ' as const, workTreeStatus: 'M' as const },
      ];
      const gitService = {
        getStatus: async () => rows,
        onDidChangeRepository: (_l: (repo: IRepository) => void) => ({ dispose: (): void => {} }),
      } as unknown as IGitService;

      const svc = createChangelistService(gitService);
      try {
        // Settle: the file lands in Default (membership change on first pass).
        await svc.reconcileWithGitStatus(mockRepo);

        let fireCount = 0;
        const sub = svc.onDidChangeChangelists(() => {
          fireCount++;
        });

        // Same file, now staged — membership is unchanged, only the overlay flips.
        rows = [{ path: 'src/foo.ts', indexStatus: 'M' as const, workTreeStatus: ' ' as const }];
        await svc.reconcileWithGitStatus(mockRepo);

        assert.strictEqual(fireCount, 1, 'status-only flip must fire onDidChangeChangelists');
        sub.dispose();
      } finally {
        svc.dispose();
      }
    });

    it('a no-op reconcile (identical status, no membership change) does not fire onDidChangeChangelists', async () => {
      const rows: IFileStatus[] = [
        { path: 'src/foo.ts', indexStatus: 'M' as const, workTreeStatus: ' ' as const },
      ];
      const gitService = {
        getStatus: async () => rows,
        onDidChangeRepository: (_l: (repo: IRepository) => void) => ({ dispose: (): void => {} }),
      } as unknown as IGitService;

      const svc = createChangelistService(gitService);
      try {
        // Settle the file into Default with a known status overlay.
        await svc.reconcileWithGitStatus(mockRepo);

        let fireCount = 0;
        const sub = svc.onDidChangeChangelists(() => {
          fireCount++;
        });

        // Nothing changed — same membership, same status. Must stay silent.
        await svc.reconcileWithGitStatus(mockRepo);

        assert.strictEqual(fireCount, 0, 'an unchanged reconcile must not fire');
        sub.dispose();
      } finally {
        svc.dispose();
      }
    });
  });

  describe('file metadata reflects git status after reconcile', () => {
    /**
     * Build an IGitService stub whose `getStatus` returns the given
     * IFileStatus rows verbatim, so specs can drive real index/work-tree
     * codes through reconcile and assert the overlaid metadata.
     */
    function makeStatusStub(rows: IFileStatus[]): IGitService {
      return {
        getStatus: async () => rows,
        onDidChangeRepository: (_listener: (repo: IRepository) => void) => ({
          dispose: (): void => {},
        }),
      } as unknown as IGitService;
    }

    async function reconcileAndGet(rows: IFileStatus[]): Promise<IChangelist[]> {
      const svc = createChangelistService(makeStatusStub(rows));
      try {
        await svc.reconcileWithGitStatus(mockRepo);
        return svc.getChangelists(mockRepo);
      } finally {
        svc.dispose();
      }
    }

    function fileMeta(lists: IChangelist[], filePath: string) {
      for (const cl of lists) {
        const f = cl.files.find((x) => x.path === filePath);
        if (f) {
          return f;
        }
      }
      throw new Error(`file ${filePath} not found in any changelist`);
    }

    it('a file staged in the index is reported staged', async () => {
      const lists = await reconcileAndGet([
        { path: 'staged.ts', indexStatus: 'M', workTreeStatus: ' ' },
      ]);
      assert.strictEqual(fileMeta(lists, 'staged.ts').staged, true);
    });

    it('an unstaged working-tree change is reported unstaged', async () => {
      const lists = await reconcileAndGet([
        { path: 'dirty.ts', indexStatus: ' ', workTreeStatus: 'M' },
      ]);
      assert.strictEqual(fileMeta(lists, 'dirty.ts').staged, false);
    });

    it('an untracked file carries status "untracked"', async () => {
      const lists = await reconcileAndGet([
        { path: 'new.ts', indexStatus: '?', workTreeStatus: '?' },
      ]);
      const f = fileMeta(lists, 'new.ts');
      assert.strictEqual(f.status, 'untracked');
      assert.strictEqual(f.staged, false, 'an untracked file is never staged');
    });

    it('an added (staged-new) file carries status "added" and staged true', async () => {
      const lists = await reconcileAndGet([
        { path: 'added.ts', indexStatus: 'A', workTreeStatus: ' ' },
      ]);
      const f = fileMeta(lists, 'added.ts');
      assert.strictEqual(f.status, 'added');
      assert.strictEqual(f.staged, true);
    });

    it('a deleted file carries status "deleted"', async () => {
      const lists = await reconcileAndGet([
        { path: 'gone.ts', indexStatus: 'D', workTreeStatus: ' ' },
      ]);
      assert.strictEqual(fileMeta(lists, 'gone.ts').status, 'deleted');
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

/**
 * Meta-test for the `makeThrowingGitServiceStub` helper.
 *
 * The stub exists as defense-in-depth against the B1-class bug (silent
 * no-op stubs hiding accidental gitService calls). These tests verify
 * the stub actually throws on property access — if it silently returned
 * `undefined` like a plain `{}`, it would reintroduce the exact trap it
 * was built to prevent. This block also keeps the helper referenced so
 * `noUnusedLocals` doesn't flag it while no existing spec needs it.
 */
describe('makeThrowingGitServiceStub (defense-in-depth helper)', () => {
  it('throws with member name when any method is accessed', () => {
    const stub = makeThrowingGitServiceStub();
    assert.throws(
      () => stub.getStatus,
      /unexpected call to IGitService\.getStatus/,
      'property read must throw and identify the member'
    );
  });

  it('throws for onDidChangeRepository access (constructor path)', () => {
    const stub = makeThrowingGitServiceStub();
    assert.throws(
      () => stub.onDidChangeRepository,
      /unexpected call to IGitService\.onDidChangeRepository/
    );
  });
});
