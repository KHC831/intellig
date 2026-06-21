/**
 * Pin every ref-consuming GitService method to argv-injection
 * safety. Each test passes a `--upload-pack=evil`-shaped ref and asserts
 * the recorded argv carries `--end-of-options` BEFORE that ref.
 *
 * Pre-migration argv lacks `--end-of-options`, so a ref with a
 * `--`-prefix would land as a git flag. Post-migration the structural
 * helper {@link buildGitArgs} interleaves `--end-of-options` between
 * flag args and ref args.
 *
 * The ~15 methods covered here are the ones the comprehensive review
 * Flagged as ref-consumers. Methods that take ONLY paths
 * (e.g. `stage`, `unstage`) or ONLY a remote name (`fetch`) are
 * out-of-scope; their args don't touch the user-controlled-ref path.
 */

import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

const HOSTILE_REF = '--upload-pack=evil';

class MockGitCli {
  public executedCommands: { args: string[]; options: unknown }[] = [];
  public mockResults: Map<string, { exitCode: number; stdout: string; stderr: string }> = new Map();
  public mockResultsByPrefix: Map<string, { exitCode: number; stdout: string; stderr: string }> =
    new Map();
  private _onCommandExecuted = {
    event: (): { dispose: () => void } => ({ dispose: (): void => {} }),
  };

  get onCommandExecuted(): () => { dispose: () => void } {
    return this._onCommandExecuted.event;
  }

