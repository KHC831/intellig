/**
 * Changing a graph setting shows at once. The settings the graph reads while
 * drawing (long edges, the GPG column, root names) repaint what is loaded;
 * the cherry-pick marks come from git, so that setting reloads. Without this
 * a change waited for the next history change, because an identical reload
 * is skipped (see graphIdleRefreshNoRerender.test.ts) and settings are not
 * part of what it compares.
 */

import '../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { ICommit, IAuthor } from '../../src/git-core/interfaces/IGitService';
import { Uri } from '../mocks/vscode';

const AUTHOR: IAuthor = { name: 'tester', email: 't@example.com' };

function mkCommit(hash: string): ICommit {
  const date = new Date(2020, 0, 1);
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message: 'm',
    author: AUTHOR,
    committer: AUTHOR,
    parents: [],
    authorDate: date,
    commitDate: date,
  };
}

function tapView(provider: GitToolWindowProvider): { htmlSetCount: () => number } {
  let count = 0;
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
  (provider as any)._view = {
    webview: {
      get html(): string {
        return '';
      },
      set html(_v: string) {
        count += 1;
      },
      options: {},
      cspSource: 'test:',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (u: unknown) => u,
    },
    visible: true,
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
  return { htmlSetCount: () => count };
}

describe('a graph setting change shows at once', () => {
  let provider: GitToolWindowProvider;
  const commits = [mkCommit('a'.repeat(40))];

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(async () => {
    const config = vscode.workspace.getConfiguration('intellig');
    for (const key of ['log.showLongEdges', 'log.showGpgColumn', 'log.highlightCherryPicked']) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
    provider.dispose();
  });

  for (const key of ['log.showLongEdges', 'log.showGpgColumn', 'log.showRootNames']) {
    it(`repaints the loaded graph when intellig.${key} changes`, async () => {
      const view = tapView(provider);
      provider.updateLogState(commits, new Map(), new Map(), commits[0].hash, 'main');
      const before = view.htmlSetCount();

      await vscode.workspace
        .getConfiguration('intellig')
        .update(key, true, vscode.ConfigurationTarget.Global);

      assert.ok(view.htmlSetCount() > before, `a change to ${key} repaints`);
    });
  }

  it('reloads when intellig.log.highlightCherryPicked changes', async () => {
    let reloads = 0;
    provider.onDidRequestRefresh(() => {
      reloads += 1;
    });
    await vscode.workspace
      .getConfiguration('intellig')
      .update('log.highlightCherryPicked', false, vscode.ConfigurationTarget.Global);
    assert.ok(reloads > 0, 'the cherry-pick marks are loaded again');
  });

  it('stops listening once disposed', async () => {
    const view = tapView(provider);
    provider.updateLogState(commits, new Map(), new Map(), commits[0].hash, 'main');
    provider.dispose();
    const before = view.htmlSetCount();
    await vscode.workspace
      .getConfiguration('intellig')
      .update('log.showLongEdges', true, vscode.ConfigurationTarget.Global);
    assert.strictEqual(view.htmlSetCount(), before);
  });
});
