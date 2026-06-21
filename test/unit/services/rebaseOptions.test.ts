/**
 * P2 — rebase options (IntelliJ git4idea GitRebaseOption parity).
 *
 * git4idea's options popup (`GitRebaseOption.kt` / `REBASE_FLAGS`) lets the
 * user pass `--rebase-merges`, `--keep-empty`, `--root`, `--update-refs`, and
 * `--autosquash` to a non-interactive rebase. We had only the bare
 * `git rebase <onto>`. `rebaseBranch` now accepts an optional `IRebaseOptions`
 * and splices the corresponding flags; legacy callers (no options) are
 * unchanged.
 *
 * These assert the exact argv emitted to git — the flags must land between the
 * `rebase` subcommand and the `--end-of-options <onto>` ref guard, never after
 * it (a flag after `--end-of-options` would be treated as a path).
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService } from '../../../src/git-core/GitService';
import { GitCli } from '../../../src/git-core/gitCli';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

class ScriptedGitCli {
  public scripted: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
  public executed: Array<{ args: string[] }> = [];

  private _onCommandExecuted = {
    event: (): { dispose: () => void } => ({ dispose: (): void => {} }),
  };

  get onCommandExecuted(): () => { dispose: () => void } {
    return this._onCommandExecuted.event;
  }

  async exec(
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.executed.push({ args: [...args] });
    const next = this.scripted.shift();
    if (!next) {
      throw new Error(`ScriptedGitCli ran out of scripted results at: git ${args.join(' ')}`);
    }
    return { ...next, combined: next.stdout + next.stderr };
  }

  async getRepositoryRoot(path: string): Promise<string | undefined> {
    return path;
  }

  dispose(): void {}
}

function createGitServiceWithCli(cli: ScriptedGitCli): GitService {
  const gitService = new GitService();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  (gitService as any)._gitCli = cli;
  return gitService;
}

function createMockRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: undefined,
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

/** Push a clean rebase (exit 0) + clean status, so rebaseBranch returns ok. */
function scriptCleanRebase(cli: ScriptedGitCli): void {
  cli.scripted.push({ exitCode: 0, stdout: '', stderr: '' }); // rebase
  cli.scripted.push({ exitCode: 0, stdout: '', stderr: '' }); // status --porcelain
}

/** Push a `git --version` banner result (consumed by the --update-refs guard). */
function scriptGitVersion(cli: ScriptedGitCli, banner = 'git version 2.50.1'): void {
  cli.scripted.push({ exitCode: 0, stdout: banner, stderr: '' });
}

