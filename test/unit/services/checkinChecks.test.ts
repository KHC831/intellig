/**
 * Unit tests for the before-commit check I/O shell (CheckinChecks.ts):
 *  - gatherCheckinContext reads user.name/user.email via the gitCli hatch,
 *    maps committed paths onto working-tree statuses, and detects detached
 *    HEAD.
 *  - The unresolved flag fires (no false positive) when the hatch is absent.
 *  - formatCheckinProblems orders errors before warnings.
 */

import '../../setup';
import * as assert from 'assert';
import {
  gatherCheckinContext,
  formatCheckinProblems,
  recommendedAutoCrlfValue,
  runBeforeCommitChecks,
  chunkPathsForArgv,
  CRLF_DONT_ASK_SLOT,
} from '../../../src/commits/CheckinChecks';
import { loadPersisted, savePersisted, type MementoLike } from '../../../src/utils/persistedState';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  runCheckinHandlers,
  crlfCheckinHandler,
  largeFileCheckinHandler,
  badFilenameCheckinHandler,
  LARGE_FILE_WARNING_BYTES,
  ICheckinContext,
} from '../../../src/commits/CheckinHandlers';
import { sampleFileFacts, FACTS_SCAN_CAP_BYTES } from '../../../src/commits/CheckinChecks';
import type {
  IGitService,
  IRepository,
  IFileStatus,
} from '../../../src/git-core/interfaces/IGitService';
import { Uri, resetMockConfiguration, setMockConfigValue } from '../../mocks/vscode';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

interface FakeCliConfig {
  userName?: string;
  userEmail?: string;
  detached?: boolean;
  lfsRepositoryFormatVersion?: string;
}

/**
 * Build a gitService stub that exposes a `gitCli` whose `exec` answers the
 * three queries gatherCheckinContext issues:
 *   - config --get user.name / user.email
 *   - symbolic-ref -q HEAD (exit !=0 ⇒ detached)
 */
