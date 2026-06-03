import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MergeView } from '../../../conflicts/MergeView';
import { IGitService, IRepository, IFileStatus } from '../../../git-core/interfaces/IGitService';
import type { IMergeState } from '../../../conflicts/interfaces/IMergeView';
import { installErrorMessageTracker, restoreMessageFunctions } from '../../typed/windowStub';

/**
 * TestSurface for the private state MergeView exposes to
 * `markResolved()`. Matches docs/testing.md §3 — declared at the top of
 * the test file, single-purpose, no `I`-prefix.
 */
interface MergeViewInternals {
  _mergeState: IMergeState | undefined;
  _repository: IRepository | undefined;
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

    // markResolved must write the resolved content atomically (via
    // atomicWriteFile), not through a direct workspace.fs.writeFile. The
    // invariant we care about: during a simulated mid-flight write, a
    // concurrent reader sees either the full OLD content or the full NEW
    // content, never a partial/truncated file. We verify this by:
    //   1. Seeding a real on-disk file with OLD content.
    //   2. Priming _mergeState so _generateResolvedContent() returns a
    //      known NEW payload.
    //   3. Calling markResolved and asserting the file is at NEW with no
    //      `.<name>.tmp-*` debris in the directory afterwards.
    //
    // This also guards the Phase 4 regression where vscode.workspace.fs
    // was substituted for a non-atomic direct write.
    // Wave-3- Finding #1 — markResolved must surface atomic-write failures
    // as a toast and leave the pane + merge state intact. Before the fix,
    // the webview dispatcher invoked `void this.markResolved()` (fire-and-
    // forget) and a rejected promise from atomicWriteFile silently closed
    // the pane while `git add` never ran → user sees the merge "complete"
    // against stale content. The fix internalises error handling in
    // markResolved itself: catch the throw, sanitise + toast, and return
    // without firing `_onDidResolve` or calling `hide()`.
    //
    // We trigger a real atomic-write failure by pointing the repo root at
    // a non-existent path — the sibling-temp file write then fails with
    // ENOENT (no such directory). This is a realistic failure mode for
    // read-only / unmounted / racing-dispose working trees and exercises
    // the exact error path we care about (rename throws → catch block).
    it('surfaces error via showErrorMessage when atomic write fails; pane + state preserved', async () => {
      const tracker = installErrorMessageTracker();
      // Track stage invocations to confirm we never staged a half-written
      // file — stage must not run once the write has failed.
      const stageCalls: Array<{ repo: IRepository; paths: string[] }> = [];
      (mockGitService as unknown as { stage: IGitService['stage'] }).stage = (
        repo: IRepository,
        paths: string[]
      ): Promise<void> => {
        stageCalls.push({ repo, paths });
        return Promise.resolve();
      };

      // Track _onDidResolve emissions so we can assert the event does NOT
      // fire on the error path (downstream consumers gate on it).
      const resolveEvents: string[] = [];
      const resolveSub = mergeView.onDidResolve((file) => {
        resolveEvents.push(file);
      });

      try {
        // Point the repo at a non-existent directory so atomicWriteFile's
        // sibling-tmp writeFile rejects with ENOENT — the exact shape of
        // the kernel error we want to guard against (same catch path as
        // EBUSY/EPERM on a locked/read-only tree).
        const missingDir = path.join(
          os.tmpdir(),
          `intellig-mergeview-missing-${process.pid}-${Date.now()}`
        );
        const internals = mergeView as unknown as MergeViewInternals;
        internals._repository = {
          rootUri: vscode.Uri.file(missingDir),
          state: 'idle',
          head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
          remotes: [],
          submodules: [],
        };
        const zeroRange = new vscode.Range(0, 0, 0, 0);
        internals._mergeState = {
          file: 'README.md',
          base: 'OLD\n',
          current: 'NEW\n',
          incoming: 'OLD\n',
          conflicts: [
            {
              id: 0,
              baseRange: zeroRange,
              currentRange: zeroRange,
              incomingRange: zeroRange,
              baseContent: 'OLD\n',
              currentContent: 'NEW\n',
              incomingContent: 'OLD\n',
              resolved: true,
              resolution: 'current',
            },
          ],
          resolvedConflicts: new Set([0]),
        };

        // Must NOT throw out of the catch — the fix internalises the error.
        await mergeView.markResolved();

        // Error toast surfaced with a user-facing prefix + the underlying
        // error context (sanitised via sanitizeGitError but ENOENT on a
        // local tmp path has no credentials to redact, so the raw message
        // passes through).
        assert.strictEqual(
          tracker.calls.length,
          1,
          `expected exactly one showErrorMessage call, got ${tracker.calls.length}`
        );
        assert.ok(
          tracker.calls[0].message.startsWith('Failed to mark resolved:'),
          `expected user-facing prefix, got: "${tracker.calls[0].message}"`
        );
        assert.ok(
          tracker.calls[0].message.length > 'Failed to mark resolved:'.length + 1,
          'error message should include the sanitised error context'
        );

        // `stage` must NOT have been invoked — staging a file whose
        // working-tree content is still the pre-merge version would ship
        // conflict markers into the commit.
        assert.strictEqual(
          stageCalls.length,
          0,
          'stage() must not run when atomicWriteFile failed'
        );

        // `_onDidResolve` must NOT have fired — downstream consumers
        // (e.g. the conflict-resolution dialog refresh) treat the file
        // as unresolved when the event is absent.
        assert.strictEqual(
          resolveEvents.length,
          0,
          '_onDidResolve must not fire on the error path'
        );

        // Pane + merge state preserved so the user can retry or dismiss
        // with context intact. `hide()` clears `_mergeState`, so checking
        // that the state is still defined also proves `hide()` was NOT
        // called.
        assert.ok(
          mergeView.getMergeState() !== undefined,
          'merge state must persist after error (pane should stay open)'
        );
      } finally {
        resolveSub.dispose();
        restoreMessageFunctions();
      }
    });

