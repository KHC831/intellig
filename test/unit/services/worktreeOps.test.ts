/**
 * WorktreeOps unit coverage (workstream D, slice 5).
 *
 * Pins the two safety-critical primitives behind "New Worktree…" /
 * "Open Worktree…":
 *
 *   - `parseWorktreeList`: turns `git worktree list --porcelain` output into
 *     structured entries (worktree / HEAD / branch / bare / detached / locked
 *     records, blank-line separated), matching IntelliJ git4idea's
 *     GitWorktreeListParser.handleLine record handling.
 *   - `addWorktree` argv: injection-safe — the user-controlled path and ref
 *     land AFTER `--end-of-options`/`--`, never as flags, and a path that
 *     already exists is rejected before git runs.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { WorktreeOps, parseWorktreeList, worktreesOf } from '../../../src/git-core/ops/WorktreeOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { GitCli, GitCommandError } from '../../../src/git-core/gitCli';
import { Uri } from '../../mocks/vscode';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';
import { isSamePath } from '../../helpers/samePath';

/** Whether a listed worktree is the one at `target`. */
const isAt =
  (target: string) =>
  (e: { path: string }): boolean =>
    isSamePath(e.path, target);

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
}

class DispatchGitCli {
  public executed: string[][] = [];
  constructor(private readonly handler: (args: string[]) => Partial<ExecResult>) {}
  // Faithfully emulates GitCli.exec: when `throwOnError` is set and git exits
  // non-zero, it rejects with a `GitCommandError` (so the ops Result boundary
  // classifies it as a `CommandFailedError`), exactly like the real binary.
  async exec(args: string[], options?: { throwOnError?: boolean }): Promise<ExecResult> {
    this.executed.push([...args]);
    const partial = this.handler(args);
    const result: ExecResult = {
      exitCode: partial.exitCode ?? 0,
      stdout: partial.stdout ?? '',
      stderr: partial.stderr ?? '',
      combined: partial.combined ?? partial.stdout ?? '',
    };
    if (options?.throwOnError && result.exitCode !== 0) {
      throw new GitCommandError('git', args, result);
    }
    return result;
  }
}

function makeRepo(root: string): IRepository {
  return { rootUri: Uri.file(root) } as unknown as IRepository;
}

function makeOps(handler: (args: string[]) => Partial<ExecResult>): {
  ops: WorktreeOps;
  cli: DispatchGitCli;
} {
  const cli = new DispatchGitCli(handler);
  const ctx = {
    get gitCli(): IGitOpsContext['gitCli'] {
      return cli as unknown as IGitOpsContext['gitCli'];
    },
    invalidateCache(): void {},
    fireDidFetch(): void {},
  } satisfies IGitOpsContext;
  const ops = new WorktreeOps(ctx);
  return { ops, cli };
}