describe('GitService.rebaseBranch — options (#P2 git4idea GitRebaseOption)', () => {
  it('emits the bare autostash rebase when no options are given (legacy unchanged)', async () => {
    const cli = new ScriptedGitCli();
    scriptCleanRebase(cli);
    await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'origin/main');
    assert.deepStrictEqual(cli.executed[0].args, [
      'rebase',
      '--autostash',
      '--end-of-options',
      'origin/main',
    ]);
  });

  it('splices --rebase-merges before the ref guard', async () => {
    const cli = new ScriptedGitCli();
    scriptCleanRebase(cli);
    await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'origin/main', {
      rebaseMerges: true,
    });
    assert.deepStrictEqual(cli.executed[0].args, [
      'rebase',
      '--autostash',
      '--rebase-merges',
      '--end-of-options',
      'origin/main',
    ]);
  });

  it('combines update-refs + autosquash + keep-empty in git4idea declaration order', async () => {
    const cli = new ScriptedGitCli();
    // updateRefs triggers a `git --version` pre-flight guard; script a modern
    // banner so the flag passes through.
    scriptGitVersion(cli);
    scriptCleanRebase(cli);
    await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'feature', {
      keepEmpty: true,
      updateRefs: true,
      autosquash: true,
    });
    const rebaseCall = cli.executed.find((c) => c.args[0] === 'rebase');
    assert.ok(rebaseCall, 'a rebase should have been executed');
    assert.deepStrictEqual(rebaseCall.args, [
      'rebase',
      '--autostash',
      '--keep-empty',
      '--update-refs',
      '--autosquash',
      '--end-of-options',
      'feature',
    ]);
  });

  // M6 — `git rebase --update-refs` HARD-ERRORS on git < 2.38 ("unknown option
  // `update-refs'"). Refuse it with a clear, pre-flight reason instead of
  // passing it blindly and letting git abort with a cryptic message.
  it('refuses --update-refs on git < 2.38 with a clear reason and never runs the rebase', async () => {
    const cli = new ScriptedGitCli();
    scriptGitVersion(cli, 'git version 2.25.1');
    const result = await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'feature', {
      updateRefs: true,
    });
    assert.strictEqual(result.success, false, 'must fail rather than run an unsupported flag');
    assert.ok(
      /2\.38/.test(result.failureReason ?? ''),
      `failureReason should name the required version; got: ${result.failureReason}`
    );
    assert.ok(
      !cli.executed.some((c) => c.args[0] === 'rebase'),
      'the rebase must NOT run when --update-refs is unsupported'
    );
  });

  it('allows --update-refs on git >= 2.38', async () => {
    const cli = new ScriptedGitCli();
    scriptGitVersion(cli, 'git version 2.38.0');
    scriptCleanRebase(cli);
    const result = await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'feature', {
      updateRefs: true,
    });
    assert.strictEqual(result.success, true);
    const rebaseCall = cli.executed.find((c) => c.args[0] === 'rebase');
    assert.ok(
      rebaseCall?.args.includes('--update-refs'),
      '--update-refs must be passed on new git'
    );
  });

  it('with --root, omits the onto ref (git4idea disables the upstream field)', async () => {
    const cli = new ScriptedGitCli();
    scriptCleanRebase(cli);
    await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'main', { root: true });
    // --root rebases from the root commit; no upstream/onto ref is passed.
    assert.deepStrictEqual(cli.executed[0].args, ['rebase', '--autostash', '--root']);
  });

  it('still returns success on a clean rebase with options', async () => {
    const cli = new ScriptedGitCli();
    scriptCleanRebase(cli);
    const result = await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'main', {
      rebaseMerges: true,
    });
    assert.strictEqual(result.success, true);
  });
});

