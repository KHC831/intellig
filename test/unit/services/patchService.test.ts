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
import { execFileSync } from 'child_process';
import {
  PatchService,
  PatchWriteFailed,
  filterPatchByFiles,
  splitPatchByFile,
  validateBaseDir,
  validateStripLevel,
} from '../../../src/patches/PatchService';
import { ApplyPatchDialog } from '../../../src/patches/ApplyPatchDialog';
import type {
  IGitService,
  IFileStatus,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';
import type {
  IConflictResolutionService,
  IConflictOpContext,
  IConflictedFile,
} from '../../../src/conflicts/interfaces/IConflictResolutionService';

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
      '--',
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

  it('P2: removes the temp DIRECTORY (not just the file) after an inline-content apply', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'patching file f.ts\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    await svc.applyPatch(repo, { patchContent: 'diff --git a/f.ts b/f.ts\n' });
    const lastArg = git._exec[0].args[git._exec[0].args.length - 1];
    const tempDir = path.dirname(lastArg);
    assert.ok(
      path.basename(tempDir).startsWith('intellig-patch-'),
      'sanity: last arg lives in the mkdtemp dir'
    );
    assert.strictEqual(fs.existsSync(tempDir), false, 'temp DIR must be removed, not leaked');
  });

  it('P1: routes the patch path after `--` so a leading-dash path is a positional (apply)', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'patching file a.ts\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    await svc.applyPatch(repo, { patchPath: '-leading.patch', stripLevel: 1 });
    const args = git._exec[0].args;
    const sep = args.indexOf('--');
    assert.notStrictEqual(sep, -1, 'argv must contain a -- end-of-options separator');
    assert.strictEqual(
      args[sep + 1],
      '-leading.patch',
      'the patch path must immediately follow -- as a positional'
    );
    assert.strictEqual(args[args.length - 1], '-leading.patch', 'patch path stays last');
  });

  it('P1: routes the patch path after `--` for `git am` too', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'Applying: x\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    await svc.applyPatch(repo, { patchPath: '-leading.patch', useAm: true });
    const args = git._exec[0].args;
    assert.strictEqual(args[0], 'am');
    const sep = args.indexOf('--');
    assert.notStrictEqual(sep, -1, 'am argv must contain a -- separator');
    assert.strictEqual(args[sep + 1], '-leading.patch');
  });

  it('P3: scopes returned conflicts to the patch-touched files (ignores unrelated repo-wide U files)', async () => {
    const git = makeMockGitService(
      [
        {
          exitCode: 1,
          stdout: 'Checking patch touched.ts...\n',
          stderr: "Applied patch to 'touched.ts' with conflicts.",
        },
      ],
      [
        { path: 'touched.ts', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus,
        { path: 'unrelated.ts', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus,
      ]
    );
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/x.patch' });
    assert.ok(res.conflicts, 'should report conflicts');
    assert.deepStrictEqual(
      res.conflicts.map((c) => c.path),
      ['touched.ts'],
      'only the patch-touched file is reported; the pre-existing unrelated U file is excluded'
    );
  });

  it('P3: does NOT read git status for a hard error lacking conflict phrasing (narrowed heuristic)', async () => {
    // "you " embeds the legacy over-broad "u " token. The narrowed heuristic
    // must NOT treat this hard error as conflict-shaped, so no status read fires.
    const git = makeMockGitService([
      { exitCode: 1, stdout: '', stderr: 'fatal: could not apply because you have local edits' },
    ]);
    let statusCalls = 0;
    (git as unknown as { getStatus: () => Promise<IFileStatus[]> }).getStatus = async () => {
      statusCalls++;
      return [];
    };
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/x.patch' });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.conflicts, undefined);
    assert.strictEqual(statusCalls, 0, 'no repo-wide status read without conflict phrasing');
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

/**
 * splitPatchByFile mirrors IntelliJ PatchReader.readTextPatches()
 * (platform/vcs-impl/.../diff/impl/patch/PatchReader.java), which yields one
 * TextFilePatch per file by splitting on the `diff --git` header line.
 */
describe('splitPatchByFile', () => {
  const fileX = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
  const fileY =
    'diff --git a/dir/y.ts b/dir/y.ts\n--- a/dir/y.ts\n+++ b/dir/y.ts\n@@ -1 +1 @@\n-a\n+b\n';

  it('splits a two-file git patch into one segment per changed file', () => {
    const segments = splitPatchByFile(fileX + fileY);
    assert.strictEqual(segments.length, 2);
    assert.deepStrictEqual(
      segments.map((s) => s.path),
      ['x.ts', 'dir/y.ts']
    );
  });

  it('keeps each file segment verbatim and free of sibling content', () => {
    const segments = splitPatchByFile(fileX + fileY);
    assert.strictEqual(segments[0].content, fileX);
    assert.strictEqual(segments[1].content, fileY);
    assert.ok(!segments[0].content.includes('y.ts'));
  });

  it('returns a single segment equal to the input for a one-file patch', () => {
    const segments = splitPatchByFile(fileX);
    assert.strictEqual(segments.length, 1);
    assert.strictEqual(segments[0].content, fileX);
    assert.strictEqual(segments[0].path, 'x.ts');
  });

  it('returns an empty array when no git headers are present', () => {
    assert.deepStrictEqual(splitPatchByFile('not a patch\njust text\n'), []);
  });

  it('ignores a format-patch style preamble before the first git header', () => {
    const preamble = 'From abc123 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] thing\n\n';
    const segments = splitPatchByFile(preamble + fileX);
    assert.strictEqual(segments.length, 1);
    assert.strictEqual(segments[0].path, 'x.ts');
    assert.strictEqual(segments[0].content, fileX);
  });
});

/**
 * filterPatchByFiles reassembles only the user-selected files' blocks into a
 * valid patch — the engine behind the per-file Apply-Patch selection (E-7).
 * Mirrors IntelliJ ApplyPatchDifferentiatedDialog.getIncludedChanges()
 * (platform/vcs-impl/.../patch/ApplyPatchDifferentiatedDialog.java): only the
 * checked rows are applied.
 */
describe('filterPatchByFiles', () => {
  const fileX = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
  const fileY =
    'diff --git a/dir/y.ts b/dir/y.ts\n--- a/dir/y.ts\n+++ b/dir/y.ts\n@@ -1 +1 @@\n-a\n+b\n';

  it('reassembles only the selected files, verbatim and sibling-free', () => {
    const out = filterPatchByFiles(fileX + fileY, ['dir/y.ts']);
    assert.strictEqual(out, fileY);
    assert.ok(!out.includes('x.ts'));
  });

  it('selecting every file reproduces the whole patch', () => {
    assert.strictEqual(filterPatchByFiles(fileX + fileY, ['x.ts', 'dir/y.ts']), fileX + fileY);
  });

  it('returns an empty string when no file matches', () => {
    assert.strictEqual(filterPatchByFiles(fileX + fileY, ['nope.ts']), '');
  });

  it('round-trips a subset through real `git apply`, leaving unselected files untouched', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-e7-rt-'));
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf-8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
    try {
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      fs.writeFileSync(path.join(root, 'a.txt'), 'old\n');
      fs.writeFileSync(path.join(root, 'b.txt'), 'old\n');
      git('add', 'a.txt', 'b.txt');
      git('commit', '-q', '-m', 'base');

      // Edit both files, capture a two-file patch, then revert the worktree.
      fs.writeFileSync(path.join(root, 'a.txt'), 'new\n');
      fs.writeFileSync(path.join(root, 'b.txt'), 'new\n');
      const fullPatch = git('diff');
      git('checkout', '--', '.');
      assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf-8'), 'old\n');
      assert.strictEqual(fs.readFileSync(path.join(root, 'b.txt'), 'utf-8'), 'old\n');

      // Apply only a.txt's block; b.txt must stay untouched.
      const subset = filterPatchByFiles(fullPatch, ['a.txt']);
      const subsetFile = path.join(root, 'subset.patch');
      fs.writeFileSync(subsetFile, subset);
      git('apply', subsetFile);

      assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf-8'), 'new\n');
      assert.strictEqual(fs.readFileSync(path.join(root, 'b.txt'), 'utf-8'), 'old\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * ApplyPatchDialog per-file selection (E-7): when the patch touches more than
 * one file, the dialog presents a multi-select pick and applies only the
 * chosen files' blocks.
 */
describe('ApplyPatchDialog per-file selection (E-7)', () => {
  const twoFilePatch =
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n' +
    'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new\n';

  let ctx: vscode.ExtensionContext;
  let repo: IRepository;
  let dialog: ApplyPatchDialog | undefined;
  const originalQuickPick = vscode.window.showQuickPick;
  const originalClipRead = vscode.env.clipboard.readText;

  beforeEach(() => {
    ctx = makeContext();
    repo = makeRepo();
  });

  afterEach(() => {
    (vscode.window as unknown as { showQuickPick: typeof originalQuickPick }).showQuickPick =
      originalQuickPick;
    (vscode.env.clipboard as unknown as { readText: typeof originalClipRead }).readText =
      originalClipRead;
    if (dialog) {
      dialog.dispose();
      dialog = undefined;
    }
  });

  it('applies only the selected file when a subset is picked', async () => {
    const recorded: Array<{ patchContent?: string; patchPath?: string }> = [];
    const stubSvc = {
      applyPatch: async (_repo: IRepository, options: { patchContent?: string }) => {
        recorded.push(options);
        return { success: true, appliedFiles: ['a.ts'] };
      },
      createPatchFromLocalChanges: async () => '',
      dispose: (): void => {},
    };
    (vscode.env.clipboard as unknown as { readText: () => Promise<string> }).readText = async () =>
      twoFilePatch;
    // Pick only a.ts.
    (
      vscode.window as unknown as {
        showQuickPick: (items: Array<{ label: string }>) => Promise<unknown>;
      }
    ).showQuickPick = async (items) => items.filter((i) => i.label === 'a.ts');

    dialog = new ApplyPatchDialog(ctx, { repo, patchService: stubSvc });
    await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
      type: 'apply',
      useClipboard: true,
    });

    assert.strictEqual(recorded.length, 1);
    const applied = recorded[0].patchContent ?? '';
    assert.ok(applied.includes('a.ts'));
    assert.ok(!applied.includes('b.ts'));
    assert.strictEqual(recorded[0].patchPath, undefined);
  });

  it('aborts the apply when the file pick is cancelled', async () => {
    let applyCalled = false;
    const stubSvc = {
      applyPatch: async () => {
        applyCalled = true;
        return { success: true, appliedFiles: [] };
      },
      createPatchFromLocalChanges: async () => '',
      dispose: (): void => {},
    };
    (vscode.env.clipboard as unknown as { readText: () => Promise<string> }).readText = async () =>
      twoFilePatch;
    (vscode.window as unknown as { showQuickPick: () => Promise<unknown> }).showQuickPick =
      async () => undefined;

    dialog = new ApplyPatchDialog(ctx, { repo, patchService: stubSvc });
    await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
      type: 'apply',
      useClipboard: true,
    });

    assert.strictEqual(applyCalled, false);
  });
});
