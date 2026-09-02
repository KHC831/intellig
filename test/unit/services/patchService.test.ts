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
import { okAsync } from 'neverthrow';
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
import type { IPatchService } from '../../../src/patches/interfaces/IPatchService';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';
import { literalPathspec } from '../../../src/git-core/gitCli';

interface RecordedExec {
  args: string[];
  options: { cwd?: string; input?: string; throwOnError?: boolean } | undefined;
}

interface MockGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined?: string;
  truncated?: boolean;
}

/**
 * Build a mock IGitService wired to a scripted exec list. Each call pops the
 * next scripted response; if exhausted, returns exit 0 empty stdout/stderr.
 */
function makeMockGitService(
  scriptedResponses: MockGitResult[] = [],
  statusFiles: IFileStatus[] = [],
  opts?: {
    /**
     * By default the pre-apply `git stash create` snapshot answers "clean
     * tree" WITHOUT consuming a scripted response, so apply-focused tests
     * script only the apply exec. Bracket-focused tests set this to script
     * the snapshot row explicitly.
     */
    scriptStashCreate?: boolean;
  }
): IGitService & { _exec: RecordedExec[]; _pushResponse: (r: MockGitResult) => void } {
  const execLog: RecordedExec[] = [];
  const responses = [...scriptedResponses];

  const svc = {
    getRepositories: (): IRepository[] => [],
    onDidChangeRepository: new vscode.EventEmitter<IRepository>().event,
    getStatus: async () => statusFiles,
    stage: () => okAsync(undefined),
    gitCli: {
      exec: async (args: string[], options: unknown): Promise<MockGitResult> => {
        execLog.push({ args: [...args], options: options as RecordedExec['options'] });
        if (!opts?.scriptStashCreate && args[0] === 'stash' && args[1] === 'create') {
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        }
        if (args[0] === 'rev-parse' && args.includes('HEAD')) {
          // Born HEAD by default, WITHOUT consuming a scripted response, so
          // diff-focused tests script only the diff exec.
          const stdout = `${'a'.repeat(40)}\n`;
          return { exitCode: 0, stdout, stderr: '', combined: stdout };
        }
        if (args[0] === 'status') {
          // Porcelain -z synthesized from `statusFiles` so the shared am
          // session op (which reads status through the CLI) sees the same
          // conflict set as getStatus().
          const stdout = statusFiles
            .map((f) => `${f.indexStatus ?? ' '}${f.workTreeStatus ?? ' '} ${f.path}\0`)
            .join('');
          return { exitCode: 0, stdout, stderr: '', combined: stdout };
        }
        const r = responses.shift();
        if (r) {
          return {
            exitCode: r.exitCode,
            stdout: r.stdout,
            stderr: r.stderr,
            combined: r.combined ?? r.stdout + r.stderr,
            ...(r.truncated ? { truncated: true } : {}),
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

/**
 * The recorded execs minus the pre-apply `git stash create` snapshot, so
 * apply-focused assertions can keep indexing from 0.
 */
function applyCalls(git: { _exec: RecordedExec[] }): RecordedExec[] {
  return git._exec.filter((c) => c.args[0] !== 'stash');
}

function makeContext(): vscode.ExtensionContext {
  const state = new Map<string, unknown>();
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file('/tmp/ext'),
    // Dialogs read persisted settings on construction; a real host always
    // supplies this, so the stub must too.
    workspaceState: {
      get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
      update: (key: string, value: unknown): Thenable<void> => {
        state.set(key, value);
        return Promise.resolve();
      },
      keys: (): readonly string[] => [...state.keys()],
    },
  } as unknown as vscode.ExtensionContext;
}

/**
 * No-op am session ops for dialog stubs whose test doesn't exercise the am
 * recovery arm. Spread into the stub literal to satisfy IPatchService.
 */
const stubAmOps = {
  amContinue: async (): Promise<{ success: boolean }> => ({ success: true }),
  amSkip: async (): Promise<{ success: boolean }> => ({ success: true }),
  amAbort: async (): Promise<{ success: boolean }> => ({ success: true }),
};

describe('PatchService.createPatchFromLocalChanges — truncation fail-closed', () => {
  const TMP = path.join(path.resolve(__dirname, '../../..'), 'workspace-notes', 'tmp');

  it('throws PatchWriteFailed and writes no file when the diff is truncated', async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TMP, 'patch-trunc-'));
    const outPath = path.join(dir, 'x.patch');
    try {
      // The single `git diff --cached` returns a truncated (capped) diff — a
      // corrupt patch if written.
      const git = makeMockGitService([
        { exitCode: 0, stdout: 'partial diff head', stderr: '', truncated: true },
      ]);
      const svc = new PatchService(git);
      const repo = makeRepo();
      await assert.rejects(
        () => svc.createPatchFromLocalChanges(repo, { stagedOnly: true, outputPath: outPath }),
        (e: unknown) => e instanceof PatchWriteFailed
      );
      assert.ok(!fs.existsSync(outPath), 'a truncated diff must not be written as a patch');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
    assert.deepStrictEqual(applyCalls(git)[0].args, [
      'apply',
      '--index',
      '--3way',
      '--verbose',
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
    assert.strictEqual(applyCalls(git)[0].args[0], 'am');
    assert.ok(applyCalls(git)[0].args.includes('--3way'));
    assert.strictEqual(applyCalls(git)[0].args[applyCalls(git)[0].args.length - 1], '/tmp/x.patch');
  });

  it('refuses useAm on a plain diff instead of spawning an am that cannot succeed', async () => {
    // `git am --3way` exits 128 with "Patch format detection failed." on a
    // patch with no mailbox envelope, while the preview's `git apply --check`
    // reports it as appliable. Refuse before the spawn so the two agree.
    const git = makeMockGitService([{ exitCode: 0, stdout: '', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, {
      patchContent: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
      useAm: true,
    });
    assert.strictEqual(res.success, false);
    assert.match(res.stderr ?? '', /mailbox|envelope|format-patch/i);
    assert.strictEqual(applyCalls(git).length, 0, 'no git process should have spawned');
  });

  it('allows useAm when the patch carries a mailbox envelope', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'Applying: x\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, {
      patchContent:
        'From 1234567890123456789012345678901234567890 Mon Sep 17 00:00:00 2001\n' +
        'From: A <a@b.c>\nSubject: [PATCH] x\n\n' +
        'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
      useAm: true,
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(applyCalls(git)[0].args[0], 'am');
  });

  it('falls back to `git apply --reverse` when useAm + reverse (git am has no --reverse)', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: '', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    await svc.applyPatch(repo, { patchPath: '/tmp/x.patch', useAm: true, reverse: true });
    assert.strictEqual(applyCalls(git)[0].args[0], 'apply');
    assert.ok(applyCalls(git)[0].args.includes('--reverse'));
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
    assert.ok(applyCalls(git)[0].args.includes('--check'));
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

  // ─── Finding #7: AA/DD conflict detection in _extractConflicts ───────────
  //
  // Regression: _extractConflicts filtered status via 'U'-only check, missing
  // both-sides-added (AA) and both-sides-deleted (DD) entries. The fix delegates
  // to isConflictedStatus so all three conflict classes are caught.

  it('detects a both-sides-added (AA) conflict file when applying a patch', async () => {
    // CONFLICT phrase triggers the getStatus path; AA status must now be found.
    const git = makeMockGitService(
      [{ exitCode: 1, stdout: '', stderr: 'CONFLICT (add/add): Merge conflict in collide.ts' }],
      [{ path: 'collide.ts', indexStatus: 'A', workTreeStatus: 'A' } as IFileStatus]
    );
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/x.patch' });
    assert.strictEqual(res.success, false);
    assert.ok(res.conflicts, 'expected conflicts array to be populated for AA entry');
    assert.strictEqual(res.conflicts.length, 1);
    assert.strictEqual(res.conflicts[0].path, 'collide.ts');
  });

  it('detects a both-sides-deleted (DD) conflict file when applying a patch', async () => {
    const git = makeMockGitService(
      [{ exitCode: 1, stdout: '', stderr: 'CONFLICT (delete/delete): Merge conflict in gone.ts' }],
      [{ path: 'gone.ts', indexStatus: 'D', workTreeStatus: 'D' } as IFileStatus]
    );
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/x.patch' });
    assert.strictEqual(res.success, false);
    assert.ok(res.conflicts, 'expected conflicts array to be populated for DD entry');
    assert.strictEqual(res.conflicts.length, 1);
    assert.strictEqual(res.conflicts[0].path, 'gone.ts');
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
    const lastArg = applyCalls(git)[0].args[applyCalls(git)[0].args.length - 1];
    assert.ok(lastArg.includes('intellig-patch-') && lastArg.endsWith('patch.diff'));
    assert.strictEqual(fs.existsSync(lastArg), false, 'temp file should be unlinked');
  });

  it('P2: removes the temp DIRECTORY (not just the file) after an inline-content apply', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'patching file f.ts\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    await svc.applyPatch(repo, { patchContent: 'diff --git a/f.ts b/f.ts\n' });
    const lastArg = applyCalls(git)[0].args[applyCalls(git)[0].args.length - 1];
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
    const args = applyCalls(git)[0].args;
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
    const args = applyCalls(git)[0].args;
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
      assert.strictEqual(applyCalls(git).length, 1);
      assert.ok(applyCalls(git)[0].args.includes('--directory'));
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
        assert.ok(applyCalls(git)[0].args.includes(`-p${lvl}`));
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

/** The diff invocations only — the HEAD-base probe runs first and is noise here. */
function diffExecs(git: { _exec: RecordedExec[] }): string[][] {
  return git._exec.filter((e) => e.args[0] === 'diff').map((e) => e.args);
}

describe('PatchService.createPatchFromLocalChanges', () => {
  it('default: runs a single `git diff HEAD` (one base, one block per file)', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'HEAD_DIFF\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const patch = await svc.createPatchFromLocalChanges(repo, {});
    assert.strictEqual(patch, 'HEAD_DIFF\n');
    assert.deepStrictEqual(
      diffExecs(git),
      [['diff', 'HEAD', '--binary', '--no-textconv']],
      'exactly one diff invocation'
    );
  });

  it('stagedOnly: runs only `git diff --cached`', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'STAGED_DIFF\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const patch = await svc.createPatchFromLocalChanges(repo, { stagedOnly: true });
    assert.strictEqual(patch, 'STAGED_DIFF\n');
    assert.strictEqual(git._exec.length, 1);
    assert.deepStrictEqual(git._exec[0].args, ['diff', '--cached', '--binary', '--no-textconv']);
  });

  it('appends `-- file1 file2` when files are specified', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'U\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    await svc.createPatchFromLocalChanges(repo, { files: ['a.ts', 'b.ts'] });
    assert.deepStrictEqual(diffExecs(git), [
      [
        'diff',
        'HEAD',
        '--binary',
        '--no-textconv',
        '--',
        literalPathspec('a.ts'),
        literalPathspec('b.ts'),
      ],
    ]);
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

  it('an empty diff never touches the clipboard or writes a file', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: '', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    let clipboardWrites = 0;
    const originalWrite = vscode.env.clipboard.writeText;
    (vscode.env.clipboard as unknown as { writeText: (v: string) => Promise<void> }).writeText =
      async () => {
        clipboardWrites++;
      };
    const outPath = path.join(fs.mkdtempSync(path.join(SCRATCH_ROOT, 'patch-empty-')), 'x.patch');

    try {
      const patch = await svc.createPatchFromLocalChanges(repo, {
        toClipboard: true,
        outputPath: outPath,
      });
      assert.strictEqual(patch, '');
      assert.strictEqual(clipboardWrites, 0, 'a clean tree must not wipe the clipboard');
      assert.strictEqual(fs.existsSync(outPath), false, 'no 0-byte patch file');
    } finally {
      (vscode.env.clipboard as unknown as { writeText: typeof originalWrite }).writeText =
        originalWrite;
    }
  });

  it('a failing git diff throws (stderr surfaced) instead of reading as no changes', async () => {
    const git = makeMockGitService([
      { exitCode: 128, stdout: '', stderr: 'fatal: bad revision HEAD' },
    ]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    let clipboardWrites = 0;
    const originalWrite = vscode.env.clipboard.writeText;
    (vscode.env.clipboard as unknown as { writeText: (v: string) => Promise<void> }).writeText =
      async () => {
        clipboardWrites++;
      };
    try {
      await assert.rejects(
        () => svc.createPatchFromLocalChanges(repo, { toClipboard: true }),
        /bad revision/
      );
      assert.strictEqual(clipboardWrites, 0, 'the clipboard survives a failed diff');
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
      // atomicWriteFile must clean up its sibling-tmp file so no
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

  // Fault injection — a failing atomic write must surface a
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
      // `{ cause: err }` wiring must survive future
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
      ...stubAmOps,
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
      ...stubAmOps,
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
      ...stubAmOps,
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
      ...stubAmOps,
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
      ...stubAmOps,
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
      ...stubAmOps,
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

describe('PatchService.applyPatch — conflict scoping against real git output shapes', () => {
  // Real `git apply --index --3way` reports a conflicted file as
  // "Applied patch to '<path>' with conflicts." (and a clean 3way fallback as
  // "... cleanly."). The touched-file parse must recognise that shape, or the
  // conflict scoping silently degrades to ALL unmerged files and a
  // pre-existing unrelated conflict is mis-attributed to the patch.
  it('scopes conflicts using the "Applied patch to \'<path>\' with conflicts." shape', async () => {
    const git = makeMockGitService(
      [
        {
          exitCode: 1,
          stdout: '',
          stderr: "Applied patch to 'target.txt' with conflicts.\nU target.txt",
        },
      ],
      [
        { path: 'other.txt', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus,
        { path: 'target.txt', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus,
      ]
    );
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/x.patch' });
    assert.strictEqual(res.success, false);
    assert.ok(res.conflicts);
    assert.deepStrictEqual(
      res.conflicts.map((c) => c.path),
      ['target.txt'],
      'the pre-existing unrelated UU file must NOT be attributed to the patch'
    );
  });

  it('counts a cleanly 3way-merged file ("Applied patch to \'<path>\' cleanly.") as touched', async () => {
    const git = makeMockGitService([
      {
        exitCode: 0,
        stdout: '',
        stderr: "Applied patch to 'a.ts' cleanly.",
      },
    ]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/x.patch' });
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(res.appliedFiles, ['a.ts']);
  });
});

describe('PatchService.createPatchFromLocalChanges — reverse (-R)', () => {
  it('adds -R to the single HEAD diff when reverse is set', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'diff-a', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    await svc.createPatchFromLocalChanges(repo, { reverse: true });

    assert.deepStrictEqual(
      diffExecs(git),
      [['diff', 'HEAD', '--binary', '--no-textconv', '-R']],
      'exactly one diff invocation'
    );
  });

  it('adds -R to the cached leg in stagedOnly mode', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'diff', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    await svc.createPatchFromLocalChanges(repo, { stagedOnly: true, reverse: true });

    assert.deepStrictEqual(git._exec[0].args, [
      'diff',
      '--cached',
      '--binary',
      '--no-textconv',
      '-R',
    ]);
  });

  it('keeps -R ahead of the file scope separator', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: '', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    await svc.createPatchFromLocalChanges(repo, {
      stagedOnly: true,
      reverse: true,
      files: ['a.ts'],
    });

    assert.deepStrictEqual(git._exec[0].args, [
      'diff',
      '--cached',
      '--binary',
      '--no-textconv',
      '-R',
      '--',
      literalPathspec('a.ts'),
    ]);
  });
});

describe('PatchService.applyPatch — pre-apply bracket (rollback token)', () => {
  it('snapshots the working state before a plain apply and threads it into a conflict result', async () => {
    const STASH_SHA = 'ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12';
    const git = makeMockGitService(
      [
        // git stash create → snapshot sha (dirty tree)
        { exitCode: 0, stdout: `${STASH_SHA}\n`, stderr: '' },
        // git apply → 3way conflict, one clean sibling + one conflicted file
        {
          exitCode: 1,
          stdout: '',
          stderr:
            'Checking patch sib.ts...\n' +
            "Applied patch to 'sib.ts' cleanly.\n" +
            'Checking patch target.ts...\n' +
            "Applied patch to 'target.ts' with conflicts.\nU target.ts",
        },
      ],
      [{ path: 'target.ts', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus],
      { scriptStashCreate: true }
    );
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/x.patch' });

    assert.strictEqual(res.success, false);
    assert.deepStrictEqual(git._exec[0].args, ['stash', 'create', 'IntelliG: before Apply Patch']);
    assert.ok(res.preApplyState, 'a conflict result must carry the pre-apply restore token');
    assert.strictEqual(res.preApplyState.source, 'stash');
    assert.strictEqual(
      res.preApplyState.source === 'stash' ? res.preApplyState.sha : undefined,
      STASH_SHA
    );
    assert.deepStrictEqual(
      res.preApplyState.patchPaths.sort(),
      ['sib.ts', 'target.ts'],
      'the token must name every touched file, including the cleanly-applied sibling'
    );
  });

  it('adds --verbose to the plain apply argv so silent clean files are still reported', async () => {
    const git = makeMockGitService([
      { exitCode: 0, stdout: '', stderr: '' }, // stash create (clean tree → empty)
      { exitCode: 0, stdout: 'Checking patch a.ts...\n', stderr: '' },
    ]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/x.patch' });

    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(git._exec[1].args, [
      'apply',
      '--index',
      '--3way',
      '--verbose',
      '--',
      '/tmp/x.patch',
    ]);
  });

  it('a FAILED snapshot on a dirty tree offers no rollback token', async () => {
    // `git stash create` exits non-zero for real (e.g. an unwritable object
    // store). Reporting that as "tree was clean" would make Abort restore the
    // patch-touched paths from HEAD, discarding uncommitted work while
    // reporting success. No snapshot means no Abort offer.
    const git = makeMockGitService(
      [
        { exitCode: 1, stdout: '', stderr: 'error: insufficient permission' }, // stash create failed
        {
          exitCode: 1,
          stdout: '',
          stderr: "Applied patch to 'target.ts' with conflicts.",
        },
      ],
      [{ path: 'target.ts', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus],
      { scriptStashCreate: true }
    );
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/x.patch' });

    assert.strictEqual(res.success, false);
    assert.ok(res.conflicts && res.conflicts.length > 0, 'the conflict handoff still happens');
    assert.strictEqual(
      res.preApplyState,
      undefined,
      'a failed snapshot must not be offered as a restorable pre-apply state'
    );
  });

  it('a clean pre-apply tree yields a token without a stash sha', async () => {
    const git = makeMockGitService(
      [
        { exitCode: 0, stdout: '\n', stderr: '' }, // stash create → empty = clean
        {
          exitCode: 1,
          stdout: '',
          stderr: "Applied patch to 'target.ts' with conflicts.",
        },
      ],
      [{ path: 'target.ts', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus],
      { scriptStashCreate: true }
    );
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/x.patch' });

    assert.ok(res.preApplyState);
    assert.strictEqual(res.preApplyState.source, 'head', 'a clean tree restores from HEAD');
  });

  it('hard failure and check mode carry NO restore token', async () => {
    const hard = makeMockGitService(
      [
        { exitCode: 0, stdout: '', stderr: '' },
        { exitCode: 1, stdout: '', stderr: 'error: corrupt patch at line 3' },
      ],
      [],
      { scriptStashCreate: true }
    );
    const svc = new PatchService(hard);
    const repo = makeRepo();
    const res = await svc.applyPatch(repo, { patchPath: '/tmp/x.patch' });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.preApplyState, undefined, 'hard failure is atomic — nothing to restore');

    const check = makeMockGitService([
      { exitCode: 1, stdout: '', stderr: 'error: patch does not apply' },
    ]);
    const svc2 = new PatchService(check);
    const res2 = await svc2.applyPatch(repo, { patchPath: '/tmp/x.patch', check: true });
    assert.strictEqual(res2.preApplyState, undefined);
    assert.ok(
      !check._exec.some((c) => c.args[0] === 'stash'),
      'check mode must not snapshot the working state'
    );
  });

  it('the am path takes no bracket (git am --abort is its rollback)', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'Applying: x\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    await svc.applyPatch(repo, { patchPath: '/tmp/x.patch', useAm: true });

    assert.ok(
      !git._exec.some((c) => c.args[0] === 'stash'),
      'useAm must not snapshot the working state'
    );
  });
});

describe('PatchService am session ops (paused git-am recovery)', () => {
  it('amContinue issues `git am --continue` in the repo root', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: 'Applying: two\n', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.amContinue(repo);
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(git._exec[0].args, ['am', '--continue']);
    assert.strictEqual(git._exec[0].options?.cwd, repo.rootUri.fsPath);
  });

  it('amSkip issues `git am --skip`', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: '', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.amSkip(repo);
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(git._exec[0].args, ['am', '--skip']);
  });

  it('amAbort issues `git am --abort`', async () => {
    const git = makeMockGitService([{ exitCode: 0, stdout: '', stderr: '' }]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.amAbort(repo);
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(git._exec[0].args, ['am', '--abort']);
  });

  it('amContinue failure with unmerged files reports them as conflicts', async () => {
    const git = makeMockGitService(
      [{ exitCode: 1, stdout: '', stderr: 'error: Failed to merge in the changes.' }],
      [{ path: 'a.ts', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus]
    );
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.amContinue(repo);
    assert.strictEqual(res.success, false);
    assert.ok(res.conflicts, 'expected conflicts to be reported');
    assert.strictEqual(res.conflicts.length, 1);
    assert.strictEqual(res.conflicts[0].path, 'a.ts');
    assert.strictEqual(res.conflicts[0].resolved, false);
  });

  it('amSkip failure with unmerged files reports them as conflicts (next patch collides)', async () => {
    const git = makeMockGitService(
      [{ exitCode: 1, stdout: '', stderr: 'error: Failed to merge in the changes.' }],
      [{ path: 'b.ts', indexStatus: 'A', workTreeStatus: 'A' } as IFileStatus]
    );
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.amSkip(repo);
    assert.strictEqual(res.success, false);
    assert.ok(res.conflicts);
    assert.strictEqual(res.conflicts[0].path, 'b.ts');
  });

  it('amContinue non-conflict failure surfaces a sanitized failureReason', async () => {
    const git = makeMockGitService([
      {
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: cannot resume: https://user:secret@host/repo unavailable',
      },
    ]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.amContinue(repo);
    assert.strictEqual(res.success, false);
    assert.ok(!res.conflicts || res.conflicts.length === 0);
    assert.ok(res.failureReason, 'expected a failure reason');
    assert.ok(!res.failureReason.includes('secret'), 'credentials must be scrubbed');
  });

  it('amAbort non-conflict failure surfaces a failureReason', async () => {
    const git = makeMockGitService([
      { exitCode: 128, stdout: '', stderr: 'fatal: no am session in progress' },
    ]);
    const svc = new PatchService(git);
    const repo = makeRepo();

    const res = await svc.amAbort(repo);
    assert.strictEqual(res.success, false);
    assert.ok(res.failureReason?.includes('no am session'));
  });
});

describe('PatchService.applyPatch — paused am session detection', () => {
  const TMP = path.join(path.resolve(__dirname, '../../..'), 'workspace-notes', 'tmp');
  let root: string;

  beforeEach(() => {
    fs.mkdirSync(TMP, { recursive: true });
    root = fs.mkdtempSync(path.join(TMP, 'am-session-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seedAmSession(): void {
    fs.mkdirSync(path.join(root, '.git', 'rebase-apply'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'rebase-apply', 'applying'), '');
  }

  it('useAm failure with rebase-apply/applying on disk → amSessionActive', async () => {
    seedAmSession();
    const git = makeMockGitService([
      { exitCode: 128, stdout: '', stderr: 'error: could not build fake ancestor' },
    ]);
    const svc = new PatchService(git);
    const repo = makeRepo(root);

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/two.patch', useAm: true });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.amSessionActive, true);
  });

  it('useAm conflict failure with the marker on disk → conflicts AND amSessionActive', async () => {
    seedAmSession();
    const git = makeMockGitService(
      [{ exitCode: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict in a.ts' }],
      [{ path: 'a.ts', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus]
    );
    const svc = new PatchService(git);
    const repo = makeRepo(root);

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/two.patch', useAm: true });
    assert.strictEqual(res.success, false);
    assert.ok(res.conflicts && res.conflicts.length === 1);
    assert.strictEqual(res.amSessionActive, true);
  });

  it('useAm failure without the marker → amSessionActive not set', async () => {
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const git = makeMockGitService([
      { exitCode: 128, stdout: '', stderr: 'error: patch does not apply' },
    ]);
    const svc = new PatchService(git);
    const repo = makeRepo(root);

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/two.patch', useAm: true });
    assert.strictEqual(res.success, false);
    assert.ok(!res.amSessionActive, 'no marker on disk must not claim a live am session');
  });

  it('plain apply failure (no useAm) never claims an am session, even with a stale marker', async () => {
    // A leftover session from an earlier am must not be attributed to a
    // plain `git apply` failure — the plain path never creates repo state.
    seedAmSession();
    const git = makeMockGitService([
      { exitCode: 1, stdout: '', stderr: 'error: patch does not apply' },
    ]);
    const svc = new PatchService(git);
    const repo = makeRepo(root);

    const res = await svc.applyPatch(repo, { patchPath: '/tmp/one.patch' });
    assert.strictEqual(res.success, false);
    assert.ok(!res.amSessionActive);
  });
});

describe('ApplyPatchDialog — paused am session failure arm', () => {
  let ctx: vscode.ExtensionContext;
  let repo: IRepository;
  let dialog: ApplyPatchDialog | undefined;
  let errorCalls: Array<{ message: string; items: string[] }>;
  let warningCalls: Array<{ message: string; items: unknown[] }>;
  let infoCalls: string[];
  let errorAnswers: Array<string | undefined>;
  let warningAnswer: string | undefined;
  const originalError = vscode.window.showErrorMessage;
  const originalWarning = vscode.window.showWarningMessage;
  const originalInfo = vscode.window.showInformationMessage;

  beforeEach(() => {
    ctx = makeContext();
    repo = makeRepo();
    errorCalls = [];
    warningCalls = [];
    infoCalls = [];
    errorAnswers = [];
    warningAnswer = undefined;
    (vscode.window as { showErrorMessage: unknown }).showErrorMessage = async (
      message: string,
      ...items: string[]
    ): Promise<string | undefined> => {
      errorCalls.push({ message, items });
      return errorAnswers.shift();
    };
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = async (
      message: string,
      ...items: unknown[]
    ): Promise<string | undefined> => {
      warningCalls.push({ message, items });
      return warningAnswer;
    };
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async (
      message: string
    ): Promise<string | undefined> => {
      infoCalls.push(message);
      return undefined;
    };
  });

  afterEach(() => {
    (vscode.window as { showErrorMessage: unknown }).showErrorMessage = originalError;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = originalWarning;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = originalInfo;
    if (dialog) {
      dialog.dispose();
      dialog = undefined;
    }
  });

  interface AmStubOptions {
    amContinueResult?: { success: boolean; conflicts?: IConflictedFile[]; failureReason?: string };
  }

  function makeAmStubService(calls: string[], options?: AmStubOptions) {
    return {
      applyPatch: async () => ({
        success: false,
        appliedFiles: [],
        stderr: 'error: could not build fake ancestor',
        amSessionActive: true,
      }),
      createPatchFromLocalChanges: async () => '',
      amContinue: async () => {
        calls.push('continue');
        return options?.amContinueResult ?? { success: true };
      },
      amSkip: async () => {
        calls.push('skip');
        return { success: true };
      },
      amAbort: async () => {
        calls.push('abort');
        return { success: true };
      },
      dispose: (): void => {},
    };
  }

  async function fireApply(): Promise<void> {
    await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
      type: 'apply',
      patchPath: '/tmp/two.patch',
      useAm: true,
    });
  }

  it('hard failure with a live am session offers Continue / Skip Patch / Abort', async () => {
    const calls: string[] = [];
    dialog = new ApplyPatchDialog(ctx, {
      repo,
      patchService: makeAmStubService(calls),
      initialPatchPath: '/tmp/two.patch',
    });

    await fireApply();

    assert.strictEqual(errorCalls.length, 1, 'one failure toast expected');
    assert.deepStrictEqual(
      errorCalls[0].items,
      ['Continue', 'Skip Patch', 'Abort'],
      'the failure toast must offer the am recovery actions'
    );
    assert.ok(
      !/rebase/i.test(errorCalls[0].message),
      `am failure toast must never claim a rebase, got: "${errorCalls[0].message}"`
    );
  });

  it('hard failure WITHOUT a live am session keeps the plain error toast', async () => {
    const stubSvc = {
      applyPatch: async () => ({
        success: false,
        appliedFiles: [],
        stderr: 'error: patch does not apply',
      }),
      createPatchFromLocalChanges: async () => '',
      amContinue: async () => ({ success: true }),
      amSkip: async () => ({ success: true }),
      amAbort: async () => ({ success: true }),
      dispose: (): void => {},
    };
    dialog = new ApplyPatchDialog(ctx, {
      repo,
      patchService: stubSvc,
      initialPatchPath: '/tmp/one.patch',
    });

    await fireApply();

    assert.strictEqual(errorCalls.length, 1);
    assert.deepStrictEqual(errorCalls[0].items, [], 'no recovery buttons without an am session');
  });

  it('Abort choice → modal confirm → amAbort invoked', async () => {
    const calls: string[] = [];
    errorAnswers = ['Abort'];
    warningAnswer = 'Abort';
    dialog = new ApplyPatchDialog(ctx, {
      repo,
      patchService: makeAmStubService(calls),
      initialPatchPath: '/tmp/two.patch',
    });

    await fireApply();

    assert.strictEqual(warningCalls.length, 1, 'abort must confirm first');
    assert.deepStrictEqual(calls, ['abort']);
    assert.ok(
      infoCalls.some((m) => m.toLowerCase().includes('abort')),
      `expected an aborted toast, got: ${JSON.stringify(infoCalls)}`
    );
  });

  it('Abort confirm declined → amAbort NOT invoked', async () => {
    const calls: string[] = [];
    errorAnswers = ['Abort'];
    warningAnswer = undefined;
    dialog = new ApplyPatchDialog(ctx, {
      repo,
      patchService: makeAmStubService(calls),
      initialPatchPath: '/tmp/two.patch',
    });

    await fireApply();

    assert.deepStrictEqual(calls, [], 'declining the confirm must not abort');
  });

  it('Continue choice → amContinue; success completes the apply', async () => {
    const calls: string[] = [];
    let completed = 0;
    errorAnswers = ['Continue'];
    dialog = new ApplyPatchDialog(ctx, {
      repo,
      patchService: makeAmStubService(calls),
      initialPatchPath: '/tmp/two.patch',
      onApplyComplete: () => {
        completed++;
      },
    });

    await fireApply();

    assert.deepStrictEqual(calls, ['continue']);
    assert.strictEqual(completed, 1, 'onApplyComplete must fire after a successful continue');
    assert.ok(
      infoCalls.some((m) => m.toLowerCase().includes('applied')),
      `expected an applied toast, got: ${JSON.stringify(infoCalls)}`
    );
  });

  it('Continue with further conflicts → Resolve Conflicts handoff (operation applyPatch)', async () => {
    const calls: string[] = [];
    errorAnswers = ['Continue'];
    const recordedOpen: Array<{ conflicts: IConflictedFile[]; opContext: IConflictOpContext }> = [];
    const stubConflictSvc = {
      openResolveConflictsDialog: async (
        _r: IRepository,
        c: IConflictedFile[],
        ctxArg: IConflictOpContext
      ) => {
        recordedOpen.push({ conflicts: c, opContext: ctxArg });
      },
    } as unknown as IConflictResolutionService;

    dialog = new ApplyPatchDialog(ctx, {
      repo,
      patchService: makeAmStubService(calls, {
        amContinueResult: {
          success: false,
          conflicts: [{ path: 'b.ts', resolved: false }],
        },
      }),
      conflictResolutionService: stubConflictSvc,
      initialPatchPath: '/tmp/two.patch',
    });

    await fireApply();

    assert.deepStrictEqual(calls, ['continue']);
    assert.strictEqual(recordedOpen.length, 1);
    assert.strictEqual(recordedOpen[0].opContext.operation, 'applyPatch');
    assert.strictEqual(recordedOpen[0].conflicts[0].path, 'b.ts');
  });

  it('Skip Patch choice → modal confirm → amSkip invoked', async () => {
    const calls: string[] = [];
    errorAnswers = ['Skip Patch'];
    warningAnswer = 'Skip';
    dialog = new ApplyPatchDialog(ctx, {
      repo,
      patchService: makeAmStubService(calls),
      initialPatchPath: '/tmp/two.patch',
    });

    await fireApply();

    assert.strictEqual(warningCalls.length, 1, 'skip must confirm first');
    assert.deepStrictEqual(calls, ['skip']);
  });
});

/**
 * Apply Patch selection and preview are PER FILE. A path can appear in more
 * than one block (a multi-commit mailbox touching the same file twice), and
 * `filterPatchByFiles` keys off a set of paths — so every block for a path
 * shares one fate. Offering a row per block would offer a choice the apply
 * cannot honour: deselecting one of two identical rows changed nothing.
 */
describe('ApplyPatchDialog per-file selection — duplicate paths', () => {
  const dupPatch =
    'diff --git a/dup.ts b/dup.ts\n--- a/dup.ts\n+++ b/dup.ts\n@@ -1 +1 @@\n-old1\n+new1\n' +
    'diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-o\n+n\n' +
    'diff --git a/dup.ts b/dup.ts\n--- a/dup.ts\n+++ b/dup.ts\n@@ -9 +9 @@\n-old2\n+new2\n';

  let ctx: vscode.ExtensionContext;
  let repo: IRepository;
  let dialog: ApplyPatchDialog | undefined;
  const originalQuickPick = vscode.window.showQuickPick;
  const originalClipRead = vscode.env.clipboard.readText;

  beforeEach(() => {
    ctx = makeContext();
    repo = makeRepo();
    (vscode.env.clipboard as unknown as { readText: () => Promise<string> }).readText = async () =>
      dupPatch;
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

  function stubApply(
    recorded: Array<{ patchContent?: string }>
  ): IPatchService & { dispose: () => void } {
    return {
      applyPatch: async (_repo: IRepository, options: { patchContent?: string }) => {
        recorded.push(options);
        return { success: true, appliedFiles: [] };
      },
      createPatchFromLocalChanges: async () => '',
      ...stubAmOps,
      dispose: (): void => {},
    } as unknown as IPatchService & { dispose: () => void };
  }

  it('offers ONE row per distinct path, annotated with its block count', async () => {
    let offered: Array<{ label: string; description?: string }> = [];
    (
      vscode.window as unknown as {
        showQuickPick: (items: Array<{ label: string; description?: string }>) => Promise<unknown>;
      }
    ).showQuickPick = async (items) => {
      offered = items;
      return items;
    };

    dialog = new ApplyPatchDialog(ctx, { repo, patchService: stubApply([]) });
    await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
      type: 'apply',
      useClipboard: true,
    });

    assert.deepStrictEqual(
      offered.map((i) => i.label),
      ['dup.ts', 'other.ts'],
      'the twice-touched path gets one row, not two identical ones'
    );
    assert.match(
      offered[0].description ?? '',
      /2 changes/,
      'the row says how many blocks it covers'
    );
    assert.strictEqual(
      offered[1].description,
      undefined,
      'a single-block path needs no annotation'
    );
  });

  it('deselecting a duplicated path drops BOTH of its blocks', async () => {
    const recorded: Array<{ patchContent?: string }> = [];
    (
      vscode.window as unknown as {
        showQuickPick: (items: Array<{ label: string }>) => Promise<unknown>;
      }
    ).showQuickPick = async (items) => items.filter((i) => i.label === 'other.ts');

    dialog = new ApplyPatchDialog(ctx, { repo, patchService: stubApply(recorded) });
    await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
      type: 'apply',
      useClipboard: true,
    });

    assert.strictEqual(recorded.length, 1);
    const applied = recorded[0].patchContent ?? '';
    assert.ok(applied.includes('other.ts'), 'the kept file is applied');
    assert.ok(!applied.includes('new1'), 'the first block of the dropped path is gone');
    assert.ok(!applied.includes('new2'), 'the second block of the dropped path is gone too');
  });

  it('keeping a duplicated path applies BOTH of its blocks', async () => {
    const recorded: Array<{ patchContent?: string }> = [];
    (
      vscode.window as unknown as {
        showQuickPick: (items: Array<{ label: string }>) => Promise<unknown>;
      }
    ).showQuickPick = async (items) => items.filter((i) => i.label === 'dup.ts');

    dialog = new ApplyPatchDialog(ctx, { repo, patchService: stubApply(recorded) });
    await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
      type: 'apply',
      useClipboard: true,
    });

    const applied = recorded[0].patchContent ?? '';
    assert.ok(applied.includes('new1') && applied.includes('new2'), 'both blocks ride along');
    assert.ok(!applied.includes('other.ts'), 'the deselected file is gone');
  });

  it('previews ONE verdict per distinct path', async () => {
    const checked: string[] = [];
    const stubSvc = {
      applyPatch: async (
        _repo: IRepository,
        options: { patchContent?: string; check?: boolean }
      ) => {
        if (options.check) {
          checked.push(options.patchContent ?? '');
        }
        return { success: true, appliedFiles: [] };
      },
      createPatchFromLocalChanges: async () => '',
      ...stubAmOps,
      dispose: (): void => {},
    } as unknown as IPatchService;

    dialog = new ApplyPatchDialog(ctx, { repo, patchService: stubSvc });
    await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
      type: 'preview',
      useClipboard: true,
    });

    assert.strictEqual(checked.length, 2, 'one check per distinct path, not per block');
    assert.ok(
      checked[0].includes('new1') && checked[0].includes('new2'),
      'the path is checked whole'
    );
  });

  it('disposing mid-preview stops further git runs', async () => {
    let calls = 0;
    const stubSvc = {
      applyPatch: async () => {
        calls += 1;
        // Cancel the dialog while the first file is still being checked.
        dialog?.dispose();
        return { success: true, appliedFiles: [] };
      },
      createPatchFromLocalChanges: async () => '',
      ...stubAmOps,
      dispose: (): void => {},
    } as unknown as IPatchService;

    dialog = new ApplyPatchDialog(ctx, { repo, patchService: stubSvc });
    await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
      type: 'preview',
      useClipboard: true,
    });

    assert.strictEqual(calls, 1, 'the loop bails instead of spawning git against a dead panel');
  });
});