// The argv-shape tests above prove the flag is emitted; this round-trip proves
// the emitted command actually squashes — `git rebase --autosquash` applies
// `fixup!`/`squash!` commits non-interactively on modern git (no `-i` needed),
// the verified behavior we lock against regression.
describe('GitService.rebaseBranch — autosquash real-git round-trip', () => {
  let repoPath: string;
  let gitCli: GitCli;
  let gitService: GitService;
  let repo: IRepository;
  let savedSeqEditor: string | undefined;
  let savedEditor: string | undefined;

  beforeEach(async () => {
    // Belt-and-suspenders: if a host git ever wants an editor, make it a no-op
    // so the test can never hang waiting on interactive input.
    savedSeqEditor = process.env.GIT_SEQUENCE_EDITOR;
    savedEditor = process.env.GIT_EDITOR;
    process.env.GIT_SEQUENCE_EDITOR = 'true';
    process.env.GIT_EDITOR = 'true';

    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-autosquash-'));
    gitCli = new GitCli();
    await gitCli.exec(['-c', 'init.defaultBranch=main', 'init'], { cwd: repoPath });
    await gitCli.exec(['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    await gitCli.exec(['config', 'user.name', 'Test User'], { cwd: repoPath });

    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'a\n');
    await gitCli.exec(['add', '.'], { cwd: repoPath });
    await gitCli.exec(['commit', '-m', 'base'], { cwd: repoPath });

    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'a\nb\n');
    await gitCli.exec(['add', '.'], { cwd: repoPath });
    await gitCli.exec(['commit', '-m', 'feat: thing'], { cwd: repoPath });

    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'a\nb\nc\n');
    await gitCli.exec(['add', '.'], { cwd: repoPath });
    await gitCli.exec(['commit', '-m', 'fixup! feat: thing'], { cwd: repoPath });

    gitService = new GitService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = gitCli;
    repo = { rootUri: Uri.file(repoPath) } as unknown as IRepository;
  });

  afterEach(() => {
    process.env.GIT_SEQUENCE_EDITOR = savedSeqEditor;
    process.env.GIT_EDITOR = savedEditor;
    if (savedSeqEditor === undefined) {
      delete process.env.GIT_SEQUENCE_EDITOR;
    }
    if (savedEditor === undefined) {
      delete process.env.GIT_EDITOR;
    }
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it('squashes a fixup! commit into its target (count drops, fixup! gone)', async () => {
    const base = (await gitCli.exec(['rev-parse', 'HEAD~2'], { cwd: repoPath })).stdout.trim();

    const before = (
      await gitCli.exec(['rev-list', '--count', `${base}..HEAD`], { cwd: repoPath })
    ).stdout.trim();
    assert.strictEqual(before, '2', 'precondition: feat + fixup commits sit above base');

    const result = await gitService.rebaseBranch(repo, base, { autosquash: true });
    assert.strictEqual(result.success, true, 'autosquash rebase should complete cleanly');

    const after = (
      await gitCli.exec(['rev-list', '--count', `${base}..HEAD`], { cwd: repoPath })
    ).stdout.trim();
    assert.strictEqual(after, '1', 'the fixup must be melded — one commit left above base');

    const subjects = (await gitCli.exec(['log', '--format=%s', `${base}..HEAD`], { cwd: repoPath }))
      .stdout;
    assert.ok(!/fixup!/.test(subjects), `no fixup! subject should remain, got: ${subjects}`);
  });
});

// M6 — the remaining git4idea rebase flags were pinned ONLY by argv-shape
// tests (ScriptedGitCli proves the flag is emitted). These real-git
// round-trips prove each flag is OBSERVABLY honored by the running git.
//
// Version caveats (handled / documented):
//  - `--keep-empty` needs the merge backend (default since git 2.26); under
//    `rebase.backend=apply` it silently no-ops. The test env (git 2.50) uses
//    the merge backend, so the round-trip is reliable here.
//  - `--update-refs` HARD-ERRORS on git < 2.38 — guarded by `rebaseBranch`'s
//    pre-flight check (see the argv-shape suite); this round-trip runs on the
//    test env's git ≥ 2.38.
describe('GitService.rebaseBranch — option flags real-git round-trips', () => {
  let repoPath: string;
  let gitCli: GitCli;
  let gitService: GitService;
  let repo: IRepository;
  let savedSeqEditor: string | undefined;
  let savedEditor: string | undefined;

  async function git(...args: string[]): Promise<string> {
    return (await gitCli.exec(args, { cwd: repoPath })).stdout.trim();
  }

  async function writeAddCommit(file: string, content: string, message: string): Promise<void> {
    fs.writeFileSync(path.join(repoPath, file), content);
    await gitCli.exec(['add', '.'], { cwd: repoPath });
    await gitCli.exec(['commit', '-m', message], { cwd: repoPath });
  }

  beforeEach(async () => {
    // Belt-and-suspenders: pin a no-op editor so a host git never hangs on
    // interactive input during the interactive-backend replays these flags use.
    savedSeqEditor = process.env.GIT_SEQUENCE_EDITOR;
    savedEditor = process.env.GIT_EDITOR;
    process.env.GIT_SEQUENCE_EDITOR = 'true';
    process.env.GIT_EDITOR = 'true';

    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-flags-'));
    gitCli = new GitCli();
    await gitCli.exec(['-c', 'init.defaultBranch=main', 'init'], { cwd: repoPath });
    await gitCli.exec(['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    await gitCli.exec(['config', 'user.name', 'Test User'], { cwd: repoPath });

    gitService = new GitService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = gitCli;
    repo = { rootUri: Uri.file(repoPath) } as unknown as IRepository;
  });

  afterEach(() => {
    process.env.GIT_SEQUENCE_EDITOR = savedSeqEditor;
    process.env.GIT_EDITOR = savedEditor;
    if (savedSeqEditor === undefined) {
      delete process.env.GIT_SEQUENCE_EDITOR;
    }
    if (savedEditor === undefined) {
      delete process.env.GIT_EDITOR;
    }
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it('--rebase-merges preserves a merge commit that a plain rebase would flatten', async () => {
    await writeAddCommit('f.txt', 'A\n', 'A');
    await git('checkout', '-b', 'feature');
    await writeAddCommit('f.txt', 'A\nB\n', 'B');
    await git('checkout', '-b', 'sub');
    await writeAddCommit('g.txt', 'C\n', 'C');
    await git('checkout', 'feature');
    await gitCli.exec(['merge', '--no-ff', '-m', 'Merge sub', 'sub'], { cwd: repoPath });
    await git('checkout', 'main');
    await writeAddCommit('d.txt', 'D\n', 'D');
    await git('checkout', 'feature');

    assert.strictEqual(
      await git('rev-list', '--merges', '--count', 'main..HEAD'),
      '1',
      'precondition: a merge commit sits in the range to be rebased'
    );

    const result = await gitService.rebaseBranch(repo, 'main', { rebaseMerges: true });
    assert.strictEqual(result.success, true, 'rebase --rebase-merges should complete cleanly');

    assert.strictEqual(
      await git('rev-list', '--merges', '--count', 'main..HEAD'),
      '1',
      'the merge topology must be preserved (a plain rebase would flatten it to 0)'
    );
  });

  // --keep-empty needs a NEGATIVE CONTROL or it is a tautology: under the merge
  // backend (default on git ≥ 2.26) a start-empty commit is KEPT regardless of
  // the flag, so a "flag → kept" assertion passes even if the flag is a no-op.
  // We therefore force `rebase.backend=apply`, where the default DROPS a
  // start-empty commit, and contrast:
  //   - negative control (no `--keep-empty`)  → the empty commit is DROPPED;
  //   - positive (`{ keepEmpty: true }`)       → the empty commit is KEPT.
  // The positive arm now genuinely goes RED if `rebaseOptionFlags` stopped
  // emitting `--keep-empty` (the apply default would drop it → count 0).
  //
  // Builds a fresh start-empty repo each arm so the two are independent.
  async function buildStartEmptyApplyRepo(): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-keepempty-'));
    await gitCli.exec(['-c', 'init.defaultBranch=main', 'init'], { cwd: dir });
    await gitCli.exec(['config', 'user.email', 'test@example.com'], { cwd: dir });
    await gitCli.exec(['config', 'user.name', 'Test User'], { cwd: dir });
    // The apply backend is where `--keep-empty` is load-bearing: its default
    // drops a start-empty commit (the merge backend keeps it either way).
    await gitCli.exec(['config', 'rebase.backend', 'apply'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'f.txt'), 'A\n');
    await gitCli.exec(['add', '.'], { cwd: dir });
    await gitCli.exec(['commit', '-m', 'A'], { cwd: dir });
    await gitCli.exec(['checkout', '-b', 'feature'], { cwd: dir });
    await gitCli.exec(['commit', '--allow-empty', '-m', 'EMPTY placeholder'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'f.txt'), 'A\nB\n');
    await gitCli.exec(['add', '.'], { cwd: dir });
    await gitCli.exec(['commit', '-m', 'B'], { cwd: dir });
    await gitCli.exec(['checkout', 'main'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'd.txt'), 'D\n');
    await gitCli.exec(['add', '.'], { cwd: dir });
    await gitCli.exec(['commit', '-m', 'D'], { cwd: dir });
    await gitCli.exec(['checkout', 'feature'], { cwd: dir });
    return dir;
  }

  async function emptyCount(dir: string): Promise<number> {
    const out = (await gitCli.exec(['log', '--format=%s', 'main..HEAD'], { cwd: dir })).stdout;
    return (out.match(/EMPTY placeholder/g) ?? []).length;
  }

  it('--keep-empty NEGATIVE CONTROL: without it the apply backend DROPS a start-empty commit', async () => {
    const dir = await buildStartEmptyApplyRepo();
    try {
      // Same rebase the extension would run, minus the flag (here made explicit
      // via --no-keep-empty so the apply default is unambiguous).
      await gitCli.exec(['rebase', '--autostash', '--no-keep-empty', '--end-of-options', 'main'], {
        cwd: dir,
      });
      assert.strictEqual(
        await emptyCount(dir),
        0,
        'baseline: the empty commit must be dropped when --keep-empty is absent'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--keep-empty POSITIVE: it retains the start-empty commit the baseline drops', async () => {
    const dir = await buildStartEmptyApplyRepo();
    try {
      const dirRepo = { rootUri: Uri.file(dir) } as unknown as IRepository;
      const result = await gitService.rebaseBranch(dirRepo, 'main', { keepEmpty: true });
      assert.strictEqual(result.success, true, 'rebase --keep-empty should complete cleanly');
      assert.strictEqual(
        await emptyCount(dir),
        1,
        'the empty commit must survive --keep-empty (RED here if the flag were a no-op)'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--update-refs advances an intermediate branch to follow the rebased commits', async () => {
    await writeAddCommit('f.txt', 'A\n', 'A');
    await git('checkout', '-b', 'feature');
    await writeAddCommit('f.txt', 'A\nB\n', 'B');
    await git('branch', 'mid'); // mid points at B
    await writeAddCommit('f.txt', 'A\nB\nC\n', 'C');
    await git('checkout', 'main');
    await writeAddCommit('d.txt', 'D\n', 'D');
    await git('checkout', 'feature');

    const midBefore = await git('rev-parse', 'mid');

    const result = await gitService.rebaseBranch(repo, 'main', { updateRefs: true });
    assert.strictEqual(result.success, true, 'rebase --update-refs should complete cleanly');

    const midAfter = await git('rev-parse', 'mid');
    assert.notStrictEqual(midAfter, midBefore, 'mid must be rewritten to the rebased B');
    // mid (rewritten B) must now sit on the rebased feature line.
    const isAncestor = await gitCli.exec(['merge-base', '--is-ancestor', 'mid', 'feature'], {
      cwd: repoPath,
    });
    assert.strictEqual(isAncestor.exitCode, 0, 'mid must be an ancestor of the rebased feature');
  });

  it('--root replays the root commit (a fixup! into root melds non-interactively)', async () => {
    await writeAddCommit('f.txt', 'A\n', 'root commit');
    await writeAddCommit('g.txt', 'B\n', 'second');
    await writeAddCommit('f.txt', 'A2\n', 'fixup! root commit');

    assert.strictEqual(await git('rev-list', '--count', 'HEAD'), '3', 'precondition: 3 commits');

    // --root rebases from the very first commit (no upstream); autosquash melds
    // the fixup! into the root, which is only reachable because of --root.
    const result = await gitService.rebaseBranch(repo, 'main', { root: true, autosquash: true });
    assert.strictEqual(result.success, true, 'rebase --root --autosquash should complete cleanly');

    assert.strictEqual(
      await git('rev-list', '--count', 'HEAD'),
      '2',
      'the fixup! must meld into the (now replayed) root commit'
    );
    assert.ok(
      !/fixup!/.test(await git('log', '--format=%s')),
      'no fixup! subject should remain after the root autosquash'
    );
  });
});
