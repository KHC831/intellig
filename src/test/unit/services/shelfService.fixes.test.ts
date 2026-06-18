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
import { ShelfService } from '../../../shelf/ShelfService';
import { IRepository } from '../../../git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
import { IGitCommandResult } from '../../../git-core/gitCli';

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
      if (args[0] === 'diff' && args[1] === '--') {
        const filePath = args[2];
        const file = files.find((f) => f.path === filePath);
        return {
          exitCode: 0,
          stdout: file ? file.diff : '',
          stderr: '',
          combined: '',
        };
      }
      // Reverse-apply during shelve → succeed silently so the service moves on.
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    };
    const item = await svc.shelve(repo, name, { files: files.map((f) => f.path) });
    return item.id;
  }

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
        if (args[0] === 'diff' && args[1] === '--') {
          const p = args[2];
          const f = files.find((x) => x.path === p);
          return { exitCode: 0, stdout: f ? f.diff : '', stderr: '', combined: '' };
        }
        // apply/apply -R/checkout → succeed.
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
});
