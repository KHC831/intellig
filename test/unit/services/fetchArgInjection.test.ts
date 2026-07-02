/**
 * Argv-injection guard for `GitService.fetch`.
 *
 * A remote name is user-controlled (it comes from `.git/config`, which a
 * cloned/hostile repo can author) and the auto-fetch loop calls `fetch`
 * unattended. A name like `--upload-pack=evil` must NOT be able to land as a
 * git flag. `pull` and `push` already route refs through `buildGitArgs`, which
 * splices `--end-of-options` ahead of user-controlled refs; `fetch` must do the
 * same.
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [{ name: 'origin' }],
    submodules: [],
  };
}

function installGitService(): { gitService: GitService; executed: string[][] } {
  const gitService = new GitService();
  const executed: string[][] = [];
  const gitCli = {
    onCommandExecuted: (): { dispose: () => void } => ({ dispose: (): void => {} }),
    exec: async (args: string[]) => {
      executed.push([...args]);
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
    invalidateCache: () => {},
  };
  (gitService as unknown as { _gitCli: unknown })._gitCli = gitCli;
  return { gitService, executed };
}

/** The `fetch` invocation among the executed calls (a fetch is now bracketed
 * by two `for-each-ref` snapshot reads, so it is no longer `executed[0]`). */
function fetchArgs(executed: string[][]): string[] {
  const call = executed.find((args) => args.find((a) => !a.startsWith('-')) === 'fetch');
  if (!call) {
    throw new Error('no fetch call was executed');
  }
  return call;
}

describe('GitService.fetch — argv-injection guard', () => {
  it('splices --end-of-options before a remote-specific fetch', async () => {
    const { gitService, executed } = installGitService();
    await gitService.fetch(makeRepo(), 'origin');
    const args = fetchArgs(executed);
    const eooIdx = args.indexOf('--end-of-options');
    const remoteIdx = args.indexOf('origin');
    assert.ok(eooIdx >= 0, `expected --end-of-options in args: ${args.join(' ')}`);
    assert.ok(remoteIdx >= 0, `expected remote in args: ${args.join(' ')}`);
    assert.ok(
      eooIdx < remoteIdx,
      `--end-of-options must precede the remote name; got ${args.join(' ')}`
    );
  });

  it('a hostile remote name lands after --end-of-options, never as a flag', async () => {
    const { gitService, executed } = installGitService();
    const hostile = '--upload-pack=touch /tmp/pwned';
    await gitService.fetch(makeRepo(), hostile);
    const args = fetchArgs(executed);
    const eooIdx = args.indexOf('--end-of-options');
    const hostileIdx = args.indexOf(hostile);
    assert.ok(eooIdx >= 0, `expected --end-of-options in args: ${args.join(' ')}`);
    assert.ok(
      hostileIdx > eooIdx,
      `hostile remote must sit after --end-of-options; got ${args.join(' ')}`
    );
  });

  it('--all fetch emits no --end-of-options (no user ref to guard)', async () => {
    const { gitService, executed } = installGitService();
    await gitService.fetch(makeRepo(), { all: true });
    const args = fetchArgs(executed);
    assert.ok(args.includes('--all'), `args: ${args.join(' ')}`);
    assert.ok(
      !args.includes('--end-of-options'),
      `no ref → no --end-of-options; got ${args.join(' ')}`
    );
  });
});