describe('parseWorktreeList', () => {
  it('parses the main worktree, a linked branch worktree, and a detached worktree', () => {
    const porcelain = [
      'worktree /home/user/project',
      'HEAD abc123def456abc123def456abc123def456abcd',
      'branch refs/heads/main',
      '',
      'worktree /home/user/project-feature',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/feature/login',
      '',
      'worktree /home/user/project-detached',
      'HEAD 2222222222222222222222222222222222222222',
      'detached',
      '',
    ].join('\n');

    const entries = parseWorktreeList(porcelain);

    assert.strictEqual(entries.length, 3);

    assert.deepStrictEqual(entries[0], {
      path: '/home/user/project',
      head: 'abc123def456abc123def456abc123def456abcd',
      branch: 'refs/heads/main',
      isMain: true,
      isDetached: false,
      isBare: false,
      isLocked: false,
      lockReason: undefined,
      isPrunable: false,
      prunableReason: undefined,
    });

    assert.strictEqual(entries[1].path, '/home/user/project-feature');
    assert.strictEqual(entries[1].branch, 'refs/heads/feature/login');
    assert.strictEqual(entries[1].isMain, false);
    assert.strictEqual(entries[1].isDetached, false);

    assert.strictEqual(entries[2].path, '/home/user/project-detached');
    assert.strictEqual(entries[2].branch, undefined);
    assert.strictEqual(entries[2].isDetached, true);
  });

  it('parses a bare main worktree (no HEAD/branch records)', () => {
    const porcelain = ['worktree /home/user/project.git', 'bare', ''].join('\n');

    const entries = parseWorktreeList(porcelain);

    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].path, '/home/user/project.git');
    assert.strictEqual(entries[0].isBare, true);
    assert.strictEqual(entries[0].isMain, true);
    assert.strictEqual(entries[0].branch, undefined);
  });

  it('flags a locked worktree', () => {
    const porcelain = [
      'worktree /home/user/project',
      'HEAD abc123def456abc123def456abc123def456abcd',
      'branch refs/heads/main',
      '',
      'worktree /home/user/wt-locked',
      'HEAD 3333333333333333333333333333333333333333',
      'branch refs/heads/wip',
      'locked',
      '',
    ].join('\n');

    const entries = parseWorktreeList(porcelain);

    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[1].isLocked, true);
  });

  it('terminates the final record when output has no trailing blank line', () => {
    const porcelain = [
      'worktree /home/user/project',
      'HEAD abc123def456abc123def456abc123def456abcd',
      'branch refs/heads/main',
    ].join('\n');

    const entries = parseWorktreeList(porcelain);

    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].path, '/home/user/project');
    assert.strictEqual(entries[0].branch, 'refs/heads/main');
  });

  it('returns an empty list for empty output', () => {
    assert.deepStrictEqual(parseWorktreeList(''), []);
    assert.deepStrictEqual(parseWorktreeList('   \n  '), []);
  });
});

