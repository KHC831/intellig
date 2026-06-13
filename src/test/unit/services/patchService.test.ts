/**
 * Unit tests for PatchService + ApplyPatchDialog.
 *
 * Coverage:
 * - PatchService.applyPatch: argv for patchPath + strip + baseDir + reverse.
 * - PatchService.applyPatch: `useAm=true` → uses `git am`.
 * - PatchService.applyPatch: stderr containing CONFLICT-like phrase →
 *   populates result.conflicts via ConflictService status check.
 * - PatchService.applyPatch: check mode → adds --check, never opens dialog.
 * - PatchService.applyPatch: patchContent writes temp file, cleans up.
 * - PatchService.applyPatch: validation errors (no source, both sources).
 * - PatchService.createPatchFromLocalChanges: no files → `git diff` + diff --cached.
 * - PatchService.createPatchFromLocalChanges: with files → appended as `-- f1 f2`.
 * - PatchService.createPatchFromLocalChanges: stagedOnly → `git diff --cached` only.
 * - PatchService.createPatchFromLocalChanges: toClipboard → clipboard write.
 * - PatchService.createPatchFromLocalChanges: outputPath → file write.
 * - ApplyPatchDialog: apply message dispatches to patchService.applyPatch.
 * - ApplyPatchDialog: conflicts → openResolveConflictsDialog called with
 *   operation='applyPatch'.
 * - ApplyPatchDialog: cancel → dialog disposed, no apply call.
 */

/*
 * Stub factories synthesise IGitService / IConflictService implementations
 * whose member signatures return `Promise<T>`; no-await stub bodies are
 * intentional here.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  PatchService,
  PatchWriteFailed,
  validateBaseDir,
  validateStripLevel,
} from '../../../patches/PatchService';
import { ApplyPatchDialog } from '../../../patches/ApplyPatchDialog';
import type {
  IGitService,
  IFileStatus,
  IRepository,
} from '../../../git-core/interfaces/IGitService';
import type {
  IConflictResolutionService,
  IConflictOpContext,
  IConflictedFile,
} from '../../../conflicts/interfaces/IConflictResolutionService';

interface RecordedExec {
  args: string[];
  options: { cwd?: string; input?: string; throwOnError?: boolean } | undefined;
}

interface MockGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined?: string;
}

/**
 * Build a mock IGitService wired to a scripted exec list. Each call pops the
 * next scripted response; if exhausted, returns exit 0 empty stdout/stderr.
 */
function makeMockGitService(
  scriptedResponses: MockGitResult[] = [],
  statusFiles: IFileStatus[] = []
): IGitService & { _exec: RecordedExec[]; _pushResponse: (r: MockGitResult) => void } {
  const execLog: RecordedExec[] = [];
  const responses = [...scriptedResponses];

  const svc = {
    getRepositories: (): IRepository[] => [],
    onDidChangeRepository: new vscode.EventEmitter<IRepository>().event,
    getStatus: async () => statusFiles,
    stage: async (): Promise<void> => {},
    gitCli: {
      exec: async (args: string[], options: unknown): Promise<MockGitResult> => {
        execLog.push({ args: [...args], options: options as RecordedExec['options'] });
        const r = responses.shift();
        if (r) {
          return {
            exitCode: r.exitCode,
            stdout: r.stdout,
            stderr: r.stderr,
            combined: r.combined ?? r.stdout + r.stderr,
          };
        }
        return { exitCode: 0, stdout: '', stderr: '', combined: '' };
      },
    },
    _exec: execLog,
    _pushResponse: (r: MockGitResult): void => {
      responses.push(r);
    },
  } as unknown as IGitService & {
    _exec: RecordedExec[];
    _pushResponse: (r: MockGitResult) => void;
  };
  return svc;
}

function makeRepo(rootPath?: string): IRepository {
  const root = rootPath ?? fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-patchtest-'));
  return {
    rootUri: vscode.Uri.file(root),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file('/tmp/ext'),
  } as unknown as vscode.ExtensionContext;
}

