/**
 * The rebase path decides "did this finish cleanly?" from a `git status` read,
 * and a failed read used to be byte-identical to a clean tree.
 *
 * The sharpest case is the autostash guard. It exists BECAUSE git fails
 * silently: with `--autostash`, if re-applying the stashed working tree
 * collides with the rebased changes, git leaves unmerged files behind and still
 * exits 0. The guard reads the unmerged set to catch that, so a failed read
 * defeated a guard whose whole purpose was catching a silent failure, and
 * IntelliG reported a clean completion over a conflicted tree.
 *
 * A control matters here as much as the failing case: a genuinely clean tree
 * must still report success, or the fix is only a new false alarm.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';
import { GitCli, IGitCommandResult } from '../../../src/git-core/gitCli';
import { RebaseService } from '../../../src/git-core/RebaseService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { IRebaseResult, IRebaseSession } from '../../../src/git-core/interfaces/IRebaseService';

const NUL = '\0';

/** A GitCli whose `git status` answer is scripted; everything else succeeds. */
class ScriptedGitCli extends GitCli {
  constructor(private readonly _status: IGitCommandResult) {
    super('git');
  }

  override exec(args: string[]): Promise<IGitCommandResult> {
    if (args[0] === 'status') {
      return Promise.resolve(this._status);
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
  }
}

function makeRepo(): IRepository {
  return { rootUri: { fsPath: '/repo' } } as unknown as IRepository;
}

/** Reach the private read through the service's own surface. */
async function readConflicts(status: IGitCommandResult): Promise<string[] | undefined> {
  const service = new RebaseService(new ScriptedGitCli(status));
  try {
    const read = await (
      service as unknown as {
        getConflictedFiles(repo: IRepository): Promise<{ ok: boolean; files?: string[] }>;
      }
    ).getConflictedFiles(makeRepo());
    return read.ok ? read.files : undefined;
  } finally {
    service.dispose();
  }
}

describe('rebase conflict read: a failed status is not a clean tree', () => {
  it('reports the unmerged paths when the tree is conflicted', () => {
    // Control: the harness reaches a real parse, so the failing case below
    // cannot pass merely by returning nothing.
    return readConflicts({
      exitCode: 0,
      stdout: `UU f.txt${NUL}`,
      stderr: '',
      combined: '',
    }).then((files) => assert.deepStrictEqual(files, ['f.txt']));
  });

  it('reports an EMPTY list for a genuinely clean tree', () => {
    // Control: an empty read on a SUCCESSFUL command is real information and
    // must stay a success, or every clean rebase becomes an error.
    return readConflicts({ exitCode: 0, stdout: '', stderr: '', combined: '' }).then((files) =>
      assert.deepStrictEqual(files, [])
    );
  });

  it('reports FAILURE when git exits non-zero, not an empty list', () => {
    // The defect: flattened to [], this told the autostash guard the tree was
    // clean and the rebase was reported complete over unmerged files.
    return readConflicts({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: unable to read index',
      combined: 'fatal: unable to read index',
    }).then((files) =>
      assert.strictEqual(files, undefined, 'a failed read is not an empty conflict set')
    );
  });
});

/**
 * Reaches the private consumers. The seam's three outcomes are pinned above;
 * these pin what each caller DOES with them, which is where the fix lives:
 * delete the failed-read arm from the consumers and the seam specs stay green
 * while the original defect is back.
 */
class RebaseProbe extends RebaseService {
  handle(repo: IRepository, result: IGitCommandResult): Promise<IRebaseResult> {
    const session = {
      repoPath: '/repo',
      status: 'in-progress',
      currentStep: 1,
      totalSteps: 1,
      commits: [],
    } as unknown as IRebaseSession;
    return (
      this as unknown as {
        handleRebaseResult(
          r: IRepository,
          s: IRebaseSession,
          res: IGitCommandResult
        ): Promise<IRebaseResult>;
      }
    ).handleRebaseResult(repo, session, result);
  }

  pausedForEdit(repo: IRepository): Promise<boolean> {
    return (
      this as unknown as { isPausedForEdit(r: IRepository): Promise<boolean> }
    ).isPausedForEdit(repo);
  }
}

describe('rebase consumers: an unreadable status is never a clean finish', () => {
  const clean: IGitCommandResult = { exitCode: 0, stdout: '', stderr: '', combined: '' };
  const failedStatus: IGitCommandResult = {
    exitCode: 128,
    stdout: '',
    stderr: 'fatal: unable to read index',
    combined: 'fatal: unable to read index',
  };

  it('reports a CONFLICT rather than a completed rebase when the status read fails', async () => {
    // The autostash guard. It exists because git can leave unmerged files and
    // still exit 0, so answering "clean" from a failed read is the one outcome
    // that loses the pop-conflict silently.
    const service = new RebaseProbe(new ScriptedGitCli(failedStatus));
    try {
      const outcome = await service.handle(makeRepo(), clean);
      assert.strictEqual(outcome.status, 'conflict', 'a failed read cannot vouch for a clean tree');
    } finally {
      service.dispose();
    }
  });

  it('still reports a completed rebase when the status read succeeds and is empty', async () => {
    // Control: the fix must not turn every clean rebase into a conflict.
    const service = new RebaseProbe(new ScriptedGitCli(clean));
    try {
      const outcome = await service.handle(makeRepo(), clean);
      assert.notStrictEqual(outcome.status, 'conflict');
    } finally {
      service.dispose();
    }
  });

  /**
   * A repo genuinely stopped mid-rebase: without the marker files
   * isPausedForEdit returns false before it ever reads the status, and the
   * case passes whatever the gate does.
   */
  function pausedRepo(): IRepository {
    fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
    const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'rebase-paused-'));
    const rebaseMerge = path.join(root, '.git', 'rebase-merge');
    fs.mkdirSync(rebaseMerge, { recursive: true });
    fs.writeFileSync(path.join(rebaseMerge, 'message'), 'pick something\n');
    fs.writeFileSync(path.join(rebaseMerge, 'stopped-sha'), 'abc123\n');
    return { rootUri: { fsPath: root } } as unknown as IRepository;
  }

