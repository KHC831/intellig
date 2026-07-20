/**
 * The define-remote dialog's host must re-validate the submitted name and URL.
 *
 * The webview is a separate scripting context, so its validation is a UX
 * affordance, not a trust boundary: a `submit` message reaches `_onMessage`
 * carrying whatever payload it likes, and the resolved values are handed
 * straight to `git remote add` / `rename` / `set-url`. IntelliJ runs the same
 * checks (nameNotBlank / nameWellFormed / nameUnique / urlNotBlank in
 * plugins/git4idea/backend/src/remote/GitDefineRemoteDialog.kt) inside
 * doOKAction, but there the dialog and the git call share one trusted process.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { DefineRemoteDialog } from '../../../src/sync/DefineRemoteDialog';
import type { IDefineRemoteResult } from '../../../src/sync/defineRemoteDialog.protocol';

function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file('/tmp/ext'),
    extensionPath: '/tmp/ext',
    asAbsolutePath: (rel: string): string => `/tmp/ext/${rel}`,
  } as unknown as vscode.ExtensionContext;
}

class TestDefineRemoteDialog extends DefineRemoteDialog {
  public sent: Array<{ type: string; [k: string]: unknown }> = [];

  constructor(...args: ConstructorParameters<typeof DefineRemoteDialog>) {
    super(...args);
    const panel = (this as unknown as { _panel: vscode.WebviewPanel })._panel;
    const origPost = panel.webview.postMessage.bind(panel.webview);
    panel.webview.postMessage = (payload: unknown): Thenable<boolean> => {
      if (payload && typeof payload === 'object') {
        this.sent.push(payload as { type: string });
      }
      return origPost(payload);
    };
  }

  public async simulateMessage(raw: unknown): Promise<void> {
    await (this as unknown as { _onMessage(m: unknown): Promise<void> })._onMessage(raw);
  }
}

function makeDialog(existingNames: string[] = ['origin']): {
  dialog: TestDefineRemoteDialog;
  settled: { value: IDefineRemoteResult | undefined; done: boolean };
} {
  const dialog = new TestDefineRemoteDialog(makeContext(), {
    request: {
      title: 'Define Remote',
      name: '',
      url: '',
      existingNames,
    },
  });
  const settled = { value: undefined as IDefineRemoteResult | undefined, done: false };
  void dialog.prompt().then((v) => {
    settled.value = v;
    settled.done = true;
  });
  return { dialog, settled };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('DefineRemoteDialog host-side re-validation', () => {
  it('rejects an option-shaped remote name instead of resolving it to git', async () => {
    const { dialog, settled } = makeDialog();

    await dialog.simulateMessage({ type: 'submit', name: '-x', url: 'https://example.com/r.git' });
    await flush();

    assert.strictEqual(settled.done, false, 'prompt() must not resolve on an invalid name');
    assert.ok(
      dialog.sent.some((m) => m.type === 'error'),
      'the dialog reports the problem and stays open'
    );
    dialog.dispose();
  });

  it('rejects blank name and URL', async () => {
    const { dialog, settled } = makeDialog();

    await dialog.simulateMessage({ type: 'submit', name: '', url: '' });
    await flush();

    assert.strictEqual(settled.done, false, 'prompt() must not resolve on blank input');
    assert.ok(dialog.sent.some((m) => m.type === 'error'));
    dialog.dispose();
  });

  it('rejects a duplicate remote name', async () => {
    const { dialog, settled } = makeDialog(['origin', 'upstream']);

    await dialog.simulateMessage({
      type: 'submit',
      name: 'upstream',
      url: 'https://example.com/r.git',
    });
    await flush();

    assert.strictEqual(settled.done, false, 'prompt() must not resolve on a duplicate name');
    assert.ok(dialog.sent.some((m) => m.type === 'error'));
    dialog.dispose();
  });

  it('rejects an option-shaped URL', async () => {
    const { dialog, settled } = makeDialog();

    await dialog.simulateMessage({ type: 'submit', name: 'upstream', url: '--upload-pack=evil' });
    await flush();

    assert.strictEqual(settled.done, false, 'prompt() must not resolve on an option-shaped URL');
    assert.ok(dialog.sent.some((m) => m.type === 'error'));
    dialog.dispose();
  });

  it('still resolves a well-formed submission', async () => {
    const { dialog, settled } = makeDialog();

    await dialog.simulateMessage({
      type: 'submit',
      name: 'upstream',
      url: 'https://example.com/r.git',
    });
    await flush();

    assert.strictEqual(settled.done, true, 'a valid submission resolves');
    assert.deepStrictEqual(settled.value, {
      name: 'upstream',
      url: 'https://example.com/r.git',
      fetch: true,
    });
  });
});