describe('parseWorktreeList — states the Worktrees list renders', () => {
  it('captures a lock reason, not just the lock', () => {
    const entries = parseWorktreeList(
      [
        'worktree /repo',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /wt/pinned',
        'HEAD bbb',
        'branch refs/heads/feature',
        'locked on a removable drive',
        '',
      ].join('\n')
    );
    assert.strictEqual(entries[1].isLocked, true);
    assert.strictEqual(entries[1].lockReason, 'on a removable drive');
  });

  it('decodes a C-quoted reason: git quotes non-ASCII, quotes and newlines', () => {
    const entries = parseWorktreeList(
      [
        'worktree /repo',
        'HEAD aaa',
        '',
        'worktree /wt/a',
        'HEAD bbb',
        'locked "caf\\303\\251 \\"B\\" drive"',
        '',
        'worktree /wt/b',
        'HEAD ccc',
        'locked "two\\nlines"',
        '',
      ].join('\n')
    );
    assert.strictEqual(entries[1].lockReason, 'café "B" drive');
    assert.strictEqual(entries[2].lockReason, 'two\nlines');
  });

  it('leaves the lock reason undefined for a bare `locked` line', () => {
    const entries = parseWorktreeList(
      ['worktree /repo', 'HEAD aaa', '', 'worktree /wt/x', 'HEAD bbb', 'locked', ''].join('\n')
    );
    assert.strictEqual(entries[1].isLocked, true);
    assert.strictEqual(entries[1].lockReason, undefined);
  });

  it('flags a prunable worktree and keeps the reason git gave', () => {
    const entries = parseWorktreeList(
      [
        'worktree /repo',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /wt/gone',
        'HEAD bbb',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n')
    );
    assert.strictEqual(entries[1].isPrunable, true);
    assert.strictEqual(entries[1].prunableReason, 'gitdir file points to non-existent location');
  });

  it('flags a bare `prunable` line with no reason', () => {
    const entries = parseWorktreeList(
      ['worktree /repo', 'HEAD aaa', '', 'worktree /wt/gone', 'prunable', ''].join('\n')
    );
    assert.strictEqual(entries[1].isPrunable, true);
    assert.strictEqual(entries[1].prunableReason, undefined);
  });

  it('reports neither lock nor prunable on an ordinary worktree', () => {
    const entries = parseWorktreeList(
      ['worktree /repo', 'HEAD aaa', 'branch refs/heads/main', ''].join('\n')
    );
    assert.strictEqual(entries[0].isLocked, false);
    assert.strictEqual(entries[0].isPrunable, false);
    assert.strictEqual(entries[0].lockReason, undefined);
    assert.strictEqual(entries[0].prunableReason, undefined);
  });
});

describe('WorktreeOps.lockWorktree / unlockWorktree argv', () => {
  it('locks with the path after --, so a hostile path cannot become a flag', async () => {
    const { ops, cli } = makeOps(() => ({ exitCode: 0 }));
    const res = await ops.lockWorktree(makeRepo('/repo'), '--upload-pack=evil');
    assert.ok(res.isOk(), 'expected Ok');
    const args = cli.executed[0];
    assert.deepStrictEqual(args.slice(0, 2), ['worktree', 'lock']);
    assert.strictEqual(args[args.length - 2], '--');
    assert.strictEqual(args[args.length - 1], '--upload-pack=evil');
  });

  it('passes a lock reason as --reason with its own value', async () => {
    const { ops, cli } = makeOps(() => ({ exitCode: 0 }));
    const res = await ops.lockWorktree(makeRepo('/repo'), '/wt/x', 'on a removable drive');
    assert.ok(res.isOk(), 'expected Ok');
    assert.deepStrictEqual(cli.executed[0], [
      'worktree',
      'lock',
      '--reason',
      'on a removable drive',
      '--',
      '/wt/x',
    ]);
  });

  it('unlocks with the path after --', async () => {
    const { ops, cli } = makeOps(() => ({ exitCode: 0 }));
    const res = await ops.unlockWorktree(makeRepo('/repo'), '/wt/x');
    assert.ok(res.isOk(), 'expected Ok');
    assert.deepStrictEqual(cli.executed[0], ['worktree', 'unlock', '--', '/wt/x']);
  });

  it('requires a non-empty path on both, with no git run', async () => {
    const { ops, cli } = makeOps(() => ({ exitCode: 0 }));
    assert.ok((await ops.lockWorktree(makeRepo('/repo'), '  ')).isErr());
    assert.ok((await ops.unlockWorktree(makeRepo('/repo'), '')).isErr());
    assert.strictEqual(cli.executed.length, 0, 'git must not run for an empty path');
  });

  it('returns a typed command-failed Err when git refuses the lock', async () => {
    const { ops } = makeOps(() => ({ exitCode: 128, stderr: 'already locked' }));
    const res = await ops.lockWorktree(makeRepo('/repo'), '/wt/x');
    assert.ok(res.isErr(), 'expected Err');
  });
});

describe('worktreesOf', () => {
  it('returns the worktree operations of a service that provides them', () => {
    const { ops } = makeOps(() => ({ exitCode: 0 }));
    assert.strictEqual(worktreesOf({ worktrees: ops }), ops);
  });

  it('refuses, by name, a git service without them', () => {
    assert.throws(() => worktreesOf({}), /worktree operations/);
  });
});

describe('WorktreeOps.addWorktree argv', () => {
  it('places a single -- before the user path and ref so a hostile path cannot become a flag', async () => {
    const { ops, cli } = makeOps(() => ({ exitCode: 0 }));

    await ops.addWorktree(makeRepo('/repo'), {
      path: '--upload-pack=evil',
      ref: 'main',
    });

    const argv = cli.executed.find((a) => a[0] === 'worktree' && a[1] === 'add');
    assert.ok(argv, 'expected a `git worktree add` invocation');

    // Layout is `worktree add -- <path> <ref>`: exactly ONE `--` ends option
    // parsing, then path and ref follow as positionals in that order. (A second
    // `--` or an `--end-of-options` token would itself be a stray positional
    // that real git rejects with a usage error.)
    const dashDashIndex = argv.indexOf('--');
    const pathIndex = argv.indexOf('--upload-pack=evil');
    const refIndex = argv.indexOf('main');
    assert.ok(dashDashIndex >= 0, 'expected -- in argv');
    assert.strictEqual(
      argv.filter((a) => a === '--').length,
      1,
      'exactly one -- separator (a second -- is a usage error)'
    );
    assert.ok(
      !argv.includes('--end-of-options'),
      '--end-of-options is rejected by git worktree add'
    );
    assert.ok(pathIndex > dashDashIndex, 'user path must follow --');
    assert.ok(refIndex > pathIndex, 'ref must follow the path');
  });

  it('adds -b <newBranch> when creating a new branch', async () => {
    const { ops, cli } = makeOps(() => ({ exitCode: 0 }));

    await ops.addWorktree(makeRepo('/repo'), {
      path: '/repo/../wt-new',
      ref: 'origin/main',
      newBranch: 'feature/x',
    });

    const argv = cli.executed.find((a) => a[0] === 'worktree' && a[1] === 'add')!;
    const bIndex = argv.indexOf('-b');
    assert.ok(bIndex >= 0, 'expected -b for new branch creation');
    assert.strictEqual(argv[bIndex + 1], 'feature/x');
  });

  it('reports a missing path first, even when the ref is also bad', async () => {
    const { ops, cli } = makeOps(() => ({ exitCode: 0 }));
    const res = await ops.addWorktree(makeRepo('/repo'), { path: '', ref: '-x' });
    assert.ok(res.isErr(), 'expected Err');
    assert.match(res._unsafeUnwrapErr().message, /path is required/i);
    assert.strictEqual(cli.executed.length, 0);
  });

  it('rejects a new branch name that looks like a flag (invalid-argument Err, no git run)', async () => {
    const { ops, cli } = makeOps(() => ({ exitCode: 0 }));
    const result = await ops.addWorktree(makeRepo('/repo'), {
      path: '/wt',
      ref: 'main',
      newBranch: '-x',
    });
    assert.ok(result.isErr());
    assert.strictEqual(result._unsafeUnwrapErr().kind, 'invalid-argument');
    assert.match(result._unsafeUnwrapErr().message, /Invalid branch name/);
    assert.strictEqual(cli.executed.length, 0, 'a rejected argument must never reach git');
  });

  it('rejects a ref that looks like a flag (invalid-argument Err)', async () => {
    const { ops, cli } = makeOps(() => ({ exitCode: 0 }));
    const result = await ops.addWorktree(makeRepo('/repo'), { path: '/wt', ref: '--evil' });
    assert.ok(result.isErr());
    assert.strictEqual(result._unsafeUnwrapErr().kind, 'invalid-argument');
    assert.match(result._unsafeUnwrapErr().message, /Invalid ref/);
    assert.strictEqual(cli.executed.length, 0);
  });

  it('requires a non-empty path (invalid-argument Err)', async () => {
    const { ops } = makeOps(() => ({ exitCode: 0 }));
    const result = await ops.addWorktree(makeRepo('/repo'), { path: '', ref: 'main' });
    assert.ok(result.isErr());
    assert.strictEqual(result._unsafeUnwrapErr().kind, 'invalid-argument');
    assert.match(result._unsafeUnwrapErr().message, /path/i);
  });

  it('returns a typed command-failed Err when git rejects the add', async () => {
    const { ops } = makeOps(() => ({ exitCode: 128, stderr: "fatal: '/wt' already exists" }));
    const result = await ops.addWorktree(makeRepo('/repo'), { path: '/wt', ref: 'main' });
    assert.ok(result.isErr());
    assert.strictEqual(result._unsafeUnwrapErr().kind, 'command-failed');
  });
});

describe('WorktreeOps.listWorktrees', () => {
  it('runs `git worktree list --porcelain` and returns parsed entries', async () => {
    const porcelain = [
      'worktree /home/user/project',
      'HEAD abc123def456abc123def456abc123def456abcd',
      'branch refs/heads/main',
      '',
    ].join('\n');
    const { ops, cli } = makeOps((args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { exitCode: 0, stdout: porcelain };
      }
      return { exitCode: 0 };
    });

    const result = await ops.listWorktrees(makeRepo('/home/user/project'));
    assert.ok(result.isOk());
    const entries = result._unsafeUnwrap();

    const argv = cli.executed.find((a) => a[0] === 'worktree' && a[1] === 'list');
    assert.ok(argv, 'expected a `git worktree list` invocation');
    assert.ok(argv.includes('--porcelain'), 'expected --porcelain flag');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].branch, 'refs/heads/main');
  });

  it('spells each worktree path the way this host spells paths', async () => {
    // Git prints `D:/a/x` on Windows; Node and VS Code spell it `D:\a\x`.
    const { ops } = makeOps(() => ({ exitCode: 0, stdout: 'worktree /home//user/project\n' }));
    const entries = (await ops.listWorktrees(makeRepo('/home/user/project')))._unsafeUnwrap();
    assert.strictEqual(entries[0].path, path.normalize('/home//user/project'));
  });

  it('returns a typed command-failed Err on git failure (not a silent empty list)', async () => {
    const { ops } = makeOps(() => ({ exitCode: 128, stderr: 'fatal' }));
    const result = await ops.listWorktrees(makeRepo('/repo'));
    assert.ok(result.isErr(), 'a git failure must surface, not masquerade as "no worktrees"');
    assert.strictEqual(result._unsafeUnwrapErr().kind, 'command-failed');
  });
});

