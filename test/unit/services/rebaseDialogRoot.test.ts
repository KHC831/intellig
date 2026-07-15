/**
 * Unit tests for H2 — `--root` flag in the Rebase Dialog.
 *
 * Covers:
 *   - `loadRebaseOptions` returns `root: false` by default.
 *   - `loadRebaseOptions` reads `root: true` from stored state.
 *   - HTML includes a "root" checkbox.
 *   - When root is pre-checked (persisted), the onto select has `disabled`.
 *   - `saveRebaseOptions` persists the `root` flag.
 *   - Non-interactive rebase with root=true forwards `root: true` to `rebaseBranch`.
 */

import '../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import { extractWebviewScript } from '../../helpers/webviewHtml';
import * as vscode from 'vscode';
import {
  RebaseDialog,
  IRebaseDialogOptions,
  IPersistedRebaseOptions,
  IRebaseOptionsStore,
  REBASE_OPTIONS_STATE_KEY,
  loadRebaseOptions,
  saveRebaseOptions,
} from '../../../src/rebase/RebaseDialog';
import {
  IGitService,
  IRepository,
  IBasicRebaseResult,
  IRebaseOptions,
} from '../../../src/git-core/interfaces/IGitService';
import { RebaseEditor } from '../../../src/rebase/RebaseEditor';
import { Uri } from '../../mocks/vscode';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function makeStore(initial: Record<string, unknown> = {}): IRebaseOptionsStore {
  return makeMemento(initial) as unknown as IRebaseOptionsStore;
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
  public renderedHtml(): string {
    return (this as unknown as { _panel: { webview: { html: string } } })._panel.webview.html;
  }
}

/** Run the dialog's inline nonce'd script in jsdom and return the built DOM. */
const _entryHarnesses: IWebviewEntryHarness[] = [];
afterEach(() => {
  while (_entryHarnesses.length > 0) {
    _entryHarnesses.pop()?.dispose();
  }
});

/** Boot the bundled rebase entry against the host body (incl. init island). */
function renderRebaseDoc(dialog: TestRebaseDialog): Document {
  const bodyHtml = extractWebviewScript(dialog.renderedHtml()).bodyHtml;
  assert.ok(
    !/id="flag-root"/.test(bodyHtml),
    'controls must not be pre-baked in host markup — the entry builds the DOM'
  );
  const h = bootWebviewEntry('rebase/webview/rebaseDialog', { bodyHtml });
  _entryHarnesses.push(h);
  return h.document;
}

