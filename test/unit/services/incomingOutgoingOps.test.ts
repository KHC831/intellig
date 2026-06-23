/**
 * Phase 0a — IncomingOutgoingOps unit coverage.
 *
 * Exercises the ops collaborator through the GitService façade
 * (`getIncomingOutgoing` / `getIncomingOutgoingForBranch`) with a mock GitCli
 * that dispatches per-subcommand, so we can pin:
 *
 *   - the exact argv (`rev-parse --abbrev-ref <ref>` — NO `--end-of-options`,
 *     which rev-parse would echo back; `rev-list --left-right --count
 *     --end-of-options <left>...<right>` — which correctly carries the guard),
 *   - left→incoming / right→outgoing parsing,
 *   - the no-upstream short-circuit (no rev-list issued, noUpstream:true),
 *   - defensive zeroing on git failure / unparseable output.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

import * as assert from 'assert';
import { okAsync } from 'neverthrow';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
}

/**
 * Mock GitCli whose `exec` is driven by a `(args) => ExecResult` handler so
 * each test decides what `rev-parse` vs `rev-list` returns, and captures every
 * argv for assertion.
 */
class DispatchGitCli {
  public executed: string[][] = [];
  private _onCommandExecuted = {
    event: (): { dispose: () => void } => ({ dispose: (): void => {} }),
  };

  constructor(private readonly handler: (args: string[]) => Partial<ExecResult>) {}

  get onCommandExecuted(): () => { dispose: () => void } {
    return this._onCommandExecuted.event;
  }

  async exec(args: string[]): Promise<ExecResult> {
    this.executed.push([...args]);
    const partial = this.handler(args);
    return {
      exitCode: partial.exitCode ?? 0,
      stdout: partial.stdout ?? '',
      stderr: partial.stderr ?? '',
      combined: partial.combined ?? partial.stdout ?? '',
    };
  }

  getRepositoryRoot(path: string) {
    return okAsync<string | undefined, never>(path);
  }

  dispose(): void {}
}

const ROOT = '/test/repo';

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file(ROOT),
    state: 'idle',
    remotes: [],
    submodules: [],
  };
}

function attach(handler: (args: string[]) => Partial<ExecResult>): {
  gitService: GitService;
  cli: DispatchGitCli;
} {
  const gitService = new GitService();
  const cli = new DispatchGitCli(handler);
  (gitService as any)._gitCli = cli;
  return { gitService, cli };
}

