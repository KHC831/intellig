/**
 * Unit test: appending a git-console entry must not re-render the graph webview
 * unless the Console tab is the active tab.
 *
 * Root cause of the "graph resizes / dragged widths snap back on every commit
 * click" report: `addConsoleEntry` called `_render()` unconditionally.
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

describe('clearing the console does not destroy the document it is not showing', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  const entry = (command: string): Parameters<GitToolWindowProvider['addConsoleEntry']>[0] => ({
    command,
    output: '',
    exitCode: 0,
    isError: false,
  });

  // Positive control for the instrument itself. Every other assertion in this
  // describe expects a count of ZERO, and a tap that observed nothing would
  // report zero for all of them — indistinguishable from success. So prove the
  // tap counts a render that is known to happen before trusting it not to.
  it('counts exactly one document rebuild for a render that is known to happen', async () => {
    await provider.focusTab('console');
    const view = tapView(provider);

    provider.addConsoleEntry(entry('git status'));

    assert.strictEqual(
      view.htmlSetCount(),
      1,
      'tap is blind: a console entry on the active Console tab must rebuild the document exactly once'
    );
  });

  it('performs no document rebuild when the Console tab is not the active tab', async () => {
    await provider.focusTab('console');
    provider.addConsoleEntry(entry('git fetch'));
    await provider.focusTab('log');
    assert.notStrictEqual(provider.getActiveTab(), 'console', 'precondition: Log tab active');

    const view = tapView(provider);
    provider.clearConsole();

    assert.strictEqual(
      view.htmlSetCount(),
      0,
      'clearing the console while the Log tab is showing must not destroy the log document'
    );
  });

  it('performs no document rebuild when the entry list is already empty', async () => {
    await provider.focusTab('console');
    const view = tapView(provider);

    provider.clearConsole();

    assert.strictEqual(
      view.htmlSetCount(),
      0,
      'clearing an already-empty console changes nothing observable, so it must not rebuild'
    );
  });

  it('rebuilds once when there is something to clear and the Console tab is showing', async () => {
    await provider.focusTab('console');
    provider.addConsoleEntry(entry('git pull'));
    const view = tapView(provider);

    provider.clearConsole();

    assert.strictEqual(
      view.htmlSetCount(),
      1,
      'a real clear on the visible Console tab still has to repaint it'
    );
  });

  it('rebuilds only once across two identical clears', async () => {
    await provider.focusTab('console');
    provider.addConsoleEntry(entry('git push'));
    const view = tapView(provider);

    provider.clearConsole();
    provider.clearConsole();

    assert.strictEqual(
      view.htmlSetCount(),
      1,
      'the second clear is a no-op, so it must not rebuild the document again'
    );
  });
});
