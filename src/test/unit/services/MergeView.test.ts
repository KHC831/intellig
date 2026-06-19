import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MergeView } from '../../../conflicts/MergeView';
import { IGitService, IRepository, IFileStatus } from '../../../git-core/interfaces/IGitService';

import {
  installErrorMessageTracker,
  restoreMessageFunctions,
  writableCommands,
} from '../../typed/windowStub';

/**
 * TestSurface for the private state MergeView exposes to
 * `markResolved()`. Matches docs/testing.md section 3 — declared at the top of
 * the test file, single-purpose, no `I`-prefix.
 */
interface MergeViewInternals {
  _repository: IRepository | undefined;
  _lastFile: string | undefined;
}

/**
 * Unit tests for MergeView
 */
describe('MergeView', () => {
  let mergeView: MergeView;
  let mockGitService: Partial<IGitService>;
  let mockExtensionUri: vscode.Uri;

  beforeEach(() => {
    // Create mock extension URI
    mockExtensionUri = vscode.Uri.file('/mock/extension/path');

    // Create minimal mock Git service
    mockGitService = {
      getRepository: (): Promise<undefined> => Promise.resolve(undefined),
      getRepositories: (): IRepository[] => [],
      stage: (): Promise<void> => Promise.resolve(),
      getStatus: (): Promise<IFileStatus[]> => Promise.resolve([]),
    };

    mergeView = new MergeView(mockExtensionUri, mockGitService as IGitService);
  });

  afterEach(() => {
    mergeView.dispose();
  });

  describe('constructor', () => {
    it('should create a new instance', () => {
      assert.ok(mergeView);
    });

    it('should have onDidResolve event', () => {
      assert.ok(mergeView.onDidResolve);
      assert.strictEqual(typeof mergeView.onDidResolve, 'function');
    });
  });

  describe('getMergeState()', () => {
    it('should return undefined when no merge is active', () => {
      assert.strictEqual(mergeView.getMergeState(), undefined);
    });
  });

  describe('allConflictsResolved()', () => {
    it('should return false when no merge is active', () => {
      assert.strictEqual(mergeView.allConflictsResolved(), false);
    });
  });

  describe('hide()', () => {
    it('should not throw when no panel is open', () => {
      assert.doesNotThrow(() => mergeView.hide());
    });
  });

  describe('acceptCurrent()', () => {
    it('should not throw when no merge is active', () => {
      assert.doesNotThrow(() => mergeView.acceptCurrent());
    });

    it('should accept conflict ID parameter', () => {
      assert.doesNotThrow(() => mergeView.acceptCurrent(0));
    });
  });

  describe('acceptIncoming()', () => {
    it('should not throw when no merge is active', () => {
      assert.doesNotThrow(() => mergeView.acceptIncoming());
    });

    it('should accept conflict ID parameter', () => {
      assert.doesNotThrow(() => mergeView.acceptIncoming(0));
    });
  });

  describe('acceptBoth()', () => {
    it('should not throw when no merge is active', () => {
      assert.doesNotThrow(() => mergeView.acceptBoth());
    });

    it('should accept conflict ID parameter', () => {
      assert.doesNotThrow(() => mergeView.acceptBoth(0));
    });
  });

  describe('acceptAllCurrent()', () => {
    it('should not throw when no merge is active', () => {
      assert.doesNotThrow(() => mergeView.acceptAllCurrent());
    });
  });

  describe('acceptAllIncoming()', () => {
    it('should not throw when no merge is active', () => {
      assert.doesNotThrow(() => mergeView.acceptAllIncoming());
    });
  });

  describe('nextConflict()', () => {
    it('should not throw when no merge is active', () => {
      assert.doesNotThrow(() => mergeView.nextConflict());
    });
  });

  describe('previousConflict()', () => {
    it('should not throw when no merge is active', () => {
      assert.doesNotThrow(() => mergeView.previousConflict());
    });
  });

  describe('markResolved()', () => {
    it('should not throw when no merge is active', async () => {
      await mergeView.markResolved();
      // Should complete without error
      assert.ok(true);
    });

    // markResolved now only stages the file — the native merge editor is
    // responsible for writing the resolved content to the working tree.
    // The error path: if `git stage` throws, we show a toast and do NOT
    // fire onDidResolve, so downstream consumers (e.g. ResolveConflictsDialog)
    // continue treating the file as unresolved and the user can retry.
    it('surfaces error via showErrorMessage when staging fails; onDidResolve not fired', async () => {
      const tracker = installErrorMessageTracker();
      const stageError = new Error('EACCES: permission denied, /repo/.git/index.lock');

      (mockGitService as unknown as { stage: IGitService['stage'] }).stage = (): Promise<void> => {
        return Promise.reject(stageError);
      };

      // Track onDidResolve emissions — must NOT fire on the error path.
      const resolveEvents: string[] = [];
      const resolveSub = mergeView.onDidResolve((file) => {
        resolveEvents.push(file);
      });

      try {
        // Prime the adapter's internal state as if show() had been called.
        const internals = mergeView as unknown as MergeViewInternals;
        internals._repository = {
          rootUri: vscode.Uri.file('/mock/repo'),
          state: 'merging',
          head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
          remotes: [],
          submodules: [],
        };
        internals._lastFile = 'README.md';

        // Must NOT throw — error handling is internalised.
        await mergeView.markResolved();

        // Error toast surfaced with the user-facing prefix.
        assert.strictEqual(
          tracker.calls.length,
          1,
          `expected exactly one showErrorMessage call, got ${tracker.calls.length}`
        );
        assert.ok(
          tracker.calls[0].message.startsWith('Failed to mark resolved:'),
          `expected user-facing prefix, got: "${tracker.calls[0].message}"`
        );

        // onDidResolve must NOT fire when staging failed.
        assert.strictEqual(
          resolveEvents.length,
          0,
          'onDidResolve must not fire on the staging-error path'
        );
      } finally {
        resolveSub.dispose();
        restoreMessageFunctions();
      }
    });

    it('stages the file and fires onDidResolve when staging succeeds', async () => {
      const stagedPaths: string[] = [];
      (mockGitService as unknown as { stage: IGitService['stage'] }).stage = (
        _repo: IRepository,
        paths: string[]
      ): Promise<void> => {
        stagedPaths.push(...paths);
        return Promise.resolve();
      };

      const resolveEvents: string[] = [];
      const resolveSub = mergeView.onDidResolve((file) => {
        resolveEvents.push(file);
      });

      try {
        // Prime the adapter state as if show() had been called.
        const internals = mergeView as unknown as MergeViewInternals;
        internals._repository = {
          rootUri: vscode.Uri.file('/mock/repo'),
          state: 'merging',
          head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
          remotes: [],
          submodules: [],
        };
        internals._lastFile = 'src/conflict.ts';

        await mergeView.markResolved();

        assert.deepStrictEqual(
          stagedPaths,
          ['src/conflict.ts'],
          'stage must be called with the file path'
        );
        assert.deepStrictEqual(
          resolveEvents,
          ['src/conflict.ts'],
          'onDidResolve must fire with the file path on success'
        );
      } finally {
        resolveSub.dispose();
      }
    });
  });

  describe('dispose()', () => {
    it('should dispose without error', () => {
      assert.doesNotThrow(() => mergeView.dispose());
    });

    it('should be safe to call multiple times', () => {
      mergeView.dispose();
      assert.doesNotThrow(() => mergeView.dispose());
    });
  });

  describe('Conflict Resolution Actions', () => {
    it('should support Accept Current action', () => {
      assert.strictEqual(typeof mergeView.acceptCurrent, 'function');
    });

    it('should support Accept Incoming action', () => {
      assert.strictEqual(typeof mergeView.acceptIncoming, 'function');
    });

    it('should support Accept Both action', () => {
      assert.strictEqual(typeof mergeView.acceptBoth, 'function');
    });
  });

  describe('Accept All Actions', () => {
    it('should support Accept All Current action', () => {
      assert.strictEqual(typeof mergeView.acceptAllCurrent, 'function');
    });

    it('should support Accept All Incoming action', () => {
      assert.strictEqual(typeof mergeView.acceptAllIncoming, 'function');
    });
  });

  describe('Keyboard Navigation', () => {
    it('should support navigating to next conflict', () => {
      assert.strictEqual(typeof mergeView.nextConflict, 'function');
    });

    it('should support navigating to previous conflict', () => {
      assert.strictEqual(typeof mergeView.previousConflict, 'function');
    });
  });

  describe('Mark Resolved', () => {
    it('should support marking file as resolved', () => {
      assert.strictEqual(typeof mergeView.markResolved, 'function');
    });
  });

  describe('Three-Way Merge Display', () => {
    it('should have show method for displaying merge view', () => {
      assert.strictEqual(typeof mergeView.show, 'function');
    });

    it('should have hide method for closing merge view', () => {
      assert.strictEqual(typeof mergeView.hide, 'function');
    });
  });

  describe('show() repository resolution (Bug D)', () => {
    // Regression: the Resolve Conflicts dialog and the conflicted-file picker
    // pass repo-RELATIVE paths (from `git status --porcelain`). The old
    // `show()` ran `vscode.Uri.file(file)` on that relative path, anchoring it
    // at the filesystem root (`/src/foo.ts`) so `getRepository` found no repo
    // and threw "No repository found for file" — surfacing as the "Failed to
    // open merge view" error when clicking "Merge…". `show()` must resolve the
    // relative path against the discovered repository roots.
    it('resolves a repo-relative path against discovered repository roots', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-mergeview-relpath-'));
      try {
        const relPath = 'src/foo.ts';
        const absPath = path.join(tmpDir, relPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n', 'utf8');

        const repo: IRepository = {
          rootUri: vscode.Uri.file(tmpDir),
          state: 'idle',
          head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
          remotes: [],
          submodules: [],
        };

        // The bogus root-anchored path misses (returns undefined); the
        // absolute path under the repo root resolves.
        const resolved = path.resolve(tmpDir, relPath);
        mockGitService.getRepository = (uri: vscode.Uri): Promise<IRepository | undefined> =>
          Promise.resolve(uri.fsPath === resolved ? repo : undefined);
        mockGitService.getRepositories = (): IRepository[] => [repo];

        await mergeView.show(relPath);

        // The repo must be resolved and bound internally so markResolved()
        // can stage against the correct repo after the user finishes in the
        // native editor.
        const internals = mergeView as unknown as MergeViewInternals;
        assert.strictEqual(
          internals._repository?.rootUri.fsPath,
          tmpDir,
          'show() should bind the repo found via the relative-path fallback'
        );
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });

    it('throws a debuggable error naming the path and searched roots when nothing resolves', async () => {
      const repoA: IRepository = {
        rootUri: vscode.Uri.file('/repo-a'),
        state: 'idle',
        head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
        remotes: [],
        submodules: [],
      };
      mockGitService.getRepository = (): Promise<undefined> => Promise.resolve(undefined);
      mockGitService.getRepositories = (): IRepository[] => [repoA];

      await assert.rejects(
        () => mergeView.show('src/does-not-exist.ts'),
        (err: Error) => {
          assert.ok(
            err.message.includes('src/does-not-exist.ts'),
            'error should name the attempted path'
          );
          assert.ok(
            err.message.includes('/repo-a'),
            'error should list the repository roots searched'
          );
          return true;
        }
      );
    });
  });

  describe('show() — native merge editor delegation', () => {
    // Regression spec: show() must route to `git.openMergeEditor` with the
    // conflicted file's absolute URI rather than opening a custom webview.
    // This is the core contract of the Workstream-B slice: IntelliJ-style
    // 3-way view is replaced by VS Code's built-in merge editor.

    let commandLog: Array<{ command: string; args: unknown[] }>;
    let originalExecuteCommand: WritableCommands['executeCommand'];

    // Alias so TypeScript knows the shape we need.
    type WritableCommands = {
      executeCommand: (command: string, ...rest: unknown[]) => Promise<unknown>;
    };

    beforeEach(() => {
      commandLog = [];
      originalExecuteCommand = writableCommands().executeCommand;
      writableCommands().executeCommand = (
        command: string,
        ...rest: unknown[]
      ): Promise<unknown> => {
        commandLog.push({ command, args: rest });
        return Promise.resolve(undefined);
      };
    });

    afterEach(() => {
      writableCommands().executeCommand = originalExecuteCommand;
    });

    it('invokes git.openMergeEditor with the absolute file URI for an absolute path', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-native-merge-'));
      try {
        const absPath = path.join(tmpDir, 'README.md');
        fs.writeFileSync(absPath, '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\n', 'utf8');

        const repo: IRepository = {
          rootUri: vscode.Uri.file(tmpDir),
          state: 'merging',
          head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
          remotes: [],
          submodules: [],
        };
        mockGitService.getRepository = (): Promise<IRepository> => Promise.resolve(repo);
        mockGitService.getRepositories = (): IRepository[] => [repo];

        await mergeView.show(absPath);

        const mergeEditorCalls = commandLog.filter((c) => c.command === 'git.openMergeEditor');
        assert.strictEqual(
          mergeEditorCalls.length,
          1,
          'show() must invoke git.openMergeEditor exactly once'
        );
        const arg = mergeEditorCalls[0].args[0] as vscode.Uri;
        assert.ok(arg instanceof vscode.Uri, 'argument must be a vscode.Uri');
        assert.strictEqual(arg.fsPath, absPath, 'URI must point to the conflicted file');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('resolves a repo-relative path to absolute before passing to git.openMergeEditor', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-native-merge-rel-'));
      try {
        const relPath = 'src/conflict.ts';
        const absPath = path.join(tmpDir, relPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\n', 'utf8');

        const repo: IRepository = {
          rootUri: vscode.Uri.file(tmpDir),
          state: 'merging',
          head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
          remotes: [],
          submodules: [],
        };
        // First call (verbatim path) misses; second call (absolute) resolves.
        const resolved = path.resolve(tmpDir, relPath);
        mockGitService.getRepository = (uri: vscode.Uri): Promise<IRepository | undefined> =>
          Promise.resolve(uri.fsPath === resolved ? repo : undefined);
        mockGitService.getRepositories = (): IRepository[] => [repo];

        await mergeView.show(relPath);

        const mergeEditorCalls = commandLog.filter((c) => c.command === 'git.openMergeEditor');
        assert.strictEqual(mergeEditorCalls.length, 1, 'git.openMergeEditor must be called once');
        const arg = mergeEditorCalls[0].args[0] as vscode.Uri;
        assert.strictEqual(
          arg.fsPath,
          absPath,
          'relative path must be resolved to absolute before being passed to the native editor'
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('does NOT open a custom webview panel when delegating to the native editor', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-native-merge-nowv-'));
      try {
        const absPath = path.join(tmpDir, 'file.ts');
        fs.writeFileSync(absPath, '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n', 'utf8');

        const repo: IRepository = {
          rootUri: vscode.Uri.file(tmpDir),
          state: 'merging',
          head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
          remotes: [],
          submodules: [],
        };
        mockGitService.getRepository = (): Promise<IRepository> => Promise.resolve(repo);
        mockGitService.getRepositories = (): IRepository[] => [repo];

        // getMergeState() returns undefined iff no webview state was loaded.
        await mergeView.show(absPath);
        assert.strictEqual(
          mergeView.getMergeState(),
          undefined,
          'native-editor path must not populate internal merge state (webview path is bypassed)'
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('markResolved() — stage-after-native-editor', () => {
    // ConflictResolutionService.markResolved() is the staging path after the
    // user finishes in the native merge editor. MergeView.markResolved() is
    // a secondary entry point (wired to the intellig.merge.markResolved
    // command). When called with no active merge state (the normal case
    // after native-editor delegation) it must return cleanly without staging.
    it('returns without staging when no merge state is loaded (native editor path)', async () => {
      const stageCalls: string[][] = [];
      (mockGitService as unknown as { stage: IGitService['stage'] }).stage = (
        _repo: IRepository,
        paths: string[]
      ): Promise<void> => {
        stageCalls.push(paths);
        return Promise.resolve();
      };

      await mergeView.markResolved();

      assert.strictEqual(
        stageCalls.length,
        0,
        'stage must not be called when there is no merge state'
      );
    });
  });
});