describe('PatchService.applyPatch', () => {
  it('builds correct argv for patchPath with strip + baseDir', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'patching file a.ts\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, {
      patchPath: '/tmp/x.patch',
      stripLevel: 2,
      baseDir: 'subdir',
    });
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(git._exec[0].args, [
      'apply',
      '--index',
      '--3way',
      '-p2',
      '--directory',
      'subdir',
      '/tmp/x.patch',
    ]);
    assert.ok(res.appliedFiles.includes('a.ts'));
  });

  it('uses `git am --3way` when useAm=true', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'Applying: x\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    await svc.applyPatch(repo, { patchPath: '/tmp/x.patch', useAm: true });
    assert.strictEqual(git._exec[0].args[0], 'am');
    assert.ok(git._exec[0].args.includes('--3way'));
    assert.strictEqual(git._exec[0].args[git._exec[0].args.length - 1], '/tmp/x.patch');
  });

  it('falls back to `git apply --reverse` when useAm + reverse (git am has no --reverse)', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: '', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    await svc.applyPatch(repo, { patchPath: '/tmp/x.patch', useAm: true, reverse: true });
    assert.strictEqual(git._exec[0].args[0], 'apply');
    assert.ok(git._exec[0].args.includes('--reverse'));
  });

  it('adds --check in check mode and does not extract conflicts', async () => {
    const git = makeMockGitService([
      { exitCode: 1, stdout: '', stderr: 'error: patch does not apply' },
    ]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/x.patch', check: true });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.conflicts, undefined);
    assert.ok(git._exec[0].args.includes('--check'));
  });

  it('stderr with CONFLICT phrasing + unmerged files → returns conflicts array', async () => {
    const git = makeMockGitService(
      [{ exitCode: 1, stdout: '', stderr: 'CONFLICT (content): applying patch a.ts' }],
      [{ path: 'a.ts', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus]
    );
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/x.patch' });
    assert.strictEqual(res.success, false);
    assert.ok(res.conflicts);
    assert.strictEqual(res.conflicts.length, 1);
    assert.strictEqual(res.conflicts[0].path, 'a.ts');
  });

  it('hard failure (no conflict phrase) returns stderr and no conflicts', async () => {
    const git = makeMockGitService([
      { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' },
    ]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/x.patch' });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.conflicts, undefined);
    assert.ok(res.stderr && res.stderr.includes('fatal'));
  });

  it('writes patchContent to a temp file, calls apply, then cleans up', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'patching file f.ts\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, { patchContent: 'diff --git a/f.ts b/f.ts\n' });
    assert.strictEqual(res.success, true);
    // The temp file path ended up as the last arg; it was created then deleted.
    const lastArg = git._exec[0].args[git._exec[0].args.length - 1];
    assert.ok(lastArg.includes('intellig-patch-') && lastArg.endsWith('patch.diff'));
    assert.strictEqual(fs.existsSync(lastArg), false, 'temp file should be unlinked');
  });

  it('rejects when neither patchPath nor patchContent provided', async () => {
    const git = makeMockGitService();
    const svc = new PatchService(git);
    const repo = makeRepo();
    const res = await svc.applyPatch(repo, {});
    assert.strictEqual(res.success, false);
    assert.ok(res.stderr && res.stderr.includes('patchPath or patchContent'));
  });

  it('rejects when both patchPath and patchContent provided', async () => {
    const git = makeMockGitService();
    const svc = new PatchService(git);
    const repo = makeRepo();
    const res = await svc.applyPatch(repo, {
      patchPath: '/tmp/x.patch',
      patchContent: 'diff',
    });
    assert.strictEqual(res.success, false);
    assert.ok(res.stderr && res.stderr.includes('mutually exclusive'));
  });

  // ─── SR-7: baseDir + stripLevel input validation ──────────────────────
  describe('SR-7 input validation at service boundary', () => {
    it('rejects baseDir containing ".." traversal', async () => {
      const git = makeMockGitService();
      const svc = new PatchService(git);
      const repo = makeRepo();
      const res = await svc.applyPatch(repo, {
        patchPath: '/tmp/x.patch',
        baseDir: '../evil',
      });
      assert.strictEqual(res.success, false);
      assert.ok(res.stderr && res.stderr.includes('baseDir'));
      assert.strictEqual(git._exec.length, 0, 'git apply never invoked on bad baseDir');
    });

    it('rejects absolute baseDir outside the repo root', async () => {
      const git = makeMockGitService();
      const svc = new PatchService(git);
      const repo = makeRepo();
      const res = await svc.applyPatch(repo, {
        patchPath: '/tmp/x.patch',
        baseDir: '/etc',
      });
      assert.strictEqual(res.success, false);
      assert.ok(res.stderr && res.stderr.includes('baseDir'));
      assert.strictEqual(git._exec.length, 0);
    });

    it('accepts baseDir relative to the repo root', async () => {
      const git = makeMockGitService([{ exitCode: 0, stdout: '', stderr: '' }]);
      const svc = new PatchService(git);
      const repo = makeRepo();
      const res = await svc.applyPatch(repo, {
        patchPath: '/tmp/x.patch',
        baseDir: 'subdir/inner',
      });
      assert.strictEqual(res.success, true);
      assert.strictEqual(git._exec.length, 1);
      assert.ok(git._exec[0].args.includes('--directory'));
    });

    it('rejects NaN stripLevel (defense against webview parseInt)', async () => {
      const git = makeMockGitService();
      const svc = new PatchService(git);
      const repo = makeRepo();
      const res = await svc.applyPatch(repo, {
        patchPath: '/tmp/x.patch',
        stripLevel: NaN,
      });
      assert.strictEqual(res.success, false);
      assert.ok(res.stderr && res.stderr.toLowerCase().includes('striplevel'));
      assert.strictEqual(git._exec.length, 0);
    });

    it('rejects negative stripLevel', async () => {
      const git = makeMockGitService();
      const svc = new PatchService(git);
      const repo = makeRepo();
      const res = await svc.applyPatch(repo, {
        patchPath: '/tmp/x.patch',
        stripLevel: -1,
      });
      assert.strictEqual(res.success, false);
      assert.ok(res.stderr && res.stderr.toLowerCase().includes('striplevel'));
      assert.strictEqual(git._exec.length, 0);
    });

    it('rejects absurd stripLevel (> 20)', async () => {
      const git = makeMockGitService();
      const svc = new PatchService(git);
      const repo = makeRepo();
      const res = await svc.applyPatch(repo, {
        patchPath: '/tmp/x.patch',
        stripLevel: 999,
      });
      assert.strictEqual(res.success, false);
      assert.ok(res.stderr && res.stderr.toLowerCase().includes('striplevel'));
      assert.strictEqual(git._exec.length, 0);
    });

    it('accepts stripLevel 0, 1, 5', async () => {
      for (const lvl of [0, 1, 5]) {
        const git = makeMockGitService([{ exitCode: 0, stdout: '', stderr: '' }]);
        const svc = new PatchService(git);
        const repo = makeRepo();
        const res = await svc.applyPatch(repo, {
          patchPath: '/tmp/x.patch',
          stripLevel: lvl,
        });
        assert.strictEqual(res.success, true, `stripLevel=${lvl} should pass`);
        assert.ok(git._exec[0].args.includes(`-p${lvl}`));
      }
    });
  });

  // ─── SR-7 unit tests for the exported pure helpers ────────────────────
  describe('validateBaseDir (pure)', () => {
    it('allows undefined / empty', () => {
      assert.strictEqual(validateBaseDir(undefined, '/tmp/repo'), undefined);
      assert.strictEqual(validateBaseDir('', '/tmp/repo'), undefined);
    });
    it('allows nested paths', () => {
      assert.strictEqual(validateBaseDir('a/b', '/tmp/repo'), undefined);
      assert.strictEqual(validateBaseDir('./a/b', '/tmp/repo'), undefined);
    });
    it('rejects traversal', () => {
      assert.ok(validateBaseDir('../x', '/tmp/repo'));
      assert.ok(validateBaseDir('a/../../x', '/tmp/repo'));
    });
    it('rejects absolute-outside-root', () => {
      assert.ok(validateBaseDir('/etc', '/tmp/repo'));
      assert.ok(validateBaseDir('/tmp/other', '/tmp/repo'));
    });
    it('rejects NUL bytes', () => {
      assert.ok(validateBaseDir('a\0b', '/tmp/repo'));
    });
  });

  describe('validateStripLevel (pure)', () => {
    it('allows undefined', () => {
      assert.strictEqual(validateStripLevel(undefined), undefined);
    });
    it('allows 0, 1, 20', () => {
      for (const v of [0, 1, 20]) {
        assert.strictEqual(validateStripLevel(v), undefined, `${v} should pass`);
      }
    });
    it('rejects NaN', () => {
      assert.ok(validateStripLevel(NaN));
    });
    it('rejects non-integer', () => {
      assert.ok(validateStripLevel(1.5));
    });
    it('rejects negative', () => {
      assert.ok(validateStripLevel(-1));
    });
    it('rejects > 20', () => {
      assert.ok(validateStripLevel(21));
      assert.ok(validateStripLevel(999));
    });
  });
});

describe('PatchService.createPatchFromLocalChanges', () => {
  it('default: runs `git diff` then `git diff --cached` and concatenates', async () => {
    const git = makeMockGitService([
      { exitCode: 0, stdout: 'UNSTAGED_DIFF\n', stderr: '' },
      { exitCode: 0, stdout: 'STAGED_DIFF\n', stderr: '' },
    ]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const patch = await svc.createPatchFromLocalChanges(repo, {});
    assert.strictEqual(patch, 'UNSTAGED_DIFF\nSTAGED_DIFF\n');
    assert.deepStrictEqual(git._exec[0].args, ['diff']);
    assert.deepStrictEqual(git._exec[1].args, ['diff', '--cached']);
  });

  it('stagedOnly: runs only `git diff --cached`', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'STAGED_DIFF\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const patch = await svc.createPatchFromLocalChanges(repo, { stagedOnly: true });
    assert.strictEqual(patch, 'STAGED_DIFF\n');
    assert.strictEqual(git._exec.length, 1);
    assert.deepStrictEqual(git._exec[0].args, ['diff', '--cached']);
  });

  it('appends `-- file1 file2` when files are specified', async () => {
    const git = makeMockGitService([
      { exitCode: 0, stdout: 'U\n', stderr: '' },
      { exitCode: 0, stdout: 'S\n', stderr: '' },
    ]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    await svc.createPatchFromLocalChanges(repo, { files: ['a.ts', 'b.ts'] });
    assert.deepStrictEqual(git._exec[0].args, ['diff', '--', 'a.ts', 'b.ts']);
    assert.deepStrictEqual(git._exec[1].args, ['diff', '--cached', '--', 'a.ts', 'b.ts']);
  });

  it('toClipboard: writes the patch text to the VS Code clipboard', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'CLIP\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    let clipboardValue = '';
    const originalWrite = vscode.env.clipboard.writeText;
    (vscode.env.clipboard as unknown as { writeText: (v: string) => Promise<void> }).writeText =
      async (v: string) => {
        clipboardValue = v;
      };

    try {
      const patch = await svc.createPatchFromLocalChanges(repo, {
        toClipboard: true,
        stagedOnly: true,
      });
      assert.strictEqual(clipboardValue, 'CLIP\n');
      assert.strictEqual(patch, 'CLIP\n');
    } finally {
      (vscode.env.clipboard as unknown as { writeText: typeof originalWrite }).writeText =
        originalWrite;
    }
  });

  it('outputPath: writes the patch text to disk', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'FILE_DIFF\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-patchout-'));
    const outPath = path.join(tmpDir, 'out.patch');

    try {
      await svc.createPatchFromLocalChanges(repo, {
        outputPath: outPath,
        stagedOnly: true,
      });
      assert.strictEqual(fs.readFileSync(outPath, 'utf-8'), 'FILE_DIFF\n');
      // TL-38: atomicWriteFile must clean up its sibling-tmp file so no
      // `.out.patch.tmp-<pid>-*` garbage remains in the directory.
      const debris = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-'));
      assert.strictEqual(debris.length, 0, `unexpected tmp debris: ${debris.join(', ')}`);
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  // TL-38: fault injection — a failing atomic write must surface a
  // sanitised toast inside the service (so callers don't have to re-toast)
  // AND throw a typed `PatchWriteFailed` so extension.ts can distinguish
  // write-only failure from other errors and suppress its own redundant
  // toast.
  it('outputPath: throws PatchWriteFailed + shows sanitised toast when atomic write fails', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'FILE_DIFF\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    // Non-existent parent directory → atomicWriteFile's sibling-tmp
    // write rejects with ENOENT.
    const missingPath = path.join(
      os.tmpdir(),
      `intellig-patchout-missing-${process.pid}-${Date.now()}`,
      'out.patch'
    );

    const errorCalls: Array<{ message: string }> = [];
    const originalError = vscode.window.showErrorMessage;
    (
      vscode.window as unknown as {
        showErrorMessage: (message: string, ...items: string[]) => Promise<string | undefined>;
      }
    ).showErrorMessage = (message: string) => {
      errorCalls.push({ message });
      return Promise.resolve(undefined);
    };

    try {
      let thrown: unknown;
      try {
        await svc.createPatchFromLocalChanges(repo, {
          outputPath: missingPath,
          stagedOnly: true,
        });
      } catch (err) {
        thrown = err;
      }
      if (!(thrown instanceof PatchWriteFailed)) {
        assert.fail(
          `must throw PatchWriteFailed, got ${thrown === undefined ? 'undefined' : String(thrown)}`
        );
      }
      assert.strictEqual(
        thrown.userNotified,
        true,
        'PatchWriteFailed must carry userNotified=true sentinel'
      );
      // Senior-wave4 OBS #7: `{ cause: err }` wiring must survive future
      // refactors so downstream debuggers can still walk the chain to the
      // original ENOENT/EBUSY. Asserting the shape here pins it.
      assert.ok(
        thrown.cause instanceof Error,
        'PatchWriteFailed must preserve original error via `cause`'
      );
      assert.strictEqual(
        errorCalls.length,
        1,
        `expected exactly one toast, got ${errorCalls.length}`
      );
      assert.ok(
        errorCalls[0].message.startsWith('Failed to write patch:'),
        `expected sanitised prefix, got: "${errorCalls[0].message}"`
      );
    } finally {
      (
        vscode.window as unknown as {
          showErrorMessage: typeof originalError;
        }
      ).showErrorMessage = originalError;
    }
  });
});

