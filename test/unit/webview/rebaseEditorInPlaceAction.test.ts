/**
 * Runtime (jsdom) regression: the interactive Rebase Editor updates a single
 * commit row IN PLACE when its action dropdown changes — it does NOT rebuild
 * the whole webview.
 *
 * The host used to re-template the entire document (`webview.html = …`) on every
 * action change, which tore down and rebuilt the DOM (resetting scroll, losing
 * the drag wiring, etc.). A dropdown change only affects one row: its action
 * color class and whether the reword/squash message box is shown. The webview
 * now applies that change directly to the row and just notifies the host of the
 * new action; the host no longer re-renders on `updateAction`.
 *
 * These specs run the real client script under jsdom, change a dropdown, and
 * assert the row mutates in place (class swap + message box show/hide) and the
 * host is still told, without depending on any host round-trip.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { RebaseEditor } from '../../../src/rebase/RebaseEditor';
import type {
  IRebaseService,
  IRebaseSession,
  RebaseAction,
} from '../../../src/git-core/interfaces/IRebaseService';
import { Uri } from '../../mocks/vscode';
import { runWebviewScript, IWebviewHarness } from '../../helpers/webviewHarness';

function stubRebaseService(): IRebaseService {
  const emitter = new vscode.EventEmitter<IRebaseSession | undefined>();
  return {
    onDidChangeRebaseSession: emitter.event,
    dispose: (): void => emitter.dispose(),
  } as unknown as IRebaseService;
}

function scriptWithCommits(actions: RebaseAction[]): string {
  const commits = actions.map((action, i) => ({
    hash: String(i + 1).padStart(40, '0'),
    message: `commit ${i + 1}`,
    action,
  }));
  const editor = new RebaseEditor(Uri.file('/tmp/ext'), stubRebaseService());
  (editor as unknown as { _session: IRebaseSession })._session = {
    onto: 'main',
    originalBranch: 'feature',
    commits,
    currentStep: 0,
    status: 'planning',
  };
  return (editor as unknown as { _getScript(p?: boolean): string })._getScript();
}

function boot(actions: RebaseAction[]): IWebviewHarness {
  return runWebviewScript(scriptWithCommits(actions), {
    bodyHtml: '<div class="rebase-editor" id="rebase-root"></div>',
  });
}

function changeDropdown(h: IWebviewHarness, index: number, value: RebaseAction): HTMLElement {
  const selects = h.document.querySelectorAll('.action-dropdown');
  const select = selects[index] as HTMLSelectElement;
  (select as unknown as { value: string }).value = value;
  select.dispatchEvent(new h.window.Event('change'));
  return select.closest('.commit-item') as HTMLElement;
}

describe('webview: rebase editor in-place action change (jsdom)', () => {
  let h: IWebviewHarness;
  afterEach(() => h && h.dispose());

  it('swaps the row action color class in place on a dropdown change', () => {
    h = boot(['pick', 'pick', 'pick']);
    const row = changeDropdown(h, 2, 'squash');
    assert.ok(row.classList.contains('action-squash'), 'row gains the new action class');
    assert.ok(!row.classList.contains('action-pick'), 'row drops the old action class');
    assert.strictEqual(h.errors.length, 0);
  });

  it('shows the message box when switching to reword/squash', () => {
    h = boot(['pick']);
    const row = changeDropdown(h, 0, 'reword');
    const box = row.querySelector('.reword-message-editor');
    assert.ok(box, 'a message editor is shown');
    assert.ok(box.querySelector('textarea.reword-message-input'), 'with a textarea');
  });

  it('removes the message box when switching away from reword/squash', () => {
    h = boot(['reword']);
    assert.ok(
      h.document.querySelector('.reword-message-editor'),
      'reword row starts with a message box'
    );
    const row = changeDropdown(h, 0, 'pick');
    assert.ok(!row.querySelector('.reword-message-editor'), 'the message box is removed');
  });

  it('still notifies the host of the new action', () => {
    h = boot(['pick', 'pick']);
    changeDropdown(h, 1, 'drop');
    assert.deepEqual(h.posted.at(-1), {
      type: 'updateAction',
      hash: '0000000000000000000000000000000000000002',
      action: 'drop',
    });
  });

  it('wires the newly-shown textarea so typing posts updateMessage', () => {
    h = boot(['pick']);
    const row = changeDropdown(h, 0, 'squash');
    const ta = row.querySelector('textarea.reword-message-input') as HTMLTextAreaElement;
    (ta as unknown as { value: string }).value = 'combined';
    ta.dispatchEvent(new h.window.Event('input'));
    assert.deepEqual(h.posted.at(-1), {
      type: 'updateMessage',
      hash: '0000000000000000000000000000000000000001',
      message: 'combined',
    });
  });
});
