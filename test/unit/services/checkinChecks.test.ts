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
import { gatherCheckinContext, formatCheckinProblems } from '../../../src/commits/CheckinChecks';
import {
  runCheckinHandlers,
  crlfCheckinHandler,
  largeFileCheckinHandler,
  badFilenameCheckinHandler,
  LARGE_FILE_WARNING_BYTES,
  ICheckinContext,
} from '../../../src/commits/CheckinHandlers';
import { sampleFileFacts } from '../../../src/commits/CheckinChecks';
import type {
  IGitService,
  IRepository,
  IFileStatus,
} from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

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

// ─── sampleFileFacts (fs sampling for the CRLF + size checks) ────────────────

describe('sampleFileFacts', () => {
  const fakeFs = (byPath: Record<string, { size?: number; chunk?: string; fail?: boolean }>) => ({
    stat: async (p: string) => {
      const e = byPath[p];
      if (!e || e.fail) {
        throw new Error('ENOENT');
      }
      return { size: e.size ?? 0 };
    },
    readChunk: async (p: string) => {
      const e = byPath[p];
      if (!e || e.fail || e.chunk === undefined) {
        throw new Error('ENOENT');
      }
      return Buffer.from(e.chunk, 'binary');
    },
  });

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
});
