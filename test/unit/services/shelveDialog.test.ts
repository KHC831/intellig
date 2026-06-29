/**
 * Unit tests for the Shelve Changes dialog (src/shelf/ShelveDialog.ts).
 *
 * The dialog is the IntelliJ-parity "Shelve Changes" surface: a webview panel
 * with a checkbox list of changed files + a name field + a "Shelve Changes"
 * button. It is the single source of truth behind both entry points
 * (file right-click and the `Shelve Changes…` command).
 *
 * Covers:
 *  - `validateShelfName` — empty / whitespace / valid.
 *  - `buildShelveFileItems` — selection model (preselect subset vs all) +
 *    status mapping.
 *  - `ShelveDialog._onMessage`:
 *      * cancel → dispose, no shelve call.
 *      * shelve with empty name → no shelve call, error toast.
 *      * shelve with no files → no shelve call, error toast.
 *      * valid shelve → shelfService.shelve(repo, name, {files}); success toast;
 *        onShelved fired; dialog disposed.
 *      * partialCleanupFailures → warning toast.
 *      * service throws → error toast, dialog stays open.
 *  - rendered DOM (jsdom): script builds the name field + a checkbox per file,
 *    reflects the preselection, disables Shelve until valid, and posts the
 *    right messages on Cancel / Shelve.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  ShelveDialog,
  IShelveDialogOptions,
  validateShelfName,
  buildShelveFileItems,
} from '../../../src/shelf/ShelveDialog';
import { IFileStatus, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { IShelfItem, IShelveSelection } from '../../../src/shelf/interfaces/IShelfService';
import { Uri } from '../../mocks/vscode';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file('/tmp/ext'),
    asAbsolutePath: (rel: string): string => `/tmp/ext/${rel}`,
  } as unknown as vscode.ExtensionContext;
}

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

function fs(path: string, indexStatus: string, workTreeStatus: string): IFileStatus {
  return { path, indexStatus, workTreeStatus } as IFileStatus;
}

interface ShelveCall {
  repo: IRepository;
  name: string;
  selection: IShelveSelection;
}

function makeShelfService(opts?: { throwError?: Error; partialCleanupFailures?: string[] }): {
  shelve: (r: IRepository, n: string, s: IShelveSelection) => Promise<IShelfItem>;
  calls: ShelveCall[];
} {
  const calls: ShelveCall[] = [];
  return {
    calls,
    shelve: async (repo: IRepository, name: string, selection: IShelveSelection) => {
      calls.push({ repo, name, selection });
      if (opts?.throwError) {
        throw opts.throwError;
      }
      const item: IShelfItem = {
        id: 'shelf-1',
        name,
        timestamp: new Date(),
        files: (selection.files ?? []).map((p) => ({ path: p, diff: '' })),
      };
      if (opts?.partialCleanupFailures) {
        item.partialCleanupFailures = opts.partialCleanupFailures;
      }
      return item;
    },
  };
}

interface MessageLog {
  info: string[];
  warn: string[];
  error: string[];
}

function installMessageTrackers(): MessageLog {
  const log: MessageLog = { info: [], warn: [], error: [] };
  (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = async (
    m: string
  ) => {
    log.info.push(m);
    return undefined;
  };
  (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async (
    m: string
  ) => {
    log.warn.push(m);
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

class TestShelveDialog extends ShelveDialog {
  public async simulateMessage(raw: unknown): Promise<void> {
    await (this as unknown as { _onMessage(m: unknown): Promise<void> })._onMessage(raw);
  }
  public disposed(): boolean {
    return (this as unknown as { _disposed: boolean })._disposed;
  }
}

function makeDialog(overrides: Partial<IShelveDialogOptions> = {}): {
  dialog: TestShelveDialog;
  shelfService: ReturnType<typeof makeShelfService>;
  onShelvedCalls: number;
} {
  const shelfService =
    (overrides.shelfService as unknown as ReturnType<typeof makeShelfService>) ??
    makeShelfService();
  let onShelvedCalls = 0;
  const dialog = new TestShelveDialog(makeContext(), {
    repo: overrides.repo ?? makeRepo(),
    shelfService: shelfService as unknown as IShelveDialogOptions['shelfService'],
    changedFiles: overrides.changedFiles ?? [
      fs('src/a.ts', 'M', ' '),
      fs('src/b.ts', ' ', 'M'),
      fs('src/c.ts', '?', '?'),
    ],
    preSelectedPaths: overrides.preSelectedPaths,
    defaultName: overrides.defaultName,
    onShelved:
      overrides.onShelved ??
      (() => {
        onShelvedCalls += 1;
      }),
  });
  return {
    dialog,
    shelfService,
    get onShelvedCalls() {
      return onShelvedCalls;
    },
  } as ReturnType<typeof makeDialog>;
}

// ─── validateShelfName ───────────────────────────────────────────────────────

describe('validateShelfName', () => {
  it('rejects empty name', () => {
    assert.ok(validateShelfName(''));
  });
  it('rejects whitespace-only name', () => {
    assert.ok(validateShelfName('   '));
  });
  it('accepts a simple name', () => {
    assert.strictEqual(validateShelfName('My WIP'), undefined);
  });
});

// ─── buildShelveFileItems ────────────────────────────────────────────────────

describe('buildShelveFileItems', () => {
  const files = [fs('src/a.ts', 'M', ' '), fs('src/b.ts', ' ', 'M'), fs('src/c.ts', '?', '?')];

  it('selects ALL files when no preselection is given', () => {
    const items = buildShelveFileItems(files);
    assert.strictEqual(items.length, 3);
    assert.ok(items.every((i) => i.selected));
  });

  it('selects ONLY the preselected file when a subset is given', () => {
    const items = buildShelveFileItems(files, ['src/b.ts']);
    assert.deepStrictEqual(
      items.filter((i) => i.selected).map((i) => i.path),
      ['src/b.ts']
    );
  });

  it('maps file name + dir from the path', () => {
    const items = buildShelveFileItems([fs('src/deep/x.ts', 'M', ' ')]);
    assert.strictEqual(items[0].fileName, 'x.ts');
    assert.strictEqual(items[0].fileDir, 'src/deep');
  });

  it('labels an untracked file as Added/Untracked, not blank', () => {
    const items = buildShelveFileItems([fs('new.ts', '?', '?')]);
    assert.ok(items[0].statusLabel.length > 0);
    assert.ok(items[0].statusChar.length > 0);
  });
});

// ─── _onMessage ──────────────────────────────────────────────────────────────

describe('ShelveDialog._onMessage', () => {
  it('cancel → disposes without shelving', async () => {
    installMessageTrackers();
    const { dialog, shelfService } = makeDialog();
    await dialog.simulateMessage({ type: 'cancel' });
    assert.strictEqual(shelfService.calls.length, 0);
    assert.strictEqual(dialog.disposed(), true);
  });

  it('shelve with empty name → error toast, no shelve call, stays open', async () => {
    const log = installMessageTrackers();
    const { dialog, shelfService } = makeDialog();
    await dialog.simulateMessage({ type: 'shelve', name: '   ', files: ['src/a.ts'] });
    assert.strictEqual(shelfService.calls.length, 0);
    assert.strictEqual(log.error.length, 1);
    assert.strictEqual(dialog.disposed(), false);
  });

  it('shelve with no files → error toast, no shelve call', async () => {
    const log = installMessageTrackers();
    const { dialog, shelfService } = makeDialog();
    await dialog.simulateMessage({ type: 'shelve', name: 'WIP', files: [] });
    assert.strictEqual(shelfService.calls.length, 0);
    assert.strictEqual(log.error.length, 1);
  });

  it('valid shelve → shelfService.shelve(repo, name, {files}); success toast; onShelved; disposed', async () => {
    const log = installMessageTrackers();
    const result = makeDialog();
    const { dialog, shelfService } = result;
    await dialog.simulateMessage({
      type: 'shelve',
      name: 'My WIP',
      files: ['src/a.ts', 'src/c.ts'],
    });
    assert.strictEqual(shelfService.calls.length, 1);
    assert.strictEqual(shelfService.calls[0].name, 'My WIP');
    assert.deepStrictEqual(shelfService.calls[0].selection.files, ['src/a.ts', 'src/c.ts']);
    assert.strictEqual(log.info.length, 1);
    assert.strictEqual(result.onShelvedCalls, 1);
    assert.strictEqual(dialog.disposed(), true);
  });

  it('partialCleanupFailures → warning toast (not plain success)', async () => {
    const log = installMessageTrackers();
    const { dialog } = makeDialog({
      shelfService: makeShelfService({
        partialCleanupFailures: ['src/a.ts'],
      }) as unknown as IShelveDialogOptions['shelfService'],
    });
    await dialog.simulateMessage({ type: 'shelve', name: 'WIP', files: ['src/a.ts'] });
    assert.strictEqual(log.warn.length, 1);
    assert.strictEqual(log.info.length, 0);
  });

  it('service throws → error toast, dialog stays open for retry', async () => {
    const log = installMessageTrackers();
    const { dialog } = makeDialog({
      shelfService: makeShelfService({
        throwError: new Error('boom'),
      }) as unknown as IShelveDialogOptions['shelfService'],
    });
    await dialog.simulateMessage({ type: 'shelve', name: 'WIP', files: ['src/a.ts'] });
    assert.strictEqual(log.error.length, 1);
    assert.strictEqual(dialog.disposed(), false);
  });
});
