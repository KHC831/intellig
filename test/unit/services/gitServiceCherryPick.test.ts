/**
 * Unit tests for Cherry-Pick variants in GitService.
 *
 * Covers:
 * - Plain `cherryPick(repo, [hash])` (original behaviour) — no --no-commit.
 *  - `{ noCommit: true }` → `git cherry-pick --no-commit <hash>`.
 *  - `{ files: [...] }` → `cherry-pick --no-commit`, then `git show --name-only`
 *    for each commit to collect touched files, then
 *    `reset HEAD -- <others>` + `checkout -- <others>` to narrow the index +
 *    working tree to the selected subset.
 *  - Empty `files: []` short-circuits with success — never touches git.
 *  - Conflict exit code → `success: false` + conflicts from `getConflictedFiles`.
 *  - Option object accepts both `noCommit` alone and combined with `files`.
 */

/*
 * Stub factories synthesise gitCli implementations whose member signatures
 * return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

// ─── MockGitCli — copy of the pattern used in GitService.test.ts ─────────────

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
}

interface ExecutedCommand {
  args: string[];
  options: { cwd?: string; throwOnError?: boolean };
}

class MockGitCli {
  public executedCommands: ExecutedCommand[] = [];
  public mockResults: Map<string, { exitCode: number; stdout: string; stderr: string }> = new Map();
  public mockResultsByPrefix: Map<string, { exitCode: number; stdout: string; stderr: string }> =
    new Map();

  get onCommandExecuted(): () => { dispose: () => void } {
    return (): { dispose: () => void } => ({ dispose: (): void => {} });
  }

  async exec(
    args: string[],
    options: { cwd?: string; throwOnError?: boolean } = {}
  ): Promise<ExecResult> {
    this.executedCommands.push({ args, options });
    const key = args.join(' ');
    let mock = this.mockResults.get(key);
    if (!mock) {
      for (const [prefix, result] of this.mockResultsByPrefix) {
        if (key.startsWith(prefix)) {
          mock = result;
          break;
        }
      }
    }
    if (mock) {
      if (options.throwOnError && mock.exitCode !== 0) {
        throw new Error(`Git command failed: ${mock.stderr}`);
      }
      return { ...mock, combined: mock.stdout + mock.stderr };
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

  findCommand(argsPrefix: string[]): ExecutedCommand | undefined {
    return this.executedCommands.find(
      (c) => c.args.length >= argsPrefix.length && argsPrefix.every((a, i) => c.args[i] === a)
    );
  }

  findCommands(argsPrefix: string[]): ExecutedCommand[] {
    return this.executedCommands.filter(
      (c) => c.args.length >= argsPrefix.length && argsPrefix.every((a, i) => c.args[i] === a)
    );
  }
}

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: 'refs/heads/feature', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

function installGitService(): { gitService: GitService; mockGitCli: MockGitCli } {
  const gitService = new GitService();
  const mockGitCli = new MockGitCli();
  (gitService as unknown as { _gitCli: MockGitCli })._gitCli = mockGitCli;
  return { gitService, mockGitCli };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GitService.cherryPick — variants', () => {
  describe('plain cherry-pick (no options)', () => {
    it('passes only the commit hashes to git — no --no-commit', async () => {
      const { gitService, mockGitCli } = installGitService();
      const result = (await gitService.cherryPick(makeRepo(), ['abc1234']))._unsafeUnwrap();
      assert.strictEqual(result.success, true);
      const cp = mockGitCli.findCommand(['cherry-pick']);
      assert.ok(cp);
      assert.deepStrictEqual(cp.args, ['cherry-pick', '--end-of-options', 'abc1234']);
    });

    it('empty hash list returns success without invoking git', async () => {
      const { gitService, mockGitCli } = installGitService();
      const result = (await gitService.cherryPick(makeRepo(), []))._unsafeUnwrap();
      assert.strictEqual(result.success, true);
      assert.strictEqual(mockGitCli.executedCommands.length, 0);
    });
  });

  describe('{ noCommit: true }', () => {
    it('appends --no-commit before the hash list', async () => {
      const { gitService, mockGitCli } = installGitService();
      await gitService.cherryPick(makeRepo(), ['abc1234'], { noCommit: true });
      const cp = mockGitCli.findCommand(['cherry-pick']);
      assert.ok(cp);
      assert.deepStrictEqual(cp.args, [
        'cherry-pick',
        '--no-commit',
        '--end-of-options',
        'abc1234',
      ]);
    });

    it('does not invoke `git show --name-only` or reset/checkout for other files', async () => {
      const { gitService, mockGitCli } = installGitService();
      await gitService.cherryPick(makeRepo(), ['abc1234'], { noCommit: true });
      assert.strictEqual(
        mockGitCli.findCommand(['show', '--name-only']),
        undefined,
        '`git show --name-only` should not run without a file subset'
      );
      assert.strictEqual(
        mockGitCli.findCommand(['reset', 'HEAD']),
        undefined,
        'no reset for non-subset mode'
      );
      assert.strictEqual(
        mockGitCli.findCommand(['checkout', '--']),
        undefined,
        'no checkout for non-subset mode'
      );
    });
  });

  describe('{ files: [...] } — Apply Selected Changes', () => {
    it('runs cherry-pick --no-commit, then unstages + restores non-selected files', async () => {
      const { gitService, mockGitCli } = installGitService();
      // Commit touches: a.ts, b.ts, c.ts. User keeps only a.ts.
      mockGitCli.setMockResult('show --name-only -z --format= --end-of-options abc1234', {
        exitCode: 0,
        stdout: 'a.ts\0b.ts\0c.ts\0',
        stderr: '',
      });

      const result = (
        await gitService.cherryPick(makeRepo(), ['abc1234'], {
          files: ['a.ts'],
        })
      )._unsafeUnwrap();

      assert.strictEqual(result.success, true);

      // The cherry-pick itself.
      const cp = mockGitCli.findCommand(['cherry-pick']);
      assert.ok(cp);
      assert.deepStrictEqual(cp.args, [
        'cherry-pick',
        '--no-commit',
        '--end-of-options',
        'abc1234',
      ]);

      // The diff discovery.
      const show = mockGitCli.findCommand(['show', '--name-only']);
      assert.ok(show);
      // `commit` follows `--end-of-options` (buildGitArgs).
      assert.deepStrictEqual(show.args, [
        'show',
        '--name-only',
        '-z',
        '--format=',
        '--end-of-options',
        'abc1234',
      ]);

      // The reset + checkout for the NON-selected files.
      const reset = mockGitCli.findCommand(['reset', 'HEAD']);
      assert.ok(reset);
      assert.deepStrictEqual(reset.args, ['reset', 'HEAD', '--', 'b.ts', 'c.ts']);

      const checkout = mockGitCli.findCommand(['checkout', '--']);
      assert.ok(checkout);
      assert.deepStrictEqual(checkout.args, ['checkout', '--', 'b.ts', 'c.ts']);
    });

    it('collects touched files with show --name-only -z, keeping a non-ASCII name verbatim', async () => {
      // Without -z, `git show --name-only` C-quotes a non-ASCII path
      // (`"caf\303\251.ts"`), so it never matches the user's real selection and
      // the index-narrowing restores the wrong file. -z + NUL split keeps the
      // name verbatim so the selected file is kept and only the rest are dropped.
      const { gitService, mockGitCli } = installGitService();
      mockGitCli.setMockResult('show --name-only -z --format= --end-of-options abc1234', {
        exitCode: 0,
        stdout: 'café.ts\0other.ts\0',
        stderr: '',
      });

      const result = (
        await gitService.cherryPick(makeRepo(), ['abc1234'], { files: ['café.ts'] })
      )._unsafeUnwrap();

      assert.strictEqual(result.success, true);
      // café.ts is kept (matched verbatim); only other.ts is dropped.
      const reset = mockGitCli.findCommand(['reset', 'HEAD']);
      assert.ok(reset, 'a reset should narrow the index to drop non-selected files');
      assert.deepStrictEqual(reset.args, ['reset', 'HEAD', '--', 'other.ts']);
      const checkout = mockGitCli.findCommand(['checkout', '--']);
      assert.ok(checkout);
      assert.deepStrictEqual(checkout.args, ['checkout', '--', 'other.ts']);
    });

    it('forces --no-commit even when caller did not request it', async () => {
      const { gitService, mockGitCli } = installGitService();
      mockGitCli.setMockResult('show --name-only -z --format= --end-of-options abc1234', {
        exitCode: 0,
        stdout: 'a.ts\0b.ts\0',
        stderr: '',
      });
      await gitService.cherryPick(makeRepo(), ['abc1234'], {
        files: ['a.ts'],
        noCommit: false, // ignored — files subset implies --no-commit
      });
      const cp = mockGitCli.findCommand(['cherry-pick']);
      assert.ok(cp);
      assert.deepStrictEqual(cp.args, [
        'cherry-pick',
        '--no-commit',
        '--end-of-options',
        'abc1234',
      ]);
    });

    it('empty files array short-circuits without invoking git', async () => {
      const { gitService, mockGitCli } = installGitService();
      const result = (
        await gitService.cherryPick(makeRepo(), ['abc1234'], { files: [] })
      )._unsafeUnwrap();
      assert.strictEqual(result.success, true);
      assert.strictEqual(mockGitCli.executedCommands.length, 0);
    });

    it('files subset equal to all touched files skips the reset/checkout', async () => {
      const { gitService, mockGitCli } = installGitService();
      mockGitCli.setMockResult('show --name-only -z --format= --end-of-options abc1234', {
        exitCode: 0,
        stdout: 'a.ts\0b.ts\0',
        stderr: '',
      });
      await gitService.cherryPick(makeRepo(), ['abc1234'], { files: ['a.ts', 'b.ts'] });
      // cherry-pick + show ran; reset + checkout should NOT have (drop list empty).
      assert.strictEqual(mockGitCli.findCommand(['reset', 'HEAD']), undefined);
      assert.strictEqual(mockGitCli.findCommand(['checkout', '--']), undefined);
    });

    it('multi-commit: unions touched files across every commit', async () => {
      const { gitService, mockGitCli } = installGitService();
      mockGitCli.setMockResult('show --name-only -z --format= --end-of-options abc1234', {
        exitCode: 0,
        stdout: 'a.ts\0b.ts\0',
        stderr: '',
      });
      mockGitCli.setMockResult('show --name-only -z --format= --end-of-options def5678', {
        exitCode: 0,
        stdout: 'b.ts\0c.ts\0',
        stderr: '',
      });
      await gitService.cherryPick(makeRepo(), ['abc1234', 'def5678'], {
        files: ['a.ts'], // keep only a.ts; drop b.ts + c.ts (union minus keep)
      });
      const reset = mockGitCli.findCommand(['reset', 'HEAD']);
      assert.ok(reset);
      // Order of b.ts / c.ts depends on Set iteration; assert set equality.
      const dropped = reset.args.slice(3); // skip 'reset', 'HEAD', '--'
      assert.deepStrictEqual([...dropped].sort(), ['b.ts', 'c.ts']);
    });
  });

  describe('conflicts', () => {
    it('non-zero cherry-pick exit returns success=false with conflict file list', async () => {
      const { gitService, mockGitCli } = installGitService();
      // Cherry-pick itself fails.
      mockGitCli.setMockResult('cherry-pick --end-of-options abc1234', {
        exitCode: 1,
        stdout: '',
        stderr: 'CONFLICT (content): Merge conflict in src/foo.ts',
      });
      // getConflictedFiles reads `status --porcelain -z` (NUL-terminated).
      mockGitCli.setMockResult('status --porcelain -z', {
        exitCode: 0,
        // 'UU' = both-modified conflict; 'DU' = deleted-by-us conflict.
        // parseStatus picks up any row where indexStatus or workTreeStatus is 'U'.
        stdout: 'UU src/foo.ts\0DU src/bar.ts\0',
        stderr: '',
      });
      const result = (await gitService.cherryPick(makeRepo(), ['abc1234']))._unsafeUnwrap();
      assert.strictEqual(result.success, false);
      assert.ok(result.conflicts);
      assert.strictEqual(result.conflicts.length, 2);
      assert.ok(result.conflicts.includes('src/foo.ts'));
      assert.ok(result.conflicts.includes('src/bar.ts'));
    });

    it('reports both-added (AA) and both-deleted (DD) unmerged entries as conflicts', async () => {
      // A cherry-pick can leave AA / DD unmerged paths (neither column is 'U'),
      // which a U-only filter silently drops. Detect conflicts consistently with
      // every other site via isConflictedStatus.
      const { gitService, mockGitCli } = installGitService();
      mockGitCli.setMockResult('cherry-pick --end-of-options abc1234', {
        exitCode: 1,
        stdout: '',
        stderr: 'CONFLICT (add/add): Merge conflict in src/both.ts',
      });
      mockGitCli.setMockResult('status --porcelain -z', {
        exitCode: 0,
        stdout: 'AA src/both.ts\0DD src/gone.ts\0',
        stderr: '',
      });
      const result = (await gitService.cherryPick(makeRepo(), ['abc1234']))._unsafeUnwrap();
      assert.strictEqual(result.success, false);
      assert.ok(result.conflicts);
      assert.deepStrictEqual(result.conflicts.sort(), ['src/both.ts', 'src/gone.ts']);
    });

    it('conflict during --no-commit cherry-pick: same behaviour', async () => {
      const { gitService, mockGitCli } = installGitService();
      mockGitCli.setMockResult('cherry-pick --no-commit --end-of-options abc1234', {
        exitCode: 1,
        stdout: '',
        stderr: 'CONFLICT (content): Merge conflict in src/foo.ts',
      });
      mockGitCli.setMockResult('status --porcelain -z', {
        exitCode: 0,
        stdout: 'UU src/foo.ts\0',
        stderr: '',
      });
      const result = (
        await gitService.cherryPick(makeRepo(), ['abc1234'], {
          noCommit: true,
        })
      )._unsafeUnwrap();
      assert.strictEqual(result.success, false);
      assert.ok(result.conflicts);
      assert.strictEqual(result.conflicts.length, 1);
    });

    it('conflict in file-subset mode: does NOT run the post-cherry-pick reset/checkout', async () => {
      const { gitService, mockGitCli } = installGitService();
      mockGitCli.setMockResult('cherry-pick --no-commit --end-of-options abc1234', {
        exitCode: 1,
        stdout: '',
        stderr: 'CONFLICT (content): Merge conflict in a.ts',
      });
      mockGitCli.setMockResult('status --porcelain -z', {
        exitCode: 0,
        stdout: 'UU a.ts\0',
        stderr: '',
      });
      const result = (
        await gitService.cherryPick(makeRepo(), ['abc1234'], {
          files: ['a.ts'],
        })
      )._unsafeUnwrap();
      assert.strictEqual(result.success, false);
      // Should NOT have run show --name-only or reset/checkout — conflict path
      // short-circuits before the file-subset narrowing.
      assert.strictEqual(mockGitCli.findCommand(['show', '--name-only']), undefined);
      assert.strictEqual(mockGitCli.findCommand(['reset', 'HEAD']), undefined);
      assert.strictEqual(mockGitCli.findCommand(['checkout', '--']), undefined);
    });
  });
});
