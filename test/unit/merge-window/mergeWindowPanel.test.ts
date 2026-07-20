import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  MergeWindowPanel,
  IMergeWindowConflictContext,
} from '../../../src/conflicts/merge-window/MergeWindowPanel';
import { MergeView } from '../../../src/conflicts/MergeView';
import { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { GitCli } from '../../../src/git-core/gitCli';
import { resetMockConfiguration, setMockConfigValue } from '../../mocks/vscode';

interface IMockPanel extends vscode.WebviewPanel {
  _revealCallCount: number;
  _fireMessage(message: unknown): void;
}

/** Wraps the mock createWebviewPanel to capture every panel it hands out. */
function capturePanels(): { created: IMockPanel[]; restore(): void } {
  const created: IMockPanel[] = [];
  const original = vscode.window.createWebviewPanel;
  (vscode.window as { createWebviewPanel: typeof original }).createWebviewPanel = (
    ...args: Parameters<typeof original>
  ): vscode.WebviewPanel => {
    const panel = original(...args) as IMockPanel;
    created.push(panel);
    return panel;
  };
  return {
    created,
    restore: (): void => {
      (vscode.window as { createWebviewPanel: typeof original }).createWebviewPanel = original;
    },
  };
}

function fakeContext(store: Map<string, unknown> = new Map()): vscode.ExtensionContext {
  const workspaceState = {
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    update: (key: string, value: unknown): Promise<void> => {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
      return Promise.resolve();
    },
  };
  return {
    extensionUri: vscode.Uri.file('/ext'),
    workspaceState,
  } as unknown as vscode.ExtensionContext;
}

function buildPanel(
  absolutePath: string,
  stagedPaths: string[][],
  gitCli: GitCli = {} as GitCli,
  conflictContext: IMergeWindowConflictContext = { stageNames: {}, operation: 'merge' },
  store: Map<string, unknown> = new Map()
): { panel: PanelProbe; applied: string[] } {
  const applied: string[] = [];
  const repository = { rootUri: vscode.Uri.file('/repo') } as IRepository;
  const gitService = {
    stage: (_repo: IRepository, paths: string[]) => ({
      match: <T>(okFn: () => T): Promise<T> => {
        stagedPaths.push(paths);
        return Promise.resolve(okFn());
      },
    }),
  } as unknown as IGitService;
  const panel = new PanelProbe(fakeContext(store), {
    repository,
    relPath: path.basename(absolutePath),
    absolutePath,
    conflictContext,
    gitCli,
    gitService,
    onApplied: (rel): void => {
      applied.push(rel);
    },
  });
  return { panel, applied };
}

/**
 * A gitCli whose exec serves one conflicted path's three index stages.
 * `salt` varies the stage blob SHAs, i.e. makes it a DIFFERENT conflict.
 */
function stubStagesGitCli(relPath: string, salt = '1'): GitCli {
  const shas = {
    base: salt.repeat(40),
    ours: (salt + '2').repeat(20),
    theirs: (salt + '3').repeat(20),
  };
  return {
    exec: (args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      if (args[0] === 'ls-files') {
        const stdout = [
          `100644 ${shas.base} 1\t${relPath}`,
          `100644 ${shas.ours} 2\t${relPath}`,
          `100644 ${shas.theirs} 3\t${relPath}`,
        ]
          .map((line) => line + '\u0000')
          .join('');
        return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
      }
      if (args[0] === 'cat-file') {
        const bySha: Record<string, string> = {
          [shas.base]: 'base\n',
          [shas.ours]: 'ours\n',
          [shas.theirs]: 'theirs\n',
        };
        return Promise.resolve({ exitCode: 0, stdout: bySha[args[2]] ?? '', stderr: '' });
      }
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` });
    },
  } as unknown as GitCli;
}

/** Waits for the constructor's async load to post its init message. */
async function initMessageOf(panel: IMockPanel): Promise<Record<string, unknown>> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    const posted = (panel.webview as unknown as { _posted: unknown[] })._posted;
    const init = posted.find((m) => (m as { type?: string }).type === 'init');
    if (init) {
      return init as Record<string, unknown>;
    }
  }
  throw new Error('the panel never posted its init message');
}

/** Exposes the protected message handler and rendered HTML for assertions. */
class PanelProbe extends MergeWindowPanel {
  deliver(message: unknown): Promise<void> {
    return Promise.resolve(this._onMessage(message));
  }
  /** Persist writes are debounced; force the pending one out for assertions. */
  flushPersist(): void {
    this._flushUnsavedResult();
  }
  get html(): string {
    return this._panel.webview.html;
  }
}

describe('MergeWindowPanel', () => {
  const tmpDir = path.join(__dirname, '..', '..', '..', 'workspace-notes', 'tmp');

  it('escapes the file name in the document title (markup injection)', () => {
    const capture = capturePanels();
    try {
      const { panel } = buildPanel('/repo/a<img src=x>.txt', []);
      assert.ok(!panel.html.includes('<img src=x>'), 'raw markup must not reach the document');
      assert.ok(panel.html.includes('&lt;img src=x&gt;'), 'title must be HTML-escaped');
      panel.dispose();
    } finally {
      capture.restore();
    }
  });

  it('the document styles ride VS Code theme tokens, not IntelliJ hexes', () => {
    const capture = capturePanels();
    try {
      const { panel } = buildPanel('/repo/x.txt', []);
      assert.ok(
        panel.html.includes('--vscode-mergeEditor-changeBase-background'),
        'conflict color rides the VS Code merge-editor theme token'
      );
      assert.ok(!panel.html.includes('#6b2e35'), 'no hardcoded IntelliJ conflict background');
      assert.ok(!panel.html.includes('#a03d49'), 'no hardcoded IntelliJ conflict accent');
      panel.dispose();
    } finally {
      capture.restore();
    }
  });

  it('the init payload carries the auto-apply setting', async () => {
    const capture = capturePanels();
    try {
      setMockConfigValue('intellig', 'mergeWindow.autoApplyNonConflicting', true);
      const { panel } = buildPanel('/repo/x.txt', [], stubStagesGitCli('x.txt'));
      await panel.deliver({ type: 'ready' });
      const init = await initMessageOf(capture.created[0]);
      assert.strictEqual(init.autoApplyNonConflicting, true);
      assert.strictEqual(init.left, 'ours\n', 'stage 2 is the left pane');
      panel.dispose();
    } finally {
      capture.restore();
      resetMockConfiguration();
    }
  });

  it('a forward operation labels the panes from the stage names unswapped', async () => {
    const capture = capturePanels();
    try {
      const { panel } = buildPanel('/repo/x.txt', [], stubStagesGitCli('x.txt'), {
        stageNames: { ours: 'main', theirs: 'feature' },
        operation: 'merge',
      });
      await panel.deliver({ type: 'ready' });
      const init = await initMessageOf(capture.created[0]);
      assert.strictEqual(init.left, 'ours\n');
      assert.strictEqual(init.leftLabel, 'Yours (main)');
      assert.strictEqual(init.right, 'theirs\n');
      assert.strictEqual(init.rightLabel, 'Theirs (feature)');
      panel.dispose();
    } finally {
      capture.restore();
      resetMockConfiguration();
    }
  });

  it('a rebase swaps pane CONTENT together with the labels (reversed operation)', async () => {
    const capture = capturePanels();
    try {
      const { panel } = buildPanel('/repo/x.txt', [], stubStagesGitCli('x.txt'), {
        stageNames: { ours: 'main', theirs: 'feature' },
        operation: 'rebase',
      });
      await panel.deliver({ type: 'ready' });
      const init = await initMessageOf(capture.created[0]);
      assert.strictEqual(init.left, 'theirs\n', 'Yours pane must hold stage 3 on a rebase');
      assert.strictEqual(init.leftLabel, 'Yours (feature)');
      assert.strictEqual(init.right, 'ours\n');
      assert.strictEqual(init.rightLabel, 'Theirs (main)');
      panel.dispose();
    } finally {
      capture.restore();
      resetMockConfiguration();
    }
  });

  it('the auto-apply setting defaults to off (IntelliJ parity)', async () => {
    const capture = capturePanels();
    try {
      const { panel } = buildPanel('/repo/x.txt', [], stubStagesGitCli('x.txt'));
      await panel.deliver({ type: 'ready' });
      const init = await initMessageOf(capture.created[0]);
      assert.strictEqual(init.autoApplyNonConflicting, false);
      panel.dispose();
    } finally {
      capture.restore();
      resetMockConfiguration();
    }
  });

  it("a 'confirm' request shows a modal and posts the user's consent back", async () => {
    const capture = capturePanels();
    const prompts: string[] = [];
    const originalWarn = vscode.window.showWarningMessage;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = async (
      message: string,
      _opts: unknown,
      ...items: string[]
    ): Promise<string | undefined> => {
      prompts.push(message);
      return items[0];
    };
    try {
      const { panel } = buildPanel('/repo/x.txt', []);
      await panel.deliver({ type: 'confirm', requestId: 7, action: 'acceptLeft' });
      const posted = (capture.created[0].webview as unknown as { _posted: unknown[] })._posted;
      const result = posted.find((m) => (m as { type?: string }).type === 'confirmResult') as {
        requestId: number;
        confirmed: boolean;
      };
      assert.ok(result, 'the host must answer the confirm request');
      assert.strictEqual(result.requestId, 7);
      assert.strictEqual(result.confirmed, true);
      assert.ok(/unsaved changes/i.test(prompts[0] ?? ''), 'modal warns about unsaved changes');
      panel.dispose();
    } finally {
      (vscode.window as { showWarningMessage: unknown }).showWarningMessage = originalWarn;
      capture.restore();
    }
  });

  it('a partially-resolved Apply confirm spells out the unprocessed counts', async () => {
    const capture = capturePanels();
    const prompts: string[] = [];
    const originalWarn = vscode.window.showWarningMessage;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = async (
      message: string,
      _opts: unknown,
      ...items: string[]
    ): Promise<string | undefined> => {
      prompts.push(message);
      return items[0];
    };
    try {
      const { panel } = buildPanel('/repo/x.txt', []);
      await panel.deliver({
        type: 'confirm',
        requestId: 9,
        action: 'applyUnresolved',
        changes: 2,
        conflicts: 1,
      });
      const posted = (capture.created[0].webview as unknown as { _posted: unknown[] })._posted;
      const result = posted.find((m) => (m as { type?: string }).type === 'confirmResult') as {
        confirmed: boolean;
      };
      assert.ok(result?.confirmed, 'choosing the apply button confirms');
      assert.ok(
        /2 changes and 1 conflict left unprocessed/.test(prompts[0] ?? ''),
        `counts must be spelled out, got: ${prompts[0]}`
      );
      panel.dispose();
    } finally {
      (vscode.window as { showWarningMessage: unknown }).showWarningMessage = originalWarn;
      capture.restore();
    }
  });

  it('dismissing the confirm modal posts confirmed=false', async () => {
    const capture = capturePanels();
    try {
      const { panel } = buildPanel('/repo/x.txt', []);
      await panel.deliver({ type: 'confirm', requestId: 3, action: 'acceptRight' });
      const posted = (capture.created[0].webview as unknown as { _posted: unknown[] })._posted;
      const result = posted.find((m) => (m as { type?: string }).type === 'confirmResult') as {
        requestId: number;
        confirmed: boolean;
      };
      assert.ok(result, 'the host must answer even a dismissed confirm');
      assert.strictEqual(result.requestId, 3);
      assert.strictEqual(result.confirmed, false);
      panel.dispose();
    } finally {
      capture.restore();
    }
  });

  it('a modified state persists the result text; a later pristine post cannot wipe it', async () => {
    const capture = capturePanels();
    const store = new Map<string, unknown>();
    try {
      const { panel } = buildPanel('/repo/x.txt', [], stubStagesGitCli('x.txt'), undefined, store);
      await panel.deliver({ type: 'ready' });
      await initMessageOf(capture.created[0]);
      await panel.deliver({
        type: 'state',
        unresolved: 1,
        total: 2,
        modified: true,
        resultText: 'half-merged\n',
      });
      panel.flushPersist();
      assert.deepStrictEqual(
        [...store.values()].map((v) => (v as { data: { text: string } }).data.text),
        ['half-merged\n']
      );
      assert.ok(
        [...store.keys()][0].includes('x.txt'),
        'the persisted result is keyed by the file'
      );

      // The merge model never returns to pristine once edited, so a
      // modified=false post can only come from a FRESH webview rendering its
      // initial state — it must not erase a result kept by dismissing the
      // restore prompt. A result that carries no merge work is dropped when
      // it is offered, by comparing it against the base.
      await panel.deliver({ type: 'state', unresolved: 2, total: 2, modified: false });
      panel.flushPersist();
      assert.strictEqual(store.size, 1, 'a pristine render state erases nothing');
      panel.dispose();
    } finally {
      capture.restore();
    }
  });

  it('coalesces per-keystroke result posts into one write and flushes on dispose', async () => {
    const capture = capturePanels();
    let writes = 0;
    const store = new (class extends Map<string, unknown> {
      override set(key: string, value: unknown): this {
        writes += 1;
        return super.set(key, value);
      }
    })();
    try {
      const { panel } = buildPanel('/repo/x.txt', [], stubStagesGitCli('x.txt'), undefined, store);
      await panel.deliver({ type: 'ready' });
      await initMessageOf(capture.created[0]);

      for (let i = 0; i < 25; i++) {
        await panel.deliver({
          type: 'state',
          unresolved: 1,
          total: 2,
          modified: true,
          resultText: `keystroke ${i}\n`,
        });
      }
      assert.strictEqual(writes, 0, '25 keystrokes must not each write the whole file');

      panel.dispose();
      assert.strictEqual(writes, 1, 'dispose flushes exactly one write');
      assert.strictEqual(
        ([...store.values()][0] as { data: { text: string } }).data.text,
        'keystroke 24\n',
        'the flushed value is the LATEST text, never a stale one'
      );
    } finally {
      capture.restore();
    }
  });

  it('a successful apply clears the persisted merge result', async () => {
    const capture = capturePanels();
    fs.mkdirSync(tmpDir, { recursive: true });
    const target = path.join(tmpDir, `apply-clears-${process.pid}.txt`);
    const store = new Map<string, unknown>();
    try {
      const { panel } = buildPanel(
        target,
        [],
        stubStagesGitCli(path.basename(target)),
        undefined,
        store
      );
      await panel.deliver({ type: 'ready' });
      await initMessageOf(capture.created[0]);
      await panel.deliver({
        type: 'state',
        unresolved: 0,
        total: 2,
        modified: true,
        resultText: 'merged\n',
      });
      panel.flushPersist();
      assert.strictEqual(store.size, 1);
      await panel.deliver({ type: 'apply', resultText: 'merged\n' });
      assert.strictEqual(store.size, 0, 'an applied result needs no restore copy');
    } finally {
      capture.restore();
      fs.rmSync(target, { force: true });
    }
  });

  it('reopening with a persisted result offers a restore and seeds init with it', async () => {
    const capture = capturePanels();
    const store = new Map<string, unknown>();
    const originalInfo = vscode.window.showInformationMessage;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async (
      _message: string,
      _opts: unknown,
      ...items: string[]
    ): Promise<string | undefined> => items.find((i) => /restore/i.test(i));
    try {
      {
        const { panel } = buildPanel(
          '/repo/x.txt',
          [],
          stubStagesGitCli('x.txt'),
          undefined,
          store
        );
        await panel.deliver({ type: 'ready' });
        await initMessageOf(capture.created[0]);
        await panel.deliver({
          type: 'state',
          unresolved: 1,
          total: 2,
          modified: true,
          resultText: 'half-merged\n',
        });
        panel.dispose();
      }
      const { panel } = buildPanel('/repo/x.txt', [], stubStagesGitCli('x.txt'), undefined, store);
      await panel.deliver({ type: 'ready' });
      const init = await initMessageOf(capture.created[1]);
      assert.strictEqual(init.restoredResult, 'half-merged\n');
      panel.dispose();
    } finally {
      (vscode.window as { showInformationMessage: unknown }).showInformationMessage = originalInfo;
      capture.restore();
    }
  });

  it('offers no restore for a result identical to the base stage', async () => {
    const capture = capturePanels();
    const store = new Map<string, unknown>();
    let prompts = 0;
    const originalInfo = vscode.window.showInformationMessage;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async (
      _message: string,
      _opts: unknown,
      ...items: string[]
    ): Promise<string | undefined> => {
      prompts++;
      return items.find((i) => /restore/i.test(i));
    };
    try {
      {
        // Editing and then undoing back to the start leaves the model flagged
        // modified (it never returns to pristine), so the base text itself is
        // what gets persisted.
        const { panel } = buildPanel(
          '/repo/x.txt',
          [],
          stubStagesGitCli('x.txt'),
          undefined,
          store
        );
        await panel.deliver({ type: 'ready' });
        await initMessageOf(capture.created[0]);
        await panel.deliver({
          type: 'state',
          unresolved: 2,
          total: 2,
          modified: true,
          resultText: 'base\n',
        });
        panel.dispose();
      }
      const { panel } = buildPanel('/repo/x.txt', [], stubStagesGitCli('x.txt'), undefined, store);
      await panel.deliver({ type: 'ready' });
      const init = await initMessageOf(capture.created[1]);

      assert.strictEqual(prompts, 0, 'nothing was merged, so there is nothing to restore');
      assert.strictEqual(init.restoredResult, undefined, 'the window opens on the conflict');
      assert.strictEqual(store.size, 0, 'the useless slot is dropped, not left to re-prompt');
      panel.dispose();
    } finally {
      (vscode.window as { showInformationMessage: unknown }).showInformationMessage = originalInfo;
      capture.restore();
    }
  });

  it('dismissing the restore prompt keeps the saved result for a later reopen', async () => {
    const capture = capturePanels();
    const store = new Map<string, unknown>();
    const originalInfo = vscode.window.showInformationMessage;
    // Dismissing (Esc / clicking away) resolves undefined — neither Restore
    // nor Discard.
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage =
      async (): Promise<string | undefined> => undefined;
    try {
      {
        const { panel } = buildPanel(
          '/repo/x.txt',
          [],
          stubStagesGitCli('x.txt'),
          undefined,
          store
        );
        await panel.deliver({ type: 'ready' });
        await initMessageOf(capture.created[0]);
        await panel.deliver({
          type: 'state',
          unresolved: 1,
          total: 2,
          modified: true,
          resultText: 'half-merged\n',
        });
        panel.dispose();
      }
      {
        // Reopen: dismiss the prompt, then the fresh webview reports its
        // pristine render state.
        const { panel } = buildPanel(
          '/repo/x.txt',
          [],
          stubStagesGitCli('x.txt'),
          undefined,
          store
        );
        await panel.deliver({ type: 'ready' });
        await initMessageOf(capture.created[1]);
        await panel.deliver({ type: 'state', unresolved: 2, total: 2, modified: false });
        panel.flushPersist();
        assert.strictEqual(store.size, 1, 'a dismissed prompt must not erase the saved result');
        panel.dispose();
      }

      const { panel } = buildPanel('/repo/x.txt', [], stubStagesGitCli('x.txt'), undefined, store);
      await panel.deliver({ type: 'ready' });
      const init = await initMessageOf(capture.created[2]);
      assert.strictEqual(
        init.restoredResult,
        undefined,
        'this reopen dismisses too, so nothing is seeded'
      );
      assert.strictEqual(store.size, 1, 'the result is still there to offer again');
      panel.dispose();
    } finally {
      (vscode.window as { showInformationMessage: unknown }).showInformationMessage = originalInfo;
      capture.restore();
    }
  });

  it('declining the restore drops the persisted result and opens clean', async () => {
    const capture = capturePanels();
    const store = new Map<string, unknown>();
    const originalInfo = vscode.window.showInformationMessage;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async (
      _message: string,
      _opts: unknown,
      ...items: string[]
    ): Promise<string | undefined> => items.find((i) => /discard/i.test(i));
    try {
      {
        const { panel } = buildPanel(
          '/repo/x.txt',
          [],
          stubStagesGitCli('x.txt'),
          undefined,
          store
        );
        await panel.deliver({ type: 'ready' });
        await initMessageOf(capture.created[0]);
        await panel.deliver({
          type: 'state',
          unresolved: 1,
          total: 2,
          modified: true,
          resultText: 'half-merged\n',
        });
        panel.dispose();
      }
      const { panel } = buildPanel('/repo/x.txt', [], stubStagesGitCli('x.txt'), undefined, store);
      await panel.deliver({ type: 'ready' });
      const init = await initMessageOf(capture.created[1]);
      assert.strictEqual(init.restoredResult, undefined, 'declining must not seed the result');
      assert.strictEqual(store.size, 0, 'declining discards the saved copy');
      panel.dispose();
    } finally {
      (vscode.window as { showInformationMessage: unknown }).showInformationMessage = originalInfo;
      capture.restore();
    }
  });

  it('drops a saved result whose index stages no longer match (a later, unrelated conflict)', async () => {
    const capture = capturePanels();
    const store = new Map<string, unknown>();
    let prompts = 0;
    const originalInfo = vscode.window.showInformationMessage;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async (
      _message: string,
      _opts: unknown,
      ...items: string[]
    ): Promise<string | undefined> => {
      prompts += 1;
      return items.find((i) => /restore/i.test(i));
    };
    try {
      {
        const { panel } = buildPanel(
          '/repo/x.txt',
          [],
          stubStagesGitCli('x.txt', '1'),
          undefined,
          store
        );
        await panel.deliver({ type: 'ready' });
        await initMessageOf(capture.created[0]);
        await panel.deliver({
          type: 'state',
          unresolved: 1,
          total: 2,
          modified: true,
          resultText: 'abandoned\n',
        });
        panel.dispose();
      }
      assert.strictEqual(store.size, 1, 'the abandoned result is on disk');

      // The path conflicts again later with entirely different stage blobs.
      const { panel } = buildPanel(
        '/repo/x.txt',
        [],
        stubStagesGitCli('x.txt', '9'),
        undefined,
        store
      );
      await panel.deliver({ type: 'ready' });
      const init = await initMessageOf(capture.created[1]);

      assert.strictEqual(prompts, 0, 'a stale result is never offered');
      assert.strictEqual(init.restoredResult, undefined, 'the editor opens on the new conflict');
      assert.strictEqual(store.size, 0, 'the stale result is cleared, not left to resurface');
      panel.dispose();
    } finally {
      (vscode.window as { showInformationMessage: unknown }).showInformationMessage = originalInfo;
      capture.restore();
    }
  });

  it('surfaces a fatal webview failure as a toast and closes the dead panel', async () => {
    const capture = capturePanels();
    const errors: string[] = [];
    const originalError = vscode.window.showErrorMessage;
    (vscode.window as { showErrorMessage: unknown }).showErrorMessage = (
      message: string
    ): Thenable<string | undefined> => {
      errors.push(message);
      return Promise.resolve(undefined);
    };
    try {
      const { panel } = buildPanel('/repo/x.txt', [], stubStagesGitCli('x.txt'));
      let disposed = false;
      capture.created[0].onDidDispose(() => {
        disposed = true;
      });

      // A half-built webview can neither Apply nor Abort; leaving the tab open
      // reads as a hung merge.
      await panel.deliver({ type: 'log', level: 'fatal', text: 'boom' });

      assert.strictEqual(errors.length, 1, 'the user must be told the window died');
      assert.ok(/merge window/i.test(errors[0]), `unexpected toast: ${errors[0]}`);
      assert.strictEqual(disposed, true, 'the dead panel must close');
    } finally {
      (vscode.window as { showErrorMessage: unknown }).showErrorMessage = originalError;
      capture.restore();
    }
  });

  it("rejects an 'apply' with a missing resultText instead of writing an empty file", async () => {
    const capture = capturePanels();
    fs.mkdirSync(tmpDir, { recursive: true });
    const target = path.join(tmpDir, `r6-apply-guard-${process.pid}.txt`);
    const stagedPaths: string[][] = [];
    try {
      const { panel, applied } = buildPanel(target, stagedPaths);
      await panel.deliver({ type: 'apply' });
      assert.strictEqual(fs.existsSync(target), false, 'no file may be written');
      assert.strictEqual(stagedPaths.length, 0, 'nothing may be staged');
      assert.strictEqual(applied.length, 0, 'onApplied must not fire');
      panel.dispose();
    } finally {
      capture.restore();
      fs.rmSync(target, { force: true });
    }
  });
});

describe('MergeView merge-window per-file dedup', () => {
  afterEach(() => {
    resetMockConfiguration();
  });

  function buildView(relPath = 'a.txt'): MergeView {
    const repo = { rootUri: vscode.Uri.file('/repo') } as IRepository;
    const gitService = {
      getRepository: () => Promise.resolve(repo),
      getRepositories: () => [repo],
      // The dedup key includes the conflict's index-stage identity, so the
      // view needs a git CLI that reports real unmerged stages.
      gitCli: stubStagesGitCli(relPath),
    } as unknown as IGitService;
    return new MergeView(vscode.Uri.file('/ext'), gitService, {
      context: fakeContext(),
      getConflictContext: () => Promise.resolve({ stageNames: {}, operation: undefined }),
    });
  }

  it('reveals the existing window instead of stacking a duplicate', async () => {
    setMockConfigValue('intellig', 'mergeWindow.enabled', true);
    const capture = capturePanels();
    try {
      const view = buildView();
      await view.show('/repo/a.txt');
      await view.show('/repo/a.txt');
      assert.strictEqual(capture.created.length, 1, 'second show must not create a second panel');
      assert.strictEqual(capture.created[0]._revealCallCount, 1, 'second show must reveal');
    } finally {
      capture.restore();
    }
  });

  it('opens a fresh window after the previous one is disposed', async () => {
    setMockConfigValue('intellig', 'mergeWindow.enabled', true);
    const capture = capturePanels();
    try {
      const view = buildView();
      await view.show('/repo/a.txt');
      capture.created[0].dispose();
      await view.show('/repo/a.txt');
      assert.strictEqual(capture.created.length, 2, 'a disposed window must be replaced');
    } finally {
      capture.restore();
    }
  });

  it('tracks different files in different windows', async () => {
    setMockConfigValue('intellig', 'mergeWindow.enabled', true);
    const capture = capturePanels();
    try {
      const view = buildView();
      await view.show('/repo/a.txt');
      await view.show('/repo/b.txt');
      assert.strictEqual(capture.created.length, 2);
    } finally {
      capture.restore();
    }
  });
});
