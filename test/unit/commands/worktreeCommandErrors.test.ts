/**
 * BranchContextMenuCommands worktree handlers — Result Err-arm coverage.
 *
 * After the maximalist Result conversion, `listWorktrees` / `addWorktree`
 * return `ResultAsync<T, GitError>`. These specs prove the CALLER does not
 * swallow a failure: the Err arm surfaces a SANITIZED error toast (the
 * effort's thesis), rather than silently rendering "no worktrees" or eating
 * the failure.
 */

import '../../setup';
import * as assert from 'assert';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { GitError, SpawnFailedError, CommandFailedError } from '../../../src/git-core/errors';
import { IWorktreeEntry, IAddWorktreeOptions } from '../../../src/git-core/ops/WorktreeOps';
import { Uri } from '../../mocks/vscode';
import { installErrorMessageTracker, restoreMessageFunctions } from '../../typed/windowStub';

function makeRepo(): IRepository {
  return { rootUri: Uri.file('/test-repo') } as unknown as IRepository;
}

function makeProvider(repo: IRepository | undefined): BranchTreeProvider {
  return {
    getRepository: () => repo,
    refresh: () => {},
  } as unknown as BranchTreeProvider;
}

/** GitService stub exposing only the worktree capability the handlers use. */
function makeGitService(over: {
  listWorktrees?: () => ResultAsync<IWorktreeEntry[], GitError>;
  addWorktree?: (repo: IRepository, options: IAddWorktreeOptions) => ResultAsync<void, GitError>;
}): IGitService {
  return {
    listWorktrees:
      over.listWorktrees ?? ((): ResultAsync<IWorktreeEntry[], GitError> => okAsync([])),
    addWorktree: over.addWorktree ?? ((): ResultAsync<void, GitError> => okAsync(undefined)),
  } as unknown as IGitService;
}

interface WorktreeHandlerSurface {
  _handleOpenWorktree(): Promise<void>;
}

describe('worktree command handlers — Result Err arm', () => {
  afterEach(() => {
    restoreMessageFunctions();
  });

  it('_handleOpenWorktree surfaces a SANITIZED error toast when listWorktrees fails (no silent "no worktrees")', async () => {
    const tracker = installErrorMessageTracker();
    // A spawn fault whose message embeds a credential URL — proves the toast
    // is both shown (not swallowed) AND scrubbed via the Err arm.
    const leaky =
      "fatal: unable to access 'https://x-access-token:ghp_SECRETTOKEN123456@github.com/o/r.git/'";
    const gitService = makeGitService({
      listWorktrees: () => errAsync(new SpawnFailedError(leaky)),
    });
    const commands = new BranchContextMenuCommands(gitService, makeProvider(makeRepo()));

    await (commands as unknown as WorktreeHandlerSurface)._handleOpenWorktree();

    assert.strictEqual(tracker.calls.length, 1, 'exactly one error toast on failure');
    const shown = tracker.calls[0].message;
    assert.match(shown, /Failed to list worktrees/);
    assert.ok(!shown.includes('ghp_SECRETTOKEN123456'), 'token must be redacted from the toast');
    assert.ok(shown.includes('<redacted>'), 'sanitized placeholder present');
  });

  it('_handleOpenWorktree shows the toast for a command-failed listing too', async () => {
    const tracker = installErrorMessageTracker();
    const gitService = makeGitService({
      listWorktrees: () => errAsync(new CommandFailedError(128, 'fatal: not a git repository')),
    });
    const commands = new BranchContextMenuCommands(gitService, makeProvider(makeRepo()));

    await (commands as unknown as WorktreeHandlerSurface)._handleOpenWorktree();

    assert.strictEqual(tracker.calls.length, 1);
    assert.match(tracker.calls[0].message, /Failed to list worktrees/);
  });
});