  it('does not call a pause an EDIT pause when the status read fails', async () => {
    // Only a successful empty read means "stopped with nothing unmerged".
    // Guessing edit offers continue-style affordances for a conflict.
    const service = new RebaseProbe(new ScriptedGitCli(failedStatus));
    try {
      assert.strictEqual(await service.pausedForEdit(pausedRepo()), false);
    } finally {
      service.dispose();
    }
  });

  it('DOES call it an edit pause when the status read succeeds and is empty', async () => {
    // Control: the gate must still recognise a real edit pause, or amend stops
    // being offered where it belongs.
    const service = new RebaseProbe(new ScriptedGitCli(clean));
    try {
      assert.strictEqual(await service.pausedForEdit(pausedRepo()), true);
    } finally {
      service.dispose();
    }
  });
});

/**
 * The remaining four consumers. handleRebaseResult above is the sharpest case,
 * but it is not the only one: continue, skip, reword and amend each decide
 * "did that step finish?" from the same read, and each answered yes on a failed
 * read before the fix. Pinned per site, because deleting the failed-read arm
 * from ALL of them still left a suite that only noticed the one.
 */
describe('rebase steps: a failed read is never a finished step', () => {
  const clean: IGitCommandResult = { exitCode: 0, stdout: '', stderr: '', combined: '' };
  const failedStatus: IGitCommandResult = {
    exitCode: 128,
    stdout: '',
    stderr: 'fatal: unable to read index',
    combined: 'fatal: unable to read index',
  };

  /** Seeds the in-progress session these steps require before they read status. */
  class StepProbe extends RebaseService {
    seed(repo: IRepository): void {
      const self = this as unknown as {
        getRepoKey(r: IRepository): string;
        _sessions: Map<string, IRebaseSession>;
      };
      self._sessions.set(self.getRepoKey(repo), {
        repoPath: repo.rootUri.fsPath,
        status: 'in-progress',
        currentStep: 1,
        totalSteps: 1,
        commits: [],
      } as unknown as IRebaseSession);
    }
  }

  /**
   * The step commands only consult the status read when git itself reports a
   * failure: an exit-0 `rebase --continue` is answered from the .git markers
   * and never reads status. So the conflict arm is reachable only behind a
   * non-zero step, which is exactly the shape a real mid-rebase conflict takes.
   */
  class StepGitCli extends GitCli {
    constructor(private readonly _status: IGitCommandResult) {
      super('git');
    }

    override exec(args: string[]): Promise<IGitCommandResult> {
      if (args[0] === 'status') {
        return Promise.resolve(this._status);
      }
      if (args[0] === 'rebase' || args[0] === 'commit') {
        return Promise.resolve({
          exitCode: 1,
          stdout: '',
          stderr: 'could not apply',
          combined: 'could not apply',
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
    }
  }

  async function run(
    status: IGitCommandResult,
    call: (s: RebaseService, r: IRepository) => Promise<IRebaseResult>
  ): Promise<IRebaseResult> {
    const service = new StepProbe(new StepGitCli(status));
    const repo = makeRepo();
    service.seed(repo);
    try {
      return await call(service, repo);
    } finally {
      service.dispose();
    }
  }

  const steps: ReadonlyArray<{
    name: string;
    call: (s: RebaseService, r: IRepository) => Promise<IRebaseResult>;
  }> = [
    { name: 'continueRebase', call: (s, r) => s.continueRebase(r) },
    { name: 'skipCommit', call: (s, r) => s.skipCommit(r) },
    { name: 'provideRewordMessage', call: (s, r) => s.provideRewordMessage(r, 'msg') },
    { name: 'amendEditCommit', call: (s, r) => s.amendEditCommit(r, 'msg') },
  ];

  for (const step of steps) {
    it(`${step.name} reports a conflict when the status read fails`, async () => {
      const outcome = await run(failedStatus, step.call);
      assert.strictEqual(
        outcome.status,
        'conflict',
        'a failed read cannot vouch for a finished step'
      );
    });

    it(`${step.name} still succeeds when the status read succeeds and is empty`, async () => {
      // Control: without this the case above passes on a step that reports
      // 'conflict' unconditionally.
      const outcome = await run(clean, step.call);
      assert.notStrictEqual(outcome.status, 'conflict');
    });
  }
});
