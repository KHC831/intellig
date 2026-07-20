/**
 * Closing the panel must settle the dialog's promise.
 *
 * BaseWebviewPanel registers an onDidDispose that drains `_disposables`.
 * A subclass that registers its own onDidDispose INTO `_disposables`
 * afterwards has that listener disposed mid-delivery, and VS Code's emitter
 * skips listeners disposed during delivery — so the subclass callback never
 * runs and any awaiting caller hangs forever.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { DefineRemoteDialog } from '../../../src/sync/DefineRemoteDialog';
import { CommitMessageDialog } from '../../../src/commits/CommitMessageDialog';

function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file('/tmp/ext'),
    extensionPath: '/tmp/ext',
    asAbsolutePath: (rel: string): string => `/tmp/ext/${rel}`,
  } as unknown as vscode.ExtensionContext;
}

function panelOf(dialog: object): vscode.WebviewPanel {
  return (dialog as unknown as { _panel: vscode.WebviewPanel })._panel;
}

async function settlesWithin(promise: Promise<unknown>): Promise<boolean> {
  const sentinel = Symbol('pending');
  const raced = await Promise.race([
    promise,
    new Promise((r) => setTimeout(() => r(sentinel), 20)),
  ]);
  return raced !== sentinel;
}

describe('webview dialogs settle when the panel closes', () => {
  it('DefineRemoteDialog.prompt() resolves when the user closes the panel', async () => {
    const dialog = new DefineRemoteDialog(makeContext(), {
      request: { title: 'Define Remote', name: '', url: '', existingNames: [] },
    });
    const pending = dialog.prompt();

    // The host path: VS Code fires onDidDispose when the tab is closed.
    panelOf(dialog).dispose();

    assert.ok(await settlesWithin(pending), 'prompt() must not hang when the panel closes');
    assert.strictEqual(await pending, undefined, 'a closed dialog reads as cancelled');
  });

  it('CommitMessageDialog.prompt() resolves when the user closes the panel', async () => {
    const dialog = new CommitMessageDialog(makeContext(), {
      seedMessage: '',
      viewType: 'intellig.testCommitMessage',
      title: 'Commit Message',
      heading: 'Message',
      submitLabel: 'Commit',
      submitVerb: 'commit',
    });
    const pending = dialog.prompt();

    panelOf(dialog).dispose();

    assert.ok(await settlesWithin(pending), 'prompt() must not hang when the panel closes');
    assert.strictEqual(await pending, undefined);
  });
});
