/**
 * Tests for the diff whitespace ignore-policy (workstream F, slice 6).
 *
 * Two layers:
 *  1. The pure `diffIgnorePolicyFlags` mapping — each IntelliJ IgnorePolicy
 *     maps onto the right git whitespace flags.
 *  2. Integration through `DiffOps` (via the GitService façade): the configured
 *     `intellig.diff.ignorePolicy` is threaded into the `git show`/`git diff`
 *     argv when a diff is generated.
 *
 * Harness mirrors `gitServiceMergeCommitDiff.test.ts` (ScriptedGitCli) plus the
 * mock-config helpers from `BlameOptionsSource.test.ts`.
 */

import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import {
  diffIgnorePolicyFlags,
  normalizeDiffIgnorePolicy,
} from '../../../src/git-core/diffIgnorePolicy';
import { Uri, setMockConfigValue, resetMockConfiguration } from '../../mocks/vscode';

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
    const next = this.scripted.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
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

function fakeRepo(): IRepository {
  return { rootUri: Uri.file('/tmp/repo') } as unknown as IRepository;
}

describe('diff ignore-policy → git flag mapping', () => {
  it('default → no flags (current behavior preserved)', () => {
    assert.deepStrictEqual(diffIgnorePolicyFlags('default'), []);
  });

  it('trim-whitespaces → --ignore-space-at-eol', () => {
    assert.deepStrictEqual(diffIgnorePolicyFlags('trim-whitespaces'), ['--ignore-space-at-eol']);
  });

  it('ignore-whitespaces → --ignore-all-space (git -w)', () => {
    assert.deepStrictEqual(diffIgnorePolicyFlags('ignore-whitespaces'), ['--ignore-all-space']);
  });

  it('ignore-whitespaces-empty-lines → --ignore-all-space --ignore-blank-lines', () => {
    assert.deepStrictEqual(diffIgnorePolicyFlags('ignore-whitespaces-empty-lines'), [
      '--ignore-all-space',
      '--ignore-blank-lines',
    ]);
  });

  it('normalize coerces unknown/undefined to default', () => {
    assert.strictEqual(normalizeDiffIgnorePolicy(undefined), 'default');
    assert.strictEqual(normalizeDiffIgnorePolicy('bogus'), 'default');
    assert.strictEqual(normalizeDiffIgnorePolicy('ignore-whitespaces'), 'ignore-whitespaces');
  });
});

describe('DiffOps applies configured ignore-policy', () => {
  afterEach(() => {
    resetMockConfiguration();
  });

  it('getCommitDiff appends -w flag when policy = ignore-whitespaces', async () => {
    setMockConfigValue('intellig', 'diff.ignorePolicy', 'ignore-whitespaces');
    const cli = new ScriptedGitCli();
    cli.scripted.push({ exitCode: 0, stdout: '', stderr: '' });
    const svc = createGitServiceWithCli(cli);

    await svc.getCommitDiff(fakeRepo(), 'abc123');

    const args = cli.executed[0].args;
    assert.ok(args.includes('--ignore-all-space'), `expected -w flag in: ${args.join(' ')}`);
  });

  it('getCommitDiff appends no whitespace flag by default', async () => {
    const cli = new ScriptedGitCli();
    cli.scripted.push({ exitCode: 0, stdout: '', stderr: '' });
    const svc = createGitServiceWithCli(cli);

    await svc.getCommitDiff(fakeRepo(), 'abc123');

    const args = cli.executed[0].args;
    assert.ok(
      !args.includes('--ignore-all-space') && !args.includes('--ignore-space-at-eol'),
      `expected no whitespace flag in: ${args.join(' ')}`
    );
  });

  it('getDiff appends trim flag when policy = trim-whitespaces', async () => {
    setMockConfigValue('intellig', 'diff.ignorePolicy', 'trim-whitespaces');
    const cli = new ScriptedGitCli();
    cli.scripted.push({ exitCode: 0, stdout: '', stderr: '' });
    const svc = createGitServiceWithCli(cli);

    await svc.getDiff(fakeRepo(), 'file.ts');

    const args = cli.executed[0].args;
    assert.ok(
      args.includes('--ignore-space-at-eol'),
      `expected --ignore-space-at-eol in: ${args.join(' ')}`
    );
  });
});

describe('DiffOps.getDiff degrades an empty path instead of crashing the caller', () => {
  // getDiff() builds its argv (and calls literalPathspec) SYNCHRONOUSLY,
  // before handing off to ResultAsync.fromPromise — so a throw from an empty
  // path would escape the ResultAsync chain entirely and crash whatever
  // called getDiff(), rather than surfacing as an Err GitService.getDiff's
  // absorb boundary (.match() above) can log and degrade.
  afterEach(() => {
    resetMockConfiguration();
  });

  it('never spawns git and never throws for an empty path', async () => {
    const cli = new ScriptedGitCli();
    const svc = createGitServiceWithCli(cli);

    const diff = await svc.getDiff(fakeRepo(), '');

    assert.strictEqual(cli.executed.length, 0, 'git must never be spawned for a refused path');
    assert.deepStrictEqual(diff, { path: '', status: 'modified', hunks: [], binary: false });
  });
});
