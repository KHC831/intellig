/**
 * Unit test: appending a git-console entry must not re-render the graph webview
 * unless the Console tab is the active tab.
 *
 * Root cause of the "graph resizes / dragged widths snap back on every commit
 * click" report: `addConsoleEntry` called `_updateWebview()` unconditionally.
 * Every git command (including the `git show` a commit selection fires to fetch
 * its diff) logs a console entry, so every git command rebuilt the entire
 * graph+details DOM — discarding the user's live-dragged divider/column widths
 * and scroll. A captured dogfood session showed 130 full re-renders from this
 * path alone.
 *
 * The fix mirrors the History/Incoming tabs: only re-render when the Console tab
 * is actually visible. While the Log (graph) tab is active — the default — a new
 * console entry updates in-memory state silently and the graph DOM is left
 * intact.
 */

import '../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { Uri } from '../mocks/vscode';

function tapView(provider: GitToolWindowProvider): { htmlSetCount: () => number } {
  let count = 0;
  let backing = '';
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
  (provider as any)._view = {
    webview: {
      get html(): string {
        return backing;
      },
      set html(v: string) {
        count += 1;
        backing = v;
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

describe('git-console entry does not re-render the graph while the Log tab is active', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  it('addConsoleEntry performs no full re-render when the Console tab is not active', () => {
    // Default active tab is the Log/graph tab.
    assert.notStrictEqual(provider.getActiveTab(), 'console', 'precondition: Log tab active');

    const view = tapView(provider);
    provider.addConsoleEntry({
      command: 'git show abc',
      output: 'diff…',
      exitCode: 0,
      isError: false,
    });
    provider.addConsoleEntry({ command: 'git status', output: '', exitCode: 0, isError: false });

    assert.strictEqual(
      view.htmlSetCount(),
      0,
      'a console entry must NOT rebuild the graph DOM while the Log tab is active'
    );
  });
});