function makeGitServiceWithCli(statuses: IFileStatus[], cfg: FakeCliConfig): IGitService {
  const exec = async (
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> => {
    if (args[0] === 'config' && args[2] === 'user.name') {
      return ok(cfg.userName ?? '');
    }
    if (args[0] === 'config' && args[2] === 'user.email') {
      return ok(cfg.userEmail ?? '');
    }
    if (args[0] === 'config' && args[2] === 'lfs.repositoryformatversion') {
      return ok(cfg.lfsRepositoryFormatVersion ?? '');
    }
    if (args[0] === 'symbolic-ref') {
      return cfg.detached
        ? { exitCode: 1, stdout: '', stderr: 'detached', combined: 'detached' }
        : ok('refs/heads/main');
    }
    return ok('');
  };
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', combined: stdout });
  return {
    getStatus: async () => statuses,
    gitCli: { exec },
  } as unknown as IGitService;
}

describe('gatherCheckinContext', () => {
  it('reads user.name/user.email and maps committed-path statuses', async () => {
    const statuses: IFileStatus[] = [
      { path: 'a.ts', indexStatus: 'M', workTreeStatus: ' ' },
      { path: 'c.ts', indexStatus: 'U', workTreeStatus: 'U' },
      { path: 'untouched.ts', indexStatus: 'M', workTreeStatus: ' ' },
    ];
    const git = makeGitServiceWithCli(statuses, {
      userName: 'Kit',
      userEmail: 'k@e.com',
    });
    const ctx = await gatherCheckinContext(git, makeRepo(), ['a.ts', 'c.ts']);
    assert.strictEqual(ctx.userName, 'Kit');
    assert.strictEqual(ctx.userEmail, 'k@e.com');
    assert.strictEqual(ctx.userIdentityResolved, true);
    assert.strictEqual(ctx.detachedHead, false);
    // Only committed paths are present; c.ts maps to conflicted.
    assert.deepStrictEqual(ctx.files.map((f) => `${f.path}:${f.status}`).sort(), [
      'a.ts:modified',
      'c.ts:conflicted',
    ]);
  });

  it('classifies AA / DD / UU as conflicted (not just U on one side)', async () => {
    const statuses: IFileStatus[] = [
      { path: 'both-added.ts', indexStatus: 'A', workTreeStatus: 'A' },
      { path: 'both-deleted.ts', indexStatus: 'D', workTreeStatus: 'D' },
      { path: 'both-unmerged.ts', indexStatus: 'U', workTreeStatus: 'U' },
      // A plain added file (A + space) must NOT be classified as conflicted.
      { path: 'plain-add.ts', indexStatus: 'A', workTreeStatus: ' ' },
    ];
    const git = makeGitServiceWithCli(statuses, { userName: 'Kit', userEmail: 'k@e.com' });
    const ctx = await gatherCheckinContext(git, makeRepo(), [
      'both-added.ts',
      'both-deleted.ts',
      'both-unmerged.ts',
      'plain-add.ts',
    ]);
    const byPath = new Map(ctx.files.map((f) => [f.path, f.status]));
    assert.strictEqual(byPath.get('both-added.ts'), 'conflicted');
    assert.strictEqual(byPath.get('both-deleted.ts'), 'conflicted');
    assert.strictEqual(byPath.get('both-unmerged.ts'), 'conflicted');
    assert.strictEqual(byPath.get('plain-add.ts'), 'added');
  });

  it('flags an LFS repo when lfs.repositoryformatversion is set, and not otherwise', async () => {
    const lfsGit = makeGitServiceWithCli([], {
      userName: 'Kit',
      userEmail: 'k@e.com',
      lfsRepositoryFormatVersion: '0',
    });
    const lfsCtx = await gatherCheckinContext(lfsGit, makeRepo(), []);
    assert.strictEqual(lfsCtx.lfsRepo, true);

    const plainGit = makeGitServiceWithCli([], { userName: 'Kit', userEmail: 'k@e.com' });
    const plainCtx = await gatherCheckinContext(plainGit, makeRepo(), []);
    assert.strictEqual(plainCtx.lfsRepo, false);
  });

  it('treats empty user.name as unset', async () => {
    const git = makeGitServiceWithCli([], { userName: '', userEmail: 'k@e.com' });
    const ctx = await gatherCheckinContext(git, makeRepo(), []);
    assert.strictEqual(ctx.userName, undefined);
    assert.strictEqual(ctx.userIdentityResolved, true);
  });

  it('detects detached HEAD via symbolic-ref exit code', async () => {
    const git = makeGitServiceWithCli([], {
      userName: 'Kit',
      userEmail: 'k@e.com',
      detached: true,
    });
    const ctx = await gatherCheckinContext(git, makeRepo(), []);
    assert.strictEqual(ctx.detachedHead, true);
  });

  it('flags identity unresolved when the gitCli hatch is absent (no false positive)', async () => {
    const git = {
      getStatus: async () => [],
    } as unknown as IGitService;
    const ctx = await gatherCheckinContext(git, makeRepo(), []);
    assert.strictEqual(ctx.userIdentityResolved, false);
  });

  it('surfaces a status-read failure instead of silently passing the conflict check', async () => {
    // Regression: a getStatus throw must NOT swallow to files:[] — that would
    // make the unresolved-merge check see no conflicts and let the commit
    // proceed with no warning (fail-open). The failure is captured + surfaced
    // as a warning.
    const git = {
      getStatus: async () => {
        throw new Error('status read failed');
      },
      gitCli: {
        exec: async (args: string[]) => {
          // Provide a valid identity so the ONLY surfaced problem is the
          // status-read warning (isolates this test from the user.name check).
          if (args[0] === 'config' && args[2] === 'user.name') {
            return { exitCode: 0, stdout: 'Kit\n', stderr: '', combined: 'Kit\n' };
          }
          if (args[0] === 'config' && args[2] === 'user.email') {
            return { exitCode: 0, stdout: 'k@e.com\n', stderr: '', combined: 'k@e.com\n' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      },
    } as unknown as IGitService;
    const ctx = await gatherCheckinContext(git, makeRepo(), ['a.ts']);
    assert.strictEqual(ctx.statusReadFailed, true, 'status-read failure must be flagged');
    assert.deepStrictEqual(ctx.files, [], 'no files when status could not be read');

    const result = runCheckinHandlers(ctx);
    const warn = result.problems.find((p) => p.handlerId === 'git.status.read');
    assert.ok(warn, 'a status-read warning problem must be surfaced');
    assert.strictEqual(warn?.severity, 'warning', 'must be non-blocking');
    assert.strictEqual(result.hasBlockingProblem, false, 'a status-read failure must not block');
  });
});

describe('formatCheckinProblems', () => {
  it('orders errors before warnings', () => {
    const out = formatCheckinProblems([
      { handlerId: 'w', text: 'a warning', severity: 'warning' },
      { handlerId: 'e', text: 'an error', severity: 'error' },
    ]);
    const errIdx = out.indexOf('an error');
    const warnIdx = out.indexOf('a warning');
    assert.ok(errIdx >= 0 && warnIdx >= 0);
    assert.ok(errIdx < warnIdx, 'errors should be listed before warnings');
  });
});

// ─── CRLF / large-file / bad-filename checks ─────────────────────────────────

function ctxWith(over: Partial<ICheckinContext>): ICheckinContext {
  return { files: [], detachedHead: false, ...over };
}

describe('crlfCheckinHandler', () => {
  it('warns when a committed file has CRLF and core.autocrlf is unset', () => {
    const problems = crlfCheckinHandler.check(
      ctxWith({ files: [{ path: 'a.ts', status: 'modified', hasCrlf: true }] })
    );
    assert.strictEqual(problems.length, 1);
    assert.strictEqual(problems[0].severity, 'warning');
    assert.ok(problems[0].text.includes('a.ts'), problems[0].text);
    assert.match(problems[0].text, /CRLF/);
  });

  it('stays silent when core.autocrlf is true or input', () => {
    for (const autocrlf of ['true', 'input'] as const) {
      const problems = crlfCheckinHandler.check(
        ctxWith({
          coreAutoCrlf: autocrlf,
          files: [{ path: 'a.ts', status: 'modified', hasCrlf: true }],
        })
      );
      assert.deepStrictEqual(problems, [], `autocrlf=${autocrlf}`);
    }
  });

  it('stays silent when no committed file has CRLF', () => {
    const problems = crlfCheckinHandler.check(
      ctxWith({ files: [{ path: 'a.ts', status: 'modified', hasCrlf: false }] })
    );
    assert.deepStrictEqual(problems, []);
  });
});

describe('largeFileCheckinHandler', () => {
  it('warns for a file over the threshold, naming it with its size', () => {
    const problems = largeFileCheckinHandler.check(
      ctxWith({
        files: [
          { path: 'big.bin', status: 'added', sizeBytes: LARGE_FILE_WARNING_BYTES + 1 },
          { path: 'small.ts', status: 'modified', sizeBytes: 10 },
        ],
      })
    );
    assert.strictEqual(problems.length, 1);
    assert.strictEqual(problems[0].severity, 'warning');
    assert.ok(problems[0].text.includes('big.bin'), problems[0].text);
    assert.ok(!problems[0].text.includes('small.ts'));
  });

  it('stays silent in a Git LFS repo (lfs.repositoryformatversion set)', () => {
    // Reference GitCheckinHandlerFactory.kt:183 filters out LFS roots.
    const problems = largeFileCheckinHandler.check(
      ctxWith({
        lfsRepo: true,
        files: [{ path: 'big.bin', status: 'added', sizeBytes: LARGE_FILE_WARNING_BYTES + 1 }],
      })
    );
    assert.deepStrictEqual(problems, []);
  });

  it('stays silent at or below the threshold or with unknown size', () => {
    const problems = largeFileCheckinHandler.check(
      ctxWith({
        files: [
          { path: 'edge.bin', status: 'added', sizeBytes: LARGE_FILE_WARNING_BYTES },
          { path: 'unknown.bin', status: 'added' },
        ],
      })
    );
    assert.deepStrictEqual(problems, []);
  });
});

describe('badFilenameCheckinHandler', () => {
  it('warns for NEW files whose names break on Windows', () => {
    const problems = badFilenameCheckinHandler.check(
      ctxWith({
        files: [
          { path: 'aux.txt', status: 'added' },
          { path: 'a<b.txt', status: 'added' },
          { path: 'dir./f.txt', status: 'untracked' },
          { path: 'trail /x.txt', status: 'added' },
          { path: 'com1.log', status: 'added' },
        ],
      })
    );
    assert.strictEqual(problems.length, 1, JSON.stringify(problems));
    assert.strictEqual(problems[0].severity, 'warning');
    for (const bad of ['aux.txt', 'a<b.txt', 'dir./f.txt', 'com1.log']) {
      assert.ok(problems[0].text.includes(bad), `${bad} in ${problems[0].text}`);
    }
  });

  it('ignores clean names and pre-existing (modified) files', () => {
    const problems = badFilenameCheckinHandler.check(
      ctxWith({
        files: [
          { path: 'src/ok-file.ts', status: 'added' },
          { path: 'aux.txt', status: 'modified' },
          { path: 'auxiliary.txt', status: 'added' },
          { path: 'a.b.c.txt', status: 'added' },
        ],
      })
    );
    assert.deepStrictEqual(problems, []);
  });
});

// ─── CRLF gitattributes exclusion ────────────────────────────────────────────

describe('gatherCheckinContext — CRLF gitattributes exclusion', () => {
  const TMP_ROOT = SCRATCH_ROOT;

  function makeAttrFixture(opts: {
    checkAttrStdout?: string;
    checkAttrFails?: boolean;
    autoCrlf?: string;
  }): {
    repo: IRepository;
    git: IGitService;
    execCalls: string[][];
  } {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'attr-check-'));
    fs.writeFileSync(path.join(dir, 'attributed.ts'), 'a\r\nb\r\n');
    fs.writeFileSync(path.join(dir, 'plain.ts'), 'a\r\nb\r\n');
    const repo = {
      rootUri: Uri.file(dir),
      state: 'idle',
      head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
    const execCalls: string[][] = [];
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', combined: stdout });
    const exec = async (args: string[]) => {
      execCalls.push(args);
      if (args[0] === 'config' && args[2] === 'core.autocrlf') {
        return ok(opts.autoCrlf ?? '');
      }
      if (args[0] === 'check-attr') {
        return opts.checkAttrFails
          ? { exitCode: 2, stdout: '', stderr: 'boom', combined: 'boom' }
          : ok(opts.checkAttrStdout ?? '');
      }
      if (args[0] === 'symbolic-ref') {
        return ok('refs/heads/main');
      }
      return ok('');
    };
    const git = {
      getStatus: async (): Promise<IFileStatus[]> => [
        { path: 'attributed.ts', indexStatus: ' ', workTreeStatus: 'M' } as IFileStatus,
        { path: 'plain.ts', indexStatus: ' ', workTreeStatus: 'M' } as IFileStatus,
      ],
      gitCli: { exec },
    } as unknown as IGitService;
    return { repo, git, execCalls };
  }

  const PATHS = ['attributed.ts', 'plain.ts'];
  const hasCrlfByPath = (ctx: { files: ReadonlyArray<{ path: string; hasCrlf?: boolean }> }) =>
    new Map(ctx.files.map((f) => [f.path, f.hasCrlf]));

  it('clears the CRLF fact for files whose text/crlf attribute is specified', async () => {
    const { repo, git, execCalls } = makeAttrFixture({
      checkAttrStdout: 'attributed.ts\0text\0auto\0plain.ts\0text\0unspecified\0',
    });
    const ctx = await gatherCheckinContext(git, repo, PATHS);
    const byPath = hasCrlfByPath(ctx);
    assert.strictEqual(byPath.get('attributed.ts'), false, 'attributed file must not warn');
    assert.strictEqual(byPath.get('plain.ts'), true, 'unattributed CRLF file still warns');
    const call = execCalls.find((a) => a[0] === 'check-attr');
    assert.ok(call, 'check-attr consulted');
    assert.ok(call.includes('--'), 'paths passed after --');
  });

  it('suppresses the CRLF facts entirely when check-attr fails (reference fails gracefully)', async () => {
    const { repo, git } = makeAttrFixture({ checkAttrFails: true });
    const ctx = await gatherCheckinContext(git, repo, PATHS);
    const byPath = hasCrlfByPath(ctx);
    assert.strictEqual(byPath.get('attributed.ts'), false);
    assert.strictEqual(byPath.get('plain.ts'), false);
  });

  it('skips check-attr when warnAboutCrlf is off (check disabled, reference isEnabled gate)', async () => {
    setMockConfigValue('intellig', 'warnAboutCrlf', false);
    try {
      const { repo, git, execCalls } = makeAttrFixture({});
      await gatherCheckinContext(git, repo, PATHS);
      assert.ok(!execCalls.some((a) => a[0] === 'check-attr'), 'no check-attr spawn needed');
    } finally {
      resetMockConfiguration();
    }
  });

  it('batches a huge path list across several check-attr spawns and merges the results', async () => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'attr-batch-'));
    const paths: string[] = [];
    for (let i = 0; i < 1200; i++) {
      const rel = `f${String(i).padStart(4, '0')}.ts`;
      fs.writeFileSync(path.join(dir, rel), 'a\r\nb\r\n');
      paths.push(rel);
    }
    const repo = {
      rootUri: Uri.file(dir),
      state: 'idle',
      head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
    const attrBatches: string[][] = [];
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', combined: stdout });
    // Only the FIRST path of each batch is attributed, so a dropped batch is
    // visible in the merged result rather than masked by a blanket answer.
    const exec = async (args: string[]) => {
      if (args[0] !== 'check-attr') {
        return ok(args[0] === 'symbolic-ref' ? 'refs/heads/main' : '');
      }
      const batch = args.slice(args.indexOf('--') + 1);
      attrBatches.push(batch);
      return ok(`${batch[0]}\0text\0auto\0`);
    };
    const git = {
      getStatus: async (): Promise<IFileStatus[]> =>
        paths.map((p) => ({ path: p, indexStatus: ' ', workTreeStatus: 'M' }) as IFileStatus),
      gitCli: { exec },
    } as unknown as IGitService;

    const ctx = await gatherCheckinContext(git, repo, paths);

    assert.ok(
      attrBatches.length > 1,
      `1200 paths must span several spawns, got ${attrBatches.length}`
    );
    assert.deepStrictEqual(
      attrBatches.flat().sort(),
      [...paths].sort(),
      'every path is checked exactly once across the batches'
    );
    const cleared = ctx.files.filter((f) => f.hasCrlf === false).map((f) => f.path);
    assert.deepStrictEqual(
      cleared.sort(),
      attrBatches.map((b) => b[0]).sort(),
      'each batch attributed answer lands in the merged exclusion set'
    );
  });

  it('skips check-attr when core.autocrlf already normalizes', async () => {
    const { repo, git, execCalls } = makeAttrFixture({ autoCrlf: 'input' });
    await gatherCheckinContext(git, repo, PATHS);
    assert.ok(!execCalls.some((a) => a[0] === 'check-attr'), 'no check-attr spawn needed');
  });
});

describe('chunkPathsForArgv', () => {
  it('keeps every batch under the byte budget without dropping or duplicating paths', () => {
    const paths = Array.from({ length: 300 }, (_, i) => `${'d'.repeat(120)}/f${i}.ts`);
    const chunks = chunkPathsForArgv(paths, 4096, 1000);

    assert.ok(chunks.length > 1, 'a long list must split');
    for (const chunk of chunks) {
      const bytes = chunk.reduce((n, p) => n + Buffer.byteLength(p, 'utf8') + 1, 0);
      assert.ok(bytes <= 4096, `batch of ${bytes} bytes exceeds the budget`);
    }
    assert.deepStrictEqual(chunks.flat(), paths, 'order and membership are preserved');
  });

  it('caps a batch by path count even when the paths are tiny', () => {
    const paths = Array.from({ length: 25 }, (_, i) => `f${i}`);
    const chunks = chunkPathsForArgv(paths, 1024 * 1024, 10);

    assert.deepStrictEqual(
      chunks.map((c) => c.length),
      [10, 10, 5]
    );
  });

  it('never emits an empty batch for an empty list', () => {
    assert.deepStrictEqual(chunkPathsForArgv([], 4096, 10), []);
  });
});

// ─── sampleFileFacts (fs sampling for the CRLF + size checks) ────────────────

describe('sampleFileFacts', () => {
  const readOffsets: number[] = [];
  const opens: string[] = [];
  const closes: string[] = [];
  beforeEach(() => {
    readOffsets.length = 0;
    opens.length = 0;
    closes.length = 0;
  });
  const fakeFs = (byPath: Record<string, { size?: number; chunk?: string; fail?: boolean }>) => {
    // sampleFileFacts joins the POSIX-literal root + path with the host `path`
    // (backslashes on Windows); look up on the forward-slash-normalized key so
    // these fixtures resolve on any runner.
    const lookup = (p: string) => byPath[p.replace(/\\/g, '/')];
    return {
      stat: async (p: string) => {
        const e = lookup(p);
        if (!e || e.fail) {
          throw new Error('ENOENT');
        }
        return { size: e.size ?? 0 };
      },
      open: async (p: string) => {
        const e = lookup(p);
        if (!e || e.fail || e.chunk === undefined) {
          throw new Error('ENOENT');
        }
        opens.push(p);
        return {
          readChunk: async (offset: number) => {
            readOffsets.push(offset);
            return Buffer.from(e.chunk as string, 'binary').subarray(offset, offset + 8192);
          },
          close: async (): Promise<void> => {
            closes.push(p);
          },
        };
      },
    };
  };

  it('flags CRLF content and reports the size', async () => {
    const files = [{ path: 'a.ts', status: 'modified' as const }];
    const out = await sampleFileFacts(
      '/root',
      files,
      fakeFs({ '/root/a.ts': { size: 42, chunk: 'line one\r\nline two\n' } })
    );
    assert.strictEqual(out[0].hasCrlf, true);
    assert.strictEqual(out[0].sizeBytes, 42);
  });

  it('treats LF-only and binary (NUL) content as not CRLF', async () => {
    const files = [
      { path: 'lf.ts', status: 'modified' as const },
      { path: 'bin.dat', status: 'added' as const },
    ];
    const out = await sampleFileFacts(
      '/root',
      files,
      fakeFs({
        '/root/lf.ts': { size: 5, chunk: 'a\nb\n' },
        '/root/bin.dat': { size: 9, chunk: 'x\u0000y\r\nz' },
      })
    );
    assert.strictEqual(out[0].hasCrlf, false);
    assert.strictEqual(out[1].hasCrlf, false);
  });

  it('finds a CRLF that lies beyond the first 8 KiB chunk', async () => {
    const files = [{ path: 'a.ts', status: 'modified' as const }];
    const content = 'a\n'.repeat(5000) + 'x\r\ny';
    const out = await sampleFileFacts('/root', files, fakeFs({ '/root/a.ts': { chunk: content } }));
    assert.strictEqual(out[0].hasCrlf, true);
  });

  it('detects a CRLF split across a chunk boundary', async () => {
    const files = [{ path: 'a.ts', status: 'modified' as const }];
    const content = 'a'.repeat(8191) + '\r\nb';
    const out = await sampleFileFacts('/root', files, fakeFs({ '/root/a.ts': { chunk: content } }));
    assert.strictEqual(out[0].hasCrlf, true);
  });

  it('stops scanning at the cap: a CRLF beyond FACTS_SCAN_CAP_BYTES is not seen', async () => {
    const files = [{ path: 'a.ts', status: 'modified' as const }];
    const content = 'a'.repeat(FACTS_SCAN_CAP_BYTES) + '\r\n';
    const out = await sampleFileFacts('/root', files, fakeFs({ '/root/a.ts': { chunk: content } }));
    assert.strictEqual(out[0].hasCrlf, false);
    assert.ok(
      readOffsets.every((o) => o < FACTS_SCAN_CAP_BYTES),
      `reads stay under the cap, got offsets up to ${Math.max(...readOffsets)}`
    );
  });

  it('treats a NUL in any scanned chunk as binary and stops', async () => {
    const files = [{ path: 'a.ts', status: 'modified' as const }];
    const content = 'a'.repeat(9000) + '\0' + '\r\n';
    const out = await sampleFileFacts('/root', files, fakeFs({ '/root/a.ts': { chunk: content } }));
    assert.strictEqual(out[0].hasCrlf, false);
  });

  it('skips deleted files and tolerates read failures', async () => {
    const files = [
      { path: 'gone.ts', status: 'deleted' as const },
      { path: 'unreadable.ts', status: 'modified' as const },
    ];
    const out = await sampleFileFacts(
      '/root',
      files,
      fakeFs({ '/root/unreadable.ts': { fail: true } })
    );
    assert.strictEqual(out[0].sizeBytes, undefined);
    assert.strictEqual(out[0].hasCrlf, undefined);
    assert.strictEqual(out[1].sizeBytes, undefined);
    assert.strictEqual(out[1].hasCrlf, undefined);
  });

  /**
   * The scan opens each committed file ONCE. Reopening per 8 KiB chunk turned
   * a 1 MiB file into 128 open/close pairs, and an unbounded fan-out held one
   * descriptor per file for the whole commit.
   */

  it('opens each file once no matter how many chunks it reads', async () => {
    // A file large enough to need several chunks, with no CRLF to stop early.
    const big = 'x'.repeat(8192 * 4) + '\n';
    const out = await sampleFileFacts(
      '/root',
      [{ path: 'a.ts', status: 'modified' as const }],
      fakeFs({ '/root/a.ts': { size: big.length, chunk: big } })
    );

    assert.strictEqual(out.length, 1);
    assert.ok(
      readOffsets.length > 1,
      `sanity: the scan read several chunks (${readOffsets.length})`
    );
    assert.strictEqual(opens.length, 1, 'one open for the whole file');
    assert.strictEqual(closes.length, 1, 'and it is closed again');
  });

  it('closes the handle even when the file is unreadable mid-scan', async () => {
    await sampleFileFacts(
      '/root',
      [{ path: 'a.ts', status: 'modified' as const }],
      fakeFs({ '/root/a.ts': { size: 10, chunk: 'hello\n' } })
    );

    assert.strictEqual(opens.length, closes.length, 'every open is matched by a close');
  });

  it('bounds how many files are open at once', async () => {
    const files = Array.from({ length: 64 }, (_, i) => ({
      path: `f${i}.ts`,
      status: 'modified' as const,
    }));
    const entries: Record<string, { size: number; chunk: string }> = {};
    for (const f of files) {
      entries[`/root/${f.path}`] = { size: 6, chunk: 'hello\n' };
    }
    let live = 0;
    let peak = 0;
    const base = fakeFs(entries);
    const counting = {
      stat: base.stat,
      open: async (p: string) => {
        live += 1;
        peak = Math.max(peak, live);
        const handle = await base.open(p);
        return {
          readChunk: handle.readChunk,
          close: async (): Promise<void> => {
            live -= 1;
            await handle.close();
          },
        };
      },
    };

    await sampleFileFacts('/root', files, counting);

    assert.ok(peak > 1, `sanity: the scan overlaps files (peak ${peak})`);
    assert.ok(peak <= 16, `at most 16 files open at once, saw ${peak}`);
  });
});

// ─── F-B1: config-gated CRLF / large-file checks ─────────────────────────────

describe('checkin handler config gates', () => {
  it('crlf check is disableable via warnAboutCrlf=false in the context', () => {
    const problems = crlfCheckinHandler.check(
      ctxWith({
        files: [{ path: 'a.ts', status: 'modified', hasCrlf: true }],
        warnAboutCrlf: false,
      })
    );
    assert.deepStrictEqual(problems, [], 'warnAboutCrlf=false must silence the check');
  });

  it('large-file threshold comes from the context (largeFileWarningBytes)', () => {
    const tenMb = 10 * 1024 * 1024;
    const problems = largeFileCheckinHandler.check(
      ctxWith({
        files: [{ path: 'mid.bin', status: 'added', sizeBytes: tenMb + 1 }],
        largeFileWarningBytes: tenMb,
      })
    );
    assert.strictEqual(problems.length, 1, 'a file over the configured threshold warns');
    assert.ok(problems[0].text.includes('10 MB'), problems[0].text);
  });

  it('largeFileWarningBytes <= 0 disables the large-file check', () => {
    const problems = largeFileCheckinHandler.check(
      ctxWith({
        files: [{ path: 'huge.bin', status: 'added', sizeBytes: LARGE_FILE_WARNING_BYTES * 4 }],
        largeFileWarningBytes: 0,
      })
    );
    assert.deepStrictEqual(problems, []);
  });

  it('gatherCheckinContext carries the two settings from configuration', async () => {
    const git = makeGitServiceWithCli([], {});
    const context = await gatherCheckinContext(git, makeRepo(), []);
    // Schema defaults: warnAboutCrlf=true, largeFileWarningMb=50.
    assert.strictEqual(context.warnAboutCrlf, true);
    assert.strictEqual(context.largeFileWarningBytes, 50 * 1024 * 1024);
  });
});

describe('recommendedAutoCrlfValue', () => {
  it("recommends 'true' on Windows (reference GitCrlfUtil.RECOMMENDED_VALUE)", () => {
    assert.strictEqual(recommendedAutoCrlfValue('win32'), 'true');
  });

  it("recommends 'input' on macOS and Linux", () => {
    assert.strictEqual(recommendedAutoCrlfValue('darwin'), 'input');
    assert.strictEqual(recommendedAutoCrlfValue('linux'), 'input');
  });
});

// ─── F-B1: CRLF modal affordances (reference GitCrlfDialog) ──────────────────

describe('runBeforeCommitChecks — CRLF affordances', () => {
  const TMP_ROOT = SCRATCH_ROOT;

  function makeCrlfFixture(opts?: { conflict?: boolean }): {
    repo: IRepository;
    git: IGitService;
    execCalls: string[][];
  } {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'crlf-check-'));
    fs.writeFileSync(path.join(dir, 'win.ts'), 'line one\r\nline two\r\n');
    const repo = {
      rootUri: Uri.file(dir),
      state: 'idle',
      head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
    const execCalls: string[][] = [];
    const ok = (stdout: string): { exitCode: number; stdout: string; stderr: string } => ({
      exitCode: 0,
      stdout,
      stderr: '',
    });
    const statuses: IFileStatus[] = [
      { path: 'win.ts', indexStatus: ' ', workTreeStatus: 'M' } as IFileStatus,
    ];
    if (opts?.conflict) {
      statuses.push({ path: 'conflict.ts', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus);
    }
    const git = {
      getStatus: async (): Promise<IFileStatus[]> => statuses,
      gitCli: {
        exec: async (
          args: string[]
        ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
          execCalls.push(args);
          if (args[0] === 'config' && args[2] === 'user.name') {
            return ok('Test');
          }
          if (args[0] === 'config' && args[2] === 'user.email') {
            return ok('t@example.com');
          }
          if (args[0] === 'symbolic-ref') {
            return ok('refs/heads/main');
          }
          return ok('');
        },
      },
    } as unknown as IGitService;
    return { repo, git, execCalls };
  }

  function stubModal(
    answer: string | undefined | ((title: string, buttons: string[]) => string | undefined)
  ): {
    prompts: Array<{ title: string; buttons: string[] }>;
    restore: () => void;
  } {
    const prompts: Array<{ title: string; buttons: string[] }> = [];
    const win = vscode.window as unknown as Record<string, unknown>;
    const original = win.showWarningMessage;
    win.showWarningMessage = async (
      title: string,
      _opts: unknown,
      ...buttons: string[]
    ): Promise<string | undefined> => {
      prompts.push({ title, buttons });
      return typeof answer === 'function' ? answer(title, buttons) : answer;
    };
    return {
      prompts,
      restore: (): void => {
        win.showWarningMessage = original;
      },
    };
  }

  it("offers Fix and Commit / Commit As-Is / don't-ask; Fix sets core.autocrlf --global", async () => {
    const { repo, git, execCalls } = makeCrlfFixture();
    const { prompts, restore } = stubModal('Fix and Commit');
    try {
      const proceed = await runBeforeCommitChecks(git, repo, ['win.ts']);
      assert.strictEqual(proceed, true, 'Fix and Commit proceeds with the commit');
      assert.strictEqual(prompts.length, 1);
      assert.deepStrictEqual(prompts[0].buttons, [
        'Fix and Commit',
        'Commit As-Is',
        "Commit As-Is, Don't Ask Again",
      ]);
      assert.ok(
        execCalls.some(
          (a) => a[0] === 'config' && a.includes('--global') && a.includes('core.autocrlf')
        ),
        `expected a core.autocrlf --global write, got: ${JSON.stringify(execCalls)}`
      );
    } finally {
      restore();
    }
  });

  it('Fix and Commit writes the platform-recommended autocrlf value (true on Windows, input elsewhere)', async () => {
    const { repo, git, execCalls } = makeCrlfFixture();
    const { restore } = stubModal('Fix and Commit');
    try {
      const proceed = await runBeforeCommitChecks(git, repo, ['win.ts']);
      assert.strictEqual(proceed, true);
      const write = execCalls.find((a) => a[0] === 'config' && a.includes('--global'));
      assert.ok(write, `expected a core.autocrlf write, got: ${JSON.stringify(execCalls)}`);
      // Reference GitCrlfUtil.RECOMMENDED_VALUE: isWindows ? "true" : "input".
      // On macOS/Linux "true" would rewrite LF checkouts to CRLF.
      const expected = process.platform === 'win32' ? 'true' : 'input';
      assert.strictEqual(write?.[write.length - 1], expected);
    } finally {
      restore();
    }
  });

  it('cancelling the CRLF prompt aborts the commit', async () => {
    const { repo, git, execCalls } = makeCrlfFixture();
    const { restore } = stubModal(undefined);
    try {
      const proceed = await runBeforeCommitChecks(git, repo, ['win.ts']);
      assert.strictEqual(proceed, false);
      assert.ok(
        !execCalls.some((a) => a.includes('core.autocrlf') && a.includes('--global')),
        'no config write on cancel'
      );
    } finally {
      restore();
    }
  });

  it('Commit As-Is proceeds without touching git config', async () => {
    const { repo, git, execCalls } = makeCrlfFixture();
    const { restore } = stubModal('Commit As-Is');
    try {
      const proceed = await runBeforeCommitChecks(git, repo, ['win.ts']);
      assert.strictEqual(proceed, true);
      assert.ok(!execCalls.some((a) => a.includes('--global')), 'no config write for as-is');
    } finally {
      restore();
    }
  });

  it("Don't Ask Again records the opt-out in workspace state, not in settings", async () => {
    resetMockConfiguration();
    const { repo, git } = makeCrlfFixture();
    const { restore } = stubModal("Commit As-Is, Don't Ask Again");
    const store = new Map<string, unknown>();
    const memento: MementoLike = {
      get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
      update: (key: string, value: unknown): Thenable<void> => {
        store.set(key, value);
        return Promise.resolve();
      },
    };
    try {
      const proceed = await runBeforeCommitChecks(git, repo, ['win.ts'], memento);
      assert.strictEqual(proceed, true);

      // A settings write would materialise <repo>/.vscode/settings.json inside
      // the commit being made; the reference keeps this flag in workspace.xml.
      const scopes = vscode.workspace.getConfiguration('intellig').inspect('warnAboutCrlf');
      assert.strictEqual(scopes?.workspaceValue, undefined, 'settings stay untouched');
      assert.strictEqual(scopes?.globalValue, undefined, 'user scope stays untouched');

      assert.strictEqual(
        loadPersisted(memento, CRLF_DONT_ASK_SLOT),
        true,
        'the opt-out is remembered in workspace state'
      );
    } finally {
      restore();
      resetMockConfiguration();
    }
  });

  it('honors the recorded opt-out on the next commit without prompting', async () => {
    resetMockConfiguration();
    const { repo, git } = makeCrlfFixture();
    const store = new Map<string, unknown>();
    const memento: MementoLike = {
      get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
      update: (key: string, value: unknown): Thenable<void> => {
        store.set(key, value);
        return Promise.resolve();
      },
    };
    await savePersisted(memento, CRLF_DONT_ASK_SLOT, true);
    const { prompts, restore } = stubModal(undefined);
    try {
      const proceed = await runBeforeCommitChecks(git, repo, ['win.ts'], memento);

      assert.strictEqual(proceed, true, 'the commit proceeds unprompted');
      assert.strictEqual(prompts.length, 0, `no CRLF prompt: ${JSON.stringify(prompts)}`);
    } finally {
      restore();
      resetMockConfiguration();
    }
  });

  it('an explicit warnAboutCrlf=false in settings still wins', async () => {
    resetMockConfiguration();
    setMockConfigValue('intellig', 'warnAboutCrlf', false);
    const { repo, git } = makeCrlfFixture();
    const { prompts, restore } = stubModal(undefined);
    try {
      const proceed = await runBeforeCommitChecks(git, repo, ['win.ts']);

      assert.strictEqual(proceed, true);
      assert.strictEqual(prompts.length, 0, 'a hand-edited setting silences the check');
    } finally {
      restore();
      resetMockConfiguration();
    }
  });

  it('a failed opt-out write never aborts the commit', async () => {
    resetMockConfiguration();
    const { repo, git } = makeCrlfFixture();
    const { restore } = stubModal("Commit As-Is, Don't Ask Again");
    const unwritable: MementoLike = {
      get: () => undefined,
      update: () => Promise.reject(new Error('EACCES')),
    };
    try {
      const proceed = await runBeforeCommitChecks(git, repo, ['win.ts'], unwritable);

      assert.strictEqual(proceed, true, 'the user asked to commit; a persist failure is not fatal');
    } finally {
      restore();
      resetMockConfiguration();
    }
  });

  it('shows the blocking-problems modal before any CRLF prompt', async () => {
    const { repo, git } = makeCrlfFixture({ conflict: true });
    const { prompts, restore } = stubModal(undefined);
    try {
      const proceed = await runBeforeCommitChecks(git, repo, ['win.ts', 'conflict.ts']);
      assert.strictEqual(proceed, false, 'aborting the blocking modal aborts the commit');
      assert.strictEqual(prompts.length, 1, JSON.stringify(prompts));
      assert.strictEqual(prompts[0].title, 'Before-commit checks found problems');
    } finally {
      restore();
    }
  });

  it('does not write git config when the blocked commit is aborted', async () => {
    const { repo, git, execCalls } = makeCrlfFixture({ conflict: true });
    // Answer Fix and Commit if the CRLF prompt ever shows; abort anything else.
    const { restore } = stubModal((_title, buttons) =>
      buttons.includes('Fix and Commit') ? 'Fix and Commit' : undefined
    );
    try {
      const proceed = await runBeforeCommitChecks(git, repo, ['win.ts', 'conflict.ts']);
      assert.strictEqual(proceed, false);
      assert.ok(
        !execCalls.some((a) => a[0] === 'config' && a.includes('--global')),
        `an aborted commit must not write core.autocrlf, got: ${JSON.stringify(execCalls)}`
      );
    } finally {
      restore();
    }
  });

  it('runs the CRLF dialog (and its config write) only after Commit Anyway', async () => {
    const { repo, git, execCalls } = makeCrlfFixture({ conflict: true });
    const { prompts, restore } = stubModal((_title, buttons) => {
      if (buttons.includes('Commit Anyway')) {
        return 'Commit Anyway';
      }
      return 'Fix and Commit';
    });
    try {
      const proceed = await runBeforeCommitChecks(git, repo, ['win.ts', 'conflict.ts']);
      assert.strictEqual(proceed, true);
      assert.deepStrictEqual(
        prompts.map((p) => p.title),
        ['Before-commit checks found problems', 'Committing CRLF line separators']
      );
      assert.ok(
        execCalls.some((a) => a[0] === 'config' && a.includes('--global')),
        'the config write lands once every gate has passed'
      );
    } finally {
      restore();
    }
  });
});

/**
 * The CRLF "Don't Ask Again" opt-out lives in workspace state.
 *
 * A settings write at Workspace scope creates `<repo>/.vscode/settings.json`
 * in a single-root workspace — an untracked file that appears mid-commit
 * inside the very list being committed — and in a multi-root workspace lands
 * in the `.code-workspace` file, silencing the check for every repo at once.
 */
describe('CRLF opt-out persistence', () => {
  function makeMemento(seed?: Record<string, unknown>): {
    memento: MementoLike;
    writes: Array<{ key: string; value: unknown }>;
  } {
    const store = new Map<string, unknown>(Object.entries(seed ?? {}));
    const writes: Array<{ key: string; value: unknown }> = [];
    return {
      memento: {
        get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
        update: (key: string, value: unknown): Thenable<void> => {
          writes.push({ key, value });
          store.set(key, value);
          return Promise.resolve();
        },
      },
      writes,
    };
  }

  it('an opt-out recorded in workspace state silences the warning next run', async () => {
    const { memento } = makeMemento();
    await savePersisted(memento, CRLF_DONT_ASK_SLOT, true);

    const ctx = await gatherCheckinContext(makeGitServiceWithCli([], {}), makeRepo(), [], memento);

    assert.strictEqual(ctx.warnAboutCrlf, false, 'the remembered opt-out is honored');
  });

  it('warns when nothing has been opted out', async () => {
    const { memento } = makeMemento();

    const ctx = await gatherCheckinContext(makeGitServiceWithCli([], {}), makeRepo(), [], memento);

    assert.notStrictEqual(ctx.warnAboutCrlf, false);
  });

  it('stores the opt-out under a workspace-state key, never in settings', async () => {
    const { memento, writes } = makeMemento();

    await savePersisted(memento, CRLF_DONT_ASK_SLOT, true);

    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].key, 'intellig.commit.crlfDontAsk');
    assert.ok(
      !CRLF_DONT_ASK_SLOT.key.startsWith('warnAboutCrlf'),
      'the opt-out is not the settings key'
    );
  });
});