// Real-git round-trip: the mock-based argv tests above pin the SHAPE of the
// command, but a shape-only test let a usage-rejected layout
// (`--end-of-options ... --`) ship green. This exercises the real `git`
// binary end-to-end so the argv we build is actually accepted, the directory
// lands on disk, and listWorktrees() parses the new entry back.
describe('WorktreeOps real-git round-trip', () => {
  let repoPath: string;
  let worktreeParent: string;
  let gitCli: GitCli;
  let ops: WorktreeOps;
  let repo: IRepository;

  function makeRealOps(cli: GitCli): WorktreeOps {
    const ctx = {
      get gitCli(): IGitOpsContext['gitCli'] {
        return cli;
      },
      invalidateCache(): void {},
      fireDidFetch(): void {},
    } satisfies IGitOpsContext;
    return new WorktreeOps(ctx);
  }

  beforeEach(async () => {
    repoPath = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'worktree-test-'));
    worktreeParent = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'worktree-dest-'));
    gitCli = new GitCli();
    // Force the initial branch to `main` regardless of the host's
    // init.defaultBranch so the `ref: 'main'` assertions below are deterministic.
    await gitCli.exec(['-c', 'init.defaultBranch=main', 'init'], { cwd: repoPath });
    await gitCli.exec(['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    await gitCli.exec(['config', 'user.name', 'Test User'], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'file.txt'), 'hello\n');
    await gitCli.exec(['add', '.'], { cwd: repoPath });
    await gitCli.exec(['commit', '-m', 'init'], { cwd: repoPath });
    await gitCli.exec(['branch', 'feature'], { cwd: repoPath });

    ops = makeRealOps(gitCli);
    repo = { rootUri: Uri.file(repoPath) } as unknown as IRepository;
  });

  afterEach(() => {
    for (const dir of [repoPath, worktreeParent]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  });

  it('checks out an existing branch into a new worktree directory git accepts', async () => {
    const target = path.join(worktreeParent, 'wt-existing');

    const addResult = await ops.addWorktree(repo, { path: target, ref: 'feature' });
    assert.ok(addResult.isOk(), 'addWorktree should succeed');

    assert.ok(fs.existsSync(target), 'worktree directory should exist on disk');
    assert.ok(fs.existsSync(path.join(target, 'file.txt')), 'committed file should be checked out');

    const entries = (await ops.listWorktrees(repo))._unsafeUnwrap();
    const added = entries.find(isAt(target));
    assert.ok(added, 'listWorktrees should return the newly added worktree');
    assert.strictEqual(added.branch, 'refs/heads/feature');
    assert.strictEqual(added.isMain, false);
  });

  it('creates a new branch in the worktree with -b', async () => {
    const target = path.join(worktreeParent, 'wt-newbranch');

    const addResult = await ops.addWorktree(repo, {
      path: target,
      ref: 'main',
      newBranch: 'spawned',
    });
    assert.ok(addResult.isOk(), 'addWorktree should succeed');

    assert.ok(fs.existsSync(target), 'worktree directory should exist on disk');

    const entries = (await ops.listWorktrees(repo))._unsafeUnwrap();
    const added = entries.find(isAt(target));
    assert.ok(added, 'listWorktrees should return the newly added worktree');
    assert.strictEqual(added.branch, 'refs/heads/spawned');
  });

  it('removes a clean linked worktree from disk and from the list', async () => {
    const target = path.join(worktreeParent, 'wt-remove');
    (await ops.addWorktree(repo, { path: target, ref: 'feature' }))._unsafeUnwrap();
    assert.ok(fs.existsSync(target));

    const removed = await ops.removeWorktree(repo, target);
    assert.ok(removed.isOk(), 'removeWorktree should succeed on a clean worktree');
    assert.ok(!fs.existsSync(target), 'worktree directory should be gone');

    const entries = (await ops.listWorktrees(repo))._unsafeUnwrap();
    assert.ok(
      !entries.some((e) => e.path.endsWith('wt-remove')),
      'removed worktree must not be listed'
    );
  });

  it('refuses a dirty worktree without force, removes it with force', async () => {
    const target = path.join(worktreeParent, 'wt-dirty');
    (await ops.addWorktree(repo, { path: target, ref: 'feature' }))._unsafeUnwrap();
    fs.writeFileSync(path.join(target, 'untracked.txt'), 'dirt');

    const refused = await ops.removeWorktree(repo, target);
    assert.ok(refused.isErr(), 'a dirty worktree must be refused without force');
    assert.match(refused._unsafeUnwrapErr().message, /force/i);

    const forced = await ops.removeWorktree(repo, target, 'discardChanges');
    assert.ok(forced.isOk(), 'force removal should succeed');
    assert.ok(!fs.existsSync(target));
  });

  it('removes a locked worktree only when told to override the lock', async () => {
    const target = path.join(worktreeParent, 'wt-locked');
    (await ops.addWorktree(repo, { path: target, ref: 'feature' }))._unsafeUnwrap();
    (await ops.lockWorktree(repo, target, 'on a USB disk'))._unsafeUnwrap();

    const plain = await ops.removeWorktree(repo, target, 'discardChanges');
    assert.ok(plain.isErr(), 'forcing past changes alone must not remove a locked worktree');
    assert.match(plain._unsafeUnwrapErr().message, /locked/i);

    const overridden = await ops.removeWorktree(repo, target, 'overrideLock');
    assert.ok(overridden.isOk(), 'overriding the lock should remove it');
    assert.ok(!fs.existsSync(target));
  });

  it('removes the record of a worktree whose folder is already gone', async () => {
    const target = path.join(worktreeParent, 'wt-vanished');
    (await ops.addWorktree(repo, { path: target, ref: 'feature' }))._unsafeUnwrap();
    fs.rmSync(target, { recursive: true, force: true });

    const removed = await ops.removeWorktree(repo, target);
    assert.ok(removed.isOk(), `remove: ${removed.isErr() ? removed.error.message : ''}`);
    const entries = (await ops.listWorktrees(repo))._unsafeUnwrap();
    assert.ok(!entries.some((e) => e.path.endsWith('wt-vanished')), 'the record is gone');
  });

  it('reports whether a worktree has uncommitted changes', async () => {
    const target = path.join(worktreeParent, 'wt-status');
    (await ops.addWorktree(repo, { path: target, ref: 'feature' }))._unsafeUnwrap();
    assert.strictEqual((await ops.hasUncommittedChanges(target))._unsafeUnwrap(), false);
    fs.writeFileSync(path.join(target, 'untracked.txt'), 'new');
    assert.strictEqual((await ops.hasUncommittedChanges(target))._unsafeUnwrap(), true);
  });

  it('overriding a lock also discards uncommitted changes, so callers must say so', async () => {
    const target = path.join(worktreeParent, 'wt-locked-dirty');
    (await ops.addWorktree(repo, { path: target, ref: 'feature' }))._unsafeUnwrap();
    fs.writeFileSync(path.join(target, 'untracked.txt'), 'work in progress');
    (await ops.lockWorktree(repo, target))._unsafeUnwrap();

    assert.ok((await ops.removeWorktree(repo, target, 'overrideLock')).isOk());
    assert.ok(!fs.existsSync(target), 'the uncommitted file went with it');
  });

  it('round-trips a lock with its reason, and unlocks it again', async () => {
    const target = path.join(worktreeParent, 'wt-lock');
    assert.ok((await ops.addWorktree(repo, { path: target, ref: 'feature' })).isOk());

    assert.ok((await ops.lockWorktree(repo, target, 'on a removable drive')).isOk());
    const locked = await ops.listWorktrees(repo);
    assert.ok(locked.isOk(), 'expected Ok');
    const lockedEntry = locked._unsafeUnwrap().find(isAt(target));
    assert.ok(lockedEntry, 'the locked worktree must still be listed');
    assert.strictEqual(lockedEntry.isLocked, true);
    assert.strictEqual(lockedEntry.lockReason, 'on a removable drive');

    assert.ok((await ops.unlockWorktree(repo, target)).isOk());
    const unlocked = await ops.listWorktrees(repo);
    assert.ok(unlocked.isOk(), 'expected Ok');
    const unlockedEntry = unlocked._unsafeUnwrap().find(isAt(target));
    assert.ok(unlockedEntry, 'the unlocked worktree must still be listed');
    assert.strictEqual(unlockedEntry.isLocked, false);
    assert.strictEqual(unlockedEntry.lockReason, undefined);
  });

  it('reads back a reason git has to quote exactly as it was given', async () => {
    const target = path.join(worktreeParent, 'wt-quoted');
    assert.ok((await ops.addWorktree(repo, { path: target, ref: 'feature' })).isOk());
    const reason = 'café "B" drive';
    assert.ok((await ops.lockWorktree(repo, target, reason)).isOk());
    const listed = await ops.listWorktrees(repo);
    assert.ok(listed.isOk(), 'expected Ok');
    const entry = listed._unsafeUnwrap().find(isAt(target));
    assert.strictEqual(entry?.lockReason, reason);
  });

  it('refuses to unlock a worktree that is not locked', async () => {
    const target = path.join(worktreeParent, 'wt-not-locked');
    assert.ok((await ops.addWorktree(repo, { path: target, ref: 'feature' })).isOk());
    const res = await ops.unlockWorktree(repo, target);
    assert.ok(res.isErr(), 'git refuses this, and the Err must surface');
  });

  it('reports a worktree whose directory vanished as prunable', async () => {
    const target = path.join(worktreeParent, 'wt-vanished');
    assert.ok((await ops.addWorktree(repo, { path: target, ref: 'feature' })).isOk());
    fs.rmSync(target, { recursive: true, force: true });

    const listed = await ops.listWorktrees(repo);
    assert.ok(listed.isOk(), 'expected Ok');
    const gone = listed._unsafeUnwrap().find(isAt(target));
    assert.ok(gone, 'git still lists the stale record until pruned');
    assert.strictEqual(gone.isPrunable, true);
    assert.ok(
      (gone.prunableReason ?? '').length > 0,
      'git states why, and the list shows that text'
    );
  });

  it('prunes a stale record after the worktree directory is deleted manually', async () => {
    const target = path.join(worktreeParent, 'wt-stale');
    (await ops.addWorktree(repo, { path: target, ref: 'feature' }))._unsafeUnwrap();
    fs.rmSync(target, { recursive: true, force: true });

    const before = (await ops.listWorktrees(repo))._unsafeUnwrap();
    assert.ok(
      before.some((e) => e.path.endsWith('wt-stale')),
      'stale record still listed before prune'
    );

    (await ops.pruneWorktrees(repo))._unsafeUnwrap();

    const after = (await ops.listWorktrees(repo))._unsafeUnwrap();
    assert.ok(!after.some((e) => e.path.endsWith('wt-stale')), 'stale record must be pruned');
  });
});

