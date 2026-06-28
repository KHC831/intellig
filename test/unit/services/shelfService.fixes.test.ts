/**
 * unit tests for ShelfService additions.
 *
 * Covers:
 * - renameShelf persists + fires onDidChangeShelf.
 * - importPatch writes an entry with the patch body as the sole file diff.
 * - markAsUnshelved / restoreShelf set and clear the `unshelvedAt` field.
 * - filterShelfFiles prunes per-path and deletes the entry when empty.
 * - unshelve + `removeAppliedFiles: true` + all-clean → entry deleted.
 * - unshelve + `removeAppliedFiles: true` + partial conflict → entry shrinks.
 * - unshelve + `removeAppliedFiles: false` (default) + all-clean + keep-copy →
 *   entry stays and is marked unshelved.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ShelfService } from '../../../src/shelf/ShelfService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
import { IGitCommandResult } from '../../../src/git-core/gitCli';

/**
 * Minimal mock GitCli capturing args and returning scripted results per test.
 */
interface ExecRecord {
  args: string[];
  input?: string;
}
class MockGitCli {
  public exec_: ExecRecord[] = [];
  public nextResult: (args: string[], input?: string) => IGitCommandResult = () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    combined: '',
  });
  async exec(
    args: string[],
    options: { cwd?: string; input?: string } = {}
  ): Promise<IGitCommandResult> {
    this.exec_.push({ args: [...args], input: options.input });
    return this.nextResult(args, options.input);
  }
  async getRepositoryRoot(p: string): Promise<string | undefined> {
    return p;
  }
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  get onCommandExecuted() {
    return () => ({ dispose: () => {} });
  }
  dispose(): void {}
}

