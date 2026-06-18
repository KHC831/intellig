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
import { GitService } from '../../../git-core/GitService';
import { GitCli } from '../../../git-core/gitCli';
import { IRepository } from '../../../git-core/interfaces/IGitService';
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
    scriptCleanRebase(cli);
    await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'feature', {
      keepEmpty: true,
      updateRefs: true,
      autosquash: true,
    });
    assert.deepStrictEqual(cli.executed[0].args, [
      'rebase',
      '--autostash',
      '--keep-empty',
      '--update-refs',
      '--autosquash',
      '--end-of-options',
      'feature',
    ]);
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
