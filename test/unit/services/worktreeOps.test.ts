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
import * as os from 'os';
import * as path from 'path';
import { WorktreeOps, parseWorktreeList } from '../../../src/git-core/ops/WorktreeOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { GitCli, GitCommandError } from '../../../src/git-core/gitCli';
import { Uri } from '../../mocks/vscode';

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
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
    worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-dest-'));
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
    const added = entries.find((e) => fs.realpathSync(e.path) === fs.realpathSync(target));
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
    const added = entries.find((e) => fs.realpathSync(e.path) === fs.realpathSync(target));
    assert.ok(added, 'listWorktrees should return the newly added worktree');
    assert.strictEqual(added.branch, 'refs/heads/spawned');
  });
});
