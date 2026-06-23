/**
 * Startup-latency guard: the heavy `git status --porcelain` untracked walk
 * yields to an in-flight graph `git log`.
 *
 * On a large repo with no commit-graph, `git log --topo-order` is CPU-bound
 * (~1.9s on intellij-community); the changes-view `git status --porcelain`
 * untracked walk runs concurrently at activation and starves it, pushing the
 * graph's first paint from ~3.3s to ~6.3s. getStatus now waits for any in-flight
 * getLog (bounded by a timeout, so a hung log never blocks status) before
 * walking — so the graph paints first and the changes view refreshes just after,
 * with no fixed delay and no effect when the two don't overlap.
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

interface IExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
}

class OrderedGitCli {
  public events: string[] = [];
  private _releaseLog!: () => void;
  public logGate: Promise<void>;
  public logHangs = false;

  constructor() {
    this.logGate = new Promise<void>((res) => {
      this._releaseLog = res;
    });
  }

  releaseLog(): void {
    this._releaseLog();
  }

  async exec(args: string[]): Promise<IExecResult> {
    const ok = (stdout = ''): IExecResult => ({
      exitCode: 0,
      stdout,
      stderr: '',
      combined: stdout,
    });
    if (args[0] === 'log') {
      this.events.push('log:start');
      if (!this.logHangs) {
        await this.logGate;
      } else {
        await new Promise<void>(() => {}); // never resolves
      }
      this.events.push('log:end');
      return ok('');
    }
    if (args[0] === 'status' && args.includes('--porcelain')) {
      this.events.push('status:start');
      return ok('');
    }
    return ok('');
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

describe('getStatus yields to an in-flight getLog', () => {
  let gitService: GitService;
  let cli: OrderedGitCli;

  beforeEach(() => {
    gitService = new GitService();
    cli = new OrderedGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = cli;
  });

  afterEach(() => {
    gitService.dispose();
  });

  it('defers the status walk until the in-flight getLog resolves', async () => {
    const r = repo();
    const logPromise = gitService.getLog(r, { maxCount: 100 });
    const statusPromise = gitService.getStatus(r);

    // Let microtasks settle; status must NOT have walked yet (log still gated).
    await new Promise((res) => setTimeout(res, 10));
    assert.ok(
      !cli.events.includes('status:start'),
      'status walk must wait while the graph log is in flight'
    );

    cli.releaseLog();
    await Promise.all([logPromise, statusPromise]);

    assert.deepStrictEqual(
      cli.events,
      ['log:start', 'log:end', 'status:start'],
      'status must walk only after the log completes'
    );
  });

  it('yields even when status is called just BEFORE getLog registers (startup race)', async () => {
    const r = repo();
    // Status fires first (SCM refresh wins the event race) — no log in flight yet.
    const statusPromise = gitService.getStatus(r);
    // The graph's getLog registers a tick later, within the startup grace.
    await new Promise((res) => setTimeout(res, 5));
    const logPromise = gitService.getLog(r, { maxCount: 100 });

    await new Promise((res) => setTimeout(res, 10));
    assert.ok(
      !cli.events.includes('status:start'),
      'status must yield to the just-registered log, not race it'
    );

    cli.releaseLog();
    await Promise.all([statusPromise, logPromise]);
    assert.deepStrictEqual(cli.events, ['log:start', 'log:end', 'status:start']);
  });

  it('runs the status walk after the grace when no getLog appears', async () => {
    const r = repo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._statusGateGraceMs = 20; // shrink the startup grace for the test
    await gitService.getStatus(r);
    assert.deepStrictEqual(cli.events, ['status:start'], 'no log appears → proceed after grace');
  });

  it('proceeds after the gate timeout if the log hangs (no deadlock)', async () => {
    const r = repo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._statusLogGateMs = 30; // shrink the safety cap for the test
    cli.logHangs = true;
    void gitService.getLog(r, { maxCount: 100 });

    await gitService.getStatus(r);
    assert.ok(
      cli.events.includes('status:start'),
      'status must proceed once the gate times out even if the log never resolves'
    );
  });
});
