/**
 * Merge success → propose deleting the merged local branch.
 *
 * git4idea parity: GitBranchPopupActions.MergeAction passes
 * deleteOnMerge = PROPOSE for a non-protected local branch
 * (GitBranchPopupActions.java:287-291), and GitMergeOperation.notifySuccess's
 * PROPOSE arm posts a "Delete <branch>" action on the success notification.
 * Accepting deletes the branch, force-retrying on not-fully-merged (the
 * reference's GitDeleteBranchOperation auto-forces) — a squash merge leaves
 * the branch unmerged by design.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { MergeDialog } from '../../../src/conflicts/MergeDialog';
import {
  IGitService,
  IMergeResult,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';
import { okAsync, errAsync } from 'neverthrow';
import { Uri } from '../../mocks/vscode';
import { restoreMessageFunctions, writableWindow } from '../../typed/windowStub';

function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file('/tmp/ext'),
    extensionMode: 3,
  } as unknown as vscode.ExtensionContext;
}

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

interface Recording {
  deleted: Array<{ name: string; force: boolean | undefined }>;
}

function makeGitService(
  result: IMergeResult,
  notFullyMergedOnSafeDelete = false
): IGitService & Recording {
  const deleted: Recording['deleted'] = [];
  return {
    deleted,
    mergeBranch: async () => result,
    deleteBranch: (_repo: IRepository, name: string, force?: boolean) => {
      if (notFullyMergedOnSafeDelete && !force) {
        return errAsync(new Error(`error: the branch '${name}' is not fully merged`));
      }
      deleted.push({ name, force });
      return okAsync(undefined);
    },
    reloadRepository: async (repo: IRepository) => repo,
  } as unknown as IGitService & Recording;
}

class TestMergeDialog extends MergeDialog {
  public async simulateMessage(raw: unknown): Promise<void> {
    await (this as unknown as { _onMessage(m: unknown): Promise<void> })._onMessage(raw);
  }
}

interface InfoCall {
  message: string;
  items: string[];
}

/** Track info toasts; resolve with `choice` when it is among the offered items. */
function installChoosingInfoTracker(choice?: string): InfoCall[] {
  const calls: InfoCall[] = [];
  writableWindow().showInformationMessage = (
    message: string,
    ...items: string[]
  ): Promise<string | undefined> => {
    calls.push({ message, items });
    return Promise.resolve(choice && items.includes(choice) ? choice : undefined);
  };
  return calls;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('MergeDialog — deleteOnMerge PROPOSE', () => {
  afterEach(() => restoreMessageFunctions());

  it('offers Delete <branch> on success and deletes it on accept', async () => {
    const gitService = makeGitService({ success: true, mergeCommit: 'abc123' });
    const info = installChoosingInfoTracker('Delete feature/x');
    const dialog = new TestMergeDialog(makeContext(), {
      repo: makeRepo(),
      sourceBranch: 'feature/x',
      gitService,
      proposeDeleteOnMerge: true,
    });

    await dialog.simulateMessage({ type: 'merge', flags: {} });
    await settle();

    assert.ok(
      info.some((c) => c.items.includes('Delete feature/x')),
      `success toast must offer deleting the merged branch; got: ${JSON.stringify(info)}`
    );
    assert.deepStrictEqual(
      gitService.deleted.map((d) => d.name),
      ['feature/x']
    );
  });

  it('force-retries the delete when the branch is not fully merged (squash merge)', async () => {
    const gitService = makeGitService({ success: true }, true);
    installChoosingInfoTracker('Delete feature/x');
    const dialog = new TestMergeDialog(makeContext(), {
      repo: makeRepo(),
      sourceBranch: 'feature/x',
      gitService,
      proposeDeleteOnMerge: true,
    });

    await dialog.simulateMessage({ type: 'merge', flags: { squash: true } });
    await settle();

    assert.deepStrictEqual(gitService.deleted, [{ name: 'feature/x', force: true }]);
  });

  it('does not offer the delete when the flag is absent (tag merges, protected branches)', async () => {
    const gitService = makeGitService({ success: true, mergeCommit: 'abc123' });
    const info = installChoosingInfoTracker('Delete v1.0');
    const dialog = new TestMergeDialog(makeContext(), {
      repo: makeRepo(),
      sourceBranch: 'v1.0',
      gitService,
    });

    await dialog.simulateMessage({ type: 'merge', flags: {} });
    await settle();

    assert.ok(!info.some((c) => c.items.includes('Delete v1.0')), 'no PROPOSE without the flag');
    assert.strictEqual(gitService.deleted.length, 0);
  });
});
