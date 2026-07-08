/**
 * GitService default-branch detection: resolve the `<remote>/HEAD` target to a
 * short branch name, preferring `origin`, degrading to `undefined` when there is
 * no remote or `<remote>/HEAD` is unset. Drives graph trunk coloring only.
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import type { IRemote } from '../../../src/git-core/interfaces/IGitService';

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
}

interface Surface {
  _gitCli: {
    exec: (args: string[], options: unknown) => Promise<ExecResult>;
    dispose: () => void;
  };
  _resolveDefaultBranch: (remotes: IRemote[], options: unknown) => Promise<string | undefined>;
}

function remote(name: string): IRemote {
  return { name, fetchUrl: `https://example/${name}.git` };
}

describe('GitService — default-branch detection', () => {
  let gitService: GitService;
  let calls: string[][];
  let respond: (args: string[]) => ExecResult;

  beforeEach(() => {
    gitService = new GitService();
    calls = [];
    respond = () => ({ exitCode: 1, stdout: '', stderr: '', combined: '' });
    (gitService as unknown as Surface)._gitCli = {
      exec: async (args: string[]): Promise<ExecResult> => {
        calls.push(args);
        return respond(args);
      },
      dispose: (): void => {},
    };
  });

  afterEach(() => gitService.dispose());

  function resolve(remotes: IRemote[]): Promise<string | undefined> {
    return (gitService as unknown as Surface)._resolveDefaultBranch(remotes, { cwd: '/r' });
  }

  it('returns undefined and spawns no git when there is no remote', async () => {
    const got = await resolve([]);
    assert.strictEqual(got, undefined);
    assert.strictEqual(calls.length, 0, 'no symbolic-ref call for a remoteless repo');
  });

  it('resolves origin/HEAD to the short branch name', async () => {
    respond = () => ({ exitCode: 0, stdout: 'origin/develop\n', stderr: '', combined: '' });
    assert.strictEqual(await resolve([remote('origin')]), 'develop');
    assert.ok(
      calls.some((a) => a.includes('refs/remotes/origin/HEAD')),
      'queries origin/HEAD'
    );
  });

  it('prefers the origin remote over others regardless of order', async () => {
    respond = (args) =>
      args.some((a) => a.includes('refs/remotes/origin/HEAD'))
        ? { exitCode: 0, stdout: 'origin/main\n', stderr: '', combined: '' }
        : { exitCode: 0, stdout: 'upstream/master\n', stderr: '', combined: '' };
    assert.strictEqual(await resolve([remote('upstream'), remote('origin')]), 'main');
  });

  it('falls back to the first remote when there is no origin', async () => {
    respond = (args) =>
      args.some((a) => a.includes('refs/remotes/fork/HEAD'))
        ? { exitCode: 0, stdout: 'fork/trunk\n', stderr: '', combined: '' }
        : { exitCode: 1, stdout: '', stderr: '', combined: '' };
    assert.strictEqual(await resolve([remote('fork'), remote('other')]), 'trunk');
  });

  it('returns undefined when <remote>/HEAD is unset (symbolic-ref non-zero)', async () => {
    respond = () => ({ exitCode: 128, stdout: '', stderr: 'not a symbolic ref', combined: '' });
    assert.strictEqual(await resolve([remote('origin')]), undefined);
  });

  it('returns undefined on empty output rather than an empty branch name', async () => {
    respond = () => ({ exitCode: 0, stdout: '\n', stderr: '', combined: '' });
    assert.strictEqual(await resolve([remote('origin')]), undefined);
  });
});
