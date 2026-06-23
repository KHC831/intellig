/**
 * Startup-latency guard: concurrent getStatus calls for the same repo coalesce
 * into ONE `git status --porcelain` walk.
 *
 * On activation several subscribers (SCM provider, changelist view, shelf view)
 * each call getStatus for the same repo at once. `git status --porcelain`
 * enumerates every untracked file by walking the whole working tree — on a large
 * repo each walk is multi-second. A captured dogfood session showed 3–4 of these
 * walks running CONCURRENTLY, saturating the disk and starving the graph's
 * `git log` (dispatched at 1.5s, it didn't return until 6.4s — right after the
 * walks finished). Coalescing identical in-flight walks into one removes the
 * redundant disk contention.
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

class CountingGitCli {
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
    if (args[0] === 'status' && args.includes('--porcelain')) {
      this.statusCalls += 1;
      // Hold the walk open until released, so both callers overlap in flight.
      await this.gate;
    }
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

  async getRepositoryRoot(p: string): Promise<string | undefined> {
    return p;
  }

  dispose(): void {}
}

function repo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: 'main', commit: 'abc', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

describe('GitService.getStatus coalesces concurrent identical walks', () => {
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

  it('two concurrent getStatus calls trigger only ONE git status --porcelain', async () => {
    const r = repo();
    const p1 = gitService.getStatus(r);
    const p2 = gitService.getStatus(r);
    // Both are now in flight against the gated walk.
    cli.release();
    await Promise.all([p1, p2]);

    assert.strictEqual(
      cli.statusCalls,
      1,
      'concurrent getStatus for the same repo must share one underlying walk'
    );
  });

  it('a fresh getStatus after the in-flight one resolves walks again', async () => {
    const r = repo();
    const first = gitService.getStatus(r);
    cli.release();
    await first;

    // New, non-overlapping call — must not be served stale; it walks again.
    cli.gate = Promise.resolve();
    await gitService.getStatus(r);

    assert.strictEqual(cli.statusCalls, 2, 'a later, non-overlapping call walks fresh');
  });
});
