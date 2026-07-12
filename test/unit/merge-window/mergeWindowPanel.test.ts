import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MergeWindowPanel } from '../../../src/conflicts/merge-window/MergeWindowPanel';
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

function fakeContext(): vscode.ExtensionContext {
  return { extensionUri: vscode.Uri.file('/ext') } as vscode.ExtensionContext;
}

function buildPanel(
  absolutePath: string,
  stagedPaths: string[][],
  gitCli: GitCli = {} as GitCli
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
  const panel = new PanelProbe(fakeContext(), {
    repository,
    relPath: path.basename(absolutePath),
    absolutePath,
    leftLabel: 'Yours',
    rightLabel: 'Theirs',
    gitCli,
    gitService,
    onApplied: (rel): void => {
      applied.push(rel);
    },
  });
  return { panel, applied };
}

/** A gitCli whose exec serves one conflicted path's three index stages. */
function stubStagesGitCli(relPath: string): GitCli {
  const shas = { base: '1'.repeat(40), ours: '2'.repeat(40), theirs: '3'.repeat(40) };
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

  function buildView(): MergeView {
    const repo = { rootUri: vscode.Uri.file('/repo') } as IRepository;
    const gitService = {
      getRepository: () => Promise.resolve(repo),
      getRepositories: () => [repo],
      gitCli: {},
    } as unknown as IGitService;
    return new MergeView(vscode.Uri.file('/ext'), gitService, {
      context: fakeContext(),
      getSideNames: () => Promise.resolve({}),
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