describe('ApplyPatchDialog', () => {
  let ctx: vscode.ExtensionContext;
  let repo: IRepository;
  let dialog: ApplyPatchDialog | undefined;

  beforeEach(() => {
    ctx = makeContext();
    repo = makeRepo();
  });

  afterEach(() => {
    if (dialog) {
      dialog.dispose();
      dialog = undefined;
    }
  });

  it('apply message → patchService.applyPatch called with correct options', async () => {
    const recorded: unknown[] = [];
    const stubSvc = {
      applyPatch: async (_repo: IRepository, options: unknown) => {
        recorded.push(options);
        return { success: true, appliedFiles: ['a.ts'] };
      },
      createPatchFromLocalChanges: async () => '',
      dispose: (): void => {},
    };

    dialog = new ApplyPatchDialog(ctx, {
      repo,
      patchService: stubSvc,
      initialPatchPath: '/tmp/x.patch',
    });

    await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
      type: 'apply',
      patchPath: '/tmp/x.patch',
      useAm: true,
      stripLevel: 2,
      baseDir: 'sub',
    });

    assert.strictEqual(recorded.length, 1);
    const opts = recorded[0] as {
      patchPath?: string;
      useAm?: boolean;
      stripLevel?: number;
      baseDir?: string;
    };
    assert.strictEqual(opts.patchPath, '/tmp/x.patch');
    assert.strictEqual(opts.useAm, true);
    assert.strictEqual(opts.stripLevel, 2);
    assert.strictEqual(opts.baseDir, 'sub');
  });

  it('conflict result → opens ResolveConflictsDialog via openResolveConflictsDialog', async () => {
    const conflicts: IConflictedFile[] = [{ path: 'a.ts', resolved: false }];
    const stubSvc = {
      applyPatch: async () => ({ success: false, appliedFiles: [], conflicts }),
      createPatchFromLocalChanges: async () => '',
      dispose: (): void => {},
    };

    const recordedOpen: Array<{
      repo: IRepository;
      conflicts: IConflictedFile[];
      opContext: IConflictOpContext;
    }> = [];
    const stubConflictSvc = {
      openResolveConflictsDialog: async (
        r: IRepository,
        c: IConflictedFile[],
        ctxArg: IConflictOpContext
      ) => {
        recordedOpen.push({ repo: r, conflicts: c, opContext: ctxArg });
      },
    } as unknown as IConflictResolutionService;

    dialog = new ApplyPatchDialog(ctx, {
      repo,
      patchService: stubSvc,
      conflictResolutionService: stubConflictSvc,
      initialPatchPath: '/tmp/x.patch',
    });

    await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
      type: 'apply',
      patchPath: '/tmp/x.patch',
    });

    assert.strictEqual(recordedOpen.length, 1);
    assert.strictEqual(recordedOpen[0].opContext.operation, 'applyPatch');
    assert.strictEqual(recordedOpen[0].opContext.canAbort, true);
    assert.strictEqual(recordedOpen[0].opContext.canContinue, true);
    assert.strictEqual(recordedOpen[0].conflicts.length, 1);
    assert.strictEqual(recordedOpen[0].conflicts[0].path, 'a.ts');
  });

  it('cancel message → dialog disposes and does not call applyPatch', async () => {
    let applyCalled = false;
    const stubSvc = {
      applyPatch: async () => {
        applyCalled = true;
        return { success: true, appliedFiles: [] };
      },
      createPatchFromLocalChanges: async () => '',
      dispose: (): void => {},
    };

    dialog = new ApplyPatchDialog(ctx, { repo, patchService: stubSvc });
    await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
      type: 'cancel',
    });

    assert.strictEqual(applyCalled, false);
    const underlying = (
      dialog as unknown as { _panel: vscode.WebviewPanel & { _disposeCallCount: number } }
    )._panel;
    assert.strictEqual(underlying._disposeCallCount, 1);
    dialog = undefined; // already disposed
  });

  it('apply with useClipboard reads clipboard into patchContent', async () => {
    const recorded: unknown[] = [];
    const stubSvc = {
      applyPatch: async (_repo: IRepository, options: unknown) => {
        recorded.push(options);
        return { success: true, appliedFiles: [] };
      },
      createPatchFromLocalChanges: async () => '',
      dispose: (): void => {},
    };

    const originalRead = vscode.env.clipboard.readText;
    (vscode.env.clipboard as unknown as { readText: () => Promise<string> }).readText = async () =>
      'diff --git a/a b/a\nclipboard patch';

    try {
      dialog = new ApplyPatchDialog(ctx, { repo, patchService: stubSvc });
      await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
        type: 'apply',
        useClipboard: true,
      });

      assert.strictEqual(recorded.length, 1);
      const opts = recorded[0] as { patchContent?: string; patchPath?: string };
      assert.ok(opts.patchContent && opts.patchContent.includes('clipboard patch'));
      assert.strictEqual(opts.patchPath, undefined);
    } finally {
      (vscode.env.clipboard as unknown as { readText: typeof originalRead }).readText =
        originalRead;
    }
  });
});
