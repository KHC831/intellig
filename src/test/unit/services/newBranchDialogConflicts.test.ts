import * as assert from 'assert';
import * as vscode from 'vscode';
import { NewBranchDialog, INewBranchDialogOptions } from '../../../branches/NewBranchDialog';
import {
  IBranch,
  IGitService,
  IRepository,
  ICreateBranchOptions,
} from '../../../git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

/**
 * Conflict-aware validation in {@link NewBranchDialog} (D slice 3).
 *
 * Mirrors git4idea `GitNewBranchDialog.validateBranchName`, which blocks
 * Create when the typed name conflicts with an existing local branch, the
 * current branch, a branch directory, or a remote branch — unless the
 * "overwrite existing" option is selected (which bypasses the local-branch
 * conflict only).
 */

function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    asAbsolutePath: (rel: string): string => `/tmp/ext/${rel}`,
    extensionUri: vscode.Uri.file('/tmp/ext'),
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

function branch(name: string, type: 'local' | 'remote', isHead = false): IBranch {
  return { name, type, commit: 'deadbeef', isHead };
}

interface CreateCall {
  name: string;
  options?: string | ICreateBranchOptions;
}

function makeGitService(branches: IBranch[]): IGitService & { _calls: CreateCall[] } {
  const calls: CreateCall[] = [];
  return {
    _calls: calls,
    getBranches: async () => branches,
    createBranch: async (
      _repo: IRepository,
      name: string,
      options?: string | ICreateBranchOptions
    ) => {
      calls.push({ name, options });
    },
  } as unknown as IGitService & { _calls: CreateCall[] };
}

function installMessageTrackers(): { info: string[]; error: string[] } {
  const log = { info: [] as string[], error: [] as string[] };
  (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = async (
    m: string
  ) => {
    log.info.push(m);
    return undefined;
  };
  (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = async (
    m: string
  ) => {
    log.error.push(m);
    return undefined;
  };
  return log;
}

class TestDialog extends NewBranchDialog {
  public async simulate(raw: unknown): Promise<void> {
    await (this as unknown as { _onMessage(m: unknown): Promise<void> })._onMessage(raw);
  }
  public disposed(): boolean {
    return (this as unknown as { _disposed: boolean })._disposed;
  }
}

function makeDialog(
  branches: IBranch[],
  overrides: Partial<INewBranchDialogOptions> = {}
): { dialog: TestDialog; gitService: IGitService & { _calls: CreateCall[] } } {
  const gitService = makeGitService(branches);
  const dialog = new TestDialog(makeContext(), {
    repo: makeRepo(),
    gitService,
    startPoint: overrides.startPoint ?? 'main',
    defaultName: overrides.defaultName,
  });
  return { dialog, gitService };
}

describe('NewBranchDialog — conflict-aware create', () => {
  it('blocks create when name matches an existing local branch', async () => {
    const log = installMessageTrackers();
    const { dialog, gitService } = makeDialog([branch('dev', 'local')]);
    await dialog.simulate({ type: 'create', name: 'dev', checkout: true });
    assert.strictEqual(gitService._calls.length, 0, 'no git call for a conflicting name');
    assert.strictEqual(log.error.length, 1);
    assert.match(log.error[0], /already exists/i);
  });

  it('blocks create when name equals the current branch', async () => {
    const log = installMessageTrackers();
    const { dialog, gitService } = makeDialog([branch('main', 'local', true)]);
    await dialog.simulate({ type: 'create', name: 'main', checkout: true });
    assert.strictEqual(gitService._calls.length, 0);
    assert.match(log.error[0], /current branch/i);
  });

  it('blocks create when name clashes with an existing branch directory', async () => {
    const log = installMessageTrackers();
    const { dialog, gitService } = makeDialog([branch('feature/x', 'local')]);
    await dialog.simulate({ type: 'create', name: 'feature', checkout: true });
    assert.strictEqual(gitService._calls.length, 0);
    assert.match(log.error[0], /director/i);
  });

  it('allows overwriting an existing local branch when overwrite is set', async () => {
    installMessageTrackers();
    const { dialog, gitService } = makeDialog([branch('dev', 'local')]);
    await dialog.simulate({ type: 'create', name: 'dev', overwrite: true, checkout: true });
    assert.strictEqual(gitService._calls.length, 1, 'overwrite bypasses the local conflict');
    const opts = gitService._calls[0].options as ICreateBranchOptions;
    assert.strictEqual(opts.force, true);
  });

  it('still blocks a directory clash even when overwrite is set', async () => {
    const log = installMessageTrackers();
    const { dialog, gitService } = makeDialog([branch('feature/x', 'local')]);
    await dialog.simulate({ type: 'create', name: 'feature', overwrite: true, checkout: true });
    assert.strictEqual(gitService._calls.length, 0);
    assert.match(log.error[0], /director/i);
  });

  it('allows a unique, non-conflicting name', async () => {
    installMessageTrackers();
    const { dialog, gitService } = makeDialog([branch('main', 'local', true)]);
    await dialog.simulate({ type: 'create', name: 'feature/login', checkout: true });
    assert.strictEqual(gitService._calls.length, 1);
  });
});