function makeDialog(
  overrides: Partial<IRebaseDialogOptions> & { contextState?: Record<string, unknown> } = {}
): { dialog: TestRebaseDialog; gitService: GitServiceStub } {
  const gitService = (overrides.gitService as GitServiceStub | undefined) ?? makeGitService();
  const dialog = new TestRebaseDialog(makeContext(overrides.contextState ?? {}), {
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

// ─── loadRebaseOptions ────────────────────────────────────────────────────────

describe('loadRebaseOptions — root flag (H2)', () => {
  it('returns root: false by default when nothing is stored', () => {
    const store = makeStore();
    const options = loadRebaseOptions(store);
    assert.strictEqual(options.root, false, 'root defaults to false');
  });

  it('returns root: false when stored object lacks the key', () => {
    const store = makeStore({
      [REBASE_OPTIONS_STATE_KEY]: {
        rebaseMerges: true,
        keepEmpty: false,
        updateRefs: false,
        autosquash: false,
      },
    });
    const options = loadRebaseOptions(store);
    assert.strictEqual(options.root, false, 'missing key coerces to false');
  });

  it('reads root: true from stored state', () => {
    const store = makeStore({
      [REBASE_OPTIONS_STATE_KEY]: {
        rebaseMerges: false,
        keepEmpty: false,
        updateRefs: false,
        autosquash: false,
        root: true,
      },
    });
    const options = loadRebaseOptions(store);
    assert.strictEqual(options.root, true, 'stored root=true is loaded');
  });

  it('reads root: false explicitly from stored state', () => {
    const store = makeStore({
      [REBASE_OPTIONS_STATE_KEY]: {
        rebaseMerges: false,
        keepEmpty: false,
        updateRefs: false,
        autosquash: false,
        root: false,
      },
    });
    const options = loadRebaseOptions(store);
    assert.strictEqual(options.root, false, 'stored root=false is loaded');
  });
});

// ─── saveRebaseOptions ────────────────────────────────────────────────────────

describe('saveRebaseOptions — root flag (H2)', () => {
  it('persists root: true and re-reads it correctly', async () => {
    const store = makeStore();
    const toSave: IPersistedRebaseOptions = {
      rebaseMerges: false,
      keepEmpty: false,
      updateRefs: false,
      autosquash: false,
      root: true,
    };
    await saveRebaseOptions(store, toSave);
    const loaded = loadRebaseOptions(store);
    assert.strictEqual(loaded.root, true, 'root: true survives a save + load round-trip');
  });

  it('persists root: false and re-reads it correctly', async () => {
    const store = makeStore();
    const toSave: IPersistedRebaseOptions = {
      rebaseMerges: false,
      keepEmpty: false,
      updateRefs: false,
      autosquash: false,
      root: false,
    };
    await saveRebaseOptions(store, toSave);
    const loaded = loadRebaseOptions(store);
    assert.strictEqual(loaded.root, false, 'root: false survives a save + load round-trip');
  });
});

// ─── HTML structure ───────────────────────────────────────────────────────────

describe('RebaseDialog — root checkbox DOM (H2)', () => {
  it('builds a root checkbox with the --root flag label', () => {
    suppressVscodeMessages();
    const { dialog } = makeDialog();
    const doc = renderRebaseDoc(dialog);
    const root = doc.querySelector('#flag-root');
    assert.ok(root, 'root checkbox is present');
    const rootLabel = root.closest('label.flag');
    assert.ok(rootLabel?.textContent?.includes('--root'), '--root flag label is shown');
  });

  it('root checkbox is unchecked by default', () => {
    suppressVscodeMessages();
    const { dialog } = makeDialog();
    const doc = renderRebaseDoc(dialog);
    assert.strictEqual(
      (doc.querySelector('#flag-root') as HTMLInputElement).checked,
      false,
      'root defaults to unchecked'
    );
  });

  it('onto select is NOT disabled when root is unchecked', () => {
    suppressVscodeMessages();
    const { dialog } = makeDialog();
    const doc = renderRebaseDoc(dialog);
    assert.strictEqual(
      (doc.querySelector('#onto-select') as HTMLSelectElement).disabled,
      false,
      'onto-select is not disabled when root is off'
    );
  });

  it('onto select is disabled when root was persisted as true', () => {
    suppressVscodeMessages();
    // Provide a context where root=true is pre-persisted so the dialog renders
    // with the onto-select disabled.
    const { dialog } = makeDialog({
      contextState: {
        [REBASE_OPTIONS_STATE_KEY]: {
          rebaseMerges: false,
          keepEmpty: false,
          updateRefs: false,
          autosquash: false,
          root: true,
        },
      },
    });
    const doc = renderRebaseDoc(dialog);
    assert.strictEqual(
      (doc.querySelector('#onto-select') as HTMLSelectElement).disabled,
      true,
      'onto-select is disabled when root is checked'
    );
    assert.strictEqual(
      (doc.querySelector('#flag-root') as HTMLInputElement).checked,
      true,
      'root checkbox is pre-checked'
    );
  });
});

// ─── Non-interactive execution ────────────────────────────────────────────────

describe('RebaseDialog — root flag forwarded to rebaseBranch (H2)', () => {
  beforeEach(() => {
    suppressVscodeMessages();
  });

  it('forwards root: true to rebaseBranch when the root message flag is set', async () => {
    const { dialog, gitService } = makeDialog({ branchChoices: ['main', 'develop'] });
    await dialog.simulateMessage({
      type: 'rebase',
      onto: 'develop',
      interactive: false,
      rebaseMerges: false,
      keepEmpty: false,
      updateRefs: false,
      autosquash: false,
      root: true,
    });
    assert.strictEqual(gitService._rebaseCalls.length, 1);
    assert.strictEqual(gitService._rebaseCalls[0].options?.root, true);
  });

  it('forwards root: false when the root flag is absent from the message', async () => {
    const { dialog, gitService } = makeDialog({ branchChoices: ['main', 'develop'] });
    await dialog.simulateMessage({
      type: 'rebase',
      onto: 'develop',
      interactive: false,
    });
    assert.strictEqual(gitService._rebaseCalls.length, 1);
    assert.strictEqual(gitService._rebaseCalls[0].options?.root, false);
  });
});