describe('WorktreeOps.removeWorktree argv', () => {
  it('places a single -- before the user path so a hostile path cannot become a flag', async () => {
    const { ops, cli } = makeOps(() => ({ exitCode: 0 }));

    await ops.removeWorktree(makeRepo('/repo'), '--upload-pack=evil');

    const argv = cli.executed.find((a) => a[0] === 'worktree' && a[1] === 'remove');
    assert.ok(argv, 'expected a `git worktree remove` invocation');
    const dashDashIndex = argv.indexOf('--');
    const pathIndex = argv.indexOf('--upload-pack=evil');
    assert.ok(dashDashIndex >= 0, 'expected -- in argv');
    assert.strictEqual(argv.filter((a) => a === '--').length, 1, 'exactly one -- separator');
    assert.ok(pathIndex > dashDashIndex, 'user path must follow --');
    assert.ok(!argv.includes('--force'), 'no --force unless requested');
  });

  it('adds --force before the -- when forced', async () => {
    const { ops, cli } = makeOps(() => ({ exitCode: 0 }));

    await ops.removeWorktree(makeRepo('/repo'), '/wt', 'discardChanges');

    const argv = cli.executed.find((a) => a[0] === 'worktree' && a[1] === 'remove')!;
    const forceIndex = argv.indexOf('--force');
    const dashDashIndex = argv.indexOf('--');
    assert.ok(forceIndex >= 0, 'expected --force');
    assert.ok(forceIndex < dashDashIndex, '--force must precede the -- separator');
  });

  it('passes --force twice before the -- to override a lock', async () => {
    const { ops, cli } = makeOps(() => ({ exitCode: 0 }));

    await ops.removeWorktree(makeRepo('/repo'), '/wt', 'overrideLock');

    const argv = cli.executed.find((a) => a[0] === 'worktree' && a[1] === 'remove')!;
    assert.deepStrictEqual(argv.slice(0, argv.indexOf('--')), [
      'worktree',
      'remove',
      '--force',
      '--force',
    ]);
  });

  it('requires a non-empty path (invalid-argument Err, no git run)', async () => {
    const { ops, cli } = makeOps(() => ({ exitCode: 0 }));
    const result = await ops.removeWorktree(makeRepo('/repo'), '   ');
    assert.ok(result.isErr());
    assert.strictEqual(result._unsafeUnwrapErr().kind, 'invalid-argument');
    assert.strictEqual(cli.executed.length, 0, 'a rejected argument must never reach git');
  });

  it('returns a typed command-failed Err when git refuses (dirty worktree)', async () => {
    const { ops } = makeOps(() => ({
      exitCode: 128,
      stderr: "fatal: '/wt' contains modified or untracked files, use --force to delete it",
    }));
    const result = await ops.removeWorktree(makeRepo('/repo'), '/wt');
    assert.ok(result.isErr());
    assert.strictEqual(result._unsafeUnwrapErr().kind, 'command-failed');
    assert.match(result._unsafeUnwrapErr().message, /--force/);
  });
});

describe('WorktreeOps.pruneWorktrees', () => {
  it('runs `git worktree prune`', async () => {
    const { ops, cli } = makeOps(() => ({ exitCode: 0 }));
    const result = await ops.pruneWorktrees(makeRepo('/repo'));
    assert.ok(result.isOk());
    assert.deepStrictEqual(cli.executed[0], ['worktree', 'prune']);
  });

  it('returns a typed command-failed Err on failure', async () => {
    const { ops } = makeOps(() => ({ exitCode: 128, stderr: 'fatal: bad state' }));
    const result = await ops.pruneWorktrees(makeRepo('/repo'));
    assert.ok(result.isErr());
    assert.strictEqual(result._unsafeUnwrapErr().kind, 'command-failed');
  });
});