describe('ShelfService — additions', () => {
  let svc: ShelfService;
  let repo: IRepository;
  let repoRoot: string;
  let mockCli: MockGitCli;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-fixes-'));
    // ShelfService stores JSON under `<repoRoot>/.git/`; create the dir.
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    mockCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    svc = new ShelfService(mockCli as any);
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
      fs.rmSync(repoRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /**
   * Seed a single shelf entry directly via the diff scripting path. `git diff`
   * is intercepted so the service writes what we hand it.
   */
  async function seedEntry(
    files: Array<{ path: string; diff: string }>,
    name = 'seed'
  ): Promise<string> {
    mockCli.nextResult = (args): IGitCommandResult => {
      // Full-file shelve captures vs HEAD (`diff HEAD -- <file>`); partial-hunk
      // shelve still uses `diff -- <file>`. Match both shapes and resolve the
      // file from the trailing path arg.
      const isFullFileDiff = args[0] === 'diff' && args[1] === 'HEAD' && args[2] === '--';
      const isUnstagedDiff = args[0] === 'diff' && args[1] === '--';
      if (isFullFileDiff || isUnstagedDiff) {
        const filePath = args[args.length - 1];
        const file = files.find((f) => f.path === filePath);
        return {
          exitCode: 0,
          stdout: file ? file.diff : '',
          stderr: '',
          combined: '',
        };
      }
      // Revert during shelve (checkout HEAD / rm / apply -R) → succeed silently
      // so the service moves on.
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    };
    const item = await svc.shelve(repo, name, { files: files.map((f) => f.path) });
    return item.id;
  }

  describe('storage location — linked worktree (.git is a FILE)', () => {
    it('persists in the resolved worktree git dir and round-trips without throwing', async () => {
      // Linked-worktree shape: `<root>/.git` is a FILE pointing at the real
      // per-worktree gitdir. Hardcoding `<root>/.git/<file>` would write inside
      // a FILE and THROW (ENOTDIR); the resolver must follow the pointer.
      const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-wt-'));
      const worktreeGitDir = path.join(wtRoot, 'gitdir-real');
      fs.mkdirSync(worktreeGitDir, { recursive: true });
      fs.writeFileSync(path.join(wtRoot, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');
      const wtRepo = {
        rootUri: Uri.file(wtRoot),
        state: 'idle',
        remotes: [],
        submodules: [],
      } as unknown as IRepository;

      try {
        const patch = 'diff --git a/wt.ts b/wt.ts\n';
        let item!: Awaited<ReturnType<ShelfService['importPatch']>>;
        await assert.doesNotReject(async () => {
          item = await svc.importPatch(wtRepo, { patchContent: patch, name: 'wt-entry' });
        }, 'shelving in a linked worktree must not throw');

        const storagePath = path.join(worktreeGitDir, 'intellig-shelf.json');
        assert.ok(
          fs.existsSync(storagePath),
          'shelf storage should land in the resolved worktree git dir'
        );

        const reloaded = svc.getShelfItems(wtRepo).find((i) => i.id === item.id);
        assert.ok(reloaded, 'shelf entry should round-trip back from the worktree git dir');
      } finally {
        fs.rmSync(wtRoot, { recursive: true, force: true });
      }
    });
  });

  describe('shelve — name validation (S1)', () => {
    it('rejects an empty / whitespace-only shelf name', async () => {
      await assert.rejects(
        () => svc.shelve(repo, '   ', { files: ['a.ts'] }),
        /Shelf name cannot be empty/,
        'a whitespace-only name must be rejected like renameShelf does'
      );
    });

    it('trims surrounding whitespace from the stored shelf name (matches renameShelf)', async () => {
      mockCli.nextResult = (args): IGitCommandResult => {
        if (args[0] === 'diff') {
          return {
            exitCode: 0,
            stdout: 'diff --git a/a.ts b/a.ts\n',
            stderr: '',
            combined: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '', combined: '' };
      };

      const item = await svc.shelve(repo, '  padded name  ', { files: ['a.ts'] });
      assert.strictEqual(item.name, 'padded name', 'returned item carries the trimmed name');

      const reloaded = svc.getShelfItems(repo).find((i) => i.id === item.id);
      assert.strictEqual(reloaded?.name, 'padded name', 'trimmed name round-trips from disk');
    });
  });

  describe('renameShelf', () => {
    it('renames a shelf entry and fires onDidChangeShelf', async () => {
      const id = await seedEntry([{ path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' }]);

      let fired = 0;
      svc.onDidChangeShelf(() => fired++);

      svc.renameShelf(repo, id, 'renamed');

      const items = svc.getShelfItems(repo);
      assert.strictEqual(items[0].name, 'renamed');
      assert.ok(fired > 0, 'expected onDidChangeShelf to fire');
    });

    it('throws when the entry does not exist', () => {
      assert.throws(() => svc.renameShelf(repo, 'no-such-id', 'x'));
    });

    it('throws on empty name', async () => {
      const id = await seedEntry([{ path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' }]);
      assert.throws(() => svc.renameShelf(repo, id, '   '));
    });
  });

  describe('importPatch', () => {
    it('creates a shelf entry from patchContent', async () => {
      const patch = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
      const item = await svc.importPatch(repo, { patchContent: patch, name: 'imported' });
      assert.strictEqual(item.name, 'imported');
      assert.strictEqual(item.files.length, 1);
      assert.strictEqual(item.files[0].diff, patch);
      // Persisted and re-loaded.
      const items = svc.getShelfItems(repo);
      assert.ok(items.find((i) => i.id === item.id));
    });

    it('creates a shelf entry from patchPath, using basename as default name', async () => {
      const patch = 'diff --git a/y.ts b/y.ts\n';
      const patchPath = path.join(repoRoot, 'my-changes.patch');
      fs.writeFileSync(patchPath, patch, 'utf-8');
      const item = await svc.importPatch(repo, { patchPath });
      assert.strictEqual(item.name, 'my-changes.patch');
      assert.strictEqual(item.files[0].diff, patch);
    });

    it('rejects when neither patchPath nor patchContent is supplied', async () => {
      await assert.rejects(() => svc.importPatch(repo, {}));
    });

    it('rejects when both patchPath and patchContent are supplied', async () => {
      await assert.rejects(() =>
        svc.importPatch(repo, { patchPath: '/tmp/x.patch', patchContent: 'diff' })
      );
    });

    it('rejects empty patch content', async () => {
      await assert.rejects(() => svc.importPatch(repo, { patchContent: '   \n' }));
    });

    it('splits a multi-file patch into one shelf file per changed file', async () => {
      const fileX = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
      const fileY =
        'diff --git a/dir/y.ts b/dir/y.ts\n--- a/dir/y.ts\n+++ b/dir/y.ts\n@@ -1 +1 @@\n-a\n+b\n';
      const item = await svc.importPatch(repo, { patchContent: fileX + fileY, name: 'multi' });

      assert.strictEqual(item.files.length, 2);
      assert.deepStrictEqual(
        item.files.map((f) => f.path),
        ['x.ts', 'dir/y.ts']
      );
      assert.strictEqual(item.files[0].diff, fileX);
      assert.strictEqual(item.files[1].diff, fileY);

      // Persisted split survives a reload.
      const reloaded = svc.getShelfItems(repo).find((i) => i.id === item.id);
      assert.strictEqual(reloaded?.files.length, 2);
    });

    it('falls back to a single synthetic entry for a patch with no git headers', async () => {
      const plain = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
      const item = await svc.importPatch(repo, { patchContent: plain });
      assert.strictEqual(item.files.length, 1);
      assert.strictEqual(item.files[0].path, 'imported-patch');
      assert.strictEqual(item.files[0].diff, plain);
    });
  });

  describe('markAsUnshelved / restoreShelf', () => {
    it('markAsUnshelved sets unshelvedAt and restoreShelf clears it', async () => {
      const id = await seedEntry([{ path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' }]);
      svc.markAsUnshelved(repo, id);
      let items = svc.getShelfItems(repo);
      assert.ok(items[0].unshelvedAt instanceof Date);

      svc.restoreShelf(repo, id);
      items = svc.getShelfItems(repo);
      assert.strictEqual(items[0].unshelvedAt, undefined);
    });

    it('markAsUnshelved is idempotent', async () => {
      const id = await seedEntry([{ path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' }]);
      svc.markAsUnshelved(repo, id);
      const first = svc.getShelfItems(repo)[0].unshelvedAt;
      svc.markAsUnshelved(repo, id);
      const second = svc.getShelfItems(repo)[0].unshelvedAt;
      assert.strictEqual(
        first?.getTime(),
        second?.getTime(),
        'unshelvedAt must not change on re-call'
      );
    });
  });

  describe('recycle bin (deleted-shelf restore)', () => {
    it('deleteShelfItem recycles instead of permanently removing', async () => {
      const id = await seedEntry([{ path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' }]);

      svc.deleteShelfItem(repo, id);

      // Gone from the active list…
      assert.strictEqual(svc.getShelfItems(repo).length, 0, 'active list must exclude recycled');
      // …but parked in the recycle bin with a deletedAt marker and files intact.
      const recycled = svc.getRecycledShelfItems(repo);
      assert.strictEqual(recycled.length, 1, 'recycle bin should hold the deleted entry');
      assert.strictEqual(recycled[0].id, id);
      assert.ok(recycled[0].deletedAt instanceof Date, 'deletedAt must be set');
      assert.strictEqual(recycled[0].files.length, 1, 'shelved files must survive deletion');
    });

    it('restoreFromRecycleBin moves a deleted entry back to the active list', async () => {
      const id = await seedEntry([{ path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' }]);
      svc.deleteShelfItem(repo, id);

      svc.restoreFromRecycleBin(repo, id);

      const active = svc.getShelfItems(repo);
      assert.strictEqual(active.length, 1, 'restored entry returns to active list');
      assert.strictEqual(active[0].id, id);
      assert.strictEqual(active[0].deletedAt, undefined, 'deletedAt must be cleared');
      assert.strictEqual(svc.getRecycledShelfItems(repo).length, 0, 'recycle bin emptied');
    });

    it('deleteShelfItemPermanently truly removes a recycled entry', async () => {
      const id = await seedEntry([{ path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' }]);
      svc.deleteShelfItem(repo, id);

      svc.deleteShelfItemPermanently(repo, id);

      assert.strictEqual(svc.getShelfItems(repo).length, 0);
      assert.strictEqual(svc.getRecycledShelfItems(repo).length, 0, 'entry is gone for good');
    });

    it('deleteShelfItemPermanently throws for a non-existent entry', () => {
      assert.throws(
        () => svc.deleteShelfItemPermanently(repo, 'no-such-id'),
        /Shelf item not found/
      );
    });

    it('restoreFromRecycleBin throws for a non-existent entry', () => {
      assert.throws(() => svc.restoreFromRecycleBin(repo, 'no-such-id'), /Shelf item not found/);
    });

    it('the deletedAt marker survives a load/save round trip', async () => {
      const id = await seedEntry([{ path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' }]);
      svc.deleteShelfItem(repo, id);

      // Fresh service instance reads from disk with a cold cache.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      const reloaded = new ShelfService(mockCli as any);
      try {
        const recycled = reloaded.getRecycledShelfItems(repo);
        assert.strictEqual(recycled.length, 1);
        assert.ok(recycled[0].deletedAt instanceof Date, 'deletedAt persisted');
        assert.strictEqual(reloaded.getShelfItems(repo).length, 0);
      } finally {
        reloaded.dispose();
      }
    });

    it('deleteShelfItem fires onDidChangeShelf', async () => {
      const id = await seedEntry([{ path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' }]);
      let fired = 0;
      svc.onDidChangeShelf(() => fired++);
      svc.deleteShelfItem(repo, id);
      assert.ok(fired > 0, 'expected onDidChangeShelf to fire on recycle');
    });
  });

  describe('filterShelfFiles', () => {
    it('prunes to remaining paths and returns updated entry', async () => {
      const id = await seedEntry([
        { path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' },
        { path: 'b.ts', diff: 'diff --git a/b.ts b/b.ts\n' },
        { path: 'c.ts', diff: 'diff --git a/c.ts b/c.ts\n' },
      ]);
      const updated = svc.filterShelfFiles(repo, id, ['b.ts']);
      assert.ok(updated);
      assert.strictEqual(updated.files.length, 1);
      assert.strictEqual(updated.files[0].path, 'b.ts');
    });

    it('deletes the entry when every path is filtered out', async () => {
      const id = await seedEntry([{ path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' }]);
      const updated = svc.filterShelfFiles(repo, id, []);
      assert.strictEqual(updated, undefined);
      assert.strictEqual(svc.getShelfItems(repo).length, 0);
    });

    it('is a no-op when the entry does not exist', () => {
      const updated = svc.filterShelfFiles(repo, 'no-such-id', ['foo']);
      assert.strictEqual(updated, undefined);
    });
  });

  describe('unshelve + removeAppliedFiles', () => {
    /**
     * Script the mock so every `git apply` succeeds on the first try, and the
     * shelve-time `diff` returns non-empty stdout per file.
     */
    function scriptAllApplyCleanly(files: Array<{ path: string; diff: string }>): void {
      mockCli.nextResult = (args): IGitCommandResult => {
        // Full-file shelve captures vs HEAD (`diff HEAD -- <file>`); match that
        // and the legacy `diff -- <file>` shape, resolving the trailing path.
        const isDiff =
          args[0] === 'diff' && ((args[1] === 'HEAD' && args[2] === '--') || args[1] === '--');
        if (isDiff) {
          const p = args[args.length - 1];
          const f = files.find((x) => x.path === p);
          return { exitCode: 0, stdout: f ? f.diff : '', stderr: '', combined: '' };
        }
        // apply/apply -R/checkout/rm → succeed.
        return { exitCode: 0, stdout: '', stderr: '', combined: '' };
      };
    }

    it('removeAppliedFiles=true + all-clean → entry deleted', async () => {
      const files = [
        { path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' },
        { path: 'b.ts', diff: 'diff --git a/b.ts b/b.ts\n' },
      ];
      scriptAllApplyCleanly(files);
      const item = await svc.shelve(repo, 'test', { files: files.map((f) => f.path) });

      const result = await svc.unshelve(repo, item.id, {
        removeFromShelf: false,
        removeAppliedFiles: true,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(svc.getShelfItems(repo).length, 0, 'entry should be deleted');
    });

    it('removeAppliedFiles=true + one conflict → entry shrinks to the conflict file', async () => {
      const files = [
        { path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' },
        { path: 'b.ts', diff: 'diff --git a/b.ts b/b.ts\n' },
      ];
      // First shelve everything; use scriptAllApplyCleanly for the shelve.
      scriptAllApplyCleanly(files);
      const item = await svc.shelve(repo, 'test', { files: files.map((f) => f.path) });

      // Now script: `apply` succeeds for `a.ts`, CONFLICTS for `b.ts`.
      mockCli.nextResult = (args, input): IGitCommandResult => {
        if (args[0] === 'apply' && input && input.includes('b.ts')) {
          return { exitCode: 1, stdout: '', stderr: 'CONFLICT (content): b.ts', combined: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '', combined: '' };
      };

      const result = await svc.unshelve(repo, item.id, {
        removeFromShelf: false,
        removeAppliedFiles: true,
      });
      assert.strictEqual(result.success, false);
      assert.deepStrictEqual(result.conflicts, ['b.ts']);

      const items = svc.getShelfItems(repo);
      assert.strictEqual(items.length, 1, 'entry should still exist');
      assert.strictEqual(items[0].files.length, 1);
      assert.strictEqual(items[0].files[0].path, 'b.ts');
    });

    it('removeAppliedFiles=false + keep-copy + all-clean → entry marked Already-Unshelved', async () => {
      const files = [{ path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' }];
      scriptAllApplyCleanly(files);
      const item = await svc.shelve(repo, 'test', { files: files.map((f) => f.path) });

      const result = await svc.unshelve(repo, item.id, {
        removeFromShelf: false, // keep a copy
      });
      assert.strictEqual(result.success, true);

      const items = svc.getShelfItems(repo);
      assert.strictEqual(items.length, 1, 'entry should still exist');
      assert.ok(items[0].unshelvedAt instanceof Date, 'should be marked Already-Unshelved');
    });

    it('removeAppliedFiles=false + default (removeFromShelf=true) + all-clean → entry deleted (legacy)', async () => {
      const files = [{ path: 'a.ts', diff: 'diff --git a/a.ts b/a.ts\n' }];
      scriptAllApplyCleanly(files);
      const item = await svc.shelve(repo, 'test', { files: files.map((f) => f.path) });

      const result = await svc.unshelve(repo, item.id);
      assert.strictEqual(result.success, true);
      assert.strictEqual(svc.getShelfItems(repo).length, 0);
    });
  });

  // ─── Finding #8: partial shelve — removal failures must surface ───────────
  //
  // Regression: revertShelvedChanges swallowed checkout/rm failures at debug
  // level and shelve() always reported full SUCCESS, leaving the change BOTH
  // saved on the shelf AND still in the working tree. The fix surfaces a
  // warning and sets partialCleanupFailures on the returned IShelfItem.

  describe('shelve — partial cleanup failure (finding #8)', () => {
    /**
     * Script the mock CLI so that:
     *   - `diff HEAD -- <file>` returns a real diff (the shelf save succeeds)
     *   - `cat-file -e HEAD:<file>` returns 0 (file IS tracked by HEAD, so rm
     *     won't be called — checkout is the only removal path)
     *   - `checkout HEAD -- <file>` returns exit 1 (removal fails)
     *
     * This leaves the file saved on the shelf but NOT cleared from the working
     * tree, so the service must signal partial success.
     */
    function scriptRemovalFailure(filePath: string): void {
      const diff = `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1 +1 @@\n-old\n+new\n`;
      mockCli.nextResult = (args): IGitCommandResult => {
        // Capture the diff for the file.
        if (args[0] === 'diff' && args.includes(filePath)) {
          return { exitCode: 0, stdout: diff, stderr: '', combined: '' };
        }
        // cat-file: file IS in HEAD (so checkout path is taken, not rm).
        if (args[0] === 'cat-file') {
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        }
        // checkout HEAD -- <file>: simulate failure (lock contention etc.).
        if (args[0] === 'checkout') {
          return { exitCode: 1, stdout: '', stderr: 'error: path is locked', combined: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '', combined: '' };
      };
    }

    it('returns partialCleanupFailures listing the files that could not be cleared', async () => {
      scriptRemovalFailure('stuck.ts');

      const item = await svc.shelve(repo, 'partial', { files: ['stuck.ts'] });

      // The shelf entry must be saved (normal shelve result).
      assert.ok(item.id, 'shelf entry must still be created');
      assert.strictEqual(item.files.length, 1);

      // And it must signal that the working tree was NOT cleared.
      assert.ok(
        Array.isArray(item.partialCleanupFailures) && item.partialCleanupFailures.length > 0,
        'partialCleanupFailures must list the file(s) that could not be removed'
      );
      assert.ok(
        item.partialCleanupFailures.includes('stuck.ts'),
        `partialCleanupFailures must include 'stuck.ts'; got: ${JSON.stringify(item.partialCleanupFailures)}`
      );
    });

    it('emits a warn-level log when at least one file could not be cleared', async () => {
      const warnMessages: string[] = [];
      (svc as unknown as { _logger: unknown })._logger = {
        debug: (): void => {},
        info: (): void => {},
        warn: (msg: string): void => {
          warnMessages.push(msg);
        },
        error: (): void => {},
        trace: (): void => {},
        child(): unknown {
          return this;
        },
      };

      scriptRemovalFailure('stuck.ts');
      await svc.shelve(repo, 'partial-warn', { files: ['stuck.ts'] });

      assert.ok(warnMessages.length > 0, 'a warn-level log must be emitted when removal fails');
      assert.ok(
        warnMessages.some((m) => /partial|working.tree|not.clear/i.test(m)),
        `warn message must mention partial / working tree; got: ${JSON.stringify(warnMessages)}`
      );
    });

    it('does NOT set partialCleanupFailures when all removals succeed', async () => {
      // Normal shelve path: checkout succeeds (exit 0).
      const diff =
        'diff --git a/clean.ts b/clean.ts\n--- a/clean.ts\n+++ b/clean.ts\n@@ -1 +1 @@\n-old\n+new\n';
      mockCli.nextResult = (args): IGitCommandResult => {
        if (args[0] === 'diff' && args.includes('clean.ts')) {
          return { exitCode: 0, stdout: diff, stderr: '', combined: '' };
        }
        // All other commands (checkout, etc.) succeed.
        return { exitCode: 0, stdout: '', stderr: '', combined: '' };
      };

      const item = await svc.shelve(repo, 'clean', { files: ['clean.ts'] });

      assert.ok(
        !item.partialCleanupFailures || item.partialCleanupFailures.length === 0,
        'partialCleanupFailures must be absent or empty on a clean shelve'
      );
    });
  });
});