    it('atomic-write: resolved content lands at target path with no temp debris', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-mergeview-atomic-'));
      try {
        const conflictedPath = path.join(tmpDir, 'README.md');
        fs.writeFileSync(conflictedPath, 'OLD\n', 'utf8');

        // Prime the private merge state directly — we're testing the write
        // path, not the parse/load pipeline.
        const internals = mergeView as unknown as MergeViewInternals;
        internals._repository = {
          rootUri: vscode.Uri.file(tmpDir),
          state: 'idle',
          head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
          remotes: [],
          submodules: [],
        };
        const zeroRange = new vscode.Range(0, 0, 0, 0);
        internals._mergeState = {
          file: 'README.md',
          base: 'OLD\n',
          current: 'NEW\n',
          incoming: 'OLD\n',
          conflicts: [
            {
              id: 0,
              baseRange: zeroRange,
              currentRange: zeroRange,
              incomingRange: zeroRange,
              baseContent: 'OLD\n',
              currentContent: 'NEW\n',
              incomingContent: 'OLD\n',
              resolved: true,
              resolution: 'current',
            },
          ],
          resolvedConflicts: new Set([0]),
        };

        await mergeView.markResolved();

        // File content landed.
        assert.strictEqual(fs.readFileSync(conflictedPath, 'utf8'), 'NEW\n');

        // No atomic-write debris — confirms the sibling-temp + rename
        // discipline completed cleanly.
        const entries = fs.readdirSync(tmpDir);
        assert.deepStrictEqual(
          entries,
          ['README.md'],
          `expected zero temp debris, got: ${entries.join(',')}`
        );
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
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

        const internals = mergeView as unknown as MergeViewInternals;
        assert.strictEqual(
          internals._repository?.rootUri.fsPath,
          tmpDir,
          'show() should bind the repo found via the relative-path fallback'
        );
        assert.ok(
          mergeView.getMergeState() !== undefined,
          'merge state should load once the repo resolves'
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
});
