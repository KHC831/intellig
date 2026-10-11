/**
 * Startup-latency guard: concurrent getStatus calls for the same repo never
 * run two `git status --porcelain` walks at once, and a burst costs at most
 * two walks — without answering any caller with a walk that started before it
 * asked.
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
  public concurrent = 0;
  public maxConcurrent = 0;
  /** What each walk prints, in call order; later walks repeat the last. */
  public outputs: string[] = [''];
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
      const stdout = this.outputs[Math.min(this.statusCalls, this.outputs.length) - 1];
      this.concurrent += 1;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
      // Hold the walk open until released, so callers overlap in flight.
      await this.gate;
      this.concurrent -= 1;
      return { exitCode: 0, stdout, stderr: '', combined: stdout };
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

  it('a burst of getStatus calls never walks twice at once, and walks at most twice', async () => {
    const r = repo();
    const burst = [gitService.getStatus(r), gitService.getStatus(r), gitService.getStatus(r)];
    cli.release();
    await Promise.all(burst);
    assert.strictEqual(cli.maxConcurrent, 1, 'walks never overlap');
    assert.strictEqual(cli.statusCalls, 2, 'the late callers share ONE follow-up walk');
  });

  it('a getStatus arriving while a walk is in flight is answered by a walk that starts after it', async () => {
    const r = repo();
    cli.outputs = ['', ' M late.txt\0'];
    const first = gitService.getStatus(r);
    // A file changes after the first walk started; this caller asks after it.
    const second = gitService.getStatus(r);
    cli.release();
    assert.deepStrictEqual(
      (await first).map((s) => s.path),
      []
    );
    assert.deepStrictEqual(
      (await second).map((s) => s.path),
      ['late.txt'],
      'the later caller sees the change, not the earlier walk'
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