describe('Phase 0a — IncomingOutgoingOps via GitService', () => {
  describe('getIncomingOutgoing (current branch)', () => {
    it('parses left→incoming / right→outgoing and issues the documented argv', async () => {
      const { gitService, cli } = attach((args) => {
        if (args[0] === 'rev-parse' && args.includes('HEAD')) {
          return { stdout: 'main\n' };
        }
        if (args[0] === 'rev-parse') {
          return { stdout: 'origin/main\n' };
        }
        if (args[0] === 'rev-list') {
          // 3 incoming (behind), 2 outgoing (ahead)
          return { stdout: '3\t2\n' };
        }
        return { exitCode: 1 };
      });

      const result = await gitService.getIncomingOutgoing(makeRepo());

      assert.strictEqual(result.incoming, 3);
      assert.strictEqual(result.outgoing, 2);
      assert.strictEqual(result.noUpstream, false);
      assert.strictEqual(result.branch, 'main');
      assert.strictEqual(result.upstream, 'origin/main');

      // The rev-list argv must use --left-right --count with the
      // <upstream>...<branch> spec spliced past --end-of-options.
      const revList = cli.executed.find((a) => a[0] === 'rev-list');
      assert.ok(revList, 'expected a rev-list invocation');
      assert.deepStrictEqual(revList, [
        'rev-list',
        '--left-right',
        '--count',
        '--end-of-options',
        '@{upstream}...HEAD',
      ]);

      gitService.dispose();
    });

    it('short-circuits to noUpstream and issues NO rev-list when HEAD has no upstream', async () => {
      const { gitService, cli } = attach((args) => {
        if (args[0] === 'rev-parse' && args.includes('HEAD')) {
          return { stdout: 'feature/x\n' };
        }
        if (args[0] === 'rev-parse') {
          // @{upstream} does not resolve → git exits non-zero
          return { exitCode: 128, stderr: 'fatal: no upstream configured' };
        }
        return { exitCode: 1 };
      });

      const result = await gitService.getIncomingOutgoing(makeRepo());

      assert.strictEqual(result.noUpstream, true);
      assert.strictEqual(result.incoming, 0);
      assert.strictEqual(result.outgoing, 0);
      assert.strictEqual(result.branch, 'feature/x');
      assert.strictEqual(result.upstream, undefined);

      assert.ok(
        !cli.executed.some((a) => a[0] === 'rev-list'),
        'no rev-list should be issued when there is no upstream'
      );

      gitService.dispose();
    });

    it('zeroes counts defensively on unparseable rev-list output', async () => {
      const { gitService } = attach((args) => {
        if (args[0] === 'rev-parse' && args.includes('HEAD')) {
          return { stdout: 'main\n' };
        }
        if (args[0] === 'rev-parse') {
          return { stdout: 'origin/main\n' };
        }
        if (args[0] === 'rev-list') {
          return { stdout: 'garbage\n' };
        }
        return { exitCode: 1 };
      });

      const result = await gitService.getIncomingOutgoing(makeRepo());
      assert.strictEqual(result.incoming, 0);
      assert.strictEqual(result.outgoing, 0);
      assert.strictEqual(result.noUpstream, false);

      gitService.dispose();
    });
  });

  describe('getIncomingOutgoingForBranch (explicit branch)', () => {
    it('resolves <branch>@{upstream} and counts <upstream>...<branch>', async () => {
      const { gitService, cli } = attach((args) => {
        if (args[0] === 'rev-parse') {
          // resolving feature/x@{upstream}
          return { stdout: 'origin/feature/x\n' };
        }
        if (args[0] === 'rev-list') {
          return { stdout: '0\t5\n' };
        }
        return { exitCode: 1 };
      });

      const result = await gitService.getIncomingOutgoingForBranch(makeRepo(), 'feature/x');

      assert.strictEqual(result.incoming, 0);
      assert.strictEqual(result.outgoing, 5);
      assert.strictEqual(result.noUpstream, false);
      assert.strictEqual(result.branch, 'feature/x');
      assert.strictEqual(result.upstream, 'origin/feature/x');

      // `rev-parse --abbrev-ref` must NOT carry `--end-of-options`: rev-parse
      // echoes that token back as an extra output line, corrupting the resolved
      // upstream (the real-git bug e2e suite 23 caught). The ref operand is an
      // internal `@{upstream}` expression, so no leading-dash injection risk.
      const revParse = cli.executed.find((a) => a[0] === 'rev-parse');
      assert.deepStrictEqual(revParse, ['rev-parse', '--abbrev-ref', 'feature/x@{upstream}']);

      const revList = cli.executed.find((a) => a[0] === 'rev-list');
      assert.deepStrictEqual(revList, [
        'rev-list',
        '--left-right',
        '--count',
        '--end-of-options',
        'origin/feature/x...feature/x',
      ]);

      gitService.dispose();
    });

    it('returns noUpstream for a branch with no tracking ref', async () => {
      const { gitService } = attach((args) => {
        if (args[0] === 'rev-parse') {
          return { exitCode: 128 };
        }
        return { exitCode: 1 };
      });

      const result = await gitService.getIncomingOutgoingForBranch(makeRepo(), 'local-only');
      assert.strictEqual(result.noUpstream, true);
      assert.strictEqual(result.incoming, 0);
      assert.strictEqual(result.outgoing, 0);
      assert.strictEqual(result.branch, 'local-only');

      gitService.dispose();
    });
  });

  describe('façade absorbs a spawn/system fault (logs + degrades, never throws)', () => {
    it('getIncomingOutgoing resolves to a degraded reading when exec rejects', async () => {
      const gitService = new GitService();
      const throwingCli = {
        onCommandExecuted: (): { dispose: () => void } => ({ dispose: (): void => {} }),
        exec: (): Promise<never> => Promise.reject(new Error('spawn ENOENT')),
        getRepositoryRoot: (p: string) => okAsync<string | undefined, never>(p),
        dispose: (): void => {},
      };
      (gitService as any)._gitCli = throwingCli;

      // Must NOT reject — the badge update degrades instead of crashing.
      const result = await gitService.getIncomingOutgoing(makeRepo());
      assert.strictEqual(result.noUpstream, true);
      assert.strictEqual(result.incoming, 0);
      assert.strictEqual(result.outgoing, 0);

      gitService.dispose();
    });
  });
});
