/**
 * H-2 — `--onto <newbase>` field in the Rebase Dialog.
 *
 * Covers:
 *   - HTML includes a newbase select with a "(none)" default option.
 *   - A selected newbase is forwarded to `rebaseBranch` as `options.newBase`.
 *   - The empty "(none)" selection forwards no newBase (default behavior).
 *   - A newBase the dialog never offered is dropped (webview cannot steer the
 *     rebase onto an arbitrary ref).
 *
 * North-star: git4idea GitRebaseDialog "Onto" new-base field.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { RebaseDialog, IRebaseDialogOptions } from '../../../src/rebase/RebaseDialog';
import {
  IGitService,
  IRepository,
  IBasicRebaseResult,
  IRebaseOptions,
} from '../../../src/git-core/interfaces/IGitService';
import { RebaseEditor } from '../../../src/rebase/RebaseEditor';
import { Uri } from '../../mocks/vscode';

function makeMemento(initial: Record<string, unknown> = {}): vscode.Memento {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    keys: () => Array.from(data.keys()),
    get: <T>(key: string, fallback?: T): T =>
      data.has(key) ? (data.get(key) as T) : (fallback as T),
    update: (key: string, value: unknown): Thenable<void> => {
      data.set(key, value);
      return Promise.resolve();
    },
  } as unknown as vscode.Memento;
}

function makeContext(initial: Record<string, unknown> = {}): vscode.ExtensionContext {
  return {
    subscriptions: [],
    workspaceState: makeMemento(),
    globalState: makeMemento(initial),
    extensionPath: '/tmp/ext',
    extensionUri: vscode.Uri.file('/tmp/ext'),
    globalStorageUri: vscode.Uri.file('/tmp/global'),
    logUri: vscode.Uri.file('/tmp/log'),
    extensionMode: 3,
    asAbsolutePath: (rel: string): string => `/tmp/ext/${rel}`,
  } as unknown as vscode.ExtensionContext;
}

function makeRepo(headName: string = 'main'): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: `refs/heads/${headName}`, commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

interface RebaseCall {
  repo: IRepository;
  onto: string;
  options?: IRebaseOptions;
}

interface GitServiceStub extends IGitService {
  _rebaseCalls: RebaseCall[];
}

function makeGitService(result: IBasicRebaseResult = { success: true }): GitServiceStub {
  const rebaseCalls: RebaseCall[] = [];
  const stub = {
    _rebaseCalls: rebaseCalls,
    rebaseBranch: async (
      repo: IRepository,
      onto: string,
      options?: IRebaseOptions
    ): Promise<IBasicRebaseResult> => {
      rebaseCalls.push({ repo, onto, options });
      return result;
    },
    reloadRepository: async (): Promise<IRepository | undefined> => undefined,
    rebaseAbort: async (): Promise<void> => {},
  } as unknown as GitServiceStub;
  return stub;
}

function makeEditorFactory(): () => RebaseEditor {
  const editor = {
    show: async (): Promise<{ completed: boolean }> => ({ completed: true }),
  } as unknown as RebaseEditor;
  return () => editor;
}

class TestRebaseDialog extends RebaseDialog {
  public async simulateMessage(raw: unknown): Promise<void> {
    await (this as unknown as { _onMessage(m: unknown): Promise<void> })._onMessage(raw);
  }
  public bodyHtml(): string {
    return (this as unknown as { _getBodyParts(): { body: string } })._getBodyParts().body;
  }
}

function makeDialog(overrides: Partial<IRebaseDialogOptions> = {}): {
  dialog: TestRebaseDialog;
  gitService: GitServiceStub;
} {
  const gitService = (overrides.gitService as GitServiceStub | undefined) ?? makeGitService();
  const dialog = new TestRebaseDialog(makeContext(), {
    repo: overrides.repo ?? makeRepo(),
    onto: overrides.onto ?? 'main',
    branchChoices: overrides.branchChoices ?? ['main', 'develop'],
    gitService,
    createRebaseEditor: overrides.createRebaseEditor ?? makeEditorFactory(),
  });
  return { dialog, gitService };
}

function suppressVscodeMessages(): void {
  (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
    async () => undefined;
  (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = async () =>
    undefined;
  (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async () =>
    undefined;
}

describe('RebaseDialog — newbase (--onto) field HTML (H-2)', () => {
  it('includes a newbase select with a "(none)" default option', () => {
    suppressVscodeMessages();
    const { dialog } = makeDialog();
    const body = dialog.bodyHtml();
    assert.ok(body.includes('id="newbase-select"'), 'newbase select is present');
    assert.ok(body.includes('value=""'), 'newbase select offers an empty (none) default');
  });
});

describe('RebaseDialog — newbase forwarded to rebaseBranch (H-2)', () => {
  beforeEach(() => {
    suppressVscodeMessages();
  });

  it('forwards a selected newBase to rebaseBranch', async () => {
    const { dialog, gitService } = makeDialog({ branchChoices: ['main', 'develop'] });
    await dialog.simulateMessage({
      type: 'rebase',
      onto: 'main',
      interactive: false,
      newBase: 'develop',
    });
    assert.strictEqual(gitService._rebaseCalls.length, 1);
    assert.strictEqual(gitService._rebaseCalls[0].options?.newBase, 'develop');
  });

  it('forwards no newBase when the (none) empty value is submitted', async () => {
    const { dialog, gitService } = makeDialog({ branchChoices: ['main', 'develop'] });
    await dialog.simulateMessage({
      type: 'rebase',
      onto: 'main',
      interactive: false,
      newBase: '',
    });
    assert.strictEqual(gitService._rebaseCalls.length, 1);
    assert.strictEqual(gitService._rebaseCalls[0].options?.newBase, undefined);
  });

  it('drops a newBase the dialog never offered (anti-injection)', async () => {
    const { dialog, gitService } = makeDialog({ branchChoices: ['main', 'develop'] });
    await dialog.simulateMessage({
      type: 'rebase',
      onto: 'main',
      interactive: false,
      newBase: '-evil',
    });
    assert.strictEqual(gitService._rebaseCalls.length, 1);
    assert.strictEqual(gitService._rebaseCalls[0].options?.newBase, undefined);
  });
});