  async exec(
    args: string[],
    options: { cwd?: string; throwOnError?: boolean; input?: string } = {}
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.executedCommands.push({ args, options });
    const commandKey = args.join(' ');
    let mockResult = this.mockResults.get(commandKey);
    if (!mockResult) {
      for (const [prefix, result] of this.mockResultsByPrefix) {
        if (commandKey.startsWith(prefix)) {
          mockResult = result;
          break;
        }
      }
    }
    if (mockResult) {
      if (options.throwOnError && mockResult.exitCode !== 0) {
        throw new Error(`Git command failed: ${mockResult.stderr}`);
      }
      return { ...mockResult, combined: mockResult.stdout + mockResult.stderr };
    }
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

  async getRepositoryRoot(path: string): Promise<string | undefined> {
    return path;
  }

  dispose(): void {}

  setMockResult(
    command: string,
    result: { exitCode: number; stdout: string; stderr: string }
  ): void {
    this.mockResults.set(command, result);
  }

  setMockResultByPrefix(
    prefix: string,
    result: { exitCode: number; stdout: string; stderr: string }
  ): void {
    this.mockResultsByPrefix.set(prefix, result);
  }

  // Find first command matching the given subcommand prefix.
  findCommand(subcommandPrefix: string): { args: string[]; options: unknown } | undefined {
    return this.executedCommands.find((c) => c.args.join(' ').startsWith(subcommandPrefix));
  }

  reset(): void {
    this.executedCommands = [];
  }
}

/** Assert argv carries --end-of-options BEFORE the hostile ref. */
function assertEndOfOptionsBeforeRef(args: string[], ref: string, where: string): void {
  const eooIdx = args.indexOf('--end-of-options');
  const refIdx = args.indexOf(ref);
  assert.ok(
    eooIdx >= 0,
    `[${where}] expected --end-of-options separator, argv=${JSON.stringify(args)}`
  );
  assert.ok(refIdx >= 0, `[${where}] expected ref ${ref} in argv=${JSON.stringify(args)}`);
  assert.ok(
    refIdx > eooIdx,
    `[${where}] expected ref AFTER --end-of-options; eoo=${eooIdx}, ref=${refIdx}, argv=${JSON.stringify(args)}`
  );
}

describe('Wave I — GitService argv-injection safety', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    gitService = new GitService();
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  describe('checkout()', () => {
    it('separates checkout ref with --end-of-options', async () => {
      await gitService.checkout(mockRepo, HOSTILE_REF);
      const cmd = mockGitCli.findCommand('checkout');
      assert.ok(cmd, 'checkout command must be issued');
      assertEndOfOptionsBeforeRef(cmd.args, HOSTILE_REF, 'checkout');
    });

    it('separates startPoint refs in createBranch + checkout', async () => {
      await gitService.createBranch(mockRepo, 'feature', HOSTILE_REF);
      const cmd = mockGitCli.findCommand('branch');
      assert.ok(cmd, 'branch command must be issued');
      assertEndOfOptionsBeforeRef(cmd.args, HOSTILE_REF, 'createBranch.startPoint');
    });
  });

  describe('mergeBranch()', () => {
    it('separates merge target with --end-of-options', async () => {
      await gitService.mergeBranch(mockRepo, HOSTILE_REF);
      const cmd = mockGitCli.findCommand('merge');
      assert.ok(cmd, 'merge command must be issued');
      assertEndOfOptionsBeforeRef(cmd.args, HOSTILE_REF, 'mergeBranch');
    });
  });

  describe('rebaseBranch()', () => {
    it('separates rebase onto with --end-of-options', async () => {
      await gitService.rebaseBranch(mockRepo, HOSTILE_REF);
      const cmd = mockGitCli.findCommand('rebase');
      assert.ok(cmd, 'rebase command must be issued');
      assertEndOfOptionsBeforeRef(cmd.args, HOSTILE_REF, 'rebaseBranch');
    });
  });

  describe('compareBranches()', () => {
    it('separates branch1/branch2 in rev-list/log/diff', async () => {
      mockGitCli.setMockResultByPrefix('rev-list --left-right', {
        exitCode: 0,
        stdout: '1\t1',
        stderr: '',
      });
      mockGitCli.setMockResultByPrefix('log', { exitCode: 0, stdout: '', stderr: '' });
      mockGitCli.setMockResultByPrefix('diff', { exitCode: 0, stdout: '', stderr: '' });

      await gitService.compareBranches(mockRepo, HOSTILE_REF, 'main');

      // compareBranches concatenates branch1+branch2 into a single
      // `<branch1>...<branch2>` token (or `..`). We assert
      // `--end-of-options` lands before the combined token (which
      // STARTS with the hostile prefix) — that's what defends against
      // argv injection.
      const revList = mockGitCli.findCommand('rev-list');
      assert.ok(revList, 'rev-list command must be issued');
      const eooR = revList.args.indexOf('--end-of-options');
      const tokR = revList.args.findIndex((a) => a.startsWith(HOSTILE_REF));
      assert.ok(eooR >= 0 && tokR > eooR, `rev-list: ${JSON.stringify(revList.args)}`);

      const log = mockGitCli.findCommand('log');
      assert.ok(log, 'log command must be issued');
      const eooL = log.args.indexOf('--end-of-options');
      const tokL = log.args.findIndex((a) => a.includes(HOSTILE_REF));
      assert.ok(eooL >= 0 && tokL > eooL, `log: ${JSON.stringify(log.args)}`);

      const diff = mockGitCli.findCommand('diff');
      assert.ok(diff, 'diff command must be issued');
      const eooD = diff.args.indexOf('--end-of-options');
      const tokD = diff.args.findIndex((a) => a.startsWith(HOSTILE_REF));
      assert.ok(eooD >= 0 && tokD > eooD, `diff: ${JSON.stringify(diff.args)}`);
    });
  });

  describe('pull()', () => {
    it('separates remote/branch with --end-of-options', async () => {
      await gitService.pull(mockRepo, { remote: 'origin', branch: HOSTILE_REF });
      const cmd = mockGitCli.findCommand('pull');
      assert.ok(cmd, 'pull command must be issued');
      assertEndOfOptionsBeforeRef(cmd.args, HOSTILE_REF, 'pull.branch');
    });
  });

  describe('push()', () => {
    it('separates remote/branch with --end-of-options', async () => {
      await gitService.push(mockRepo, { remote: 'origin', branch: HOSTILE_REF });
      const cmd = mockGitCli.findCommand('push');
      assert.ok(cmd, 'push command must be issued');
      assertEndOfOptionsBeforeRef(cmd.args, HOSTILE_REF, 'push.branch');
    });
  });

  describe('getCommit()', () => {
    it('separates commit hash with --end-of-options', async () => {
      mockGitCli.setMockResultByPrefix('show -s', {
        exitCode: 0,
        stdout:
          'abc123|abc123|me|me@x|2024-01-01T00:00:00Z|me|me@x|2024-01-01T00:00:00Z||subject\n\0',
        stderr: '',
      });
      try {
        await gitService.getCommit(mockRepo, HOSTILE_REF);
      } catch {
        // parseCommit may fail on minimal mock — we only care about the
        // recorded argv shape, which is captured before parsing.
      }
      const cmd = mockGitCli.findCommand('show');
      assert.ok(cmd, 'show command must be issued');
      assertEndOfOptionsBeforeRef(cmd.args, HOSTILE_REF, 'getCommit');
    });
  });

  describe('getFileHistory() with branch ref', () => {
    it('separates branch ref with --end-of-options', async () => {
      await gitService.getFileHistory(mockRepo, 'src/file.ts', { branch: HOSTILE_REF });
      const cmd = mockGitCli.findCommand('log');
      assert.ok(cmd, 'log command must be issued');
      assertEndOfOptionsBeforeRef(cmd.args, HOSTILE_REF, 'getFileHistory.branch');
    });
  });

  describe('getCherryMarks()', () => {
    it('separates baseRef with --end-of-options', async () => {
      mockGitCli.setMockResultByPrefix('log --cherry-mark', {
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
      await gitService.getCherryMarks(mockRepo, HOSTILE_REF);
      const cmd = mockGitCli.findCommand('log');
      assert.ok(cmd, 'log command must be issued');
      // baseRef appears as `HEAD...<baseRef>` — assert the
      // separator predates that combined token.
      const eooIdx = cmd.args.indexOf('--end-of-options');
      assert.ok(eooIdx >= 0, `expected --end-of-options in ${JSON.stringify(cmd.args)}`);
      const tokenIdx = cmd.args.findIndex((a) => a.includes(HOSTILE_REF));
      assert.ok(tokenIdx > eooIdx, `expected ref token after --end-of-options`);
    });
  });

  describe('getDiffForCommits / getMultiCommitDiff parent resolution', () => {
    it('separates commit hash in rev-parse <ref>^', async () => {
      mockGitCli.setMockResultByPrefix('show -s --format=%cI%x09%P', {
        exitCode: 0,
        stdout: '2024-01-01T00:00:00Z\t\n',
        stderr: '',
      });
      mockGitCli.setMockResultByPrefix('rev-parse', {
        exitCode: 0,
        stdout: 'abc123\n',
        stderr: '',
      });
      mockGitCli.setMockResultByPrefix('diff', { exitCode: 0, stdout: '', stderr: '' });

      // Use two commits so getMultiCommitDiff goes through the ranged path.
      await gitService.getMultiCommitDiff(mockRepo, [HOSTILE_REF, 'second-hash']);
      const revParse = mockGitCli.findCommand('rev-parse');
      assert.ok(revParse, 'rev-parse command must be issued');
      // The argv should be ['rev-parse', '--end-of-options', '<sha>^']
      const eooIdx = revParse.args.indexOf('--end-of-options');
      assert.ok(eooIdx >= 0, `expected --end-of-options in ${JSON.stringify(revParse.args)}`);
    });
  });

  describe('getChangedFilesAgainstWorkingTree()', () => {
    it('separates diff ref with --end-of-options', async () => {
      await gitService.getChangedFilesAgainstWorkingTree(mockRepo, HOSTILE_REF);
      const cmd = mockGitCli.findCommand('diff');
      assert.ok(cmd, 'diff command must be issued');
      assertEndOfOptionsBeforeRef(cmd.args, HOSTILE_REF, 'getChangedFilesAgainstWorkingTree');
    });
  });

  describe('cherryPick()', () => {
    it('separates cherry-pick refs with --end-of-options', async () => {
      await gitService.cherryPick(mockRepo, [HOSTILE_REF]);
      const cmd = mockGitCli.findCommand('cherry-pick');
      assert.ok(cmd, 'cherry-pick command must be issued');
      assertEndOfOptionsBeforeRef(cmd.args, HOSTILE_REF, 'cherryPick');
    });
  });

  describe('revert()', () => {
    it('separates revert refs with --end-of-options', async () => {
      await gitService.revert(mockRepo, [HOSTILE_REF]);
      const cmd = mockGitCli.findCommand('revert');
      assert.ok(cmd, 'revert command must be issued');
      assertEndOfOptionsBeforeRef(cmd.args, HOSTILE_REF, 'revert');
    });
  });

  describe('getBlame()', () => {
    it('separates blame path token with --end-of-options', async () => {
      // Blame's "ref" is actually a path; the structural guard still
      // wraps it under a `--` separator. End-of-options ensures any
      // path that starts with `--` cannot collapse into a flag.
      await gitService.getBlame(mockRepo, HOSTILE_REF);
      const cmd = mockGitCli.findCommand('blame');
      assert.ok(cmd, 'blame command must be issued');
      // Either --end-of-options or `--` separator must precede the path
      const eooIdx = cmd.args.indexOf('--end-of-options');
      const dashIdx = cmd.args.indexOf('--');
      const pathIdx = cmd.args.indexOf(HOSTILE_REF);
      assert.ok(pathIdx >= 0, `expected path in argv=${JSON.stringify(cmd.args)}`);
      assert.ok(
        (eooIdx >= 0 && pathIdx > eooIdx) || (dashIdx >= 0 && pathIdx > dashIdx),
        `getBlame: path must follow a separator (--end-of-options or --), argv=${JSON.stringify(cmd.args)}`
      );
    });
  });

  // =====================================================================
  // service-boundary leading-dash/dot guards on the 6 ref-
  // consuming sites missed in R0. Each method now mirrors `createBranch`'s
  // guard and (where structurally feasible) splices `--end-of-options`.
  // =====================================================================

  describe('Wave I R1 — leading-dash service-boundary guards', () => {
    describe('deleteBranch()', () => {
      it('rejects a leading-dash branch name with `Invalid branch name`', async () => {
        await assert.rejects(
          async () => gitService.deleteBranch(mockRepo, '-foo'),
          /Invalid branch name/,
          'deleteBranch must reject names starting with `-`'
        );
      });

      it('rejects a leading-dot branch name with `Invalid branch name`', async () => {
        await assert.rejects(
          async () => gitService.deleteBranch(mockRepo, '.hidden'),
          /Invalid branch name/,
          'deleteBranch must reject names starting with `.`'
        );
      });

      it('safe argv for legitimate names: `branch -d --end-of-options <name>`', async () => {
        await gitService.deleteBranch(mockRepo, 'feature/x');
        const cmd = mockGitCli.findCommand('branch');
        assert.ok(cmd, 'branch command must be issued');
        assertEndOfOptionsBeforeRef(cmd.args, 'feature/x', 'deleteBranch');
      });
    });

    describe('renameBranch()', () => {
      it('rejects a leading-dash oldName', async () => {
        await assert.rejects(
          async () => gitService.renameBranch(mockRepo, '-old', 'new'),
          /Invalid branch name/,
          'renameBranch must reject oldName starting with `-`'
        );
      });

      it('rejects a leading-dash newName', async () => {
        await assert.rejects(
          async () => gitService.renameBranch(mockRepo, 'old', '-new'),
          /Invalid branch name/,
          'renameBranch must reject newName starting with `-`'
        );
      });

      it('safe argv for legitimate names: `branch -m --end-of-options <old> <new>`', async () => {
        await gitService.renameBranch(mockRepo, 'old-name', 'new-name');
        const cmd = mockGitCli.findCommand('branch');
        assert.ok(cmd, 'branch command must be issued');
        assertEndOfOptionsBeforeRef(cmd.args, 'old-name', 'renameBranch.old');
        assertEndOfOptionsBeforeRef(cmd.args, 'new-name', 'renameBranch.new');
      });
    });

    describe('createTag()', () => {
      it('rejects a leading-dash tag name with `Invalid tag name`', async () => {
        await assert.rejects(
          async () => gitService.createTag(mockRepo, '-foo'),
          /Invalid tag name/,
          'createTag must reject names starting with `-`'
        );
      });

      it('rejects a leading-dot tag name with `Invalid tag name`', async () => {
        await assert.rejects(
          async () => gitService.createTag(mockRepo, '.hidden'),
          /Invalid tag name/,
          'createTag must reject names starting with `.`'
        );
      });

      it('safe argv (lightweight): `tag --end-of-options <name>`', async () => {
        await gitService.createTag(mockRepo, 'v9.9.9');
        const cmd = mockGitCli.findCommand('tag');
        assert.ok(cmd, 'tag command must be issued');
        assertEndOfOptionsBeforeRef(cmd.args, 'v9.9.9', 'createTag.lightweight');
      });

      it('safe argv (annotated): `tag -a -m <msg> --end-of-options <name>`', async () => {
        await gitService.createTag(mockRepo, 'v9.9.9', 'note');
        const cmd = mockGitCli.findCommand('tag');
        assert.ok(cmd, 'tag command must be issued');
        // -m/-a precede --end-of-options (verified: git refuses to parse
        // -m as a flag once the separator is set).
        assertEndOfOptionsBeforeRef(cmd.args, 'v9.9.9', 'createTag.annotated');
        const mIdx = cmd.args.indexOf('-m');
        const eooIdx = cmd.args.indexOf('--end-of-options');
        assert.ok(mIdx >= 0 && mIdx < eooIdx, '-m must precede --end-of-options');
      });
    });

    describe('deleteTag()', () => {
      it('rejects a leading-dash tag name with `Invalid tag name`', async () => {
        await assert.rejects(
          async () => gitService.deleteTag(mockRepo, '-foo'),
          /Invalid tag name/,
          'deleteTag must reject names starting with `-`'
        );
      });

      it('safe argv: `tag -d --end-of-options <name>`', async () => {
        await gitService.deleteTag(mockRepo, 'v1.2.3');
        const cmd = mockGitCli.findCommand('tag');
        assert.ok(cmd, 'tag command must be issued');
        assertEndOfOptionsBeforeRef(cmd.args, 'v1.2.3', 'deleteTag');
      });
    });

    describe('getCommitDiff()', () => {
      it('separates commit hash with --end-of-options', async () => {
        try {
          await gitService.getCommitDiff(mockRepo, HOSTILE_REF);
        } catch {
          // parseDiff may handle empty stdout gracefully; we only care
          // about the recorded argv shape.
        }
        const cmd = mockGitCli.findCommand('show');
        assert.ok(cmd, 'show command must be issued');
        assertEndOfOptionsBeforeRef(cmd.args, HOSTILE_REF, 'getCommitDiff');
      });
    });

    describe('_collectTouchedFiles (via cherryPick file-subset path)', () => {
      it('separates each commit hash with --end-of-options in `show --name-only`', async () => {
        // The internal _collectTouchedFiles is reached via the cherryPick
        // `files` subset path. We pre-mock the cherry-pick + show calls so
        // the path runs end-to-end and we can inspect the recorded argv.
        mockGitCli.setMockResultByPrefix('cherry-pick', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });
        mockGitCli.setMockResultByPrefix('show --name-only', {
          exitCode: 0,
          stdout: 'a.ts\n',
          stderr: '',
        });
        await gitService.cherryPick(mockRepo, [HOSTILE_REF], { files: ['a.ts'] });
        const show = mockGitCli.findCommand('show --name-only');
        assert.ok(show, '`show --name-only` command must be issued');
        assertEndOfOptionsBeforeRef(show.args, HOSTILE_REF, '_collectTouchedFiles');
      });
    });
  });
});
