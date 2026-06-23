/**
 * Startup-latency guard: concurrent getRepository calls for the same root
 * coalesce into ONE loadRepository probe.
 *
 * At activation many subscribers (SCM provider, changelist, branch tree, status
 * bar, blame, autofetch, the graph) each call getRepository for the same repo at
 * once. getRepository launched a fresh loadRepository every time — each spawning
 * ~6 git commands (symbolic-ref, rev-parse, upstream, rev-list, status, remote)
 * — so N subscribers produced N× the git processes, saturating the CPU and
 * starving the graph's `git log --topo-order` (observed: the same log that runs
 * in 1.9s standalone took 5.6s during the startup git storm). Coalescing
 * concurrent discovery to a single in-flight probe removes the storm.
 */

import '../../setup';
import * as assert from 'assert';
import { okAsync, ResultAsync } from 'neverthrow';
import { GitService } from '../../../src/git-core/GitService';
import { GitError } from '../../../src/git-core/errors';
import { Uri } from '../../mocks/vscode';

class CountingGitCli {
  public remoteCalls = 0;
  public statusCalls = 0;
  private _release!: () => void;
  public gate: Promise<void>;

  constructor() {
    this.gate = new Promise<void>((res) => {
      this._release = res;
    });
  }
  release(): void {
    this._release();
  }

  async exec(
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    const ok = (
      stdout = ''
    ): { exitCode: number; stdout: string; stderr: string; combined: string } => ({
      exitCode: 0,
      stdout,
      stderr: '',
      combined: stdout,
    });
    if (args[0] === 'symbolic-ref') {
      return ok('refs/heads/main\n');
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return ok('abc123\n');
    }
    if (args.includes('status')) {
      this.statusCalls += 1;
      await this.gate; // hold so concurrent callers overlap in flight
      return ok('');
    }
    if (args[0] === 'remote') {
      this.remoteCalls += 1;
      return ok('');
    }
    return ok('');
  }

  getRepositoryRoot(p: string): ResultAsync<string | undefined, GitError> {
    return okAsync(p);
  }
  dispose(): void {}
}

describe('GitService.getRepository coalesces concurrent discovery', () => {
  let gitService: GitService;
  let cli: CountingGitCli;

  beforeEach(() => {
    gitService = new GitService();
    cli = new CountingGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = cli;
  });

  afterEach(() => {
    gitService.dispose();
  });

  it('three concurrent getRepository for the same root run loadRepository once', async () => {
    const uri = Uri.file('/test/repo');
    const p1 = gitService.getRepository(uri);
    const p2 = gitService.getRepository(uri);
    const p3 = gitService.getRepository(uri);

    cli.release();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.strictEqual(cli.statusCalls, 1, 'one repo-state probe, not one per caller');
    assert.strictEqual(cli.remoteCalls, 1, 'one remote probe, not one per caller');
    assert.ok(r1 && r2 && r3, 'all callers get a repository');
    assert.strictEqual(r1, r2, 'callers share the same repository instance');
    assert.strictEqual(r2, r3, 'callers share the same repository instance');
  });
});
