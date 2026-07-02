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
  stagedPaths: string[][]
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
    gitCli: {} as GitCli,
    gitService,
    onApplied: (rel): void => {
      applied.push(rel);
    },
  });
  return { panel, applied };
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
